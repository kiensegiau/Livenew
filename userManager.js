const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const USERS_FILE = path.join(__dirname, 'users.json');
const USERS_BACKUP_FILE = path.join(__dirname, 'users_backup.json');

// Cấu hình đồng bộ Google Sheet
const SHEET_CONFIG_PATH = path.join(__dirname, 'sheet_config.json');

let users = [];
// Map lưu token phiên đang hoạt động: token => { userId, username, role, name, maxStreams, expiresAt, allowedServers, loginAt }
const activeSessions = new Map();

const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // Phiên sống tối đa 7 ngày

// Ghi file nguyên tử (ghi tạm rồi đổi tên) để không bao giờ hỏng file khi mất điện/crash giữa chừng
function writeFileAtomic(filePath, content) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

let sessionSaveTimer = null;
function scheduleSessionSave() {
  if (sessionSaveTimer) return;
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    try {
      writeFileAtomic(SESSIONS_FILE, JSON.stringify(Array.from(activeSessions.entries())));
    } catch (e) {
      console.error('[UserManager] Lỗi ghi sessions.json:', e.message);
    }
  }, 500);
}

(function hookSessionPersistence() {
  const origSet = activeSessions.set.bind(activeSessions);
  const origDelete = activeSessions.delete.bind(activeSessions);
  activeSessions.set = (k, v) => { const r = origSet(k, v); scheduleSessionSave(); return r; };
  activeSessions.delete = (k) => { const r = origDelete(k); scheduleSessionSave(); return r; };
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      let restored = 0;
      for (const [k, v] of saved) {
        if (v && v.loginAt && Date.now() - new Date(v.loginAt).getTime() < SESSION_TTL_MS) {
          origSet(k, v);
          restored++;
        }
      }
      if (restored) console.log(`[UserManager] Khôi phục ${restored} phiên đăng nhập sau khi khởi động lại.`);
    }
  } catch (e) {
    console.error('[UserManager] Không đọc được sessions.json:', e.message);
  }
})();

// Cấu hình bảo mật đồng bộ từ Google Sheet
let sheetConfig = {
  syncSecret: '', // Bí mật dùng chung giữa các VPS & Google Sheet: lấy từ CLUSTER_SECRET hoặc sheet_config.json (không lưu trong git)
  googleSheetScriptUrl: '', // URL Web App (ví dụ: https://script.google.com/macros/s/.../exec)
  directSheetAuth: true,    // Bật xác thực trực tiếp lên Google Sheet
  lastSyncTime: null
};

function loadSheetConfig() {
  try {
    if (fs.existsSync(SHEET_CONFIG_PATH)) {
      sheetConfig = { ...sheetConfig, ...JSON.parse(fs.readFileSync(SHEET_CONFIG_PATH, 'utf8')) };
    } else {
      saveSheetConfig();
    }
  } catch (e) {
    console.error('[UserManager] Lỗi đọc sheet_config.json:', e.message);
  }
  ensureSyncSecret();
}

// Đảm bảo luôn có secret đồng bộ; không bao giờ để trống (trống = ai cũng đẩy được dữ liệu)
function ensureSyncSecret() {
  if (process.env.CLUSTER_SECRET) {
    sheetConfig.syncSecret = process.env.CLUSTER_SECRET;
  } else if (!sheetConfig.syncSecret) {
    sheetConfig.syncSecret = crypto.randomBytes(18).toString('hex');
    saveSheetConfig();
    console.warn('[UserManager] ⚠️ Chưa có secret đồng bộ: đã tự sinh và lưu vào sheet_config.json.');
    console.warn('[UserManager]    Nhiều VPS phải dùng CHUNG một secret: đặt biến CLUSTER_SECRET giống nhau trên mọi máy (và trong Google Apps Script).');
  }
  if (sheetConfig.syncSecret === 'vebinh_sync_secret_2026') {
    console.warn('[UserManager] ⚠️ Đang dùng secret mặc định đã bị công khai trên GitHub. Hãy đổi bằng CLUSTER_SECRET (đồng bộ mọi VPS + Apps Script).');
  }
}

function saveSheetConfig() {
  try {
    fs.writeFileSync(SHEET_CONFIG_PATH, JSON.stringify(sheetConfig, null, 2), 'utf8');
  } catch (e) {
    console.error('[UserManager] Lỗi ghi sheet_config.json:', e.message);
  }
}

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } else if (fs.existsSync(USERS_BACKUP_FILE)) {
      console.log('[UserManager] ⚠️ Không thấy users.json, khôi phục từ users_backup.json...');
      users = JSON.parse(fs.readFileSync(USERS_BACKUP_FILE, 'utf8'));
      saveUsers();
    } else {
      // Khởi tạo tài khoản Admin mặc định (mật khẩu lấy từ ADMIN_PASSWORD, nếu không có thì tự sinh ngẫu nhiên)
      const initialAdminPw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, 'x');
      if (!process.env.ADMIN_PASSWORD) console.warn(`[UserManager] 🔑 Mật khẩu Admin khởi tạo (chỉ hiện 1 lần): admin / ${initialAdminPw}`);
      users = [
        {
          id: 'admin_root',
          username: 'admin',
          password: initialAdminPw,
          name: 'Quản Trị Viên (Admin)',
          role: 'admin',
          maxStreams: 999,
          allowedServers: ['all'],
          expiresAt: null,
          active: true,
          notes: 'Tài khoản trùm hệ thống',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ];
      saveUsers();
    }
  } catch (e) {
    console.error('[UserManager] Lỗi đọc users.json:', e.message);
    users = [];
  }
}

function saveUsers() {
  try {
    const json = JSON.stringify(users, null, 2);
    writeFileAtomic(USERS_FILE, json);
    writeFileAtomic(USERS_BACKUP_FILE, json);
  } catch (e) {
    console.error('[UserManager] Lỗi ghi users.json:', e.message);
  }
}

// Hàm hỗ trợ theo dõi chuyển hướng (Redirects) cho Google Apps Script Web App
function fetchWithRedirect(urlStr, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Quá số vòng redirect tối đa từ Google'));

    try {
      const parsedUrl = new URL(urlStr);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.get(urlStr, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 10000
      }, (res) => {
        // Xử lý HTTP 301, 302, 307 Redirect của Google Apps Script
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let nextUrl = res.headers.location;
          if (nextUrl.startsWith('/')) {
            nextUrl = `${parsedUrl.origin}${nextUrl}`;
          }
          return resolve(fetchWithRedirect(nextUrl, maxRedirects - 1));
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ statusCode: res.statusCode, data: parsed });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: data });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Hết thời gian chờ kết nối Google Sheet (10s)'));
      });

      req.on('error', (err) => reject(err));
    } catch (e) {
      reject(e);
    }
  });
}

function isUserExpired(user) {
  if (!user.expiresAt || user.expiresAt === 'Vĩnh viễn' || user.expiresAt === 'forever') return false;
  const expDate = new Date(user.expiresAt);
  if (isNaN(expDate.getTime())) return false;
  expDate.setHours(23, 59, 59, 999);
  return Date.now() > expDate.getTime();
}

// Phân tích URL Google Sheet: nhận diện dạng CSV trực tiếp hoặc Apps Script Web App
function parseGoogleSheetUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  const cleanUrl = urlStr.trim();

  // Dạng 1: Link bảng tính Google Sheets trực tiếp (ví dụ: https://docs.google.com/spreadsheets/d/XXX/edit#gid=0)
  if (cleanUrl.includes('docs.google.com/spreadsheets/d/')) {
    const idMatch = cleanUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch) return null;
    const sheetId = idMatch[1];
    const gidMatch = cleanUrl.match(/[#&?]gid=([0-9]+)/);
    const gid = gidMatch ? gidMatch[1] : '0';
    return {
      type: 'csv',
      sheetId,
      gid,
      exportUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`
    };
  }

  // Dạng 2: Google Apps Script Web App (ví dụ: https://script.google.com/macros/s/XXX/exec)
  if (cleanUrl.includes('script.google.com')) {
    return {
      type: 'webapp',
      url: cleanUrl
    };
  }

  return { type: 'unknown', url: cleanUrl };
}

// Phân tích chuỗi CSV từ Google Sheet thành danh sách tài khoản
function parseCSVRows(csvText) {
  if (!csvText || typeof csvText !== 'string') return [];
  const lines = [];
  let row = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const c = csvText[i];
    const next = csvText[i + 1];

    if (c === '"') {
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      row.push(cur.trim());
      cur = '';
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      if (c === '\r' && next === '\n') i++;
      row.push(cur.trim());
      if (row.some(cell => cell.length > 0)) {
        lines.push(row);
      }
      row = [];
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur.trim());
    if (row.some(cell => cell.length > 0)) {
      lines.push(row);
    }
  }

  if (lines.length <= 1) return [];

  // Bỏ qua dòng tiêu đề (Header 0), đọc từ dòng 1 đến hết
  const usersList = [];
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i];
    const username = String(r[0] || '').trim();
    if (!username) continue;

    const password = String(r[1] || '').trim();
    const name = String(r[2] || username).trim();
    const maxStreams = Math.max(1, parseInt(r[3]) || 1);
    
    let expiresAt = String(r[4] || '').trim();
    if (['vĩnh viễn', 'forever', 'all', 'null', ''].includes(expiresAt.toLowerCase())) {
      expiresAt = null;
    }

    const rawAllowed = String(r[5] || 'all').trim();
    const allowedServers = rawAllowed.toLowerCase() === 'all' 
      ? ['all'] 
      : rawAllowed.split(',').map(s => s.trim().toLowerCase());

    const status = String(r[6] || 'Active').trim();
    const role = String(r[7] || (username.toLowerCase() === 'admin' ? 'admin' : 'user')).trim().toLowerCase();
    const notes = String(r[8] || '').trim();

    usersList.push({
      username,
      password,
      name,
      maxStreams,
      expiresAt,
      allowedServers,
      status,
      role,
      notes
    });
  }
  return usersList;
}

/**
 * Xác thực đăng nhập (Hỗ trợ xác thực TRỰC TIẾP lên Google Sheet)
 */
async function authenticate(username, password) {
  if (!username || !password) return null;
  const cleanUsername = username.trim().toLowerCase();

  // 1. Kiểm tra tài khoản Master Admin cục bộ trước (đảm bảo Admin không bao giờ bị lockout)
  const localAdmin = users.find(u => u.username.toLowerCase() === cleanUsername && u.role === 'admin');
  if (localAdmin && localAdmin.password === password) {
    const token = 'token_' + crypto.randomBytes(24).toString('hex');
    const sessionData = {
      token,
      userId: localAdmin.id,
      username: localAdmin.username,
      name: localAdmin.name || 'Quản Trị Viên',
      role: 'admin',
      maxStreams: 999,
      allowedServers: ['all'],
      expiresAt: null,
      loginAt: new Date().toISOString()
    };
    activeSessions.set(token, sessionData);
    return { token, user: sessionData };
  }

  // 2. XÁC THỰC TRỰC TIẾP LÊN GOOGLE SHEET (NẾU ĐÃ CẤU HÌNH LINK SHEET)
  if (sheetConfig.googleSheetScriptUrl && sheetConfig.googleSheetScriptUrl.startsWith('http')) {
    const parsedTarget = parseGoogleSheetUrl(sheetConfig.googleSheetScriptUrl);

    // TRƯỜNG HỢP A: KẾT NỐI THẲNG QUA GOOGLE APPS SCRIPT WEB APP
    if (parsedTarget && parsedTarget.type === 'webapp') {
      try {
        console.log(`[UserManager] ⚡ Đang xác thực trực tiếp tài khoản [${cleanUsername}] với Google Sheet Web App...`);
        const targetUrl = `${parsedTarget.url}${parsedTarget.url.includes('?') ? '&' : '?'}action=auth&username=${encodeURIComponent(cleanUsername)}&password=${encodeURIComponent(password)}&secret=${encodeURIComponent(sheetConfig.syncSecret)}`;
        
        const res = await fetchWithRedirect(targetUrl, 5);
        if (res.data) {
          if (res.data.error) {
            return { error: res.data.error };
          }
          if (res.data.ok && res.data.user) {
            const u = res.data.user;
            const token = 'token_' + crypto.randomBytes(24).toString('hex');
            const sessionData = {
              token,
              userId: u.id || ('usr_' + u.username),
              username: u.username,
              name: u.name || u.username,
              role: u.role || 'user',
              maxStreams: parseInt(u.maxStreams) || 1,
              allowedServers: u.allowedServers || ['all'],
              expiresAt: u.expiresAt || null,
              loginAt: new Date().toISOString()
            };
            activeSessions.set(token, sessionData);

            // Ghi nhận vào cache users.json
            const existingIdx = users.findIndex(x => x.username.toLowerCase() === cleanUsername);
            if (existingIdx !== -1) {
              users[existingIdx] = { ...users[existingIdx], ...sessionData, token: undefined, password, active: true };
            } else {
              users.push({ id: sessionData.userId, ...sessionData, token: undefined, password, active: true, createdAt: new Date().toISOString() });
            }
            saveUsers();

            console.log(`[UserManager] ✅ Xác thực trực tiếp từ Google Sheet thành công: [${cleanUsername}] (${sessionData.maxStreams} luồng)`);
            return { token, user: sessionData };
          }
        }
      } catch (sheetErr) {
        console.error(`[UserManager] ⚠️ Lỗi kết nối Google Sheet Web App (${sheetErr.message}). Đang thử kiểm tra qua bộ nhớ đệm...`);
      }
    }

    // TRƯỜNG HỢP B: KẾT NỐI THẲNG QUA LINK GOOGLE SHEET CSV EXPORT
    if (parsedTarget && parsedTarget.type === 'csv') {
      try {
        console.log(`[UserManager] ⚡ Đang đọc trực tiếp dữ liệu từ Google Sheet cho tài khoản [${cleanUsername}]...`);
        const res = await fetchWithRedirect(parsedTarget.exportUrl, 5);
        const csvContent = res.raw || (typeof res.data === 'string' ? res.data : '');
        
        if (csvContent) {
          const sheetUsers = parseCSVRows(csvContent);
          const found = sheetUsers.find(u => u.username.toLowerCase() === cleanUsername);

          if (!found) {
            return { error: 'Tài khoản không tồn tại trên Google Sheet!' };
          }

          if (found.password !== password) {
            return { error: 'Mật khẩu không chính xác!' };
          }

          const statusClean = String(found.status || 'Active').toLowerCase();
          if (statusClean === 'inactive' || statusClean === 'lock') {
            return { error: 'Tài khoản của bạn đang bị tạm khóa trên Google Sheet. Vui lòng liên hệ Admin!' };
          }

          if (isUserExpired(found)) {
            return { error: `Tài khoản đã hết hạn sử dụng vào ngày ${found.expiresAt} trên Sheet!` };
          }

          const token = 'token_' + crypto.randomBytes(24).toString('hex');
          const sessionData = {
            token,
            userId: 'usr_' + found.username,
            username: found.username,
            name: found.name || found.username,
            role: found.role || 'user',
            maxStreams: found.maxStreams || 1,
            allowedServers: found.allowedServers || ['all'],
            expiresAt: found.expiresAt || null,
            loginAt: new Date().toISOString()
          };
          activeSessions.set(token, sessionData);

          // Cập nhật bộ nhớ đệm
          const existingIdx = users.findIndex(x => x.username.toLowerCase() === cleanUsername);
          if (existingIdx !== -1) {
            users[existingIdx] = { ...users[existingIdx], ...sessionData, token: undefined, password, active: true };
          } else {
            users.push({ id: sessionData.userId, ...sessionData, token: undefined, password, active: true, createdAt: new Date().toISOString() });
          }
          saveUsers();

          console.log(`[UserManager] ✅ Xác thực trực tiếp từ Google Sheet CSV thành công: [${cleanUsername}] (${sessionData.maxStreams} luồng)`);
          return { token, user: sessionData };
        }
      } catch (sheetErr) {
        console.error(`[UserManager] ⚠️ Lỗi đọc Google Sheet CSV (${sheetErr.message}). Đang thử kiểm tra qua bộ nhớ đệm...`);
      }
    }
  }

  // 3. Fallback: Kiểm tra trong bộ nhớ đệm users.json
  const user = users.find(u => u.username.toLowerCase() === cleanUsername);
  if (!user) {
    return { error: sheetConfig.googleSheetScriptUrl ? 'Tài khoản không tồn tại trên Google Sheet!' : 'Tài khoản không tồn tại trên hệ thống!' };
  }

  if (user.password !== password) {
    return { error: 'Mật khẩu không chính xác!' };
  }

  if (user.active === false) {
    return { error: 'Tài khoản của bạn đang bị tạm khóa. Vui lòng liên hệ Admin!' };
  }

  if (isUserExpired(user)) {
    return { error: `Tài khoản đã hết hạn sử dụng vào ngày ${user.expiresAt}!` };
  }

  const token = 'token_' + crypto.randomBytes(24).toString('hex');
  const sessionData = {
    token,
    userId: user.id,
    username: user.username,
    name: user.name || user.username,
    role: user.role || 'user',
    maxStreams: parseInt(user.maxStreams) || 1,
    allowedServers: user.allowedServers || ['all'],
    expiresAt: user.expiresAt || null,
    loginAt: new Date().toISOString()
  };

  activeSessions.set(token, sessionData);

  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      name: user.name || user.username,
      role: user.role || 'user',
      maxStreams: parseInt(user.maxStreams) || 1,
      allowedServers: user.allowedServers || ['all'],
      expiresAt: user.expiresAt || null
    }
  };
}

function getUserByToken(token) {
  if (!token) return null;
  const s = activeSessions.get(token);
  if (!s) return null;
  if (s.loginAt && Date.now() - new Date(s.loginAt).getTime() > SESSION_TTL_MS) {
    activeSessions.delete(token);
    return null;
  }
  return { ...s, id: s.userId || s.id };
}

// Thu hồi phiên của khách đã bị khóa / xóa / hết hạn trên Sheet (không đụng tới admin)
function revokeInvalidSessions() {
  let revoked = 0;
  for (const [token, s] of Array.from(activeSessions.entries())) {
    if (s.role === 'admin') continue;
    const u = users.find(x => x.username.toLowerCase() === String(s.username).toLowerCase());
    if (!u || u.active === false || isUserExpired(u)) {
      activeSessions.delete(token);
      revoked++;
    }
  }
  if (revoked) console.log(`[UserManager] 🔒 Đã thu hồi ${revoked} phiên của tài khoản bị khóa/xóa/hết hạn.`);
  return revoked;
}

let autoSyncTimer = null;
function startAutoSync() {
  if (autoSyncTimer) return;
  autoSyncTimer = setInterval(async () => {
    const url = sheetConfig.googleSheetScriptUrl;
    if (!url || !url.startsWith('http')) return;
    try {
      const r = await fetchUsersDirectFromSheet();
      if (r && r.error) console.warn('[UserManager] Tự đồng bộ Sheet thất bại:', r.error);
    } catch (e) {
      console.warn('[UserManager] Tự đồng bộ Sheet lỗi:', e.message);
    }
  }, Math.max(1, parseInt(sheetConfig.autoSyncIntervalMinutes) || 5) * 60 * 1000);
  if (autoSyncTimer.unref) autoSyncTimer.unref();
}

function revokeToken(token) {
  if (token) activeSessions.delete(token);
}

function changeUserPassword(userId, currentPassword, newPassword) {
  const user = users.find(u => u.id === userId);
  if (!user) return { error: 'Không tìm thấy người dùng!' };
  if (user.password !== currentPassword) return { error: 'Mật khẩu hiện tại không đúng!' };
  if (!newPassword || newPassword.length < 4) return { error: 'Mật khẩu mới phải có ít nhất 4 ký tự!' };
  user.password = newPassword;
  user.updatedAt = new Date().toISOString();
  saveUsers();
  return { ok: true, msg: 'Đổi mật khẩu thành công!' };
}

function listUsers(includeSensitive = false) {
  return users.map(u => {
    const data = {
      id: u.id,
      username: u.username,
      name: u.name || u.username,
      role: u.role || 'user',
      maxStreams: parseInt(u.maxStreams) || 1,
      allowedServers: u.allowedServers || ['all'],
      expiresAt: u.expiresAt || null,
      active: u.active !== false,
      notes: u.notes || '',
      isExpired: isUserExpired(u),
      createdAt: u.createdAt || null,
      updatedAt: u.updatedAt || null
    };
    if (includeSensitive) {
      data.password = u.password;
    }
    return data;
  });
}

function upsertUser(userData) {
  if (!userData.username || !userData.username.trim()) {
    return { error: 'Tên đăng nhập không được để trống!' };
  }
  const cleanUsername = userData.username.trim().toLowerCase();
  let user = users.find(u => u.username.toLowerCase() === cleanUsername);

  if (user) {
    if (userData.password) user.password = userData.password;
    if (userData.name !== undefined) user.name = userData.name;
    if (userData.maxStreams !== undefined) user.maxStreams = parseInt(userData.maxStreams) || 1;
    if (userData.expiresAt !== undefined) user.expiresAt = userData.expiresAt;
    if (userData.allowedServers !== undefined) user.allowedServers = userData.allowedServers;
    if (userData.active !== undefined) user.active = !!userData.active;
    if (userData.role !== undefined) user.role = userData.role;
    if (userData.notes !== undefined) user.notes = userData.notes;
    user.updatedAt = new Date().toISOString();
  } else {
    if (!userData.password) {
      return { error: 'Vui lòng cung cấp mật khẩu cho người dùng mới!' };
    }
    user = {
      id: 'usr_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6),
      username: cleanUsername,
      password: userData.password,
      name: userData.name || cleanUsername,
      role: userData.role || 'user',
      maxStreams: parseInt(userData.maxStreams) || 1,
      allowedServers: userData.allowedServers || ['all'],
      expiresAt: userData.expiresAt || null,
      active: userData.active !== false,
      notes: userData.notes || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    users.push(user);
  }

  saveUsers();
  revokeInvalidSessions();
  return { ok: true, user };
}

function deleteUser(userId) {
  const index = users.findIndex(u => u.id === userId);
  if (index === -1) return { error: 'Không tìm thấy người dùng!' };
  if (users[index].role === 'admin' && users.filter(u => u.role === 'admin').length <= 1) {
    return { error: 'Không thể xóa tài khoản Admin duy nhất của hệ thống!' };
  }
  const deleted = users.splice(index, 1);
  saveUsers();
  revokeInvalidSessions();
  return { ok: true, deleted: deleted[0] };
}

function syncFromGoogleSheet(sheetRows, secretKey) {
  if (sheetConfig.syncSecret && secretKey !== sheetConfig.syncSecret) {
    return { error: 'Secret Key đồng bộ không chính xác!' };
  }

  if (!Array.isArray(sheetRows)) {
    return { error: 'Dữ liệu Google Sheet không hợp lệ (cần danh sách hàng)!' };
  }

  let added = 0;
  let updated = 0;

  sheetRows.forEach(row => {
    if (!row || !row.username) return;
    const cleanUsername = String(row.username).trim().toLowerCase();
    if (!cleanUsername) return;

    let allowed = ['all'];
    if (row.allowedServers) {
      if (Array.isArray(row.allowedServers)) allowed = row.allowedServers;
      else allowed = String(row.allowedServers).split(',').map(s => s.trim().toLowerCase());
    }

    const maxStreams = Math.max(1, parseInt(row.maxStreams) || 1);
    let expiresAt = row.expiresAt ? String(row.expiresAt).trim() : null;
    if (expiresAt === 'Vĩnh viễn' || expiresAt === 'forever' || expiresAt === '' || expiresAt === 'null') {
      expiresAt = null;
    }

    const active = row.active !== false &&
                   String(row.status || 'Active').trim().toLowerCase() !== 'inactive' && 
                   String(row.status || 'Active').trim().toLowerCase() !== 'lock';

    const existingUser = users.find(u => u.username.toLowerCase() === cleanUsername);

    if (existingUser) {
      if (row.password) existingUser.password = String(row.password).trim();
      if (row.name) existingUser.name = String(row.name).trim();
      existingUser.maxStreams = maxStreams;
      existingUser.expiresAt = expiresAt;
      existingUser.allowedServers = allowed;
      existingUser.active = active;
      if (row.role) existingUser.role = String(row.role).trim().toLowerCase();
      if (row.notes !== undefined) existingUser.notes = String(row.notes).trim();
      existingUser.updatedAt = new Date().toISOString();
      updated++;
    } else {
      users.push({
        id: 'usr_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6),
        username: cleanUsername,
        password: String(row.password || '123456').trim(),
        name: String(row.name || cleanUsername).trim(),
        role: String(row.role || 'user').trim().toLowerCase(),
        maxStreams: maxStreams,
        allowedServers: allowed,
        expiresAt: expiresAt,
        active: active,
        notes: String(row.notes || '').trim(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      added++;
    }
  });

  // Sheet là nguồn sự thật: khách đã bị xóa khỏi Sheet thì khóa trong bộ nhớ đệm (không đụng tới admin)
  if (sheetConfig.googleSheetScriptUrl && sheetRows.length > 0) {
    const inSheet = new Set(sheetRows.filter(r => r && r.username).map(r => String(r.username).trim().toLowerCase()));
    users.forEach(u => {
      if (u.role !== 'admin' && !inSheet.has(String(u.username).toLowerCase()) && u.active !== false) {
        u.active = false;
        u.updatedAt = new Date().toISOString();
      }
    });
  }

  saveUsers();
  sheetConfig.lastSyncTime = new Date().toISOString();
  saveSheetConfig();
  revokeInvalidSessions();

  return {
    ok: true,
    added,
    updated,
    total: users.length,
    lastSyncTime: sheetConfig.lastSyncTime
  };
}

// Chủ động kéo danh sách từ Google Sheet về
async function fetchUsersDirectFromSheet(urlOverride = null) {
  const targetUrl = urlOverride || sheetConfig.googleSheetScriptUrl;
  if (!targetUrl || !targetUrl.startsWith('http')) {
    return { error: 'Chưa cấu hình URL Google Sheet (hỗ trợ link Sheet hoặc Apps Script Web App)!' };
  }

  const parsed = parseGoogleSheetUrl(targetUrl);
  if (parsed && parsed.type === 'csv') {
    try {
      const res = await fetchWithRedirect(parsed.exportUrl, 5);
      const csvContent = res.raw || (typeof res.data === 'string' ? res.data : '');
      if (!csvContent) {
        return { error: 'Không nhận được dữ liệu từ Google Sheet (Hãy chắc chắn sheet đã chia sẻ "Bất kỳ ai có đường liên kết đều có thể xem")' };
      }
      const sheetUsers = parseCSVRows(csvContent);
      if (sheetUsers.length === 0) {
        return { error: 'Sheet không có dữ liệu tài khoản hợp lệ!' };
      }
      const syncRes = syncFromGoogleSheet(sheetUsers, sheetConfig.syncSecret);
      return syncRes;
    } catch (err) {
      return { error: `Lỗi kết nối Google Sheet: ${err.message}` };
    }
  }

  try {
    const fullUrl = `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}action=getUsers&secret=${encodeURIComponent(sheetConfig.syncSecret)}`;
    const res = await fetchWithRedirect(fullUrl, 5);
    if (res.data && res.data.ok && Array.isArray(res.data.users)) {
      const syncRes = syncFromGoogleSheet(res.data.users, sheetConfig.syncSecret);
      return syncRes;
    }
    return { error: (res.data && res.data.error) || 'Phản hồi không hợp lệ từ Google Sheet Web App' };
  } catch (err) {
    return { error: `Lỗi kết nối Google Sheet: ${err.message}` };
  }
}

// Kiểm tra kết nối tới Google Sheet (hỗ trợ cả link Sheet trực tiếp và Web App)
async function testSheetConnection(url, secret) {
  const targetUrl = url || sheetConfig.googleSheetScriptUrl;
  const targetSecret = secret || sheetConfig.syncSecret;
  if (!targetUrl || !targetUrl.startsWith('http')) {
    return { error: 'Vui lòng nhập đường link Google Sheet hoặc Web App!' };
  }

  const parsed = parseGoogleSheetUrl(targetUrl);
  if (parsed && parsed.type === 'csv') {
    try {
      const res = await fetchWithRedirect(parsed.exportUrl, 5);
      const csvContent = res.raw || (typeof res.data === 'string' ? res.data : '');
      if (csvContent && csvContent.length > 5) {
        const users = parseCSVRows(csvContent);
        return {
          ok: true,
          mode: 'csv_direct',
          message: `Kết nối thành công! Đọc được ${users.length} tài khoản từ bảng tính Google Sheet trực tiếp.`,
          totalUsers: users.length
        };
      }
      return { error: 'Google Sheet không trả về dữ liệu. Vui lòng mở quyền "Bất kỳ ai có liên kết đều có thể xem".' };
    } catch (err) {
      return { error: `Lỗi kết nối tới Google Sheet: ${err.message}` };
    }
  }

  try {
    const fullUrl = `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}action=ping&secret=${encodeURIComponent(targetSecret)}`;
    const res = await fetchWithRedirect(fullUrl, 5);
    if (res.data && res.data.ok) {
      return { ok: true, mode: 'webapp', message: res.data.message || 'Kết nối thành công tới Web App!', details: res.data };
    }
    return { error: (res.data && res.data.error) || 'Google Sheet từ chối kết nối (kiểm tra lại Secret Key)' };
  } catch (err) {
    return { error: `Không thể kết nối đến Google Sheet: ${err.message}` };
  }
}

loadSheetConfig();
loadUsers();
startAutoSync();

module.exports = {
  authenticate,
  getUserByToken,
  revokeToken,
  changeUserPassword,
  listUsers,
  upsertUser,
  deleteUser,
  syncFromGoogleSheet,
  fetchUsersDirectFromSheet,
  testSheetConnection,
  isUserExpired,
  getSheetConfig: () => sheetConfig,
  updateSheetConfig: (newCfg) => {
    sheetConfig = { ...sheetConfig, ...newCfg };
    saveSheetConfig();
    return sheetConfig;
  }
};
