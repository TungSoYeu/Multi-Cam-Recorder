# Multi-Cam Recorder — BTL IT4409 (IV)

Một máy **Controller** (web trên laptop) điều khiển nhiều máy **Remote Camera** (app điện thoại) cùng quay và cùng dừng. Video tự upload lên server.

| Thư mục | Công nghệ | Vai trò |
|---|---|---|
| `server/` | Node 24 + Fastify + SQLite (`node:sqlite`, không cần cài DB) | 28 API theo slide, phục vụ luôn giao diện web |
| `web/` | React 19 + Vite | Giao diện **Controller** |
| `mobile/` | Expo SDK 58 + React Native | App **Remote** cho iPhone/Android, chạy bằng Expo Go |
| `packages/shared/` | TypeScript | Bảng mã response, kiểu dữ liệu, API client dùng chung cho web và mobile |
| `docs/` | | [API.md](docs/API.md), [DATABASE.md](docs/DATABASE.md) |

## Trạng thái

- ✅ **Tuần 1**: đăng ký, mã xác thực, đăng nhập, refresh token, tạo phòng, join phòng (kèm QR).
  Ngoài ra đã có: quên mật khẩu, đổi mật khẩu, đăng xuất, xóa tài khoản, danh sách máy, kick, rời phòng, đóng phòng (đủ nhóm A và B: 15/28 API).
- ✅ **Tuần 2**: Remote quay video MP4 (1080p, H.264), đổi camera trước/sau, thư viện clip trong app (xem, chọn nhiều để xóa), chế độ quay độc lập.
  `sync_device` / `sync_room` gửi 2 giây một lần: Controller thấy danh sách máy kèm pin, dung lượng trống, camera, độ phân giải, ON AIR/ONLINE/OFFLINE.
- ⏳ Tuần 3–5: Start/Stop đồng bộ từ Controller, upload tự động, thư viện video trên server. Bảng CSDL cho các tuần này đã có sẵn trong `server/src/db/schema.sql`.

## Chạy lần đầu (Windows, PowerShell)

Cần Node.js 24 (`node -v` ≥ 24.3) và trên điện thoại cài **Expo Go** (bản hỗ trợ SDK 58).

```powershell
cd D:\web\multicam
npm install
Copy-Item server\.env.example server\.env   # sửa CONTROLLER_PASSWORD nếu muốn
npm start                                   # build web + chạy server ở cổng 3000
```

- Mở http://localhost:3000 và đăng nhập Controller bằng `CONTROLLER_EMAIL` / `CONTROLLER_PASSWORD` trong `server/.env`.
  Tài khoản Controller được tạo tự động lần đầu server chạy.
- Khi đang phát triển web: chạy `npm run dev:server` và `npm run dev:web` (http://localhost:5173, có hot reload).

### Chạy app Remote trên điện thoại

```powershell
npm run dev:mobile
```

Dùng Camera iPhone (hoặc Expo Go trên Android) quét QR hiện trong terminal. Trong app, bấm **Máy chủ** ở cuối màn Đăng nhập rồi nhập:

- Cùng Wi-Fi: IP LAN của laptop, ví dụ `192.168.1.10:3000` (server in ra dòng `LAN:` khi khởi động). Cần mở cổng TCP 3000 trên Windows Firewall.
- 3G/4G: URL tunnel, xem mục dưới.

Nếu điện thoại không cùng mạng với laptop, Metro cũng cần chạy qua tunnel: `npm run start:tunnel -w @multicam/mobile`.

## Demo qua 3G/4G (bắt buộc khi bảo vệ)

Server chạy trên laptop, mở ra Internet bằng Cloudflare Tunnel (miễn phí, không cần tài khoản):

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:3000
```

Lệnh in ra một URL dạng `https://xxxx.trycloudflare.com`:
- Controller mở URL đó trên trình duyệt (hoặc vẫn dùng localhost).
- Trong app Remote: **Máy chủ** → nhập `xxxx.trycloudflare.com` → **Kiểm tra & lưu**.

Mỗi lần chạy lại cloudflared, URL sẽ đổi. Muốn URL cố định thì dùng named tunnel hoặc VPS.

## Kiểm tra

```powershell
npm test          # 24 test: auth, phòng, sync, chuẩn hóa MP4
npm run typecheck # shared, server, web, mobile
```

## Luồng tuần 1 để demo

1. Web: đăng nhập Controller → phòng tự mở, hiện mã 6 ký tự và QR (hết hạn sau 10 phút, bấm tạo mã mới).
2. App: Đăng ký → nhập mã xác minh (server trả mã luôn theo slide, app hiện sẵn, chạm để điền) → vào thẳng Trang chính.
3. App: **Quét mã QR** hoặc nhập mã → đặt tên camera → bật đồng ý cấp quyền điều khiển → **Tham gia phòng**.
4. Web: ô camera mới xuất hiện trong khoảng 2 giây, có trạng thái ONLINE/OFFLINE. Có thể kick máy hoặc đóng phòng.
   App sẽ nhận thông báo "bị loại" hoặc "phòng đã đóng".

## Quyết định thiết kế

- **Một tunnel cho cả web và API**: server phục vụ `web/dist` ở `/` và API ở `/api`.
- **Luôn HTTP 200 + `code`** cho lỗi nghiệp vụ, theo bảng mã response của slide. Route sai trả HTTP 404 kèm mã `9997`.
- **Token opaque** (không phải JWT): chỉ lưu SHA-256 trong DB nên thu hồi được ngay (logout, đổi mật khẩu). Refresh token dùng một lần; dùng lại token cũ thì cả phiên bị thu hồi.
- **Mật khẩu** theo slide signup: 6–20 ký tự, chỉ chữ và số, không trùng số điện thoại. Lưu bằng scrypt.
- **Polling** (Controller 2 giây, Remote 3 giây) thay cho WebSocket, đúng với nhóm API `sync_*` của slide.
- **Expo Go, không cần Mac**: chỉ dùng module có sẵn trong Expo Go (camera, file-system, battery, video, video-thumbnails, keep-awake).
  iPhone ghi QuickTime nên app ép H.264 và đổi header `ftyp` sang MP4 ngay trên máy (không nén lại). Chi tiết ở [docs/API.md](docs/API.md#video-mp4-trên-thiết-bị-tuần-2).
- **Tab Phòng luôn được giữ trong bộ nhớ** để camera sẵn sàng nhận lệnh, và chuyển tab không làm ngắt clip đang quay.

## Kiểm thử tuần 2 trên điện thoại

1. Vào phòng → màn camera hiện banner đỏ "Đang được điều khiển từ xa". Quay 5–10 giây, đổi camera, quay tiếp.
2. Tab **Thư viện**: clip có ảnh thu nhỏ, thời lượng, dung lượng; chạm để xem (có tiếng), giữ lâu để chọn và xóa.
3. Web Controller: ô của máy hiện pin, dung lượng trống, camera trước/sau, và **ON AIR** khi máy đang quay.
4. Chép một clip từ iPhone sang máy tính (AirDrop), mở bằng VLC hoặc Chrome để kiểm tra đúng MP4, có cả hình lẫn tiếng.
