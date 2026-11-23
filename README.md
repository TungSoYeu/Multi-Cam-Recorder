# Multi-Cam Recorder

Bài tập lớn môn IT4409.

Ứng dụng cho phép một máy Controller điều khiển nhiều điện thoại (máy Remote) cùng bắt đầu và cùng dừng quay video. Video từ các điện thoại tự chuyển về server, sau đó Controller xem lại, tải về hoặc xóa.

Controller là trang web chạy trên laptop, laptop này cũng chính là server. Remote là app React Native chạy trên iPhone và Android. Vai trò gắn với tài khoản: cả hệ thống chỉ có một tài khoản Controller tạo sẵn, mọi tài khoản đăng ký từ app đều là Remote.

## Chức năng

Remote:

- đăng ký, đăng nhập, xác thực bằng mã 6 số, quên và đổi mật khẩu, xóa tài khoản
- vào phòng bằng cách nhập mã hoặc quét QR, phải đồng ý cho Controller điều khiển
- quay theo lệnh của Controller hoặc tự quay khi không ở trong phòng
- lật camera trước/sau, chọn độ phân giải
- xem lại clip trong thư viện của app

Controller:

- tạo phòng, xem danh sách máy kèm pin, dung lượng trống, camera đang dùng
- bấm REC/STOP cho tất cả máy trong phòng, lật camera từ xa, loại một máy ra khỏi phòng
- xem, tải, xóa video trên server; phát cùng lúc các góc quay của một buổi

## Công nghệ

| Phần | Dùng gì |
| --- | --- |
| `server/` | Node.js 24, Fastify, SQLite (module `node:sqlite` có sẵn trong Node) |
| `web/` | React, Vite |
| `mobile/` | React Native, Expo SDK 58 |
| `packages/shared/` | kiểu dữ liệu, bảng mã lỗi và API client dùng chung cho web và app |

Tất cả viết bằng TypeScript. Server phục vụ luôn trang web đã build nên chỉ cần mở một cổng (3000).

## Cài đặt

Cần có:

- Node.js 24.3 trở lên
- Expo Go hỗ trợ SDK 58 trên điện thoại
- ffmpeg (nên có) để chuyển video sang MP4 chuẩn và tạo ảnh thu nhỏ
- cloudflared, chỉ khi muốn mỗi điện thoại dùng 4G riêng

```
git clone https://github.com/TungSoYeu/Multi-Cam-Recorder.git
cd Multi-Cam-Recorder
npm install
```

## Chạy

Khi laptop và điện thoại chung một mạng (Wi-Fi hoặc hotspot):

```
npm run demo
```

Lệnh này build web, chạy server, chạy Metro và in ra địa chỉ cùng mã QR. Mở `http://localhost:3000` trên laptop để vào Controller, dùng điện thoại quét QR để mở app. App tự nhận địa chỉ server; muốn đổi thì bấm vào mục Máy chủ ở màn đăng nhập.

Nếu mỗi điện thoại dùng 4G riêng:

```
npm run demo:4g
```

Lần chạy đầu tiên server tự tạo tài khoản Controller, email mặc định là `controller@multicam.local`. Mật khẩu lấy từ `CONTROLLER_PASSWORD` trong `server/.env`; nếu để trống, server sinh ngẫu nhiên và in ra một lần trên terminal. Đổi lại mật khẩu bằng `npm run controller:password`.

Chạy riêng từng phần khi sửa code:

```
npm run dev:server
npm run dev:web
npm run dev:mobile
```

Các biến cấu hình (cổng, thư mục dữ liệu, SMTP để gửi mã qua email...) được chú thích trong `server/.env.example`.

## Một số phần đáng chú ý

### Đồng bộ lúc bắt đầu quay

Đề bài dùng các API `sync` theo kiểu hỏi định kỳ, nên mỗi máy nhận lệnh sớm muộn khác nhau, tối đa khoảng một giây. Để các máy vẫn bắt đầu cùng lúc, server không ra lệnh "quay ngay" mà hẹn một thời điểm sau đó 2,5 giây. Mỗi máy tự ước lượng đồng hồ của mình lệch bao nhiêu so với server (dựa vào các lần sync có độ trễ thấp nhất) rồi đổi thời điểm hẹn sang giờ của mình.

Máy nào lỡ lệnh vì mất mạng thì ở lần sync sau vẫn thấy phòng đang quay và tự quay theo. Thử với hai máy giả lập có đồng hồ lệch +3 giây và -1,2 giây, thời điểm bắt đầu cách nhau 32 ms. Điện thoại thật còn thêm thời gian khởi động camera, phần này chưa tính vào.

### Upload trong lúc quay

Lúc đang quay chưa biết file nặng bao nhiêu, nên app mở một phiên upload chưa có kích thước và gửi dần từng mảnh 1 MB mà camera đã ghi xong. Khi dừng, camera thường ghi lại phần đầu file. App so SHA-256 của từng mảnh với mảnh server đang giữ, chỉ gửi lại mảnh khác, rồi server kiểm tra SHA-256 của cả file.

Mất mạng giữa chừng thì clip vẫn nằm trong máy. Khi có mạng, app hỏi server còn thiếu mảnh nào và gửi tiếp.

### Video MP4 trên iPhone

Expo chỉ cho quay ra file `.mov` trên iPhone. Cấu trúc file MOV dùng H.264 gần giống MP4, nên app đổi phần `ftyp` ở đầu file (không nén lại hình). Nếu server có ffmpeg thì file được remux lại thành MP4 chuẩn.

### Mã xác thực

Theo đề bài, `get_verify_code` trả luôn mã trong response. Riêng tài khoản Controller thì không trả, vì nếu trả thì ai gọi được API cũng đặt lại được mật khẩu. Mã của Controller hiện trên terminal của server, hoặc gửi qua email nếu đã cấu hình SMTP.

## Kiểm thử

```
npm test
npm run typecheck
npm run format:check
```

Test server chạy với CSDL trong bộ nhớ. Test của app chạy chính phần code lưu và upload video, kết nối vào server thật, chỉ thay các module của Expo bằng bản giả lập.

## Hạn chế

- App mới kiểm tra bằng test tự động và máy giả lập, chưa thử trên điện thoại thật.
- Chạy trong Expo Go nên không upload được khi tắt màn hình hoặc chuyển sang app khác.
- Chưa gửi được mã qua SMS, chỉ có email.
- Chưa có push notification (bảng trong CSDL đã có).
- Tính SHA-256 của clip dài trên điện thoại còn chậm vì Expo không có hàm băm native theo từng phần.

## Tài liệu

- [docs/API.md](docs/API.md): 28 API của đề và 2 API thêm
- [docs/DATABASE.md](docs/DATABASE.md): sơ đồ và mô tả các bảng
- [CONTRIBUTING.md](CONTRIBUTING.md): cách chia nhánh và gửi thay đổi
