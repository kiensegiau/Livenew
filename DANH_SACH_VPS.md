# 🖥️ TÀI LIỆU QUẢN LÝ HỆ THỐNG VPS & LIÊN KẾT DỊCH VỤ

> Tài liệu tổng hợp đầy đủ danh sách các máy chủ VPS, thông số phần cứng, đường dẫn quản trị Web, các link Google Apps Script (Sheet, Vượt Quota Drive, Mắt xem YouTube), Webhook Zalo và các lệnh vận hành/bảo trì nhanh.

---

## 1. CỤM MÁY CHỦ CHÍNH (HỆ THỐNG CỦA BẠN)

Cụm gồm **2 máy chủ chạy song song** (1 Master điều phối + 1 Worker phụ tải), đồng bộ chung qua Google Sheet và báo cáo về Telegram/Zalo.

### 🔹 VPS 1 — Máy Chính (Master Controller)
- **Mã Node (`id`):** `vps1`
- **Tên hiển thị:** `VPS 1 (Chính - Master)`
- **Địa chỉ IP:** `57.129.134.155`
- **Cổng dịch vụ:** `3131`
- **Link Web Quản Trị:** http://57.129.134.155:3131
- **Cấu hình phần cứng:**
  - **HĐH:** Linux VPS (Ubuntu)
  - **CPU:** Intel Core Processor (Haswell, no TSX)
  - **RAM:** `11.4 GB`
  - **Ổ cứng (Disk):** `95.8 GB`
  - **Node.js:** `v20.18.1`
- **Vai trò:**
  - Điều phối luồng tự động cho toàn cụm (`Master`).
  - Xác thực và đồng bộ tài khoản trực tiếp với Google Sheet.
  - Ghi lịch sử luồng vào tab `LICH_SU_LUONG`.
  - Nhận lệnh và gửi thông báo qua Bot Telegram & Zalo.
  - Điều phối xoay vòng (Round-Robin) các link Apps Script tạo bản sao vượt Quota Google Drive.

---

### 🔹 VPS 2 — Máy Phụ (Worker Node)
- **Mã Node (`id`):** `vps2`
- **Tên hiển thị:** `VPS 2 (Phụ - Worker)`
- **Địa chỉ IP:** `51.68.214.167`
- **Cổng dịch vụ:** `3131`
- **Link Web Quản Trị:** http://51.68.214.167:3131
- **Cấu hình phần cứng:**
  - **HĐH:** Linux VPS (Ubuntu)
  - **CPU:** Intel Core Processor (Haswell, no TSX)
  - **RAM:** `11.4 GB`
  - **Ổ cứng (Disk):** `95.8 GB`
  - **Node.js:** `v20.20.2`
- **Vai trò:**
  - Nhận luồng phân tải từ `vps1` hoặc chạy các luồng chỉ định trực tiếp trên `vps2`.
  - Chuyển tiếp thông báo trạng thái về `vps1` để gửi Telegram/Zalo tập trung.
  - Tự động dự phòng (Failover) nếu một máy trong cụm mất kết nối quá 90 giây.

---

### 🔹 Máy chủ Webhook Zalo (Thông báo nhóm Zalo)
- **Địa chỉ IP / Cổng:** `47.84.125.230:3380`
- **Endpoint gửi tin:** `http://47.84.125.230:3380/send`
- **Thread ID nhóm nhận tin:** `6868693163359042583`
- **Telegram Admin ID:** `1663554465`

---

## 2. DANH SÁCH LINK GOOGLE APPS SCRIPT (CỤM CHÍNH)

### 📊 2.1. Apps Script Quản Lý Tài Khoản & Lịch Sử Google Sheet (`google_apps_script.js`)
- **Link Web App (`/exec`):**
  ```text
  https://script.google.com/macros/s/AKfycbyIqWVPDUkgQyepOGVe-OEPQzmfeMe_j8YVfkWKTS_LBlZE-Lwd1crzdt5WPWuaXci6/exec
  ```
- **Chức năng:**
  - Xác thực tài khoản khách hàng trực tiếp từ Google Sheet (`directSheetAuth: true`).
  - Đồng bộ danh sách khách hàng (`Sync Now`).
  - Ghi lịch sử phát trực tiếp vào tab `LICH_SU_LUONG`.

### 🚀 2.2. Danh Sách Apps Script Vượt Quota Google Drive (`google_apps_script_copy.js`)
Khi file Google Drive bị giới hạn *"Rất tiếc, hiện tại bạn không thể xem hoặc tải tệp này xuống"*, hệ thống tự động xoay vòng qua 2 Script dưới đây để tạo bản sao tạm vào `LIVE_BAN_SAO_TAM`, tải về VPS và **xóa vĩnh viễn** bản sao ngay sau khi tải xong:

1. **Script Vượt Quota #1 (`…5PMBtk`):**
   ```text
   https://script.google.com/macros/s/AKfycbxEvKBNCEVl_-zPJGRObWCCxOqZL3nWCPy2uQJU5IJ1ZcDCVWIjZ2tU7Oi3sc5PMBtk/exec
   ```
2. **Script Vượt Quota #2 (`…6htBxw`):**
   ```text
   https://script.google.com/macros/s/AKfycbxMvemMZWHphW_oox8CgxCUG0BiD4LdWQXUriMBjTnu-ocWHK0HwotMBfytnrdA6htBxw/exec
   ```

### 👁️ 2.3. Apps Script Đọc Mắt Xem & Thống Kê Live YouTube
- **Link Web App (`/exec`):**
  ```text
  https://script.google.com/macros/s/AKfycbxYgYyp4MHxYQ8HoovJwywvwgLCrpETZ71Kha6L4Pzva3nvv65p95ZXQnQvzNh1GVmiLw/exec
  ```

---

## 3. VPS ĐỘC LẬP CỦA KHÁCH (KHÔNG THUỘC CỤM CHÍNH)

Máy chủ cài riêng cho khách hàng, **cách ly 100%** khỏi cụm VPS 1/VPS 2, không dùng chung Bot Telegram/Zalo và không kết nối Google Sheet của cụm chính.

### 🔹 VPS Khách #1 (`13.140.208.154`)
- **Địa chỉ IP:** `13.140.208.154`
- **Cổng dịch vụ:** `3131`
- **Link Web Quản Trị:** http://13.140.208.154:3131
- **Đăng nhập SSH:** `ssh root@13.140.208.154` (Mật khẩu `root`: `kienkaka`)
- **Đăng nhập Web Admin:**
  - **Tài khoản:** `admin`
  - **Mật khẩu:** `kienkaka`
- **Cấu hình phần cứng:**
  - **HĐH:** Ubuntu 24.04.5 LTS (Noble Numbat)
  - **CPU:** AMD EPYC Processor (with IBPB)
  - **RAM:** `23.5 GB`
  - **Ổ cứng (Disk):** `289.6 GB`
  - **Node.js:** `v20.20.2`
- **Thư mục cài đặt:** `/root/Livenew` (quản lý qua `pm2` với tên tiến trình `live-controller`, đã bật `systemd startup` tự chạy khi khởi động lại VPS).
- **Trạng thái cách ly:**
  - `cluster_nodes.json`: Chỉ chứa duy nhất `13.140.208.154` (`VPS Chính (Master)`).
  - `bot_config.json`: Đã làm trống hoàn toàn (`polling: false`, `zalo.enabled: false`, `sentinel.enabled: false`).
  - `sheet_config.json`: Dùng tài khoản cục bộ (`directSheetAuth: false`), `syncSecret` riêng (`9368f38294314bbcf6ffc3ebbac4892a`).

---

## 4. CÁC LỆNH VẬN HÀNH & BẢO TRÌ NHANH

### 🔄 4.1. Cập nhật code mới nhất từ GitHub lên VPS

- **Trên VPS 1 / VPS 2 (thuộc cụm chính của bạn):**
  ```bash
  cd ~/Livenew && git fetch origin main && git reset --hard origin/main && pm2 restart live-controller
  ```
  *(Hoặc gọi trực tiếp qua API từ xa `POST /api/admin/update`)*

- **Trên VPS Độc Lập của khách (`13.140.208.154`):**
  > ⚠️ Lưu ý: Vì file `bot_config.json` trên Git chứa cấu hình Bot của cụm chính, khi cập nhật trên VPS khách cần sao lưu và khôi phục lại `bot_config.json` để tránh bật nhầm Bot của bạn:
  ```bash
  cd /root/Livenew && cp bot_config.json /tmp/bot_config.json.bak && git fetch origin main && git reset --hard origin/main && cp /tmp/bot_config.json.bak bot_config.json && pm2 restart live-controller
  ```

### 🩺 4.2. Kiểm tra trạng thái & nhật ký (Logs)
```bash
# Xem trạng thái tiến trình PM2
pm2 status

# Xem 50 dòng log gần nhất
pm2 logs live-controller --lines 50
```
