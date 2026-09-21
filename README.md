# Uong Bi GO on Vercel + Neon

Ứng dụng này chạy bằng HTML/CSS/JS tĩnh trên Vercel. Các API nằm trong Vercel Function `api/[...path].js`; dữ liệu nằm ở Neon Postgres, được kết nối từ Vercel Marketplace. Không cần XAMPP, PHP hoặc MySQL khi triển khai.

## 1. Tạo database trên Vercel

1. Đẩy thư mục này lên một Git repository (GitHub, GitLab hoặc Bitbucket).
2. Trong Vercel, tạo **New Project** và import repository đó. Chưa cần Deploy ngay.
3. Vào **Integrations** → tìm **Neon** → Install/Create database, chọn region gần người dùng nhất.
4. Kết nối database Neon với project Vercel. Vercel sẽ tự thêm biến `DATABASE_URL`.
5. Mở Neon SQL Editor và chạy toàn bộ file [`db/schema.sql`](db/schema.sql). File này tạo schema và dữ liệu demo.

Vercel Postgres không còn cấp mới. Neon Postgres là lựa chọn Postgres serverless tích hợp chính thức qua Vercel Marketplace.

## 2. Cấu hình biến môi trường

Trong Vercel: **Project → Settings → Environment Variables**, thêm:

| Tên | Giá trị |
| --- | --- |
| `AUTH_SECRET` | Chuỗi ngẫu nhiên dài, tối thiểu 32 ký tự. Có thể tạo bằng `openssl rand -base64 48`. |
| `DATABASE_URL` | Vercel tự thêm sau khi kết nối Neon; chỉ thêm tay khi không dùng Marketplace. |

Thêm cho cả Production, Preview và Development. Không đưa `.env.local` hoặc `AUTH_SECRET` vào Git. Xem mẫu tại [`.env.example`](.env.example).

## 3. Deploy

Trong Vercel bấm **Deploy**. Sau khi xong, mở `https://<ten-project>.vercel.app/api/health`: kết quả phải là `{"ok":true}`. Sau đó mở URL gốc của project để dùng ứng dụng.

Hoặc chạy bằng CLI sau khi đã đăng nhập Vercel:

```bash
npm install
npx vercel link
npx vercel env pull .env.local
npm run dev
npm run deploy:prod
```

## 4. Tài khoản demo

| Vai trò | Email | Mật khẩu |
| --- | --- | --- |
| Quản trị | `admin@uongbigo.vn` | `Admin@123` |
| Nhân viên bếp | `bep@uongbigo.vn` | `Bep@123` |
| Sinh viên | `sv@uongbigo.vn` | `sv@123` |

Hash cũ của các tài khoản demo được nâng cấp tự động sang salted `scrypt` sau lần đăng nhập thành công đầu tiên. Hãy đổi hoặc xóa các tài khoản demo trước khi dùng thật.

## Lưu ý vận hành

- API kiểm tra token đã ký ở phía server; các endpoint admin, bếp và đơn hàng đã giới hạn theo vai trò.
- QR/thanh toán trong app là mô phỏng. Endpoint `thanhtoan/webhook` không phải tích hợp cổng thanh toán thật; cần thay bằng webhook có chữ ký của nhà cung cấp trước khi sử dụng thương mại.
- Chức năng quên mật khẩu hiện trả thông báo chưa cấu hình. Muốn chạy production cần kết nối dịch vụ email và gửi link/token đặt lại mật khẩu, không trả mật khẩu tạm thời trong API.
- Các file XAMPP/PHP/MySQL cũ đã được xóa. Database duy nhất cần dùng là Neon Postgres với schema tại [`db/schema.sql`](db/schema.sql).
