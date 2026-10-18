/**
 * ====================================================================
 *   APPS SCRIPT RIÊNG: TẠO BẢN SAO KHI FILE GOOGLE DRIVE "HẾT LƯỢT TẢI"
 * ====================================================================
 *  Không cần Google Sheet. Có thể tạo NHIỀU script trên NHIỀU Gmail khác nhau để dự phòng
 *  (mỗi Gmail có dung lượng + giới hạn riêng). VPS Master chia lần lượt, script nào lỗi tự chuyển sang script kế.
 *
 *  CÀI ĐẶT (mỗi Gmail làm 1 lần):
 *   1. Vào https://script.google.com → "Dự án mới".
 *   2. Xóa hết code mẫu, dán toàn bộ file này vào, sửa SECRET bên dưới GIỐNG secret cụm trên VPS → 💾 Lưu.
 *   3. Chọn hàm capQuyenDrive → ▶ Chạy → cấp quyền. Nhật ký phải có "✅ XÓA VĨNH VIỄN hoạt động"
 *      (nếu báo "Chỉ cho được vào Thùng rác": Dịch vụ (+) → Drive API → Thêm, rồi chạy lại).
 *   4. Triển khai → Tùy chọn triển khai mới → loại "Ứng dụng web":
 *        • Thực thi với tư cách: Tôi      • Ai có quyền truy cập: Bất kỳ ai
 *   5. Copy "URL ứng dụng web" (…/exec) → Trang quản trị VPS Master → ô "Apps Script tạo bản sao" (mỗi dòng 1 link) → Lưu & Kiểm tra.
 *
 *  AN TOÀN:
 *   - Bản sao nằm trong thư mục LIVE_BAN_SAO_TAM (Drive của Gmail này), tải xong VPS gọi xóa VĨNH VIỄN ngay.
 *   - Chỉ xóa file có dấu bản sao tạm + nằm trong LIVE_BAN_SAO_TAM → KHÔNG BAO GIỜ xóa file gốc.
 *   - Bản sao sót lại (VPS lỗi giữa chừng) tự dọn sau 6 giờ ở lần tạo bản sao kế tiếp.
 * ====================================================================
 */

const CAU_HINH = {
  SECRET: "DOI_SECRET_NAY_GIONG_CLUSTER_SECRET" // ⚠️ Đổi giống secret cụm trên VPS
};

const COPY_MARK = "livenew-temp-copy";
const COPY_FOLDER = "LIVE_BAN_SAO_TAM";
const COPY_MAX_AGE_MS = 6 * 3600 * 1000;

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const out = function (obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); };
  if (String(params.secret || "") !== CAU_HINH.SECRET) return out({ error: "Secret Key không chính xác!" });
  const action = params.action || "ping";
  try {
    if (action === "ping") return out({ ok: true, type: "drive-copy", message: "Apps Script tạo bản sao đang hoạt động", time: new Date().toISOString() });
    if (action === "copyDriveFile") return out(copyDriveFile(params.id));
    if (action === "deleteDriveCopy") return out(deleteDriveCopy(params.id));
  } catch (err) {
    return out({ error: String(err && err.message || err) });
  }
  return out({ error: "Hành động không hợp lệ" });
}

function capQuyenDrive() {
  // Chạy 1 lần trong trình soạn thảo để Google hỏi cấp quyền Drive cho Script
  const folder = getCopyFolder_();
  Logger.log("Đã có quyền Drive. Thư mục bản sao tạm: " + folder.getName());
  // Tự kiểm tra xóa vĩnh viễn bằng 1 file thử nhỏ
  const t = folder.createFile("[TAM] kiem-tra-xoa.txt", "test");
  t.setDescription(COPY_MARK);
  const kq = removeCopy_(t);
  Logger.log(kq === "deleted"
    ? "✅ XÓA VĨNH VIỄN hoạt động: bản sao tạm sẽ không nằm trong Thùng rác."
    : "⚠️ Chỉ cho được vào Thùng rác. Bật Dịch vụ (+) → Drive API rồi chạy lại hàm này.");
}

function getCopyFolder_() {
  const it = DriveApp.getFoldersByName(COPY_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(COPY_FOLDER);
}

function isTempCopy_(f) {
  if (f.getDescription() !== COPY_MARK) return false;
  const parents = f.getParents();
  while (parents.hasNext()) { if (parents.next().getName() === COPY_FOLDER) return true; }
  return false;
}

function removeCopy_(f) {
  const id = f.getId();
  // 1) Dịch vụ nâng cao Drive API (nếu đã bật)
  try {
    if (typeof Drive !== "undefined" && Drive.Files && Drive.Files.remove) { Drive.Files.remove(id); return "deleted"; }
  } catch (err) {}
  // 2) Gọi thẳng Drive REST API bằng quyền của chính Script → XÓA VĨNH VIỄN, không cần bật dịch vụ nâng cao
  try {
    if (typeof UrlFetchApp !== "undefined" && typeof ScriptApp !== "undefined") {
      const r = UrlFetchApp.fetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "?supportsAllDrives=true", {
        method: "delete",
        headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      });
      const code = r.getResponseCode();
      if (code === 204 || code === 200) return "deleted";
    }
  } catch (err) {}
  // 3) Cuối cùng: cho vào Thùng rác (lần dọn sau sẽ thử xóa vĩnh viễn lại)
  if (!f.isTrashed()) f.setTrashed(true);
  return "trashed";
}

function cleanupOldCopies_() {
  const it = getCopyFolder_().getFiles();
  const now = Date.now();
  let n = 0;
  while (it.hasNext()) {
    const f = it.next();
    if (isTempCopy_(f) && now - f.getDateCreated().getTime() > COPY_MAX_AGE_MS) { removeCopy_(f); n++; }
  }
  // Bản sao tạm còn kẹt trong Thùng rác (lần trước chưa xóa vĩnh viễn được) → thử xóa vĩnh viễn lại
  try {
    const tr = DriveApp.searchFiles("trashed = true and title contains '[TAM]'");
    while (tr.hasNext()) {
      const f = tr.next();
      if (isTempCopy_(f) && removeCopy_(f) === "deleted") n++;
    }
  } catch (err) {}
  return n;
}

function copyDriveFile(id) {
  id = String(id || "");
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return { error: "ID file Drive không hợp lệ" };
  try { cleanupOldCopies_(); } catch (err) {}
  let src;
  try { src = DriveApp.getFileById(id); }
  catch (err) { return { error: "Script không mở được file gốc (file phải chia sẻ 'Bất kỳ ai có liên kết' hoặc chia sẻ cho tài khoản chạy Script): " + err.message }; }
  const copy = src.makeCopy("[TAM] " + src.getName(), getCopyFolder_());
  copy.setDescription(COPY_MARK);
  try { copy.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
  catch (err) { removeCopy_(copy); return { error: "Không bật được chia sẻ cho bản sao: " + err.message }; }
  return { ok: true, copyId: copy.getId(), name: copy.getName(), size: copy.getSize() };
}

function deleteDriveCopy(id) {
  id = String(id || "");
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return { error: "ID file Drive không hợp lệ" };
  let f;
  try { f = DriveApp.getFileById(id); } catch (err) { return { ok: true, note: "File không còn" }; }
  if (!isTempCopy_(f)) return { error: "Từ chối: chỉ được xóa bản sao tạm do hệ thống tạo" };
  if (f.isTrashed()) { const kq = removeCopy_(f); return { ok: true, result: kq, note: kq === "deleted" ? "Đã xóa vĩnh viễn khỏi Thùng rác" : "Đã nằm trong Thùng rác" }; }
  return { ok: true, result: removeCopy_(f) };
}
