# Claude Team: kiểm tra API trước triển khai

Ngày: 2026-10-22. Chỉ thực hiện GET và đọc SQLite ở chế độ read-only.
Credential lấy từ `/tmp/ct-sk.txt` và account OAuth hiện có; không lưu credential trong báo cáo.

## Kết quả

| API | Xác thực | Kết quả |
| --- | --- | --- |
| `GET https://claude.ai/api/account` | Session web | 200; engineering@masterybilliards.vn, role primary_owner trong Team |
| `GET https://claude.ai/api/organizations` | Session web | 200; có nhiều org, phải chọn bằng UUID và membership, không chỉ theo tên |
| `GET /api/organizations/{org}/subscription_details` | Session web | 200; `seat_tier_quantities`: team_standard=3, team_tier_1=3 |
| `GET /api/organizations/{org}/members/counts` | Session web | 200; 18 member, Standard=2, Premium=3, unassigned=13, pending invites=0 |
| `GET /api/organizations/{org}/members_v2?limit=100&offset=0` | Session web | 200; data[].member chứa account, role, seat_tier; pagination có has_more |
| `GET /api/organizations/{org}/usage?cedar_ember=1` | Session web | 200; quota của account đăng nhập và thông tin reset grants |
| `GET /api/organizations/{org}/subscription_details` | OAuth bearer, không có cookie | 403; endpoint không chấp nhận OAuth access token |
| `GET https://api.anthropic.com/api/oauth/profile` | OAuth bearer | 200 cho engineering, agent6 và account Gmail được kiểm tra |
| `GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1` | OAuth bearer | 200 cho engineering, agent2, agent8; 403 cho agent6 không có seat |

Các đường dẫn tương đối trong bảng thuộc `https://claude.ai`.

## Seat và phạm vi quản lý

- Một Standard đã mua đang trống; Premium không có slot trống.
- SQLite hiện có 16 connection Claude. Sau trim/lowercase tên account, 15 khớp email member trong org Team.
- `email` của các connection hiện đang null; email nằm trong `name`. Agent11/12 có khoảng trắng đầu tên.
- Account Gmail còn lại có OAuth profile thuộc org `claude_free` riêng; không tham gia rotate Team này.
- Có 3 member org không khớp connection trong 9router; 2 người trong số đó giữ Standard. Không đổi seat của họ, nhưng vẫn tính seat họ đang dùng vào sức chứa toàn org.
- Khi triển khai phải xác minh identity/org bằng profile thay vì chỉ tin tên connection có thể được sửa.

## Quota và reset

Snapshot phần trăm còn lại tại lúc kiểm tra:

| Account | 5h | Weekly | Fable | Lượt reset còn |
| --- | ---: | ---: | ---: | ---: |
| engineering | 79 | 61 | 61 | 0 |
| agent2 | 84 | 30 | 25 | 0 |
| agent8 | 90 | 56 | 51 | 0 |

- Fable nằm trong `limits[]`, kind=`weekly_scoped`, scope.model.display_name=`Fable`; percent là phần trăm đã dùng.
- Metadata reset nằm trong `cedar_ember`; query `cedar_ember=1` trả thông tin này cho cả web và OAuth trong các lần thử.
- Grant hiển thị của cả ba account đã hết lượt; ends_at là 2026-10-22T16:00:00Z (23:00 giờ Việt Nam). Không được suy rộng rằng mọi member đều hết lượt.
- Profile agent6 đọc được khi không có seat, nhưng quota bị từ chối. Phải lưu snapshot quota trước khi bỏ seat và đánh dấu quota dự đoán khác quota đo thực tế.
- Trong dữ liệu này, grant.clears có `seven_day_overage_included`, không ghi chữ Fable. Việc reset xóa Fable dựa trên kiểm nghiệm trước của người dùng; sau reset vẫn phải đọc lại để xác nhận.

## Xác thực và giới hạn kiểm tra

- Session mới hoạt động với cookie sessionKey/sessionKeyV3 và bộ header trình duyệt phù hợp; không cần đưa toàn bộ cookie từ cURL cũ vào source.
- Khi rút gọn sang User-Agent chung, các API org trả 403 HTML. Khôi phục bộ header đã thành công thì trả 200. Đây là quan sát, chưa xác định header cụ thể gây khác biệt.
- OAuth của admin không thay thế session web cho API quản trị. UI cần chọn account admin và nhập/thay session web riêng; xác minh hai identity trùng nhau trước khi bật.
- Chưa gọi PUT đổi seat hoặc POST dùng reset; chưa kiểm chứng rollback, độ trễ áp dụng seat hoặc khả năng mua seat tự động của endpoint gán seat.
- HAR trước đó ghi nhận PUT member với seat_tier=`unassigned` và `team_tier_1` trả 200. Đây là bằng chứng từ HAR, không phải thử thay đổi live trong lượt kiểm tra này.
- Chưa sửa code ứng dụng, refresh OAuth token, bật/tắt connection, đổi seat hoặc tiêu lượt reset.
