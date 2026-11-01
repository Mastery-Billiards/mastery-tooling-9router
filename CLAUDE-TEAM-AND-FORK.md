# Claude Team và chạy bản custom fork

## Claude Team

Trang `/dashboard/claude-team` nằm ngay dưới Quota Tracker.

1. Chọn connection OAuth của admin; không có email hay org ID hard-code.
2. Nhập sessionKey web của cùng account, rồi Save settings. Session được mã hóa AES-256-GCM trong `DATA_DIR/claude-team`, ngoài settings/connection và response API. Khóa mã hóa nằm cùng thư mục, quyền file 0600; đây là bảo vệ dữ liệu lưu, không thay thế quyền truy cập máy chủ.
3. Discover organizations, chọn org Team, rồi Save settings. Cấu hình đầy đủ sẽ tự tải member/quota ở chế độ inspection. Nếu chưa có dữ liệu, mở lại trang cũng tự tải lần đầu.
4. Refresh members & quota tải lại admin, membership, số seat đã mua và quota. Nút này không đổi seat, dùng reset hay bật/tắt connection.
5. Bật Enable automatic seat rotation and limit resets, rồi Save settings. Run now chạy ngay; nếu không, scheduler tự chạy. Đăng nhập dashboard là bắt buộc cho API này, kể cả khi setting requireLogin của dashboard đang tắt.

Session web không tự gia hạn bằng OAuth. Khi phiên hết hạn, nhập phiên mới. Không đưa `/tmp/ct-sk.txt` hay HAR vào Git. HAR hiện được ignore.

### Chính sách mặc định

- Kiểm tra mỗi 3 phút, đọc quota thật không qua cache 5 phút của Quota Tracker.
- Rotate khi 5h, weekly hoặc Fable còn không quá 5%.
- Nếu có reset phù hợp cho weekly/Fable, đợi tới 1% rồi reset; grant yêu cầu chạm giới hạn thì đợi 0%. Chỉ dùng grant khi API đánh dấu usable_now và còn hạn/lượt, không paused/cooldown.
- Chỉ hết 5h không tiêu reset. Grant sắp hết hạn trong 24 giờ được dùng sớm nếu weekly/Fable còn dưới 20% và API cho phép.
- Sau reset, đọc lại cả weekly/Fable; nếu chưa xác nhận thành công thì thử rotate.
- Thành viên mới chưa từng dùng/nhận seat được ưu tiên ở lần cấp seat tiếp theo. Không lấy seat của người vẫn dùng tốt chỉ vì thêm connection.
- Điểm = 0.50 × Fable + 0.35 × weekly + 0.15 × 5h. Khi một khung thực tế không tồn tại, bỏ khung đó và chuẩn hóa lại trọng số. Trong nhóm chênh dưới 5 điểm so với điểm cao nhất của nhóm, ưu tiên weekly reset sớm hơn.
- Lưu snapshot riêng cho Standard/Premium. Với cùng tier, suy ra 100% riêng từng khung sau thời điểm reset; không dùng quota của tier khác làm balance hiện tại. Snapshot tier khác trở thành stale sau khi account nhận/dùng seat mới.
- Ưu tiên quota đã biết dùng được, sau đó account chưa đo cho tier đích, rồi account chờ reset. Trong mỗi nhóm, member mới được ưu tiên. Quota unknown giữ giá trị null và được xác minh sau khi cấp seat; không hiển thị thành 100%.
- Không có ứng viên sẵn sàng thì giữ seat cũ; tính lần reset có thể dùng sớm nhất và lưu nextRunAt. Scheduler kiểm tra thời gian mỗi giây và tiếp tục lịch sau restart, không cần mở trang dashboard.

### Chuyển seat và phục hồi

- Xác minh identity/org bằng OAuth profile, không chỉ tên connection. Trim/lowercase tên chỉ phục vụ đối chiếu ban đầu; không dùng để cấp quyền mutation.
- Chỉ account có trong 9router và xác minh thuộc org mới được quản lý. Member ngoài 9router vẫn được tính vào số seat đang dùng của toàn org, nhưng không bị đổi seat.
- Account khớp danh sách member nhưng OAuth lỗi vẫn hiển thị trong bảng với cảnh báo, không được cấp/chuyển seat hay dùng reset tới khi xác minh OAuth thành công.
- Dùng `subscription_details.seat_tier_quantities` và `members/counts`, trừ cả pending invites; đọc lại trước mọi lần gán. Không gọi endpoint mua hay tăng số lượng seat. Chuyển đúng tier; tự lấp seat đã mua đang trống.
- Khóa worker bằng giao dịch SQLite. Trước thao tác ghi từ xa, lưu intent vào DB. PUT timeout phải đọc lại membership trước khi quyết định có thất bại hay không.
- Bỏ seat cũ rồi mới cấp seat mới. Refresh OAuth và kiểm tra quota mới; chỉ bật account mới sau khi quota đạt ngưỡng, đồng thời xóa health/model locks cũ qua hàm activation hiện có.
- Ứng viên hết quota bị bỏ seat; thử tối đa 3 ứng viên cho mỗi lần cấp seat. Trả seat về nguồn giữa các lần thử không thành công.
- Lỗi mạng không rõ kết quả để lại pending operation. Lượt chạy tiếp theo kiểm tra trạng thái thực tế, hoàn tất hoặc trả seat về nguồn. Nếu phát hiện trạng thái bị thay đổi ngoài worker, dừng và hiển thị lỗi thay vì tự ý bỏ seat đó.
- Không lặp lại POST reset có kết quả không rõ sau crash. Đọc quota để đối chiếu trước; lịch sử ghi nhận lần phục hồi.
- Lịch sử giữ 1.000 sự kiện gần nhất trong scope KV `claudeTeam`. Config, quota snapshot, lịch chạy và pending operation cũng nằm trong scope này; không đổi schema/core routing.

## Thao tác thủ công và giao diện

- Settings mở trong popup; trang chỉ hiển thị account thuộc org đã chọn. Màu quota theo Quota Tracker và bảng dùng theme chung của dashboard.
- Manual rotation cho phép chọn chủ seat và account thay thế, dùng cùng khóa/intent/kiểm tra quota với automation, kể cả khi automation tắt.
- Waiting for a seat mặc định All plans, luôn xếp theo độ ưu tiên, không có sort email. All plans ghép thứ hạng theo tier trong từng nhóm quota; không cộng quota/điểm giữa hai tier. Chọn Standard/Premium để xem đúng danh sách dùng khi cấp loại seat đó.
- Measure waiting quota mở popup chọn account cho mượn seat. Quét toàn bộ account chờ đã xác minh OAuth, không phụ thuộc bộ lọc; lần lượt gán đúng tier để đo, giữ account thử ngoài routing, rồi trả seat về chủ cũ sau mỗi lượt. Không dùng reset. Lưu tiến độ/kết quả và quota theo tier để automation tiếp tục dùng.
- Intent đo quota có kiểu riêng: khi gián đoạn phải trả seat về nguồn, không hoàn tất như giao dịch rotate. Không đổi cờ ưu tiên member mới chỉ vì đã mượn seat để đo.
- Reconnect trên trang Claude provider giữ nguyên connection ID, xác minh đúng identity/org trước khi thay credentials. OAuth health được hiển thị trên account lỗi. Authorize mở popup mới giống Add account, không fallback sang tab mới; hỗ trợ copy link để mở profile trình duyệt khác.
- Worker hiển thị phase/account đang xử lý; lịch sử có lý do, quota trước/sau, lỗi và rollback. Khóa SQLite dùng chung cho reconnect, đo quota, manual và auto rotation.
- Client thử lại một lần cho lỗi mạng tạm thời và HTTP 502/503/504 của lệnh đọc. Không replay seat/reset writes. Lỗi phân biệt endpoint, network/timeout, Cloudflare, web session và OAuth; không trả token/cookie hay nội dung lỗi remote thô.

## Chuyển từ bản npm sang fork

Thực hiện sau khi đã xem và commit các thay đổi custom cần giữ. Script cập nhật dừng khi repo có file chưa commit, kể cả file chưa tracked.

Trong thư mục repo:

```sh
npm install
npm run fork:prepare
```

`fork:prepare` đóng gói HEAD vào release riêng trong `.fork/releases`, cài dependencies, build và kiểm tra HTTP health bằng DATA_DIR tạm. Nó không merge upstream, push hay tắt server hiện tại. Không chạy prepare khi supervisor custom đã hoạt động; dùng fork:sync cho các cập nhật sau.

Sau khi release đã chuẩn bị thành công, thoát bản npm hiện tại bằng Quit trên tray, rồi chạy:

```sh
npm run fork:start
```

Mặc định cổng 20128, dữ liệu `~/.9router`; có thể đặt PORT/DATA_DIR và các biến trong `.env*`. Launcher từ chối chạy nếu cổng đang có server, không tự kill một instance khác. Để chạy nền trên macOS, có thể dùng:

```sh
nohup npm run fork:start > /tmp/9router-fork.log 2>&1 &
```

Tray tái sử dụng implementation hiện có; cập nhật chỉ restart HTTP child. Nếu đang bật autostart từ bản npm, bật lại từ tray bản fork để đường dẫn autostart trỏ tới launcher mới. Không dùng lệnh npm global để cập nhật fork này.

Khi sao lưu dữ liệu, giữ cả DB và thư mục `claude-team` chứa session mã hóa/khóa. Bản export DB thông thường không kèm các file session này.

## Sync upstream

Nút Update now / Sync custom fork mở bảng trạng thái. API `/api/version/update` chỉ chạy script cố định, không nhận lệnh/branch/path từ request, và luôn yêu cầu xác thực dashboard.

Lệnh tương đương:

```sh
npm run fork:sync
```

Để triển khai commit sửa lỗi local mà không fetch/merge upstream hay push, dùng `npm run fork:deploy`. Lệnh này vẫn yêu cầu working tree sạch và vẫn build riêng, health-check, restart HTTP child và rollback nếu lỗi.

Luồng chạy:

1. Khóa cập nhật, kiểm tra working tree sạch và supervisor đang hoạt động.
2. Thêm upstream `decolua/9router` nếu chưa có; fetch rồi merge `upstream/master` vào nhánh hiện tại.
3. Conflict: ghi danh sách file, abort merge, giữ server cũ.
4. Đóng gói HEAD bằng Git archive vào release riêng. Cài dependencies và build tại đó; cả build worker và health probe dùng DATA_DIR tạm.
5. Build/health lỗi: giữ release/server cũ. Merge thành công vẫn ở local để có thể sửa và kiểm tra.
6. Build/health thành công: đổi symlink `.fork/current`, gửi SIGUSR2 cho supervisor. Tray còn nguyên, HTTP child được thay.
7. Nếu release mới không lên healthy, trỏ lại release trước và yêu cầu supervisor khởi động lại nó.
8. Chỉ push `origin HEAD` sau khi release mới chạy healthy. Push lỗi có trạng thái riêng: release mới vẫn chạy; có thể chạy lại `git push origin HEAD`.

Log: `DATA_DIR/logs/sync-upstream.log`. Trạng thái: `.fork/update-status.json`. Sau deploy thành công, chỉ giữ release đang chạy và release trước để rollback; không xóa backup dữ liệu. Script dùng shell/Unix signals, phù hợp máy macOS hiện tại.

Rollback ở đây khôi phục **release ứng dụng**, không tự hạ schema dữ liệu nếu upstream tương lai có migration không tương thích. Cơ chế backup trước migration hiện có của 9router vẫn được giữ.

Bảng Sync custom fork hiển thị commit đang chạy, trạng thái so với origin và upstream, cùng trạng thái cập nhật npm. Phiên bản npm có thể đi trước commit upstream/master; trạng thái so Git được hiển thị riêng.

## Kiểm thử

- Unit/mock: ranking, quota estimates, reset thresholds, grants, capacity, admin identity, transfer failures, ambiguous PUT, recovery, encryption/lock, admin-vs-OAuth API credentials.
- Integration fixture: dirty repo, conflict/abort, build failure, prepared release health check, HTTP child replacement without changing supervisor PID. Git/npm trong fixture được giả lập, không merge/push repo thật.
- Regression: reset grants, quota auto-ping và ping schedules hiện có.
- Smoke: production build; API auth, automation mặc định tắt, và UI trên cổng thử 20129 với DATA_DIR riêng.

Đã build và triển khai fork trên cổng 20128, giữ supervisor/tray và DATA_DIR hiện có. Live inspection, chuyển seat tự động và quét quota bằng seat mượn đã được xác nhận trên môi trường local. Việc merge upstream và rollback khi có migration dữ liệu vẫn cần kiểm tra theo từng bản upstream.

Kiểm tra cho PR: 101 test thuộc 13 file Claude Team/OAuth/fork pass; hai test tích hợp cần quyền mở cổng localhost (sandbox mặc định chặn listen). Production build và live Refresh data cũng đã pass trên bản đang chạy.
