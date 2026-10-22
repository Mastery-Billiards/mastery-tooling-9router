# Tóm tắt yêu cầu: trang Claude Team và sync fork

- Ngày: 2026-10-22
- Nhánh: `taivtse/Rotation-Tracker`
- Trạng thái: **chưa có code nào được viết.** File này chưa được commit.

## 1. Yêu cầu của bạn

### 1.1 Yêu cầu ban đầu: trang Claude Team (CT), nằm dưới Quota Tracker

1. Admin settings: chọn account admin có quyền đổi seat của member.
2. Danh sách member, hiển thị giống Quota Tracker.
3. Khi một member hết quota (5h, weekly, Fable): bỏ seat của member đó, rồi chuyển seat cho member khác có khả năng đã được reset. Ưu tiên member còn nhiều quota nhất.
4. Chỉ chuyển seat giữa các member, **không bao giờ mua thêm seat**.
5. Member mới thêm vào 9router được ưu tiên nhận seat.
6. Sau khi chuyển seat thì kiểm tra member mới còn quota. Nếu không còn thì tìm member tiếp theo. Chọn member reset sớm nhất và tốt nhất.
7. Nếu tất cả member đều hết quota thì hẹn một job để chuyển seat ngay khi có member được reset.
8. Không đụng tới các tính năng hiện có của 9router.
9. Check quota từng account, giống Quota Tracker.
10. Lưu lịch sử chuyển seat.
11. Màu khác nhau theo trạng thái quota, và bộ sắp xếp theo thứ tự member sẽ được chọn.

UI: Chia rõ ba phần: admin settings (số seat, loại seat, số member), account đang có seat, account không có seat.

Rule: không đổi core của 9router, và member mới nhận seat phải được bật để dùng được ngay.

### 1.2 Thêm trong lúc trao đổi

- Rotate sớm hơn lúc chạm 100% một chút. Ưu tiên member còn Fable, có trọng số cho Fable và weekly.
- Dùng lượt "Reset limit" khi weekly gần hết để member giữ seat. Bạn đã thử: lượt reset có xóa cả Fable.
- Tự gán seat đã trả tiền nhưng đang trống.
- Cả 15 account trong 9router đều được rotate (đều dùng để proxy). Không đụng tới member ngoài 9router.

## 2. Sync fork: phần đã chốt

### 2.1 Mục tiêu

Khi upstream `decolua/9router` có bản mới: đưa bản đó vào fork, build, rồi chạy lại bản custom mà không mất code custom.

### 2.2 Hiện trạng

- `origin` = `Mastery-Billiards/mastery-tooling-9router`. Chưa có remote `upstream`. Các lần trước đều merge tay.
- Phần check update (`src/app/api/version/route.js`) chỉ so số version của package `9router` trên npm.
- Nút "Update now" (`src/shared/components/Sidebar.js`) copy lệnh `npm i -g 9router@latest` rồi tắt server. Lệnh đó cài bản upstream và **làm mất code custom**.

### 2.3 Cách làm

1. **Script mới `scripts/sync-upstream.sh`**, chạy trong thư mục repo đang chạy server:
   1. Có thay đổi chưa commit thì dừng.
   2. Thêm remote `upstream` nếu chưa có, rồi `git fetch upstream`.
   3. `git merge upstream/master` vào nhánh hiện tại.
   4. Nếu bị conflict: `git merge --abort`, ghi danh sách file conflict vào log, rồi dừng. Server cũ vẫn chạy.
   5. `npm install`.
   6. Build vào một thư mục tạm. Build lỗi thì dừng, server cũ vẫn chạy.
   7. Build xong mới tắt server cũ, thay bản build, rồi chạy lại với cùng `.env`.
   8. Push lên `origin`.
   9. Ghi log vào `~/.9router/logs/sync-upstream.log`.
2. **Dashboard:** nút Update chạy script trên, thay cho lệnh `npm i -g`. Nút hiện trạng thái: đang chạy, conflict (kèm danh sách file), build lỗi, hoặc xong.
3. **Bảo mật:** API mới nằm sau lớp đăng nhập dashboard có sẵn (`src/dashboardGuard.js`). API chỉ chạy một script cố định và không nhận tham số nào từ request.

### 2.4 Lựa chọn của mình (bạn kiểm tra giúp)

- Chạy từ thư mục repo, không dùng CLI `9router` cài từ npm.
- Build trước, sau đó mới restart, để server chỉ tắt vài giây. 15 agent đang proxy qua 9router.
- Dùng merge, không rebase, giống lịch sử repo.
- Chỉ push sau khi build thành công.
- Gặp conflict thì không tự sửa.

### 2.5 Giới hạn đã biết

- npm đôi khi có version mới trước khi `upstream/master` có commit tương ứng. Khi đó merge không có gì mới và banner "New version available" vẫn hiện, tới lần upstream tiếp theo.

## 3. Những điều mình thấy, cần bạn trả lời trước khi code

1. **Server đang chạy trên port 20128 là bản cài từ npm**, không phải bản chạy từ repo:
   - Lệnh đang chạy: `/usr/local/lib/node_modules/9router/cli.js --tray --skip-update`, chạy từ 15/10.
   - Như vậy có thể bản custom hiện **chưa chạy**, trừ khi bạn đã cài bản fork vào npm global.
2. **Port:**
   - `npm run start` trong repo dùng `--port 20127` (`package.json`), còn server hiện tại nghe ở 20128.
   - Mình đoán các agent đang gọi 20128, nên script phải chạy server ở 20128. Mình cần kiểm tra lại cách cờ `--port` và biến `PORT` tác động lên nhau.
3. **Checkout nào sẽ chạy server:**
   - `~/Workspace/MasteryBilliards/code/tooling/mastery-tooling-9router` đang ở nhánh `master`, chưa có `node_modules`.
   - Worktree `~/orca/workspaces/mastery-tooling-9router/Rotation-Tracker` cũng chưa có `node_modules`.
4. **Dữ liệu:** mình đoán bản npm và bản repo dùng chung DB ở `~/.9router`, nên chuyển sang bản repo sẽ không mất dữ liệu. Mình chưa kiểm tra.
