# Hướng dẫn cho thành viên

## Cài đặt lần đầu

1. Cài Node.js 24.3 trở lên và Git.
2. Clone repo rồi chạy:

   ```
   npm install
   npm test
   ```

3. Chép `server/.env.example` thành `server/.env` và đặt `CONTROLLER_PASSWORD` (6-20 chữ và số). Không commit file `.env`.
4. Chạy thử bằng `npm run demo`, xem thêm trong [README](README.md).

## Nhánh

- `main`: bản ổn định, dùng để demo.
- `dev`: nơi gộp các phần đã làm xong.
- `feat/...`, `fix/...`, `docs/...`: mỗi việc một nhánh, tách từ `dev`.

Không push thẳng lên `main` và `dev`. Các nhánh `feat/` ban đầu đánh dấu lại từng chức năng trong lịch sử, việc mới thì tạo nhánh mới.

## Làm một việc

```
git switch dev
git pull
git switch -c fix/ten-viec
```

Sửa xong, kiểm tra trước khi commit:

```
npm run format
npm run typecheck
npm test
```

Rồi push nhánh và mở pull request vào `dev`. CI phải xanh mới gộp. Khi `dev` chạy ổn thì mở pull request từ `dev` vào `main`.

## Commit

Viết tiếng Anh, theo mẫu `loại: mô tả ngắn`, ví dụ:

```
feat: add QR code zoom on controller
fix: resume upload after network change
docs: update API reference
```

Loại thường dùng: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.

## Sửa ở đâu

| Việc | Thư mục |
| --- | --- |
| API, CSDL | `server/src/modules`, `server/src/db` |
| Giao diện Controller | `web/src` |
| App Remote | `mobile/src` |
| Kiểu dữ liệu, mã lỗi, API client | `packages/shared/src` |

Đổi API thì sửa cùng lúc kiểu dữ liệu trong `packages/shared`, tài liệu [docs/API.md](docs/API.md) và test. Đổi bảng thì thêm một bước vào `MIGRATIONS` trong `server/src/db/database.ts`, không sửa `schema.sql` hay các bước cũ.

App chạy trong Expo Go nên chỉ thêm thư viện Expo Go có sẵn, cài bằng `npx expo install` trong thư mục `mobile`.
