# Multi-Cam Recorder

Bài tập lớn môn IT4409.

Ứng dụng cho phép một máy Controller điều khiển nhiều điện thoại (máy Remote) cùng bắt đầu và cùng dừng quay video.
Controller là trang web chạy trên laptop, laptop này cũng là server. Remote là app React Native.

## Cấu trúc

- `server/`: API, Node.js 24, Fastify, SQLite
- `web/`: giao diện Controller, React và Vite
- `mobile/`: app Remote, Expo SDK 58
- `packages/shared/`: kiểu dữ liệu, bảng mã lỗi và API client dùng chung

## Chạy

Cần Node.js 24.3 trở lên. Chép `server/.env.example` thành `server/.env` và đặt `CONTROLLER_PASSWORD`.

```
npm install
npm start
npm run dev:mobile
```

## Kiểm thử

```
npm test
npm run typecheck
```
