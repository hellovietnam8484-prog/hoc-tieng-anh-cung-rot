## v4.5.2
- Cập nhật avatar cà rốt trên thanh điều hướng.
- Đăng nhập bằng một ô: Gmail/email hoặc tên đăng nhập.
- Hiển thị lỗi rate limit email rõ ràng và chống gửi đăng ký liên tiếp trong 30 giây.
- Hoàn thiện avatar cà rốt mới trên thanh điều hướng và sửa tiêu đề trang.
- Giữ chủ đề, số lần ôn và thời điểm học khi thêm lại một từ đã có.
- Cải thiện sinh câu hỏi ôn tập, tránh đáp án trùng và xử lý từ có ký tự đặc biệt.

# Học tiếng Anh cùng Rốt

Phiên bản giao diện tối giản: giữ lại nhận diện cà rốt và tông màu cam, các chức năng/nội dung cũ đã được xóa.

## Chạy

```bash
npm install
npm run dev
```


### Kho từ không giới hạn
Ứng dụng không đặt giới hạn số lần thêm từ hoặc số lượng từ trong kho. Khi tải dữ liệu từ Supabase, ứng dụng tự phân trang để vượt qua giới hạn 1.000 bản ghi của một lần truy vấn.
