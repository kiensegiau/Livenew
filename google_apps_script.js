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
  SHEET_NAME: "DANH_SACH_KHACH_HANG"     // Tên sheet chứa tài khoản
};

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
    sheet = ss.getSheets()[0];
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
    sheet = ss.getSheets()[0];
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
    const role = String(row[7] || (username.toLowerCase() === 'admin' ? 'admin' : 'user')).trim();
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
      sheet = ss.getSheets()[0];
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

  if (action === "getUsers") {
    const users = getSheetUserData();
    return ContentService.createTextOutput(JSON.stringify({ 
      ok: true, 
      total: users.length,
      users: users 
    })).setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ error: "Hành động không hợp lệ" }))
    .setMimeType(ContentService.MimeType.JSON);
}
