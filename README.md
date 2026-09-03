# Học tiếng Anh cùng Rốt

Phiên bản 4.5.9.

- Đăng nhập bằng Gmail/email hoặc tên đăng nhập trong một ô.
- Avatar cà rốt trên thanh điều hướng.
- Gợi ý từ khi nhập.
- Bấm một từ trong kho để mở nghĩa và toàn bộ chi tiết ngay bên dưới chính từ đó.
- Thêm từ không bị phụ thuộc hoàn toàn vào dịch vụ tra cứu: nếu từ điển tạm thời lỗi, từ vẫn có thể được lưu với thông tin tối thiểu.
- Lưu từ ưu tiên RPC `save_user_vocab`, có fallback RLS-protected upsert cho deployment cũ/chưa refresh schema cache.
- Tự retry một lần cho lỗi mạng tạm thời.
- Không đưa `.env.local` hoặc `node_modules` vào source control.

## Biến môi trường

`VITE_SUPABASE_URL` và `VITE_SUPABASE_ANON_KEY` (Publishable key) phải được cấu hình ở môi trường deploy.
