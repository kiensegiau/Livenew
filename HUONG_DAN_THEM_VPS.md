# Hướng dẫn thêm VPS vào cụm (ghi chú để dùng sau)

> Các bước này đã được kiểm thử với VPS **giả** trên localhost (`npm test` = `node test_cluster.js`).
> **Chưa chạy trên VPS thật** → lần đầu hãy thử với 1 VPS và 1 luồng test.

## Khái niệm nhanh
- Cụm có **1 Master** (máy điều phối, hiện là `vps1`) và các **Worker** (máy phụ). Máy mới thêm luôn là Worker.
- Danh sách máy nằm trong file `cluster_nodes.json` của **từng máy** (file này không đưa lên git).
- Mọi máy trong cụm phải dùng **chung 1 secret** (`syncSecret` trong `sheet_config.json`, hoặc biến `CLUSTER_SECRET`) thì Master mới gọi được Worker.
- Cổng mặc định: **3131**.

## Cách 1 — Thêm bằng trang quản trị (đơn giản nhất)
1. **Trên VPS mới:** cài code (`git clone`, `npm install`; cần `ffmpeg`, Node 20, `pm2`).
2. Chạy server với mã máy và secret chung:
   ```
   NODE_ID=vps3 CLUSTER_SECRET=<SECRET_CHUNG> pm2 start server.js --name live-controller
   pm2 save
   ```
3. Mở cổng: `sudo ufw allow 3131/tcp` (và tường lửa của nhà cung cấp VPS nếu có).
4. **Trên Master (vps1):** vào trang quản trị → **Quản lý máy chủ (Cluster)** → điền *Mã máy* (`vps3`), *Tên hiển thị*, *IP*, *Cổng* (3131) → **Thêm máy chủ**.
5. Master tự đẩy danh sách sang các máy trong cụm. Chấm xanh = online.

## Cách 2 — VPS mới tự đăng ký (không cần bấm trên Master)
Trên VPS mới chạy thêm `MASTER_URL`:
```
MASTER_URL=http://<IP_MASTER>:3131 NODE_ID=vps3 CLUSTER_SECRET=<SECRET_CHUNG> pm2 start server.js --name live-controller
```
(tuỳ chọn: `NODE_IP=<ip công khai>`, `NODE_NAME="VPS 3 (Phụ - Worker)"`). Máy tự gọi Master để được thêm vào cụm, thử lại mỗi 30 giây đến khi thành công.

## Cách 3 — Dùng script cài đặt (`scripts/setup-worker.sh`)
Tự cài git/ffmpeg/node20/pm2, tải code vào `/opt/livenew`, mở `ufw`, chạy `pm2` và bật tự khởi động.
```
# Tự đăng ký vào Master:
MASTER_URL=http://<IP_MASTER>:3131 NODE_ID=vps3 CLUSTER_SECRET=<SECRET_CHUNG> bash scripts/setup-worker.sh
# Hoặc chỉ có 1 VPS duy nhất (máy này là Master):
SINGLE=1 bash scripts/setup-worker.sh
```

## Cách 4 — Quản lý danh sách máy bằng Google Sheet (tuỳ chọn, hiện KHÔNG dùng)
Chỉ cần nếu muốn sửa 1 chỗ để mọi máy tự cập nhật.
1. Trong **cùng spreadsheet** với tài khoản khách, tạo tab **`DANH_SACH_VPS`**, dòng 1 là tiêu đề:
   `id | tên | ip | port | vai trò (Master/Worker) | trạng thái (Active/Inactive)`
2. **Cột IP phải đặt Format → Number → Plain text** (nếu không Google Sheets đổi `57.129.134.155` thành số `57129134155` và máy bị bỏ qua).
3. Phải có đúng **1 dòng Master**. Nếu không, server giữ nguyên danh sách cũ (không xoá máy nào).
4. Dán bản mới của `google_apps_script.js` vào Apps Script → Deploy → Manage deployments → Edit → **New version** (URL giữ nguyên).
5. Server cần `googleSheetScriptUrl` + `syncSecret` trong `sheet_config.json` (hoặc biến `NODES_SHEET_URL`). Mỗi 60 giây server đọc lại danh sách.
6. Lần đồng bộ **đầu tiên** sẽ ghi đè danh sách máy và Master theo Sheet → kiểm tra IP/port trước. Xem log: `[SheetNodes] ✅`.

## Sau khi thêm — kiểm tra
- `pm2 logs live-controller` trên máy mới: có dòng `Vai trò máy chủ này: ... (Worker Node)`.
- Trang quản trị Master: máy mới có chấm xanh, hiện số luồng và CPU/RAM.
- Thử bắt 1 luồng test chạy trên máy mới (chọn máy đích) rồi dừng.

## Cập nhật code mới trên VPS (ghi chú lệnh)
Chạy trên từng VPS (ssh vào máy rồi chạy):
```
cd ~/Livenew
cp streams_backup.json streams_backup.json.bak   # (khuyên) sao lưu danh sách luồng; bỏ qua nếu báo không có file
cp bot_config.json /tmp/bot_config.json.bak      # (khuyên) sao lưu cấu hình bot Telegram/Zalo
git fetch origin
git reset --hard origin/main
npm install
pm2 restart live-controller
pm2 logs live-controller
```
- `git reset --hard origin/main` **ghi đè mọi file đã theo dõi bằng bản trên GitHub**. File `bot_config.json` đang nằm trong repo nên nếu bạn đã sửa tay trên VPS (token, `adminIds`...) thì sẽ mất → khôi phục bằng `cp /tmp/bot_config.json.bak bot_config.json` rồi `pm2 restart live-controller`.
- Các file không theo dõi (`users.json`, `sheet_config.json`, `cluster_nodes.json`, `streams_backup.json`, `history.json`, thư mục `downloads/`...) **không bị động tới**.
- Sau restart, luồng đang live bị ngắt vài giây rồi tự chạy lại. Xem log có dòng `♻️ Đã khôi phục N luồng` (N khớp số luồng đang có).
- Nếu `git reset` báo lỗi hoặc `pm2 logs` báo lỗi, gửi nội dung đó để được kiểm tra.

## Kiểm tra sâu hệ thống (cổng `/api/diag`)
Trang quản trị → **Quản lý khách hàng** → khung **🩺 KIỂM TRA SÂU HỆ THỐNG** (chỉ admin thấy):
- **⚡ Kiểm tra nhanh**: đọc trạng thái **mọi máy** trong cụm: phiên bản code (dấu vân tay từng file), vai trò Master/Worker, CPU/RAM/đĩa, FFmpeg, thư mục ghi được, luồng (key bị che), các máy khác có phản hồi, cấu hình bảo mật yếu, tài khoản, Google Sheet, Apps Script tạo bản sao, Telegram, dọn cuối ngày, tự chuyển luồng, 40 lỗi gần nhất.
- **🧪 Tự kiểm tra đầy đủ** (~30-90 giây, mọi máy): mã hóa thử video 720p, phát thử **đúng kiểu đang dùng** (copy + tee + fifo, 2 nhánh A/B) ra file, ghi/đọc 20MB, kết nối tới YouTube RTMP A/B (cổng 1935), Drive, Apps Script, Telegram, kiểm tra **secret cụm** và **máy nào chạy code khác** máy này. Có thể dán 1 link Drive để tải thử, tích "thử tạo bản sao" để thử luôn đường tạo → tải → xóa bản sao. **Không đụng tới luồng đang phát.**
- **🔑 Tạo mã kiểm tra từ xa (24h)**: mã `diag_…` chỉ hiện 1 lần. Người có mã **chỉ** gọi được `/api/diag*` (xem báo cáo, chạy tự kiểm tra); **không** xem được danh sách luồng/key đầy đủ, tài khoản, mật khẩu, không bật/tắt/sửa được gì. Tạo mã mới = mã cũ mất hiệu lực. Bấm **⛔ Thu hồi mã** khi xong. Mã lưu dạng băm trong `sheet_config.json` của **máy tạo ra nó** (tạo trên Master là đủ, Master tự hỏi các máy khác bằng secret cụm).
- Dùng mã từ máy khác (ví dụ gửi cho người hỗ trợ):
```
curl -H "X-Diag-Token: diag_xxx" "http://IP_MASTER:3131/api/diag?cluster=1"
curl -X POST -H "X-Diag-Token: diag_xxx" -H "Content-Type: application/json" -d "{\"cluster\":true}" "http://IP_MASTER:3131/api/diag/selftest"
```
- Máy còn chạy **code cũ** sẽ hiện "Máy này chạy code CŨ (chưa có cổng kiểm tra)". Tự kiểm tra chỉ chạy 1 lượt/lần, cách nhau ≥ 30 giây.

## Lưu ý quan trọng
- **Máy sau router/IP riêng tư** (192.168.x.x) mà Worker không gọi tới được Master → Worker thấy Master "chết" và có thể tự tiếp quản luồng. Dùng Tailscale/ZeroTier (ghi IP `100.x.y.z`) hoặc đặt `AUTO_MIGRATE=0` trên máy đó.
- **Tự chuyển luồng:** Master chuyển luồng của Worker sang máy còn sống nếu Worker mất kết nối quá `FAILOVER_AFTER_SEC` (mặc định 90s). Tắt hẳn bằng `AUTO_MIGRATE=0`.
- **Cập nhật code = restart = luồng ngắt vài giây**, sau đó tự chạy lại từ `streams_backup.json`. Sao lưu trước: `cp streams_backup.json streams_backup.json.bak`. Chọn lúc ít người xem.
- **File video tạm** bị xoá ngay khi luồng kết thúc/dừng. Giữ lại: đặt `KEEP_FILES_AFTER_LIVE=1`.
- **Bảo mật:** từ bản này, User-Agent của app **không còn** được coi là admin (trước đây ai giả UA cũng vào được). Các VPS nói chuyện với nhau bằng secret cụm → **mọi VPS phải dùng CÙNG một secret** (Cài đặt Sheet / `CLUSTER_SECRET`, và `SYNC_SECRET` trong Apps Script), nếu không sẽ bị 401 khi điều phối chéo. Ứng dụng desktop chỉ cần đăng nhập 1 lần. Đổi secret mặc định công khai (`DOI_SECRET_NAY_GIONG_CLUSTER_SECRET`, `vebinh_sync_secret_2026`) sang chuỗi ngẫu nhiên dài; đổi token bot Telegram nếu repo công khai. Bật lại kiểu cũ (không khuyến nghị): `ALLOW_APP_UA=1`.
- **Chỉ chạy 1 VPS:** không cần Sheet nhóm máy, Tailscale hay `AUTO_MIGRATE`. VPS sập thì không có máy nào tiếp quản, `pm2` sẽ tự bật lại khi VPS lên.
- **Thông báo Telegram/Zalo:** chỉ **Master** gửi (và nhận lệnh bot/polling). Worker (code mới) tự chuyển thông báo về Master qua `/api/cluster/notify`, tin có thêm dòng `📍 Từ máy: <tên>`; nếu không liên lạc được Master thì Worker tự gửi để khỏi mất tin. Muốn mọi máy tự gửi như cũ: đặt `NOTIFY_FROM_ALL=1`. Worker **chạy code cũ** vẫn tự gửi và tự polling (gây lỗi `409 Conflict`) cho tới khi được cập nhật.
- **Lịch sử luồng lên Google Sheet:** Master tự ghi luồng của cả cụm vào tab `LICH_SU_LUONG` (tự tạo) trong Sheet tài khoản, mỗi phút 1 lần. **Mỗi phiên live = 1 dòng**: đang chạy ghi "Đang live / Đang chờ lịch / Đang tải video / Đang khởi động / Đang kết nối lại", khi kết thúc **cùng dòng đó** đổi thành "Đã dừng / Hoàn thành / Lỗi" (không ghi trùng). Cột Stream Key ghi **đầy đủ** → chỉ chia sẻ Sheet cho người tin cậy. Cần dán bản `google_apps_script.js` mới vào Apps Script rồi **Triển khai → Quản lý bản triển khai → sửa → Phiên bản mới** (giữ nguyên link). Tắt: `HISTORY_SHEET=0`.
- **Drive "hết lượt tải" → tự tạo bản sao:** khi Google báo file hết lượt tải, Master nhờ **Apps Script riêng** (`google_apps_script_copy.js`, không cần Sheet) tạo **bản sao tạm** (thư mục `LIVE_BAN_SAO_TAM` trong Drive của Gmail chạy Script), VPS tải bản sao, rồi Script đó **xóa vĩnh viễn** bản sao. Worker tự nhờ Master. Có thể tạo **nhiều Script trên nhiều Gmail** để dự phòng: Master chia lần lượt, Script lỗi tự chuyển Script kế (Script vừa lỗi bị xếp cuối 10 phút). Cài cho mỗi Gmail:
  1. Trang quản trị Master → Quản lý khách hàng → khung **"APPS SCRIPT TẠO BẢN SAO"** → bấm **📜 Sao chép code** (đã điền sẵn secret cụm).
  2. Vào https://script.google.com bằng Gmail đó → **Dự án mới** → xóa code mẫu, dán code → 💾 Lưu.
  3. Chọn hàm `capQuyenDrive` → **Chạy** → đồng ý cấp quyền. **Nhật ký thực thi** phải có `✅ XÓA VĨNH VIỄN hoạt động` (nếu báo `⚠️ Chỉ cho được vào Thùng rác`: **Dịch vụ (+) → Drive API → Thêm**, chạy lại).
  4. **Triển khai → Tùy chọn triển khai mới → Ứng dụng web**: Thực thi với tư cách **Tôi**, Ai có quyền truy cập **Bất kỳ ai** → copy link `…/exec`.
  5. Dán link vào khung trên trang quản trị (**mỗi dòng 1 link**) → **💾 LƯU & KIỂM TRA**: mỗi link hiện ✅ là dùng được.
  - Chưa khai link riêng nào thì dùng link Google Sheet (nếu Script trong Sheet là bản mới có chức năng tạo bản sao). Biến môi trường `DRIVE_COPY_URLS=link1,link2` (nếu đặt) được ưu tiên hơn danh sách trên trang quản trị.
  - Danh sách lưu trên **Master** (`sheet_config.json`). Nếu Worker tạm lên làm Master thì Worker chưa có danh sách → khai thêm trên Worker nếu cần.
  - File gốc phải chia sẻ "Bất kỳ ai có liên kết" (hoặc chia sẻ cho tài khoản chủ Script); Drive chủ Script phải còn đủ chỗ chứa 1 bản sao. File lớn: Apps Script tối đa 6 phút/lần.
  - Script **chỉ xóa** file có dấu bản sao tạm nằm trong `LIVE_BAN_SAO_TAM`, không bao giờ xóa file gốc. Bản sao sót lại (VPS lỗi giữa chừng) tự dọn sau 6 giờ.
  - **Khóa mật khẩu mặc định admin/admin:** để chống xâm nhập trái phép, hệ thống từ chối đăng nhập nếu tài khoản dự phòng (`auth_config.json`) vẫn giữ mật khẩu mặc định `admin`. Để dùng tài khoản dự phòng, hãy đổi `"password"` trong `auth_config.json` sang mật khẩu mạnh và khởi động lại server.
- **Bảo vệ luồng khi máy vừa khởi động:** các yêu cầu thêm/sửa/xóa luồng được tự động giữ lại chờ server đọc và khôi phục xong toàn bộ luồng cũ (`streams_backup.json`), tránh bị ghi đè mất luồng hoặc tải trùng video khi máy vừa bật.
