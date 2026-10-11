# 📖 HƯỚNG DẪN DÙNG THẲNG GOOGLE SHEET XÁC THỰC TÀI KHOẢN KHÁCH HÀNG

Hệ thống cho phép bạn quản lý tài khoản khách hàng hoàn toàn trên **Google Sheets** (mở trên điện thoại hoặc máy tính). Khách hàng khi đăng nhập trên Web Dashboard sẽ được **xác thực trực tiếp thời gian thực (Real-Time)** lên Google Sheet!

---

## ⚡ CÁCH 1: DÙNG THẲNG LINK GOOGLE SHEET (Nhanh Nhất - 30 Giây)
> Không cần cài đặt Apps Script, chỉ cần dán link trang tính Google Sheets vào Dashboard!

### Bước 1: Mở Google Sheet mới
1. Truy cập [sheets.new](https://sheets.new) để tạo 1 bảng tính mới.
2. Đổi tên sheet bên dưới thành: `DANH_SACH_KHACH_HANG`.
3. Copy toàn bộ bảng mẫu bên dưới và dán vào ô **A1**:

| Username | Password | Tên Khách Hàng | Số Luồng Tối Đa | Ngày Hết Hạn | Server Được Dùng | Trạng Thái | Quyền Hạn | Ghi Chú |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `admin` | `<mật khẩu admin của bạn>` | Quản Trị Viên (Admin) | 999 | Vĩnh viễn | All | Active | admin | Tài khoản gốc |
| `khach1` | `123456` | Anh Nam (Zalo 0912...) | 3 | 2026-12-31 | All | Active | user | Gói 3 luồng |
| `khach2` | `654321` | Chị Linh Shop Live | 5 | 2026-11-15 | vps1 | Active | user | Gói 5 luồng VPS 1 |
| `khach3` | `pass888` | Team Marketing | 2 | 2026-10-30 | vps2 | Active | user | Gói 2 luồng VPS 2 |
| `khach_khoa` | `123456` | Tài Khoản Tạm Dừng | 1 | 2026-05-01 | All | Inactive | user | Tạm khóa do hết hạn |

### Bước 2: Bật quyền xem cho liên kết
1. Nhấn nút **Chia sẻ (Share)** màu xanh ở góc trên bên phải Google Sheet.
2. Tại mục *Quyền truy cập chung*, chuyển từ "Hạn chế" sang **"Bất kỳ ai có đường liên kết"** (Quyền: Người xem).
3. Nhấn **Sao chép đường liên kết** (Copy link).

### Bước 3: Dán link vào Web Dashboard
1. Mở Web Dashboard trên trình duyệt (`http://57.129.134.155:3131`).
2. Đăng nhập tài khoản Admin (`admin` / `<mật khẩu admin của bạn>`).
3. Nhấn nút **👥 QUẢN LÝ KHÁCH HÀNG** ở thanh trên cùng.
4. Dán đường link Google Sheet vừa copy vào ô **"Dán link Google Sheet hoặc Web App"**.
5. Nhấn **💾 LƯU LINK SHEET** rồi nhấn **⚡ TEST KẾT NỐI**.
6. **XONG 100%!** Kể từ bây giờ:
   - Bạn chỉ cần mở Google Sheet trên điện thoại hoặc máy tính, thêm khách mới hoặc đổi mật khẩu.
   - Khách đăng nhập vào web sẽ được máy chủ kiểm tra trực tiếp trên Google Sheet ngay lập tức!

---

## 🛡️ CÁCH 2: DÙNG APPS SCRIPT WEB APP (Bảo Mật Cao - Giữ Sheet Riêng Tư)
> Dành cho trường hợp bạn không muốn bật quyền xem công khai của Google Sheet.

### Bước 1: Dán mã Google Apps Script
1. Trên Google Sheets của bạn, nhấn menu: **Tiện ích mở rộng (Extensions)** ➜ **Apps Script**.
2. Xóa sạch mọi chữ trong khung soạn thảo, copy toàn bộ nội dung file [google_apps_script.js](file:///c:/Users/kien/Documents/Livenew/google_apps_script.js) dán vào.
3. Nhấn 💾 **Lưu dự án (Ctrl + S)**.

### Bước 2: Triển khai Ứng dụng Web (Web App)
1. Nhấn nút **Triển khai (Deploy)** màu xanh góc trên bên phải ➜ Chọn **Tùy chọn triển khai mới (New deployment)**.
2. Nhấn biểu tượng bánh răng bên cạnh *Chọn loại* ➜ Chọn **Ứng dụng web (Web App)**.
3. Cấu hình:
   - Thực thi dưới dạng (Execute as): **Tôi** (Địa chỉ Gmail của bạn)
   - Ai có quyền truy cập (Who has access): **Bất kỳ ai** (Anyone)
4. Nhấn **Triển khai (Deploy)** ➜ Cấp quyền khi được hỏi.
5. Copy **URL của ứng dụng web** (dạng `https://script.google.com/macros/s/.../exec`).

### Bước 3: Dán vào Dashboard
- Dán URL Web App vào ô cấu hình trong **👥 QUẢN LÝ KHÁCH HÀNG** ➜ Nhấn **LƯU LINK SHEET** là hoàn tất!

---

### 📌 Ghi Chú Quy Ước Các Cột Trên Sheet:
- **Username**: Tên đăng nhập (chữ liền không dấu).
- **Password**: Mật khẩu đăng nhập của khách.
- **Số Luồng Tối Đa**: Số luồng live tối đa khách được phát cùng lúc (1, 2, 3, 5, 10...).
- **Ngày Hết Hạn**: Định dạng `YYYY-MM-DD` (VD: `2026-12-31`) hoặc để `Vĩnh viễn`.
- **Server Được Dùng**: `All` (dùng cả VPS 1 và VPS 2), hoặc `vps1`, hoặc `vps2`.
- **Trạng Thái**: `Active` (hoạt động), `Inactive` hoặc `Lock` (khóa tài khoản).
