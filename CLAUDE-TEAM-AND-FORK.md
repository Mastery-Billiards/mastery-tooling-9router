# Claude Team và chạy bản custom fork

## Claude Team

Trang `/dashboard/claude-team` nằm ngay dưới Quota Tracker.

1. Chọn connection OAuth của admin; không có email hay org ID hard-code.
2. Nhập sessionKey web của cùng account, rồi Save settings. Session được mã hóa AES-256-GCM trong `DATA_DIR/claude-team`, ngoài settings/connection và response API. Khóa mã hóa nằm cùng thư mục, quyền file 0600; đây là bảo vệ dữ liệu lưu, không thay thế quyền truy cập máy chủ.
3. Discover organizations, chọn org Team, rồi Save settings.
4. Check data xác minh admin, membership, số seat đã mua và quota. Nút này không đổi seat, dùng reset hay bật/tắt connection.
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
- Không có seat: giữ snapshot, suy ra 100% riêng từng khung sau thời điểm reset. Chưa từng có snapshot được thử với ước tính 100%; đây không phải quota đã xác minh.
- Không có ứng viên sẵn sàng thì giữ seat cũ; tính lần reset có thể dùng sớm nhất và lưu nextRunAt. Scheduler kiểm tra thời gian mỗi giây và tiếp tục lịch sau restart, không cần mở trang dashboard.

### Chuyển seat và phục hồi

- Xác minh identity/org bằng OAuth profile, không chỉ tên connection. Trim/lowercase tên chỉ phục vụ đối chiếu ban đầu; không dùng để cấp quyền mutation.
- Chỉ account có trong 9router và xác minh thuộc org mới được quản lý. Member ngoài 9router vẫn được tính vào số seat đang dùng của toàn org, nhưng không bị đổi seat.
- Dùng `subscription_details.seat_tier_quantities` và `members/counts`, trừ cả pending invites; đọc lại trước mọi lần gán. Không gọi endpoint mua hay tăng số lượng seat. Chuyển đúng tier; tự lấp seat đã mua đang trống.
- Khóa worker bằng giao dịch SQLite. Trước thao tác ghi từ xa, lưu intent vào DB. PUT timeout phải đọc lại membership trước khi quyết định có thất bại hay không.
- Bỏ seat cũ rồi mới cấp seat mới. Refresh OAuth và kiểm tra quota mới; chỉ bật account mới sau khi quota đạt ngưỡng, đồng thời xóa health/model locks cũ qua hàm activation hiện có.
- Ứng viên hết quota bị bỏ seat; thử tối đa 3 ứng viên cho mỗi lần cấp seat. Trả seat về nguồn giữa các lần thử không thành công.
- Lỗi mạng không rõ kết quả để lại pending operation. Lượt chạy tiếp theo kiểm tra trạng thái thực tế, hoàn tất hoặc trả seat về nguồn. Nếu phát hiện trạng thái bị thay đổi ngoài worker, dừng và hiển thị lỗi thay vì tự ý bỏ seat đó.
- Không lặp lại POST reset có kết quả không rõ sau crash. Đọc quota để đối chiếu trước; lịch sử ghi nhận lần phục hồi.
- Lịch sử giữ 1.000 sự kiện gần nhất trong scope KV `claudeTeam`. Config, quota snapshot, lịch chạy và pending operation cũng nằm trong scope này; không đổi schema/core routing.

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

Luồng chạy:

1. Khóa cập nhật, kiểm tra working tree sạch và supervisor đang hoạt động.
2. Thêm upstream `decolua/9router` nếu chưa có; fetch rồi merge `upstream/master` vào nhánh hiện tại.
3. Conflict: ghi danh sách file, abort merge, giữ server cũ.
4. Đóng gói HEAD bằng Git archive vào release riêng. Cài dependencies và build tại đó; cả build worker và health probe dùng DATA_DIR tạm.
5. Build/health lỗi: giữ release/server cũ. Merge thành công vẫn ở local để có thể sửa và kiểm tra.
6. Build/health thành công: đổi symlink `.fork/current`, gửi SIGUSR2 cho supervisor. Tray còn nguyên, HTTP child được thay.
7. Nếu release mới không lên healthy, trỏ lại release trước và yêu cầu supervisor khởi động lại nó.
8. Chỉ push `origin HEAD` sau khi release mới chạy healthy. Push lỗi có trạng thái riêng: release mới vẫn chạy; có thể chạy lại `git push origin HEAD`.

Log: `DATA_DIR/logs/sync-upstream.log`. Trạng thái: `.fork/update-status.json`. Không tự xóa release cũ; có thể dọn sau khi đã xác nhận không cần rollback. Script dùng shell/Unix signals, phù hợp máy macOS hiện tại.

Rollback ở đây khôi phục **release ứng dụng**, không tự hạ schema dữ liệu nếu upstream tương lai có migration không tương thích. Cơ chế backup trước migration hiện có của 9router vẫn được giữ.

Banner version vẫn so phiên bản npm upstream; có thể còn hiện nếu npm mới hơn commit upstream/master.

## Kiểm thử

- Unit/mock: ranking, quota estimates, reset thresholds, grants, capacity, admin identity, transfer failures, ambiguous PUT, recovery, encryption/lock, admin-vs-OAuth API credentials.
- Integration fixture: dirty repo, conflict/abort, build failure, prepared release health check, HTTP child replacement without changing supervisor PID. Git/npm trong fixture được giả lập, không merge/push repo thật.
- Regression: reset grants, quota auto-ping và ping schedules hiện có.
- Smoke: production build; API auth, automation mặc định tắt, và UI trên cổng thử 20129 với DATA_DIR riêng.

Chưa thực hiện đổi seat/reset thật, sync/merge/push thật hoặc thay server đang phục vụ cổng 20128 trong lúc triển khai code.
