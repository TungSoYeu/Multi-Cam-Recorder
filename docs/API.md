# API

Base URL: `http://<máy chủ>:3000/api` (hoặc `https://xxxx.trycloudflare.com/api`). Body và response đều là JSON.

```json
{ "code": "1000", "message": "OK", "data": { } }
```

- Lỗi nghiệp vụ vẫn trả **HTTP 200**, phân biệt bằng `code` (bảng mã trong `packages/shared/src/codes.ts`). Lỗi do ô nhập sai thường kèm `data.field`.
- API cần đăng nhập gửi header `Authorization: Bearer <access_token>`. Token sai hoặc hết hạn trả `9998`: client gọi `refresh_token` **đúng một lần**, nếu vẫn lỗi thì về màn Đăng nhập (đã cài sẵn trong `packages/shared/src/client.ts`).
- Kiểm tra tham số: thiếu → `1002`, sai kiểu → `1003`, sai giá trị → `1004`.
- Các API `/auth/*` bị giới hạn 30 request/phút/IP (`1012`).

## A — Xác thực và tài khoản

| # | API | Method & path | Tham số | Kết quả / lỗi |
|---|---|---|---|---|
| 1 | signup | `POST /auth/signup` | `first_name, last_name, email, phone` (10 số, đầu 0), `password` (6–20 chữ/số, khác phone) | `user_id, email, phone, account_role:"remote", verify_required:"1"`. `9996` trùng email/phone. Tài khoản chưa xác thực được đăng ký lại |
| 2 | get_verify_code | `POST /auth/verify-code` | `email` **hoặc** `phone`, `purpose: signup \| forgot_password` | `expires_in:300, resend_after:120, masked_target, code_verify`. `1012` khi chưa đủ 120 giây (`data.retry_after`). `9995` không có tài khoản |
| 3 | check_verify_code | `POST /auth/verify-code/check` | `email\|phone, code_verify`; *tùy chọn* `device_id, device_type, device_name` | Kích hoạt tài khoản và trả dữ liệu như login, kèm `user_id, active:"1"`. `9993` mã sai hoặc hết hạn (khóa sau 5 lần sai) |
| 4 | login | `POST /auth/login` | `email\|phone, password, device_id` (UUID client), `device_type` (1 android, 2 ios, 4 web), `device_name` | `user, account_role, access_token, refresh_token, expires_in:3600, device{device_id, device_type, device_name, camera_name}`. `9995` không tồn tại; `9995 + verify_required:"1"` chưa xác thực; `1004 + field:"password"` sai mật khẩu |
| 5 | refresh_token | `POST /auth/refresh` | `refresh_token` | Cặp token mới. Refresh token cũ hết hiệu lực; dùng lại thì cả phiên bị thu hồi (`9998`) |
| 6 | forgot_password | `POST /auth/password/forgot` | `email\|phone, code_verify` (purpose forgot_password), `new_password` | `null`. Thu hồi mọi phiên của tài khoản |
| 7 | change_password | `PUT /auth/password` 🔒 | `password, new_password` | Token mới cho phiên hiện tại; phiên ở máy khác nhận `9998` |
| 8 | logout | `POST /auth/logout` 🔒 | | Hủy phiên hiện tại. Remote rời phòng; Controller đóng phòng (`2005`) |
| 9 | delete_account | `DELETE /users/me` 🔒 | `password` | Xóa vĩnh viễn tài khoản cùng video. Controller nhận `1009` |
| + | get_me | `GET /users/me` 🔒 | | `user, account_role, device, room_id`, dùng khôi phục giao diện (ngoài 28 API của đề bài) |

## B — Phòng và ghép nối

| # | API | Method & path | Quyền | Tham số / kết quả |
|---|---|---|---|---|
| 10 | create_room | `POST /rooms` | Controller (`1009`) | `room_name?, max_members?` (mặc định 8). Trả `room_id, room_name, invite_code, max_members, expires_at, created_at, members[]`. Đã có phòng mở thì trả lại phòng đó; nếu mã đã hết hạn thì cấp mã mới |
| 11 | join_room | `POST /rooms/join` | Remote | `invite_code` (6 ký tự, không phân biệt hoa thường), `device_id` (= `device.device_id` lúc login), `camera_name`, `grant_control:true` (bắt buộc). Lỗi: `2001` mã sai hoặc hết hạn, `2002` phòng đầy, `2003` đang ở phòng khác (`data.room_id`). Gọi lại trả cùng `member_id` |
| 12 | get_room_members | `GET /rooms/{room_id}/members` | Chủ phòng, hoặc Remote đang trong phòng | `room_id, room_name, status, total, members[{member_id, user_id, device_id, camera_name, device_name, device_type, is_online, joined_at}]`. `is_online="1"` nếu máy gọi API trong 15 giây gần nhất. Remote bị kick nhận `1009 + reason:"kicked"`; phòng đóng trả `2005` |
| 13 | kick_member | `DELETE /rooms/{room_id}/members/{member_id}` | Chủ phòng (`2004`) | |
| 14 | leave_room | `POST /rooms/{room_id}/leave` | | Remote rời phòng (gọi lặp lại vô hại). Controller gọi = đóng phòng |
| 15 | close_room | `DELETE /rooms/{room_id}` | Chủ phòng | Mọi thành viên bị đưa ra |

## C, D, E

Chưa triển khai. Gọi các route này sẽ nhận `9997`. Đường dẫn giữ đúng đề bài: `/devices/{id}/sync`, `/rooms/{id}/sync`, `/rooms/{id}/recording/start|stop`, `/videos/uploads...`, `/videos...`.

## Khác biệt nhỏ so với đề bài

| Đề bài | Ở đây | Lý do |
|---|---|---|
| `expires_in` lúc là số, lúc là chuỗi | Luôn là số | Thống nhất kiểu |
| `check_verify_code` không có thông tin thiết bị | Nhận thêm `device_*` tùy chọn | Để vào thẳng Trang chính và join phòng ngay |
| Không ghi tham số forgot_password | `email\|phone, code_verify, new_password` | Đặt lại mật khẩu trong một bước |
| Token `eyJ...` (JWT) | Token opaque `at_...`/`rt_...` | Thu hồi được ngay khi đổi mật khẩu hoặc logout |
