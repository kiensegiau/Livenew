/**
 * ====================================================================
 *   🛡️ VỆ BINH CYBER-SHIELD - GOOGLE SHEETS DIRECT AUTH & API 🚀
 * ====================================================================
 *   HƯỚNG DẪN CÀI ĐẶT ĐỂ DÙNG XÁC THỰC THẲNG LÊN SHEET:
 *   
 *   1. Mở trang tính Google Sheets của bạn.
 *   2. Vào menu: Tiện ích mở rộng (Extensions) ➜ Apps Script.
 *   3. Dán toàn bộ mã này vào và nhấn 💾 Lưu (Ctrl + S).
 *   4. Nhấn nút màu xanh góc trên bên phải: "Triển khai" (Deploy)
 *      ➜ Chọn "Tùy chọn triển khai mới" (New deployment).
 *   5. Nhấn biểu tượng bánh răng bên cạnh "Chọn loại" ➜ Chọn "Ứng dụng web" (Web App).
 *   6. Thiết lập:
 *      • Mô tả: Vệ Binh Live Auth API
 *      • Thực thi dưới dạng (Execute as): "Tôi" (Địa chỉ email của bạn)
 *      • Ai có quyền truy cập (Who has access): "Bất kỳ ai" (Anyone)
 *   7. Nhấn "Triển khai" (Deploy).
 *   8. Copy đường link "URL của ứng dụng web" (dạng https://script.google.com/macros/s/.../exec).
 *   9. Dán đường link đó vào Web Dashboard của bạn (nút "⚙️ Cài Link Sheet").
 * ====================================================================
 */

const DEFAULT_CONFIG = {
  SYNC_SECRET: "DOI_SECRET_NAY_GIONG_CLUSTER_SECRET", // Secret Key bảo mật
  NODES_SHEET_NAME: "DANH_SACH_VPS", // Tab danh sách VPS: id | tên | ip | port | vai trò (Master/Worker) | trạng thái (Active/Inactive)
  HISTORY_SHEET_NAME: "LICH_SU_LUONG", // Tab lịch sử luồng (VPS Master ghi luồng đang chạy + cập nhật trạng thái khi kết thúc/dừng)
  SHEET_NAME: "DANH_SACH_KHACH_HANG"     // Tên sheet chứa tài khoản
};

const HISTORY_HEADER = ["Kết thúc", "Máy chủ", "ID", "Tên luồng", "Tài khoản", "Stream Key", "Chế độ", "Nguồn video", "Bắt đầu live", "Thời lượng", "Trạng thái", "Chi tiết lỗi", "Link YouTube", "UID"];

// Tab chứa tài khoản khách: nếu chưa có tab đúng tên thì lấy tab đầu tiên KHÔNG PHẢI tab danh sách VPS / lịch sử (tránh đọc nhầm/đổi tên nhầm).
function pickFirstNonNodesSheet(ss) {
  const found = ss.getSheets().filter(function (s) { const n = s.getName(); return n !== DEFAULT_CONFIG.NODES_SHEET_NAME && n !== DEFAULT_CONFIG.HISTORY_SHEET_NAME; })[0];
  return found || ss.insertSheet(DEFAULT_CONFIG.SHEET_NAME);
}

// Ghi lịch sử vào tab LICH_SU_LUONG theo UID (mỗi phiên live = 1 dòng):
//  - UID chưa có → thêm dòng mới (VD: "Đang live")
//  - UID đã có  → GHI ĐÈ đúng dòng đó (VD: "Đang live" → "Đã dừng"/"Hoàn thành"/"Lỗi") → không nhân đôi
function appendHistoryRows(rows) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(DEFAULT_CONFIG.HISTORY_SHEET_NAME);
    if (!sh) sh = ss.insertSheet(DEFAULT_CONFIG.HISTORY_SHEET_NAME);
    // Luôn đảm bảo dòng tiêu đề đúng (bản cũ có cột "Kết quả" → đổi thành "Trạng thái")
    sh.getRange(1, 1, 1, HISTORY_HEADER.length).setValues([HISTORY_HEADER]).setFontWeight("bold");
    if (sh.getFrozenRows() < 1) sh.setFrozenRows(1);
    const uidCol = HISTORY_HEADER.length;
    const last = sh.getLastRow();
    const rowOf = {}; // uid → số dòng trên sheet
    if (last > 1) {
      const from = Math.max(2, last - 20000 + 1);
      sh.getRange(from, uidCol, last - from + 1, 1).getValues().forEach(function (r, i) { if (r[0]) rowOf[String(r[0])] = from + i; });
    }
    const toAdd = [];
    const addIdx = {}; // uid → vị trí trong toAdd (cùng 1 lô có 2 bản của 1 UID thì lấy bản sau)
    let updated = 0;
    (rows || []).forEach(function (r) {
      if (!Array.isArray(r)) return;
      const row = HISTORY_HEADER.map(function (_, i) { return String(r[i] === undefined || r[i] === null ? "" : r[i]).slice(0, 500); });
      const uid = row[uidCol - 1];
      if (!uid) return;
      if (rowOf[uid]) {
        const range = sh.getRange(rowOf[uid], 1, 1, HISTORY_HEADER.length);
        range.setNumberFormat("@");
        range.setValues([row]);
        updated++;
      } else if (addIdx[uid] !== undefined) {
        toAdd[addIdx[uid]] = row;
      } else {
        addIdx[uid] = toAdd.length;
        toAdd.push(row);
      }
    });
    if (toAdd.length) {
      const range = sh.getRange(sh.getLastRow() + 1, 1, toAdd.length, HISTORY_HEADER.length);
      range.setNumberFormat("@"); // giữ nguyên văn bản (không tự đổi giờ/thời lượng/key thành số)
      range.setValues(toAdd);
    }
    return { ok: true, added: toAdd.length, updated: updated };
  } finally {
    lock.releaseLock();
  }
}

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("⚡ VỆ BINH LIVE")
    .addItem("🔍 Kiểm Tra Dữ Liệu Sheet", "testSheetData")
    .addItem("🧪 Điền Dữ Liệu Mẫu", "seedSampleData")
    .addSeparator()
    .addItem("📋 Lấy Link Web App Đã Triển Khai", "showWebAppInstructions")
    .addToUi();
}

/**
 * Điền tiêu đề + 5 tài khoản mẫu vào sheet (chỉ ghi khi sheet đang trống)
 */
function seedSampleData() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DEFAULT_CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = pickFirstNonNodesSheet(ss);
    sheet.setName(DEFAULT_CONFIG.SHEET_NAME);
  }
  if (sheet.getLastRow() > 1) {
    ui.alert("Sheet đã có dữ liệu, không ghi đè để tránh mất tài khoản.");
    return;
  }
  const rows = [
    ["Username", "Password", "Tên Khách Hàng", "Số Luồng Tối Đa", "Ngày Hết Hạn", "Server Được Dùng", "Trạng Thái", "Quyền Hạn", "Ghi Chú"],
    ["admin", "DOI_MAT_KHAU_ADMIN", "Quản Trị Viên (Admin)", 999, "Vĩnh viễn", "All", "Active", "admin", "Tài khoản gốc"],
    ["khach1", "123456", "Anh Nam (Zalo 0912...)", 3, "2026-12-31", "All", "Active", "user", "Gói 3 luồng"],
    ["khach2", "654321", "Chị Linh Shop Live", 5, "2026-11-15", "vps1", "Active", "user", "Gói 5 luồng VPS 1"],
    ["khach3", "pass888", "Team Marketing", 2, "2026-10-30", "vps2", "Active", "user", "Gói 2 luồng VPS 2"],
    ["khach_khoa", "123456", "Tài Khoản Tạm Dừng", 1, "2026-05-01", "All", "Inactive", "user", "Tạm khóa"]
  ];
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.getRange(1, 1, 1, rows[0].length).setFontWeight("bold");
  sheet.getRange(2, 5, rows.length - 1, 1).setNumberFormat("@");
  ui.alert("Đã điền " + (rows.length - 1) + " tài khoản mẫu!");
}

function showWebAppInstructions() {
  const ui = SpreadsheetApp.getUi();
  ui.alert(
    "📌 CÁCH LẤY LINK WEB APP ĐỂ DÁN VÀO VPS",
    "1. Nhấn nút 'Triển khai' (Deploy) màu xanh ở trên cùng bên phải màn hình này.\n" +
    "2. Chọn 'Quản lý các bản triển khai' (Manage deployments) hoặc 'Tùy chọn triển khai mới'.\n" +
    "3. Copy 'URL của ứng dụng web' (dạng https://script.google.com/macros/s/.../exec).\n" +
    "4. Mở Web Dashboard live của bạn ➜ Nhấn '👥 QUẢN LÝ KHÁCH HÀNG' ➜ Dán link vào ô Cài đặt Google Sheet là xong 100%!",
    ui.ButtonSet.OK
  );
}

function testSheetData() {
  const ui = SpreadsheetApp.getUi();
  const users = getSheetUserData();
  ui.alert(
    "📊 KIỂM TRA DỮ LIỆU GOOGLE SHEET",
    `Tìm thấy tổng cộng: ${users.length} tài khoản trong Sheet.\n\n` +
    users.slice(0, 5).map(u => `• [${u.username}] - ${u.name} (Gói: ${u.maxStreams} luồng | Hạn: ${u.expiresAt || 'Vĩnh viễn'} | TT: ${u.status})`).join("\n") +
    (users.length > 5 ? `\n... và ${users.length - 5} tài khoản khác.` : ""),
    ui.ButtonSet.OK
  );
}

/**
 * Đọc dữ liệu từ Sheet ra mảng đối tượng
 */
function getSheetUserData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DEFAULT_CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = pickFirstNonNodesSheet(ss);
  }

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  // Quy ước cột:
  // Cột 0: Username
  // Cột 1: Password
  // Cột 2: Tên Khách Hàng
  // Cột 3: Số Luồng Tối Đa
  // Cột 4: Ngày Hết Hạn
  // Cột 5: Server Được Dùng
  // Cột 6: Trạng Thái
  // Cột 7: Quyền Hạn
  // Cột 8: Ghi Chú

  const usersList = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const username = String(row[0] || '').trim();
    if (!username) continue;

    const password = String(row[1] || '').trim();
    const name = String(row[2] || username).trim();
    const maxStreams = parseInt(row[3]) || 1;
    
    let expiresAt = null;
    const expVal = row[4];
    if (expVal instanceof Date) {
      expiresAt = Utilities.formatDate(expVal, "GMT+7", "yyyy-MM-dd");
    } else if (expVal && String(expVal).trim() && !['vĩnh viễn', 'forever', 'all'].includes(String(expVal).toLowerCase().trim())) {
      expiresAt = String(expVal).trim();
    }

    const allowedServers = String(row[5] || 'All').trim();
    const status = String(row[6] || 'Active').trim();
    const role = String(row[7] || (username.toLowerCase() === 'admin' ? 'admin' : 'user')).trim().toLowerCase();
    const notes = String(row[8] || '').trim();

    usersList.push({
      username: username,
      password: password,
      name: name,
      maxStreams: maxStreams,
      expiresAt: expiresAt,
      allowedServers: allowedServers,
      status: status,
      role: role,
      notes: notes
    });
  }

  return usersList;
}

/**
 * ⚡ WEB APP ENDPOINT - VPS GỌI TRỰC TIẾP LÊN ĐÂY
 */
function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const secret = params.secret || "";
  const action = params.action || "getUsers";

  if (secret !== DEFAULT_CONFIG.SYNC_SECRET) {
    return ContentService.createTextOutput(JSON.stringify({ error: "Secret Key không chính xác!" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 1. Kiểm tra kết nối nhanh (Ping)
  if (action === "ping") {
    return ContentService.createTextOutput(JSON.stringify({ 
      ok: true, 
      message: "Google Sheet API đang hoạt động hoàn hảo!",
      sheetName: DEFAULT_CONFIG.SHEET_NAME,
      time: new Date().toISOString()
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // 1b. GHI DỮ LIỆU VÀO SHEET (cần đúng secret)
  if (action === "seed" || action === "upsert" || action === "delete") {
    const out = function (obj) {
      return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
    };
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(DEFAULT_CONFIG.SHEET_NAME);
    if (!sheet) {
      sheet = pickFirstNonNodesSheet(ss);
      sheet.setName(DEFAULT_CONFIG.SHEET_NAME);
    }
    const header = ["Username", "Password", "Tên Khách Hàng", "Số Luồng Tối Đa", "Ngày Hết Hạn", "Server Được Dùng", "Trạng Thái", "Quyền Hạn", "Ghi Chú"];

    if (action === "seed") {
      if (sheet.getLastRow() > 1) return out({ error: "Sheet đã có dữ liệu, không ghi đè!" });
      const rows = [header,
        ["admin", "DOI_MAT_KHAU_ADMIN", "Quản Trị Viên (Admin)", 999, "Vĩnh viễn", "All", "Active", "admin", "Tài khoản gốc"],
        ["khach1", "123456", "Anh Nam (Zalo 0912...)", 3, "2026-12-31", "All", "Active", "user", "Gói 3 luồng"],
        ["khach2", "654321", "Chị Linh Shop Live", 5, "2026-11-15", "vps1", "Active", "user", "Gói 5 luồng VPS 1"],
        ["khach3", "pass888", "Team Marketing", 2, "2026-10-30", "vps2", "Active", "user", "Gói 2 luồng VPS 2"],
        ["khach_khoa", "123456", "Tài Khoản Tạm Dừng", 1, "2026-05-01", "All", "Inactive", "user", "Tạm khóa"]];
      sheet.getRange(1, 1, rows.length, header.length).setValues(rows);
      sheet.getRange(1, 1, 1, header.length).setFontWeight("bold");
      sheet.getRange(2, 5, rows.length - 1, 1).setNumberFormat("@");
      return out({ ok: true, added: rows.length - 1 });
    }

    const uname = String(params.username || "").trim();
    if (!uname) return out({ error: "Thiếu username!" });
    if (sheet.getLastRow() < 1) sheet.getRange(1, 1, 1, header.length).setValues([header]);

    const data = sheet.getDataRange().getValues();
    let rowIdx = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === uname.toLowerCase()) { rowIdx = i + 1; break; }
    }

    if (action === "delete") {
      if (rowIdx === -1) return out({ error: "Không tìm thấy tài khoản!" });
      sheet.deleteRow(rowIdx);
      return out({ ok: true, deleted: uname });
    }

    // upsert: chỉ ghi các cột có tham số truyền vào
    const cols = { password: 2, name: 3, maxStreams: 4, expiresAt: 5, servers: 6, status: 7, role: 8, notes: 9 };
    if (rowIdx === -1) {
      rowIdx = sheet.getLastRow() + 1;
      sheet.getRange(rowIdx, 5).setNumberFormat("@");
      sheet.getRange(rowIdx, 1, 1, header.length).setValues([[uname, "", uname, 1, "Vĩnh viễn", "All", "Active", "user", ""]]);
    }
    Object.keys(cols).forEach(function (k) {
      if (params[k] !== undefined) {
        const cell = sheet.getRange(rowIdx, cols[k]);
        if (k === "maxStreams") cell.setValue(parseInt(params[k]) || 1);
        else cell.setValue(String(params[k]));
      }
    });
    return out({ ok: true, upserted: uname, row: rowIdx });
  }

  // 2. Xác thực trực tiếp User/Pass (Direct Auth)
  if (action === "auth") {
    const inputUsername = String(params.username || "").trim().toLowerCase();
    const inputPassword = String(params.password || "").trim();

    if (!inputUsername || !inputPassword) {
      return ContentService.createTextOutput(JSON.stringify({ error: "Vui lòng nhập tài khoản và mật khẩu!" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const users = getSheetUserData();
    const user = users.find(u => u.username.toLowerCase() === inputUsername);

    if (!user) {
      return ContentService.createTextOutput(JSON.stringify({ error: "Tài khoản không tồn tại trên Google Sheet!" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (user.password !== inputPassword) {
      return ContentService.createTextOutput(JSON.stringify({ error: "Mật khẩu không chính xác!" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const statusClean = String(user.status || "Active").toLowerCase();
    if (statusClean === "inactive" || statusClean === "lock") {
      return ContentService.createTextOutput(JSON.stringify({ error: "Tài khoản của bạn đang bị tạm khóa trên Sheet. Vui lòng liên hệ Admin!" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Kiểm tra hết hạn
    if (user.expiresAt && !["vĩnh viễn", "forever"].includes(user.expiresAt.toLowerCase())) {
      const expDate = new Date(user.expiresAt);
      if (!isNaN(expDate.getTime())) {
        expDate.setHours(23, 59, 59, 999);
        if (Date.now() > expDate.getTime()) {
          return ContentService.createTextOutput(JSON.stringify({ error: `Tài khoản đã hết hạn sử dụng vào ngày ${user.expiresAt} trên Sheet!` }))
            .setMimeType(ContentService.MimeType.JSON);
        }
      }
    }

    let allowed = ["all"];
    if (user.allowedServers) {
      allowed = user.allowedServers.split(",").map(s => s.trim().toLowerCase());
    }

    // Trả về thông tin xác thực thành công
    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      user: {
        id: "usr_" + user.username,
        username: user.username,
        name: user.name || user.username,
        role: user.role || "user",
        maxStreams: parseInt(user.maxStreams) || 1,
        allowedServers: allowed,
        expiresAt: user.expiresAt || null,
        notes: user.notes || ""
      }
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // 3. Lấy toàn bộ danh sách tài khoản
  // 2b. Lấy danh sách VPS của cụm (tab DANH_SACH_VPS) - cần secret. Server sẽ đọc định kỳ để tự cập nhật cụm.
  // 2a. GHI tab DANH_SACH_VPS (cần đúng secret): seedNodes | upsertNode | deleteNode
  if (action === "seedNodes" || action === "upsertNode" || action === "deleteNode") {
    const outN = function (obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); };
    const ssN = SpreadsheetApp.getActiveSpreadsheet();
    let shN = ssN.getSheetByName(DEFAULT_CONFIG.NODES_SHEET_NAME);
    if (!shN) shN = ssN.insertSheet(DEFAULT_CONFIG.NODES_SHEET_NAME);
    const headN = ["id", "Tên máy", "IP", "Port", "Vai trò", "Trạng thái"];
    if (shN.getLastRow() < 1) { shN.getRange(1, 1, 1, headN.length).setValues([headN]).setFontWeight("bold"); }
    shN.getRange("C:C").setNumberFormat("@"); // IP phải là VĂN BẢN, nếu không Sheets biến 57.129.134.155 thành số 57129134155
    if (action === "seedNodes") {
      if (shN.getLastRow() > 1) return outN({ error: "Tab đã có dữ liệu, không ghi đè!" });
      const rowsN = [
        ["vps1", "VPS 1 (Chính - Master)", "57.129.134.155", 3131, "Master", "Active"],
        ["vps2", "VPS 2 (Phụ - Worker)", "51.68.214.167", 3131, "Worker", "Active"]
      ];
      shN.getRange(2, 1, rowsN.length, headN.length).setValues(rowsN);
      return outN({ ok: true, added: rowsN.length });
    }
    const idN = String(params.id || "").trim().toLowerCase();
    if (!idN) return outN({ error: "Thiếu id!" });
    const dataN = shN.getDataRange().getValues();
    let rowN = -1;
    for (let i = 1; i < dataN.length; i++) { if (String(dataN[i][0]).trim().toLowerCase() === idN) { rowN = i + 1; break; } }
    if (action === "deleteNode") {
      if (rowN === -1) return outN({ error: "Không tìm thấy máy!" });
      shN.deleteRow(rowN);
      return outN({ ok: true, deleted: idN });
    }
    if (rowN === -1) {
      rowN = shN.getLastRow() + 1;
      shN.getRange(rowN, 1, 1, headN.length).setValues([[idN, idN, "", 3131, "Worker", "Active"]]);
    }
    const colsN = { name: 2, ip: 3, port: 4, role: 5, status: 6 };
    Object.keys(colsN).forEach(function (k) {
      if (params[k] !== undefined) shN.getRange(rowN, colsN[k]).setValue(k === "port" ? (parseInt(params[k]) || 3131) : String(params[k]));
    });
    return outN({ ok: true, upserted: idN, row: rowN });
  }

  if (action === "getNodes") {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(DEFAULT_CONFIG.NODES_SHEET_NAME);
    if (!sh) {
      return ContentService.createTextOutput(JSON.stringify({ error: "Chưa có tab " + DEFAULT_CONFIG.NODES_SHEET_NAME }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const nodes = sh.getDataRange().getValues().slice(1)
      .map(function (r) { return [0, 1, 2, 3, 4, 5].map(function (i) { return String(r[i] === undefined || r[i] === null ? "" : r[i]).trim(); }); })
      .filter(function (r) { return r[0]; });
    return ContentService.createTextOutput(JSON.stringify({ ok: true, total: nodes.length, nodes: nodes }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 2c. GHI LỊCH SỬ LUỒNG (cần đúng secret): rows = JSON mảng các dòng theo HISTORY_HEADER
  if (action === "appendHistory") {
    let rowsH = [];
    try { rowsH = JSON.parse(params.rows || "[]"); } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ error: "rows không phải JSON hợp lệ" })).setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify(appendHistoryRows(rowsH))).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === "getUsers") {
    const users = getSheetUserData();
    return ContentService.createTextOutput(JSON.stringify({ 
      ok: true, 
      total: users.length,
      users: users 
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // 2d. FILE DRIVE HẾT LƯỢT TẢI: tạo bản sao tạm (có lượt tải mới) / xóa bản sao tạm (cần đúng secret)
  if (action === "copyDriveFile" || action === "deleteDriveCopy") {
    let resultC;
    try { resultC = action === "copyDriveFile" ? copyDriveFile(params.id) : deleteDriveCopy(params.id); }
    catch (err) { resultC = { error: String(err && err.message || err) }; }
    return ContentService.createTextOutput(JSON.stringify(resultC)).setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ error: "Hành động không hợp lệ" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ====================================================================
//  TỰ TẠO BẢN SAO KHI FILE GOOGLE DRIVE "HẾT LƯỢT TẢI" (Quota exceeded)
//  - VPS gặp lỗi hết lượt tải → gọi copyDriveFile → Script tạo bản sao trong thư mục LIVE_BAN_SAO_TAM (Drive của tài khoản chạy Script),
//    bật chia sẻ "Bất kỳ ai có liên kết" → VPS tải bản sao → gọi deleteDriveCopy để xóa.
//  - deleteDriveCopy CHỈ xóa file có đánh dấu bản sao tạm + nằm trong thư mục tạm (không bao giờ xóa file gốc).
//  - Bản sao tạm quá 6 giờ (VPS lỗi giữa chừng) tự xóa ở lần tạo bản sao kế tiếp.
//  - Lần đầu: chạy hàm capQuyenDrive() trong trình soạn thảo để cấp quyền Drive, rồi Triển khai → Phiên bản mới.
//    ⚠️ CẤP QUYỀN XONG MỚI TRIỂN KHAI: triển khai khi chưa cấp quyền mới thì Web App (đăng nhập, lịch sử...) có thể lỗi.
//  - Bản sao được XÓA VĨNH VIỄN (Drive REST API bằng quyền của Script); chỉ khi lỗi mới vào Thùng rác và được dọn lại lần sau.
//    capQuyenDrive() báo "Chỉ cho được vào Thùng rác" → bật Dịch vụ nâng cao "Drive API".
// ====================================================================
const COPY_MARK = "livenew-temp-copy";
const COPY_FOLDER = "LIVE_BAN_SAO_TAM";
const COPY_MAX_AGE_MS = 6 * 3600 * 1000;

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
