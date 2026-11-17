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

## C — Đồng bộ trạng thái

| # | API | Method & path | Quyền | Tham số / kết quả |
|---|---|---|---|---|
| 16 | sync_device | `POST /devices/{device_id}/sync` | Thiết bị của phiên hiện tại (khác → `1009`) | Gửi mỗi `interval_ms` (**1 giây** khi ở trong phòng, 3 giây khi không): `camera_facing` (`front\|back`), `is_recording`, `battery_level` (0–100, -1 nếu không đọc được), `free_storage_bytes`, `resolution`, `fps`, `acks[{command_id, status: done\|failed}]`. Trả `server_time_ms, interval_ms, room{room_id, room_name, member_id} \| null, last_left_reason` (`kicked\|closed\|left\|logout`), `recording` (trạng thái quay của phòng), `commands[]` (lệnh chưa ACK) |
| 17 | sync_room | `GET /rooms/{room_id}/sync` | Chủ phòng (`1009` / `2004`), phòng đóng → `2005` | `room_id, room_name, invite_code, expires_at, max_members, server_time_ms, total, online, recording`, `members[]` (như get_room_members, mỗi máy có thêm `last_seen_at`, `state{camera_facing, is_recording, battery_level, free_storage_bytes, resolution, fps, updated_at}` và `last_command{type, status: pending\|done\|failed}`) |
| 18 | start_recording | `POST /rooms/{room_id}/recording/start` | Chủ phòng | `client_command_id` (bắt buộc, sinh mới cho mỗi lần bấm). Tạo phiên quay `rs_…` và lệnh hẹn giờ `execute_at = now + 2,5 s`. Trả `recording_session_id, command_id, execute_at_ms, server_time_ms, total_devices`. Lỗi: `1010` lệnh trùng (kèm kết quả cũ; coi như thành công), `2006` phòng đang quay, `9994` phòng chưa có máy |
| 19 | stop_recording | `POST /rooms/{room_id}/recording/stop` | Chủ phòng | `client_command_id`. Lệnh dừng hẹn `now + 1,5 s`. Trả thêm `duration_ms`. `2006` nếu phòng không quay |
| + | switch_camera | `POST /rooms/{room_id}/members/{member_id}/camera` | Chủ phòng | `camera_facing, client_command_id`. Lệnh riêng cho một máy; `2006` khi đang quay. Mở rộng cho chức năng "Controller điều khiển việc lật camera" (đề bài không có API riêng) |

### Cơ chế Start/Stop đồng bộ

1. Controller gọi start_recording. Server lưu phiên quay và một lệnh chung cho cả phòng, hẹn giờ thực hiện `execute_at`.
2. Mỗi Remote sync 1 giây/lần và nhận lệnh. Từ `server_time_ms` của các lần sync, Remote ước lượng lệch đồng hồ so với server (giữ mẫu có độ trễ mạng thấp nhất, xem `ClockSync` trong `packages/shared/src/client.ts`), rồi đổi `execute_at_ms` sang giờ máy mình và bắt đầu quay đúng lúc đó.
3. Remote gửi ACK ở lần sync kế tiếp; Controller thấy "đã thực hiện / chờ máy nhận / thất bại" trên từng ô camera.
4. **Tự khớp trạng thái:** `sync_device` luôn trả `recording` của phòng. Máy lỡ lệnh (mất mạng, vào phòng muộn) sẽ tự bắt đầu quay sau giờ hẹn 1 giây. Nếu phòng đã có lệnh dừng, `recording.stop_at_ms` cho biết giờ hẹn dừng để máy dừng đúng lúc. Lệnh quá 30 giây không được giao nữa.
5. Mỗi clip lưu `recording_session_id` và `started_at_server_ms` để ghép các góc quay của cùng một buổi.

Đo bằng trình giả lập hai máy có đồng hồ lệch +3 s và −1,2 s: hai máy bắt đầu cách nhau 32 ms, dừng cách nhau 31 ms. Sai số tối đa xấp xỉ một nửa RTT khi mạng bất đối xứng.

Remote không cần gọi get_room_members để biết mình bị kick hay phòng bị đóng: `sync_device` trả `room = null` kèm `last_left_reason`.

## Video MP4 trên thiết bị

- Android (CameraX) ghi sẵn file MP4 (H.264).
- iPhone: Expo Go chỉ ghi được QuickTime `.mov`. App ép codec H.264 (`avc1`, vì HEVC không phát được trên Chrome/Windows), rồi đổi brand trong hộp `ftyp` từ `qt  ` sang `mp42`/`isom` ngay tại chỗ (không nén lại hình). Xem `packages/shared/src/mp4.ts`. Server remux lại bằng ffmpeg khi nhận file.
- Clip lưu trong thư mục riêng của app (`Documents/videos/VID_yyyyMMdd_HHmmss_nnn.mp4`), kèm ảnh thu nhỏ và `local_video_uid` để chống upload trùng.

## D — Tự động upload

| # | API | Method & path | Tham số / kết quả |
|---|---|---|---|
| 20 | init_upload | `POST /videos/uploads` | `local_video_uid` (UUID clip sinh trên máy), `file_name`, `total_size`, `checksum_sha256` (toàn file, hex), *tùy chọn* `chunk_size` (256 KB–8 MB, mặc định 5 MB), `duration_ms`, `recording_session_id`, `recorded_at_ms`, `camera_facing`, `mime_type`. Trả `upload_id, chunk_size, total_chunks, received_count, missing_chunks[], expires_at`. Clip đang upload dở thì trả lại **đúng phiên cũ** (resume). Lỗi: `3005` đã có trên server (`data.video_id`, coi như xong), `1006` > 1 GB, `3004` vượt hạn mức (tính cả phiên đang upload), `1004` `recording_session_id` không thuộc phòng mà máy từng vào |
| 21 | upload_chunk | `PUT /videos/uploads/{upload_id}/chunks/{index}` | Body nhị phân `application/octet-stream`, header `X-Chunk-Sha256`. Mảnh cuối có thể ngắn hơn. Lỗi: `3003` sai SHA-256 của mảnh (gửi lại mảnh đó), `1004` sai kích thước / sai chỉ số, `1002` thiếu header, `1007` ghi đĩa thất bại, `3001` phiên không tồn tại / hết hạn / của người khác. Gửi lại mảnh đã có thì ghi đè. Mỗi mảnh nhận được sẽ gia hạn phiên thêm 24 giờ |
| 22 | get_upload_status | `GET /videos/uploads/{upload_id}` | `missing_chunks[]`, `received_count`, `status`, `video_id` |
| 23 | complete_upload | `POST /videos/uploads/{upload_id}/complete` | *Tùy chọn* `thumbnail_base64` (JPEG ≤ 300 KB). Ghép mảnh, kiểm tra SHA-256 toàn file, remux MP4 (nếu có ffmpeg), tạo video. Trả `video_id, file_name, size_bytes, duration_ms, room_id, recording_session_id, has_thumbnail, …`. Lỗi: `3002` thiếu mảnh (`data.missing_chunks`), `3003` sai toàn file (`data.scope = "file"`, phiên bị hủy → mở phiên mới). Gọi lại sau khi đã xong thì trả cùng video |

**Phía app (`mobile/src/video/uploader.ts`):**
- Dừng quay → lưu clip → tự đưa vào hàng đợi, upload lần lượt từng clip.
- SHA-256 tính bằng `@noble/hashes`, đọc từng khối 4 MB nên không nạp cả file vào RAM.
- Mảnh nhị phân gửi bằng `expo/fetch`.
- Mỗi mảnh thử tối đa 3 lần (chờ 1 s, 2 s, 4 s); vẫn lỗi thì tạm dừng, tự thử lại khi mở lại hoặc quay lại app, hoặc khi bấm "Thử lại" trong Thư viện.
- `upload_id` và checksum lưu cùng clip nên tắt app vẫn resume được.
- `sync_device` gửi `uploads_pending` và `upload_progress` để Controller thấy tiến độ từng máy.
- Giới hạn: Expo Go không upload được khi app chạy nền, nên trong lúc upload phải để app mở.

**Phía server:** mảnh tạm ở `data/uploads/{upload_id}/`, video ở `data/videos/{video_id}.mp4` (+ `.jpg`). Phiên quá hạn được dọn mỗi 30 phút. Nếu có ffmpeg (`FFMPEG_PATH`), server remux bằng `-c copy -movflags +faststart` (không nén lại) và tự tạo ảnh thu nhỏ khi app không gửi.

## E — Thư viện video trên server

| # | API | Method & path | Quyền | Tham số / kết quả |
|---|---|---|---|---|
| 24 | get_list_videos | `GET /videos?index=&count=&room_id=&recording_session_id=&device_id=` | Controller: mọi video; Remote: chỉ video của mình | `count` 1–100 (mặc định 20). Trả `videos[], total, index, count, has_more`. Mỗi video có `camera_name, device_name, owner, recording_session_id, session_started_at, recorded_at_ms, duration_ms, size_bytes, thumbnail_url`. `index ≥ total` → `9994` (kể cả trang đầu rỗng) |
| 25 | get_video | `GET /videos/{video_id}` | như trên | Như một phần tử của danh sách + `stream_url` (link xem có hạn 1 giờ, chỉ Controller). Không thấy → `4001` |
| 26 | get_download_url | `GET /videos/{video_id}/download` | Controller (`1009`) | `download_url` (hạn 1 giờ, tải về đúng tên file), `expires_at`. Đang có lượt tải chưa xong → `4002`: client xếp hàng đợi, xin link clip kế tiếp sau |
| 27 | delete_video | `DELETE /videos/{video_id}` | Controller | Xóa bản ghi, file video và ảnh thu nhỏ. `4001` nếu không có |
| 28 | delete_videos_bulk | `POST /videos/bulk-delete` | Controller | `video_ids[]` (1–50; quá 50 → `1004`). Trả `deleted[], not_found[]`; không xóa được clip nào → `4001` |

**Link media (`/api/media/videos/{id}`, `/api/media/thumbs/{id}.jpg`):**
- Ký bằng HMAC-SHA256 (khóa `MEDIA_SECRET` hoặc `data/media.secret` sinh tự động), kèm loại link (`stream` / `download` / `thumb`), người xin link và hạn dùng.
- Đổi loại link, đổi video hoặc quá hạn → HTTP 403.
- Dùng được trực tiếp trong `<video>`, `<img>` và link tải, vì trình duyệt không gửi được header `Authorization` cho các thẻ này.
- Hỗ trợ `Range` (HTTP 206) để tua video.
- Lượt tải (`download`) được đếm cho tới khi stream đóng; đó là căn cứ để trả mã 4002.

**Xem đồng bộ nhiều góc quay (web):** các clip cùng `recording_session_id` được căn theo `recorded_at_ms` (giờ server lúc máy thực sự bắt đầu quay). Một đồng hồ chung điều khiển mọi `<video>`; video nào lệch quá 0,2 s thì được kéo về đúng vị trí. Bấm vào một khung để nghe tiếng của góc đó. Đo trên hai clip MP4 thật lệch nhau 400 ms: khi phát, độ lệch giữa hai video so với đồng hồ chung là 14 ms.

## Khác biệt nhỏ so với đề bài

| Đề bài | Ở đây | Lý do |
|---|---|---|
| `expires_in` lúc là số, lúc là chuỗi | Luôn là số | Thống nhất kiểu |
| `check_verify_code` không có thông tin thiết bị | Nhận thêm `device_*` tùy chọn | Để vào thẳng Trang chính và join phòng ngay |
| Không ghi tham số forgot_password | `email\|phone, code_verify, new_password` | Đặt lại mật khẩu trong một bước |
| Token `eyJ...` (JWT) | Token opaque `at_...`/`rt_...` | Thu hồi được ngay khi đổi mật khẩu hoặc logout |
