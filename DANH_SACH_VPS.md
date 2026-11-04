# 🖥️ CẨM NANG BÀN GIAO & QUẢN LÝ HỆ THỐNG VPS YOUTUBE LIVE PRO

> **Mục đích tài liệu:** Đây là tài liệu chuẩn dùng để bàn giao cho nhân viên vận hành, kỹ thuật viên hoặc trợ lý AI trong các phiên làm việc sau. Tài liệu chứa đầy đủ thông tin máy chủ, tài khoản, đường dẫn dịch vụ và hướng dẫn từng bước cho cả **Cụm VPS Chính (VPS cũ)** lẫn **VPS Độc Lập cho khách thuê riêng (VPS mới)**.

---

## 📌 PHẦN 1: PHÂN BIỆT 2 MÔ HÌNH ĐANG VẬN HÀNH

Hệ thống hiện có **2 nhóm máy chủ hoàn toàn tách biệt nhau**:

| Tiêu chí | **1. CỤM VPS CHÍNH (VPS 1 + VPS 2)** | **2. VPS ĐỘC LẬP CỦA KHÁCH (`13.140.208.154`)** |
| :--- | :--- | :--- |
| **Mục đích sử dụng** | Hệ thống chính của công ty, chạy chung nhiều tài khoản khách hàng. | Cài riêng cho 1 khách hàng thuê trọn gói 1 VPS, tách biệt 100% với cụm chính. |
| **Số lượng máy** | **2 máy kết nối thành 1 cụm:** `vps1` (Master) + `vps2` (Worker). | **1 máy duy nhất:** Tự làm `Master` độc lập, không nối với máy nào khác. |
| **Quản lý tài khoản** | Đồng bộ trực tiếp từ **Google Sheet** (`directSheetAuth: true`) + tạo trên Web. | Tạo/sửa/xóa **trực tiếp trên giao diện Web** (`users.json`), hoặc khách tự gắn Sheet riêng nếu muốn. |
| **Lịch sử phát Live** | Vừa lưu trên Web (`📜 Lịch sử`), vừa tự động ghi vào tab `LICH_SU_LUONG` trên Google Sheet. | Lưu trực tiếp trên VPS (`history.json` — tối đa 5,000 phiên / 90 ngày) và xem tại nút **📜 Lịch sử** trên Web. |
| **Thông báo Telegram/Zalo** | **Đang bật:** Báo cáo tự động về Bot Telegram & Nhóm Zalo của Admin. | **Đã tắt hoàn toàn (`bot_config.json` rỗng):** Để không báo nhầm tin của khách về máy Admin. |

---

## 🖥️ PHẦN 2: THÔNG TIN CHI TIẾT CÁC MÁY CHỦ VPS

### 2.1. CỤM MÁY CHỦ CHÍNH (HỆ THỐNG CỦA CÔNG TY)

#### 🔹 VPS 1 — Máy Chính Điều Phối (Master Controller)
- **Mã máy (`id`):** `vps1`
- **Tên hiển thị:** `VPS 1 (Chính - Master)`
- **Địa chỉ IP:** `57.129.134.155`
- **Cổng Web:** `3131`
- **Link Web Quản Trị:** http://57.129.134.155:3131
- **Cấu hình phần cứng:**
  - **HĐH:** Ubuntu Linux
  - **CPU:** `6 vCPU` — Intel Core Processor (Haswell, no TSX)
  - **RAM:** `11.4 GB`
  - **Ổ cứng (NVMe):** `95.8 GB`
  - **Node.js:** `v20.18.1`
- **Thư mục code trên VPS:** `~/Livenew` (`/home/ubuntu/Livenew` hoặc `/root/Livenew`)
- **Nhiệm vụ chính:**
  - Là cổng chính để Admin và khách hàng đăng nhập.
  - Khi khách chọn máy chủ là **`Tự động (Auto)`**, `vps1` sẽ tự động đo CPU/RAM/Số luồng giữa `vps1` và `vps2` để đẩy luồng sang máy đang rảnh hơn.
  - Đồng bộ danh sách khách hàng từ Google Sheet và ghi lịch sử phát vào tab `LICH_SU_LUONG`.
  - Gửi thông báo trạng thái luồng về Telegram & Zalo.
  - Xoay vòng (Round-Robin) các link Apps Script tạo bản sao khi Google Drive báo hết lượt tải.

#### 🔹 VPS 2 — Máy Phụ Phân Tải (Worker Node)
- **Mã máy (`id`):** `vps2`
- **Tên hiển thị:** `VPS 2 (Phụ - Worker)`
- **Địa chỉ IP:** `51.68.214.167`
- **Cổng Web:** `3131`
- **Link Web Quản Trị:** http://51.68.214.167:3131
- **Cấu hình phần cứng:**
  - **HĐH:** Ubuntu Linux
  - **CPU:** `6 vCPU` — Intel Core Processor (Haswell, no TSX)
  - **RAM:** `11.4 GB`
  - **Ổ cứng (NVMe):** `95.8 GB`
  - **Node.js:** `v20.20.2`
- **Nhiệm vụ chính:**
  - Nhận lệnh khởi chạy luồng từ `vps1` chuyển sang hoặc khi khách chọn đích danh `VPS 2`.
  - Chuyển tiếp mọi thông báo trạng thái luồng về `vps1` để gửi Telegram/Zalo tập trung.
  - Tự động tiếp quản luồng (Failover) nếu máy kia mất kết nối quá 90 giây.

#### 🔹 Máy chủ Webhook Zalo & Bot Telegram (Cụm chính)
- **Webhook Zalo:** `http://47.84.125.230:3380/send`
- **Thread ID nhóm Zalo nhận báo cáo:** `6868693163359042583`
- **Telegram Admin ID:** `1663554465`
- **Secret đồng bộ nội bộ cụm (`syncSecret`):** `DOI_SECRET_NAY_GIONG_CLUSTER_SECRET`

---

### 2.2. VPS ĐỘC LẬP CỦA KHÁCH (KHÔNG LIÊN QUAN CỤM CHÍNH)

#### 🔹 VPS Khách #1 (`13.140.208.154`)
- **Mã máy (`id`):** `vps1` (Chạy đơn lẻ 1 mình làm Master độc lập)
- **Tên hiển thị:** `VPS Chính (Master)`
- **Địa chỉ IP:** `13.140.208.154`
- **Cổng Web:** `3131`
- **Link Web Quản Trị:** http://13.140.208.154:3131
- **Thông tin đăng nhập SSH (Quyền cao nhất của kỹ thuật):**
  - **Lệnh SSH:** `ssh root@13.140.208.154`
  - **User:** `root`
  - **Mật khẩu SSH:** `kienkaka`
- **Thông tin đăng nhập Giao diện Web (Giao cho khách):**
  - **Link:** http://13.140.208.154:3131
  - **Tài khoản Admin gốc:** `admin`
  - **Mật khẩu Admin Web:** `Admin@123456`
  - **Các tài khoản phụ đang có trên Web:**
    - `uyên` (Quyền: `Khách`, Giới hạn: `10 luồng`, Hạn: `Vĩnh viễn`)
    - `khach1` / Mật khẩu: `123456` (Quyền: `Khách`, Giới hạn: `5 luồng`, Hạn: `2026-12-31`)
- **Cấu hình phần cứng:**
  - **HĐH:** Ubuntu 24.04.5 LTS (Noble Numbat)
  - **CPU:** `8 vCPU` — AMD EPYC Processor (with IBPB)
  - **RAM:** `23.5 GB` (Gấp đôi VPS 1/2)
  - **Ổ cứng (NVMe):** `289.6 GB` (Gấp 3 lần VPS 1/2 — chứa được 50–70 video nặng cùng lúc)
  - **Node.js:** `v20.20.2`
- **Thư mục cài đặt:** `/root/Livenew` (chạy dưới tiến trình `pm2` tên `live-controller`, đã cài `systemd startup` tự bật lại khi VPS khởi động lại).
- **Cấu hình cách ly (`sheet_config.json` & `bot_config.json`):**
  - `bot_config.json`: Đã làm rỗng hoàn toàn (không gửi Telegram/Zalo về máy công ty).
  - `cluster_nodes.json`: Chỉ có duy nhất IP `13.140.208.154`.
  - `syncSecret`: `9368f38294314bbcf6ffc3ebbac4892a`
  - Đã gắn sẵn **Apps Script đọc mắt xem Live YouTube** (`youtubeStatsScriptUrl`).

---

## 🔗 PHẦN 3: DANH SÁCH LINK GOOGLE APPS SCRIPT ĐANG SỬ DỤNG

### 📊 3.1. Apps Script Quản Lý Tài Khoản & Lịch Sử Google Sheet (Dành riêng cho Cụm Chính VPS 1 & 2)
- **File code gốc trong repo:** [`google_apps_script.js`](./google_apps_script.js)
- **Link Web App (`/exec`) đang chạy trên VPS 1 & 2:**
  ```text
  https://script.google.com/macros/s/AKfycbyIqWVPDUkgQyepOGVe-OEPQzmfeMe_j8YVfkWKTS_LBlZE-Lwd1crzdt5WPWuaXci6/exec
  ```
- **Chức năng:**
  1. Xác thực đăng nhập trực tiếp từ bảng tính Google Sheet.
  2. Đồng bộ danh sách khách hàng khi bấm nút **Đồng bộ ngay (`Sync Now`)** hoặc tự động mỗi 5 phút.
  3. Ghi lịch sử các luồng đang phát / đã kết thúc vào tab **`LICH_SU_LUONG`** mỗi 60 giây.

---

### 🚀 3.2. Apps Script Vượt Quota Google Drive (Khi tải video nặng bị báo "Hết lượt tải")
- **File code gốc trong repo:** [`google_apps_script_copy.js`](./google_apps_script_copy.js)
- **Cơ chế hoạt động:** Khi Google Drive chặn tải file lớn (>50MB) do hết băng thông ngày, VPS tự động gọi sang các link Script dưới đây để:
  1. Tạo 1 bản sao tạm vào thư mục `LIVE_BAN_SAO_TAM` trên Google Drive của Gmail chứa Script.
  2. VPS tải bản sao đó về ổ cứng.
  3. Ngay khi tải xong, VPS gọi lệnh `delete` để **xóa vĩnh viễn** bản sao tạm khỏi Google Drive (không tốn dung lượng Drive).
- **2 Link đang hoạt động trên Cụm Chính (VPS 1 & VPS 2):**
  1. **Script Vượt Quota #1 (`…5PMBtk`):**
     ```text
     https://script.google.com/macros/s/AKfycbxEvKBNCEVl_-zPJGRObWCCxOqZL3nWCPy2uQJU5IJ1ZcDCVWIjZ2tU7Oi3sc5PMBtk/exec
     ```
  2. **Script Vượt Quota #2 (`…6htBxw`):**
     ```text
     https://script.google.com/macros/s/AKfycbxMvemMZWHphW_oox8CgxCUG0BiD4LdWQXUriMBjTnu-ocWHK0HwotMBfytnrdA6htBxw/exec
     ```

---

### 👁️ 3.3. Apps Script Đọc Mắt Xem & Lượt Thích Live YouTube (Dùng được cho cả VPS Cũ & Mới)
- **Link Web App (`/exec`):**
  ```text
  https://script.google.com/macros/s/AKfycbxYgYyp4MHxYQ8HoovJwywvwgLCrpETZ71Kha6L4Pzva3nvv65p95ZXQnQvzNh1GVmiLw/exec
  ```
- **Chức năng:** Đọc số người đang xem trực tiếp (`viewers`), tổng lượt xem (`views`) và lượt thích (`likes`) của video YouTube mỗi 60 giây. *(Đã cài sẵn trên cả Cụm chính lẫn VPS Khách `13.140.208.154`)*.

---

## 📖 PHẦN 4: HƯỚNG DẪN SỬ DỤNG GIAO DIỆN WEB CHO NHÂN VIÊN

### 4.1. Cách tạo và quản lý tài khoản khách hàng (User)

#### Cách A — Tạo trực tiếp trên Web (Không cần dùng Google Sheet — Khuyên dùng cho VPS đơn của khách)
1. Đăng nhập Web bằng tài khoản **`admin`**.
2. Bấm nút **👥 Quản lý Khách hàng** ở thanh menu trên cùng.
3. Bấm nút **➕ Thêm Khách Hàng** (màu xanh).
4. Điền thông tin:
   - **Tên đăng nhập & Mật khẩu:** Ví dụ `khach1` / `123456`.
   - **Quyền hạn:**
     - `Khách (User)`: Chỉ nhìn thấy và điều khiển các luồng do chính họ tạo.
     - `Quản trị viên (Admin)`: Nhìn thấy toàn bộ luồng của mọi người và quản lý được hệ thống.
   - **Số luồng tối đa:** Số luồng được phép chạy cùng lúc (VD: `5`, `10`).
   - **Ngày hết hạn:** Chọn ngày hoặc để trống = `Vĩnh viễn`.
   - **Máy chủ cho phép:** Để `ALL` (Tất cả máy chủ) hoặc chọn cố định `VPS 1` / `VPS 2`.
5. Bấm **💾 LƯU THÔNG TIN KHÁCH HÀNG** -> Khách đăng nhập dùng được ngay lập tức.
6. Muốn đổi mật khẩu, nâng số luồng, khóa tạm thời hoặc xóa khách -> bấm **✏️ Sửa** hoặc **🗑️ Xóa** ngay cạnh tên khách.

#### Cách B — Quản lý qua Google Sheet (Dành cho Cụm Chính hoặc khách muốn quản lý bằng bảng tính)
Trong mục **👥 Quản lý Khách hàng** -> khung **📊 ĐỒNG BỘ TÀI KHOẢN TỪ GOOGLE SHEET**:
- **Kiểu 1 (Nhanh - Không cần cài Apps Script):**
  - Tạo 1 file Google Sheet gồm 9 cột (Dòng 1 là tiêu đề, từ Dòng 2 là dữ liệu):
    `Cột A: Tài khoản | Cột B: Mật khẩu | Cột C: Tên khách | Cột D: Số luồng | Cột E: Hạn dùng | Cột F: Máy chủ (all) | Cột G: Trạng thái (Active/Lock) | Cột H: Quyền hạn (User/Admin) | Cột I: Ghi chú`
  - Bật quyền chia sẻ file Sheet: **"Bất kỳ ai có đường liên kết đều có thể xem"**.
  - Copy nguyên đường link Google Sheet trên trình duyệt dán vào ô URL trên Web -> bấm **Lưu & Kiểm tra** -> bấm **🔄 Đồng bộ ngay**.
- **Kiểu 2 (Bảo mật cao + Tự ghi Lịch sử luồng):**
  - Bấm nút **📜 Xem Mã Apps Script** trên Web -> copy mã dán vào `https://script.google.com` -> Triển khai dạng **Ứng dụng web** (*Thực thi dưới tên: Tôi*, *Ai có quyền truy cập: Bất kỳ ai*) -> lấy link `.../exec` dán vào ô URL trên Web.
- ⚠️ **Lưu ý quan trọng khi bật đồng bộ Google Sheet:**
  - Tài khoản `admin` gốc luôn được bảo vệ, không bao giờ bị khóa hay mất.
  - Tuy nhiên, khi đã gắn link Google Sheet và bấm Đồng bộ, các tài khoản khách (`User`) nào tạo tay trên Web mà **chưa có tên trong bảng Google Sheet** sẽ tự động bị chuyển sang trạng thái **Bị khóa 🛑**. Do đó nếu chuyển sang dùng Sheet thì hãy nhập tên các tài khoản cần dùng vào Sheet.

---

### 4.2. Cách tạo luồng phát Live YouTube
1. Chuẩn bị video:
   - Nếu lấy từ **Google Drive**: Chuột phải vào file video trên Drive -> Chia sẻ -> **"Bất kỳ ai có đường liên kết" (Anyone with the link)** -> Copy liên kết.
2. Trên giao diện Web:
   - **Tên gợi nhớ:** Đặt tên luồng để dễ quản lý (VD: `Kênh Nhạc Chill #1`).
   - **Khóa luồng (Stream Key):** Dán mã Stream Key lấy từ YouTube Studio (không được trùng với luồng đang chạy).
   - **Nguồn Video:** Dán link Google Drive (hoặc đường dẫn file trên VPS).
   - **Link Video YouTube (Tùy chọn):** Dán link buổi phát trực tiếp (`https://www.youtube.com/watch?v=...`) nếu muốn hiện số mắt đang xem trực tiếp trên thẻ luồng.
   - **Chế độ phát:**
     - `Lặp vô hạn (Loop 24/7)`: Phát lặp đi lặp lại liên tục; nếu điền thêm ô **Giới hạn thời gian (phút)** thì hết số phút đó luồng sẽ tự động dừng.
     - `Phát 1 lần (Once)`: Phát hết video 1 lượt rồi tự kết thúc.
     - `Hẹn giờ phát (Scheduled)`: Chọn ngày giờ bắt đầu phát (theo giờ Việt Nam `GMT+7`). Hệ thống sẽ tải sẵn video về ổ cứng trước và đúng giây hẹn sẽ tự động đẩy luồng lên YouTube.
   - **Phát song song 2 máy chủ A+B (`Dual Stream`):** Khuyên **BẬT** để đẩy cùng lúc lên cả máy chủ chính (`a.rtmp.youtube.com`) và máy chủ dự phòng (`b.rtmp.youtube.com`), chống rớt luồng khi 1 đường mạng quốc tế bị nghẽn.

---

### 4.3. Cách xem Lịch sử phát & Kiểm tra sức khỏe hệ thống
- **Xem lịch sử (`📜 Lịch sử`):**
  - Bấm nút **📜 Lịch sử** trên thanh công cụ để xem 5,000 phiên phát gần nhất (lưu trong `history.json` trên VPS trong 90 ngày).
  - Admin thấy toàn bộ lịch sử của mọi tài khoản; khách thường chỉ thấy lịch sử của riêng họ.
- **Kiểm tra sâu hệ thống (`🩺 KIỂM TRA SÂU HỆ THỐNG`):**
  - Mở **👥 Quản lý Khách hàng** -> kéo xuống khung **🩺 KIỂM TRA SÂU HỆ THỐNG**:
    - Bấm **⚡ Kiểm tra nhanh:** Xem tình trạng CPU, RAM, ổ cứng, FFmpeg, đồng bộ code giữa các máy.
    - Bấm **🧪 Tự kiểm tra đầy đủ (`Selftest`):** Hệ thống tự test render thử video 720p, test đẩy 2 nhánh A+B, đo tốc độ đọc/ghi ổ cứng và đo ping tới YouTube RTMP / Google Drive mà **không làm ảnh hưởng các luồng đang phát**.

---

### 4.4. Cách thêm thêm Gmail phụ để Vượt Quota Google Drive (Khi tải nhiều file nặng)
Nếu tải quá nhiều file nặng trong ngày khiến các Script vượt quota hiện tại báo hết hạn ngạch của Google, nhân viên làm theo 5 bước sau để thêm 1 Gmail mới:
1. Mở **👥 Quản lý Khách hàng** -> tìm khung **APPS SCRIPT TẠO BẢN SAO (VƯỢT QUOTA DRIVE)** -> bấm **📜 Sao chép code**.
2. Dùng 1 tài khoản Gmail còn trống dung lượng Drive, vào https://script.google.com -> **Dự án mới** -> xóa code mẫu, dán code vừa copy vào -> bấm **💾 Lưu**.
3. Trên thanh công cụ của Apps Script, chọn hàm **`capQuyenDrive`** -> bấm **Chạy (Run)** -> Bấm cấp quyền truy cập Google Drive.
   - *Lưu ý:* Nếu Nhật ký báo chỉ xóa được vào Thùng rác, bấm dấu **`+` cạnh mục Dịch vụ (Services)** ở cột trái -> chọn **Drive API** -> bấm **Thêm (Add)** -> bấm **Chạy** lại hàm `capQuyenDrive` để kích hoạt quyền **Xóa vĩnh viễn**.
4. Bấm nút **Triển khai (Deploy) -> Tùy chọn triển khai mới -> Ứng dụng web**:
   - *Thực thi dưới tên:* **Tôi (Me)**
   - *Ai có quyền truy cập:* **Bất kỳ ai (Anyone)**
   - Bấm **Triển khai** và copy đường link kết thúc bằng `.../exec`.
5. Dán thêm đường link `.../exec` đó vào ô danh sách trên Web (**mỗi dòng 1 link**) -> bấm **💾 LƯU & KIỂM TRA** (hiện dấu ✅ là thành công).

---

## 🛠️ PHẦN 5: QUY TRÌNH CÀI ĐẶT VPS MỚI & CẬP NHẬT CODE (CHO KỸ THUẬT)

### 5.1. Lệnh cài đặt 1 VPS Độc Lập mới tinh cho khách thuê riêng (Copy-Paste 1 chạm)
Khi mua 1 VPS Ubuntu/Debian mới cho khách, SSH vào `root@<IP_VPS_MỚI>` và dán nguyên khối lệnh sau (thay `IP_CUA_VPS_MOI` bằng IP thật của VPS đó):

```bash
NEW_IP=$(curl -4 -s ifconfig.me || hostname -I | awk '{print $1}')
ADMIN_PASS="Admin@123456" bash -c '
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y curl git ffmpeg ca-certificates
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2
INSTALL_DIR="/root/Livenew"
[ ! -d "$INSTALL_DIR/.git" ] && git clone https://github.com/kiensegiau/Livenew.git "$INSTALL_DIR" || (cd "$INSTALL_DIR" && git fetch origin main && git reset --hard origin/main)
cd "$INSTALL_DIR" && npm install --omit=dev && mkdir -p videos logs temp_drive

# Xoa trang bot_config.json de khong dung chung Bot Telegram/Zalo cua cum chinh
cat > bot_config.json <<EOF
{"token":"","adminIds":[],"password":"","polling":false,"zalo":{"enabled":false,"serverUrl":"","threadId":""},"sentinel":{"enabled":false,"knownServers":[],"intervalMs":60000}}
EOF

# Cau hinh Single Master doc lap
MY_IP=$(curl -4 -s ifconfig.me || hostname -I | awk "{print \$1}")
cat > cluster_nodes.json <<EOF
[{"id":"vps1","name":"VPS Chính (Master)","ip":"$MY_IP","port":3131,"isMaster":true,"isLocal":true}]
EOF

# Cau hinh sheet_config.json doc lap + gan san script doc mat xem YouTube
RAND_SECRET=$(node -e "console.log(require(\"crypto\").randomBytes(16).toString(\"hex\"))")
cat > sheet_config.json <<EOF
{
  "syncSecret": "$RAND_SECRET",
  "googleSheetScriptUrl": "",
  "youtubeStatsScriptUrl": "https://script.google.com/macros/s/AKfycbxYgYyp4MHxYQ8HoovJwywvwgLCrpETZ71Kha6L4Pzva3nvv65p95ZXQnQvzNh1GVmiLw/exec",
  "directSheetAuth": false,
  "driveCopyUrls": []
}
EOF

command -v ufw >/dev/null 2>&1 && ufw allow 3131/tcp || true
pm2 delete live-controller >/dev/null 2>&1 || true
ADMIN_PASSWORD="${ADMIN_PASS:-Admin@123456}" pm2 start server.js --name live-controller --time
pm2 save
env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u root --hp /root || true
echo "✅ CAI DAT HOAN TAT: http://$MY_IP:3131 (admin / ${ADMIN_PASS:-Admin@123456})"
'
```

---

### 5.2. Lệnh cập nhật code mới nhất từ GitHub lên các VPS đang chạy

#### Cách 1: Cập nhật trên VPS 1 hoặc VPS 2 (Cụm chính)
SSH vào máy cần cập nhật (nên cập nhật lúc ít luồng hoặc ban đêm vì PM2 restart sẽ làm luồng ngắt ~3 giây rồi tự nối lại):
```bash
cd ~/Livenew && git fetch origin main && git reset --hard origin/main && pm2 restart live-controller
```

#### Cách 2: Cập nhật trên VPS Độc Lập của khách (`13.140.208.154`)
Giữ nguyên file `bot_config.json` rỗng của khách để không bị bật nhầm Bot của cụm chính:
```bash
cd /root/Livenew && cp bot_config.json /tmp/bot_config.json.bak && git fetch origin main && git reset --hard origin/main && cp /tmp/bot_config.json.bak bot_config.json && pm2 restart live-controller
```

*(Hoặc gọi API cập nhật tự động từ xa `POST /api/admin/update` bằng token Admin — hệ thống đã được lập trình tự động bảo toàn file `bot_config.json` hiện tại của máy đó).*

---

### 5.3. Các lệnh kiểm tra & xử lý sự cố thường gặp qua SSH
```bash
# 1. Xem trạng thái server đang chạy hay tắt
pm2 status

# 2. Xem nhật ký (log) hoạt động thời gian thực (bấm Ctrl+C để thoát xem log)
pm2 logs live-controller --lines 50

# 3. Khởi động lại server (các luồng đang chạy sẽ tự động khôi phục từ streams_backup.json)
pm2 restart live-controller

# 4. Kiểm tra dung lượng ổ cứng và bộ nhớ RAM trên VPS
df -h && free -h
```
