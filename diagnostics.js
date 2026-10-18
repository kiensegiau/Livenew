/**
 * diagnostics.js — CỔNG KIỂM TRA SÂU hệ thống (chỉ ĐỌC, không bật/tắt/sửa luồng).
 *
 *  GET  /api/diag                → báo cáo tức thời máy này (?cluster=1 → gom cả cụm)
 *  POST /api/diag/selftest       → chạy thử thật: ffmpeg (đúng kiểu phát tee+fifo), ổ đĩa, mạng tới YouTube/Google/Telegram,
 *                                   Google Sheet, Apps Script tạo bản sao; tùy chọn tải thử 1 file Drive + thử tạo/xóa bản sao.
 *  POST /api/diag/token          → (admin) tạo MÃ KIỂM TRA TỪ XA có hạn giờ — đưa mã này cho người kiểm tra, không cần mật khẩu admin
 *  POST /api/diag/token/revoke   → (admin) thu hồi mã ngay
 *
 * Quyền: admin đăng nhập | máy trong cụm (X-Cluster-Secret) | mã kiểm tra (header X-Diag-Token).
 * Mã kiểm tra CHỈ mở được các đường /api/diag*, không xem được stream key đầy đủ / mật khẩu / secret.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

let D = {};
function init(deps) { D = { ...D, ...deps }; hookConsole(); }

// ── Ghi lại 100 dòng cảnh báo/lỗi gần nhất (đã che key / link RTMP) ──
const recent = [];
let hooked = false;
function redact(s) {
  return String(s)
    .replace(/rtmps?:\/\/[^\s"'|]+/gi, 'rtmp://***')
    .replace(/\b[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}(-[a-z0-9]{4})?\b/gi, '****-key')
    .replace(/(secret=)[^&\s]+/gi, '$1***')
    .slice(0, 400);
}
function hookConsole() {
  if (hooked) return;
  hooked = true;
  for (const level of ['warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      try {
        recent.push({ t: new Date().toISOString(), level, msg: redact(args.map(a => (a && a.stack) ? a.stack : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')) });
        if (recent.length > 100) recent.shift();
      } catch (_) {}
      orig(...args);
    };
  }
}

// ── Mã kiểm tra từ xa (lưu dạng băm trong sheet_config.json, có hạn) ──
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function createToken(hours) {
  const h = Math.min(Math.max(parseFloat(hours) || 24, 0.25), 24 * 7);
  const token = 'diag_' + crypto.randomBytes(18).toString('hex');
  const expiresAt = new Date(Date.now() + h * 3600 * 1000).toISOString();
  D.userManager.updateSheetConfig({ diagTokenHash: sha(token), diagTokenExpires: expiresAt });
  return { token, expiresAt, hours: h };
}
function revokeToken() { D.userManager.updateSheetConfig({ diagTokenHash: '', diagTokenExpires: '' }); }
function tokenInfo() {
  const c = D.userManager.getSheetConfig();
  const active = !!(c.diagTokenHash && c.diagTokenExpires && Date.parse(c.diagTokenExpires) > Date.now());
  return { active, expiresAt: active ? c.diagTokenExpires : null };
}
function checkToken(token) {
  if (!token) return false;
  const c = D.userManager.getSheetConfig();
  if (!c.diagTokenHash || !c.diagTokenExpires || Date.parse(c.diagTokenExpires) <= Date.now()) return false;
  const a = Buffer.from(sha(token)), b = Buffer.from(String(c.diagTokenHash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Tiện ích ──
const ok = (detail, data) => ({ status: 'ok', detail, ...(data ? { data } : {}) });
const warn = (detail, data) => ({ status: 'warn', detail, ...(data ? { data } : {}) });
const fail = (detail, data) => ({ status: 'fail', detail, ...(data ? { data } : {}) });
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what || 'Tác vụ'} quá ${Math.round(ms / 1000)}s`)), ms))]);
async function safe(fn) { try { return await fn(); } catch (e) { return fail(e.message || String(e)); } }
const maskKey = k => (k ? '••••' + String(k).slice(-4) : '');

function ffmpegCmd() {
  const local = path.join(D.rootDir, 'ffmpeg.exe');
  return fs.existsSync(local) ? local : 'ffmpeg';
}
function runFF(args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let err = '', out = '';
    let p;
    try { p = spawn(ffmpegCmd(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { return resolve({ code: -1, err: e.message, ms: 0 }); }
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    p.stdout.on('data', d => { out += d; if (out.length > 20000) out = out.slice(-20000); });
    p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.on('error', e => { clearTimeout(timer); resolve({ code: -1, err: e.message, ms: Date.now() - t0 }); });
    p.on('close', code => { clearTimeout(timer); resolve({ code, out, err, ms: Date.now() - t0 }); });
  });
}

// Đọc commit git hiện tại mà không cần lệnh git
function gitInfo() {
  try {
    const gitDir = path.join(D.rootDir, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return { commit: head.slice(0, 7) };
    const ref = head.slice(5).trim();
    let hash = '';
    const refFile = path.join(gitDir, ref);
    if (fs.existsSync(refFile)) hash = fs.readFileSync(refFile, 'utf8').trim();
    else {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      const line = packed.split(/\r?\n/).find(l => l.endsWith(' ' + ref));
      if (line) hash = line.split(' ')[0];
    }
    return { branch: ref.replace('refs/heads/', ''), commit: hash.slice(0, 7) };
  } catch (_) { return { commit: null }; }
}
// Dấu vân tay các file code chính (so với bản trên máy dev để biết VPS đã cập nhật đúng chưa)
const CODE_FILES = ['server.js', 'userManager.js', 'clusterManager.js', 'failover.js', 'telegramBot.js', 'driveDownloader.js', 'driveQuota.js', 'historySheet.js', 'sheetNodes.js', 'diagnostics.js', 'public/index.html'];
function fileHashes() {
  const out = {};
  for (const f of CODE_FILES) {
    try { out[f] = crypto.createHash('sha1').update(fs.readFileSync(path.join(D.rootDir, f)).toString('utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 10); }
    catch (_) { out[f] = null; }
  }
  return out;
}

function tcpCheck(host, port, ms = 5000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const done = (r) => { try { s.destroy(); } catch (_) {} resolve(r); };
    s.setTimeout(ms, () => done({ ok: false, error: 'quá thời gian' }));
    s.on('connect', () => done({ ok: true, ms: Date.now() - t0 }));
    s.on('error', e => done({ ok: false, error: e.code || e.message }));
  });
}
function httpsCheck(url, ms = 8000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const req = https.get(url, { timeout: ms, headers: { 'User-Agent': 'Mozilla/5.0 LivenewDiag' } }, res => { res.resume(); resolve({ ok: res.statusCode < 500, code: res.statusCode, ms: Date.now() - t0 }); });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'quá thời gian' }); });
    req.on('error', e => resolve({ ok: false, error: e.code || e.message }));
  });
}

// ════════════════ BÁO CÁO TỨC THỜI (nhanh, không tạo gì) ════════════════
async function report() {
  const checks = {};
  const streams = D.getStreams();
  const cfg = D.userManager.getSheetConfig();

  checks.version = ok('Phiên bản code đang chạy', { ...gitInfo(), files: fileHashes(), startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() });

  const role = D.isMaster() ? 'Master' : 'Worker';
  checks.node = (D.roleConfirmed() ? ok : warn)(D.roleConfirmed() ? `${D.nodeId()} (${role})` : `${D.nodeId()} — CHƯA nhận diện được vai trò (IP máy không khớp danh sách cụm)`, {
    id: D.nodeId(), role, roleConfirmed: D.roleConfirmed(), ready: D.streamsReady(), uptimeSec: Math.round(process.uptime()),
    platform: `${os.platform()} ${os.release()}`, node: process.version, pid: process.pid, pm2: !!process.env.pm_id,
  });

  checks.resources = await safe(() => {
    const si = D.sysinfo() || {};
    const data = { cpu: si.cpuUsage, ram: si.ramUsage, disk: si.diskUsage, ramTotal: si.ramTotal, diskTotal: si.diskTotal, cpuModel: si.cpuModel, cores: os.cpus().length, capacityFull: si.capacityFull || null };
    if (si.capacityFull) return fail(`Đầy tài nguyên: ${si.capacityFull} — máy đang từ chối luồng mới`, data);
    if (si.diskUsage >= 85 || si.ramUsage >= 90) return warn(`Tài nguyên cao (CPU ${si.cpuUsage}%, RAM ${si.ramUsage}%, đĩa ${si.diskUsage}%)`, data);
    return ok(`CPU ${si.cpuUsage}% · RAM ${si.ramUsage}% · Đĩa ${si.diskUsage}%`, data);
  });

  checks.ffmpeg = await safe(async () => {
    const r = await runFF(['-hide_banner', '-version'], 10000);
    if (r.code !== 0) return fail(`Không chạy được FFmpeg (${ffmpegCmd()}): ${(r.err || '').slice(0, 200)}`);
    const v = (r.out.split(/\r?\n/)[0] || '').trim();
    return ok(v, { cmd: ffmpegCmd() });
  });

  checks.folders = await safe(() => {
    const res = {};
    for (const [name, dir] of Object.entries(D.dirs)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, `.diag_${process.pid}_${Date.now()}`);
        fs.writeFileSync(f, 'x'); fs.unlinkSync(f);
        res[name] = 'ghi được';
      } catch (e) { res[name] = 'LỖI: ' + e.message; }
    }
    const bad = Object.entries(res).filter(([, v]) => v.startsWith('LỖI'));
    return (bad.length ? fail : ok)(bad.length ? `Không ghi được: ${bad.map(b => b[0]).join(', ')}` : 'Các thư mục làm việc ghi/xóa được', res);
  });

  checks.streams = await safe(() => {
    const byStatus = {};
    const list = streams.map(s => {
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
      return {
        id: s.id, name: s.name || '', status: s.status, owner: s.ownerUsername || 'admin', key: maskKey(s.key),
        source: /drive\.google|^https?:/i.test(s.originalFile || s.file || '') ? 'Drive/link' : path.basename(s.file || ''),
        retry: s.retryCount || 0, liveSince: s.firstLiveTime || null, scheduledTime: s.scheduledTime || null,
        dl: s.status === 'downloading' ? (s.dlPercent != null ? s.dlPercent + '%' : '?') : undefined,
        lastLog: redact(s.lastLog || ''),
      };
    });
    const stuck = list.filter(s => ['reconnecting', 'launching'].includes(s.status) && s.retry >= 10);
    const summary = Object.entries(byStatus).map(([k, v]) => `${k}: ${v}`).join(', ') || 'không có luồng';
    if (stuck.length) return warn(`${summary} — ${stuck.length} luồng lỗi lặp lại ≥10 lần: ${stuck.map(s => '#' + s.id).join(', ')}`, { byStatus, list });
    return ok(summary, { byStatus, list });
  });

  checks.cluster = await safe(async () => {
    const nodes = D.clusterManager.getNodes();
    const peers = nodes.filter(n => n.id !== D.nodeId());
    const res = await Promise.all(peers.map(async n => {
      const t0 = Date.now();
      try {
        const r = await D.clusterManager.callNodeApi(n, '/api/health', 'GET', null, 5000);
        return { id: n.id, name: n.name, ip: n.ip, port: n.port, master: !!n.isMaster, ok: r && r.statusCode === 200, code: r && r.statusCode, ms: Date.now() - t0, activeStreams: r && r.data && r.data.activeStreams, uptimeSec: r && r.data && r.data.uptimeSec };
      } catch (e) { return { id: n.id, name: n.name, ip: n.ip, port: n.port, master: !!n.isMaster, ok: false, error: e.message }; }
    }));
    const masters = nodes.filter(n => n.isMaster).map(n => n.id);
    const down = res.filter(r => !r.ok);
    const data = { self: D.nodeId(), masters, peers: res };
    if (masters.length !== 1) return warn(`Cụm có ${masters.length} Master (${masters.join(', ') || 'không có'}) — nên đúng 1`, data);
    if (down.length) return fail(`${down.length}/${peers.length} máy không phản hồi: ${down.map(d => d.id).join(', ')}`, data);
    return ok(peers.length ? `${peers.length} máy khác đều phản hồi` : 'Chỉ có 1 máy trong cụm', data);
  });

  checks.security = await safe(() => {
    const issues = [];
    const sec = String(cfg.syncSecret || '');
    if (['vebinh_sync_secret_2026', 'DOI_SECRET_NAY_GIONG_CLUSTER_SECRET', 'cluster-secret'].includes(sec)) issues.push('Secret cụm đang là chuỗi MẶC ĐỊNH đã lộ trên GitHub');
    else if (sec.length < 16) issues.push('Secret cụm quá ngắn (<16 ký tự)');
    if (process.env.STRICT_INTERNAL !== '1') issues.push('Chưa bật STRICT_INTERNAL=1');
    if (D.legacyAdminWeak()) issues.push('Tài khoản đăng nhập dự phòng (auth_config) vẫn là mật khẩu mặc định "admin"');
    const root = (D.userManager.listUsers(true) || []).find(u => u.id === 'admin_root' || u.username === 'admin');
    if (root && ['admin', '123456', 'DOI_MAT_KHAU_ADMIN', 'password', '12345678'].includes(String(root.password))) issues.push('Mật khẩu admin gốc quá yếu / mặc định');
    return (issues.length ? warn : ok)(issues.length ? issues.join(' · ') : 'Không thấy cấu hình bảo mật yếu', { issues });
  });

  checks.users = await safe(() => {
    const us = D.userManager.listUsers(false) || [];
    const data = { total: us.length, admins: us.filter(u => u.role === 'admin').map(u => u.username), locked: us.filter(u => !u.active).length, expired: us.filter(u => u.isExpired).length, sheetLinked: !!cfg.googleSheetScriptUrl, lastSyncTime: cfg.lastSyncTime || null };
    return ok(`${data.total} tài khoản · admin: ${data.admins.join(', ') || '—'} · khóa: ${data.locked} · hết hạn: ${data.expired}`, data);
  });

  checks.sheet = await safe(async () => {
    if (!cfg.googleSheetScriptUrl) return warn('Chưa liên kết Google Sheet (dùng tài khoản nội bộ)');
    const r = await withTimeout(D.userManager.testSheetConnection(), 20000, 'Google Sheet');
    return (r && r.ok ? ok : fail)(r && r.ok ? (r.message || 'Kết nối Google Sheet tốt') : ((r && r.error) || 'Không kết nối được Google Sheet'), { lastSyncTime: cfg.lastSyncTime || null });
  });

  checks.driveCopy = await safe(async () => {
    const urls = D.driveQuota.copyUrls();
    if (process.env.DRIVE_AUTO_COPY === '0') return warn('Đã TẮT tự tạo bản sao (DRIVE_AUTO_COPY=0)');
    if (!urls.length) {
      if (!D.isMaster()) return ok('Không có link riêng → khi hết lượt tải sẽ nhờ Master tạo bản sao');
      if (cfg.googleSheetScriptUrl) return warn('Chưa khai link Apps Script tạo bản sao → dùng link Web App của Google Sheet (phải có bản script mới)');
      return fail('Chưa có link Apps Script tạo bản sao nào → Drive hết lượt tải sẽ KHÔNG tự xử lý được');
    }
    const res = await withTimeout(D.driveQuota.checkScripts(), 45000, 'Kiểm tra Apps Script');
    const bad = res.filter(r => !r.ok);
    const data = res.map(r => ({ label: r.label, ok: r.ok, ms: r.ms, error: r.error }));
    if (bad.length === res.length) return fail(`Cả ${res.length} script tạo bản sao đều lỗi`, data);
    if (bad.length) return warn(`${res.length - bad.length}/${res.length} script tạo bản sao hoạt động`, data);
    return ok(`${res.length} script tạo bản sao đều hoạt động`, data);
  });

  checks.telegram = await safe(() => {
    let bc = {};
    try { bc = JSON.parse(fs.readFileSync(path.join(D.rootDir, 'bot_config.json'), 'utf8')); } catch (_) {}
    const data = { tokenSet: !!(bc.token || process.env.TELEGRAM_BOT_TOKEN), polling: bc.polling !== false, admins: (bc.adminIds || []).length, zalo: !!(bc.zalo && bc.zalo.enabled), notifyFromAll: process.env.NOTIFY_FROM_ALL === '1' };
    if (!data.tokenSet) return warn('Chưa cài token bot Telegram — sẽ không có thông báo', data);
    if (!data.admins) return warn('Bot chưa có quản trị viên nào nhận báo cáo (/start với bot)', data);
    return ok(`Bot đã cài · ${data.admins} người nhận${D.isMaster() ? '' : ' · máy Worker chuyển thông báo về Master'}`, data);
  });

  checks.history = await safe(() => {
    const h = D.getHistory();
    return ok(`${h.length} dòng lịch sử · Google Sheet lịch sử: ${process.env.HISTORY_SHEET === '0' ? 'tắt' : 'bật'}`, { count: h.length, last: h.length ? h[h.length - 1].endedAt : null });
  });

  checks.cleanup = ok(D.dailyClean().enabled ? `Dọn cuối ngày lúc ${D.dailyClean().time} (giờ VN), chừa luồng vừa dừng < ${D.dailyClean().keepMin} phút` : 'Đã tắt dọn cuối ngày (DAILY_CLEAN=0)', D.dailyClean());

  checks.failover = await safe(() => {
    const st = D.failoverState() || { enabled: false };
    return (st.enabled === false && D.isMaster() ? warn : ok)(st.enabled === false ? 'Tự chuyển luồng khi máy chết: tắt / chưa chạy trên máy này' : 'Tự chuyển luồng khi máy chết: đang bật', st);
  });

  const errs = recent.filter(r => Date.now() - Date.parse(r.t) < 24 * 3600 * 1000);
  checks.recentErrors = (errs.filter(e => e.level === 'error').length ? warn : ok)(`${errs.length} cảnh báo/lỗi trong 24 giờ (từ lúc khởi động)`, errs.slice(-40));

  const all = Object.values(checks);
  const summary = { ok: all.filter(c => c.status === 'ok').length, warn: all.filter(c => c.status === 'warn').length, fail: all.filter(c => c.status === 'fail').length };
  return { node: D.nodeId(), time: new Date().toISOString(), overall: summary.fail ? 'fail' : summary.warn ? 'warn' : 'ok', summary, checks };
}

// ════════════════ TỰ KIỂM TRA CHỦ ĐỘNG (chạy thử thật, ~20-60 giây) ════════════════
let selftestRunning = false;
let lastSelftestAt = 0;
async function selftest(opts = {}) {
  if (selftestRunning) return { error: 'Đang có một lượt tự kiểm tra chạy, đợi xong rồi thử lại' };
  if (Date.now() - lastSelftestAt < 30000) return { error: 'Vừa tự kiểm tra xong, đợi 30 giây rồi thử lại' };
  selftestRunning = true;
  const tests = {};
  const tmp = path.join(D.dirs.temp || os.tmpdir(), `diag_${Date.now()}`);
  try {
    fs.mkdirSync(tmp, { recursive: true });

    // 1. FFmpeg: tạo video thử H.264/AAC rồi phát lại ĐÚNG kiểu đang dùng (copy + tee + fifo, 2 nhánh A/B) ra file
    tests.ffmpegEncode = await safe(async () => {
      const src = path.join(tmp, 'test.mp4');
      const r = await runFF(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100',
        '-t', '6', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60', '-b:v', '2500k', '-c:a', 'aac', '-b:a', '128k', '-y', src], 90000);
      if (r.code !== 0 || !fs.existsSync(src)) return fail('Không mã hóa được video thử (libx264/aac): ' + (r.err || '').slice(-300));
      const speed = +(6000 / Math.max(1, r.ms)).toFixed(1);
      return (speed < 1 ? warn : ok)(`Mã hóa 6s video 720p mất ${(r.ms / 1000).toFixed(1)}s (nhanh gấp ${speed}× thời gian thực)`, { ms: r.ms, speed, bytes: fs.statSync(src).size });
    });
    tests.ffmpegTeeFifo = await safe(async () => {
      const src = path.join(tmp, 'test.mp4');
      if (!fs.existsSync(src)) return fail('Bỏ qua: không có video thử');
      const a = path.join(tmp, 'a.flv').replace(/\\/g, '/'), b = path.join(tmp, 'b.flv').replace(/\\/g, '/');
      const esc = p => p.replace(/:/g, '\\:');
      const out = `[f=fifo:fifo_format=flv:drop_pkts_on_overflow=1:attempt_recovery=1:recovery_wait_time=5:recover_any_error=1:onfail=ignore]${esc(a)}|[f=fifo:fifo_format=flv:drop_pkts_on_overflow=1:attempt_recovery=1:recovery_wait_time=5:recover_any_error=1:onfail=ignore]${esc(b)}`;
      const r = await runFF(['-hide_banner', '-loglevel', 'error', '-thread_queue_size', '8192', '-stream_loop', '1', '-fflags', '+genpts', '-i', src, '-t', '4',
        '-map', '0', '-c', 'copy', '-flags', '+global_header', '-tag:v', '7', '-tag:a', '10', '-bsf:a', 'aac_adtstoasc', '-f', 'tee', out], 60000);
      const sa = fs.existsSync(a) ? fs.statSync(a).size : 0, sb = fs.existsSync(b) ? fs.statSync(b).size : 0;
      if (r.code !== 0 || sa < 10000 || sb < 10000) return fail('Kiểu phát song song A+B (tee+fifo) lỗi: ' + (r.err || '').slice(-300), { a: sa, b: sb });
      return ok(`Phát song song A+B (copy + tee + fifo) chạy tốt — 2 nhánh ${Math.round(sa / 1024)}KB / ${Math.round(sb / 1024)}KB`, { a: sa, b: sb, ms: r.ms });
    });

    // 2. Ổ đĩa: ghi/đọc 20MB, đo tốc độ
    tests.disk = await safe(() => {
      const f = path.join(tmp, 'disk.bin');
      const buf = crypto.randomBytes(20 * 1024 * 1024);
      const t0 = Date.now(); fs.writeFileSync(f, buf); const w = Date.now() - t0;
      const t1 = Date.now(); const back = fs.readFileSync(f); const rd = Date.now() - t1;
      const same = back.equals(buf); fs.unlinkSync(f);
      const mbps = +(20 / Math.max(0.001, w / 1000)).toFixed(0);
      return (same ? (mbps < 20 ? warn : ok) : fail)(same ? `Ghi 20MB: ${w}ms (~${mbps}MB/s), đọc: ${rd}ms` : 'Dữ liệu đọc lại KHÁC dữ liệu ghi — ổ đĩa có vấn đề', { writeMs: w, readMs: rd });
    });

    // 3. Mạng ra ngoài: YouTube RTMP (A/B), Google Drive, Apps Script, Telegram
    tests.network = await safe(async () => {
      const [ya, yb, drive, script, tg] = await Promise.all([
        tcpCheck('a.rtmp.youtube.com', 1935), tcpCheck('b.rtmp.youtube.com', 1935),
        httpsCheck('https://drive.google.com/'), httpsCheck('https://script.google.com/'), httpsCheck('https://api.telegram.org/'),
      ]);
      const data = { youtubeA: ya, youtubeB: yb, drive, script, telegram: tg };
      const bad = Object.entries(data).filter(([, v]) => !v.ok).map(([k]) => k);
      if (!ya.ok && !yb.ok) return fail('KHÔNG kết nối được máy chủ YouTube RTMP (cổng 1935) — không thể phát live', data);
      return (bad.length ? warn : ok)(bad.length ? `Không tới được: ${bad.join(', ')}` : `YouTube A ${ya.ms}ms · B ${yb.ms}ms · Drive ${drive.ms}ms · Script ${script.ms}ms · Telegram ${tg.ms}ms`, data);
    });

    // 4. Máy khác trong cụm: gọi API có xác thực (đúng secret?) + so phiên bản code
    tests.clusterAuth = await safe(async () => {
      const peers = D.clusterManager.getNodes().filter(n => n.id !== D.nodeId());
      if (!peers.length) return ok('Chỉ có 1 máy trong cụm');
      const mine = gitInfo().commit;
      const myFiles = fileHashes();
      const res = await Promise.all(peers.map(async n => {
        try {
          const r = await D.clusterManager.callNodeApi(n, '/api/diag?scope=version', 'GET', null, 8000);
          if (!r || r.statusCode !== 200 || !r.data || typeof r.data !== 'object' || !r.data.files) return { id: n.id, ok: false, error: r && r.statusCode === 401 ? 'Sai secret cụm (401)' : r && (r.statusCode === 404 || r.statusCode === 200) ? 'Máy này chạy code CŨ (chưa có cổng kiểm tra)' : `HTTP ${r && r.statusCode}` };
          const v = r.data;
          const diff = Object.keys(myFiles).filter(f => v.files && v.files[f] !== myFiles[f]);
          return { id: n.id, ok: true, commit: v.commit, sameCode: diff.length === 0, differentFiles: diff };
        } catch (e) { return { id: n.id, ok: false, error: e.message }; }
      }));
      const bad = res.filter(r => !r.ok), stale = res.filter(r => r.ok && !r.sameCode);
      if (bad.length) return fail(bad.map(b => `${b.id}: ${b.error}`).join(' · '), { mine, peers: res });
      if (stale.length) return warn(`Code KHÁC máy này: ${stale.map(s => `${s.id} (${s.differentFiles.join(', ')})`).join(' · ')}`, { mine, peers: res });
      return ok(`Secret cụm đúng, ${res.length} máy khác chạy CÙNG phiên bản code`, { mine, peers: res });
    });

    // 5. Google Sheet + Apps Script tạo bản sao (không tạo file)
    tests.sheet = await safe(async () => {
      const cfg = D.userManager.getSheetConfig();
      if (!cfg.googleSheetScriptUrl) return warn('Chưa liên kết Google Sheet');
      const r = await withTimeout(D.userManager.testSheetConnection(), 25000, 'Google Sheet');
      return (r && r.ok ? ok : fail)(r && r.ok ? (r.message || 'Kết nối Google Sheet tốt') : ((r && r.error) || 'Lỗi'));
    });
    tests.driveCopyScripts = await safe(async () => {
      const urls = D.driveQuota.copyUrls();
      if (!urls.length) return warn('Chưa khai link Apps Script tạo bản sao riêng');
      const res = await withTimeout(D.driveQuota.checkScripts(), 45000, 'Apps Script');
      const bad = res.filter(r => !r.ok);
      return (bad.length ? (bad.length === res.length ? fail : warn) : ok)(`${res.length - bad.length}/${res.length} script hoạt động`, res.map(r => ({ label: r.label, ok: r.ok, ms: r.ms, error: r.error })));
    });

    // 6. (Tùy chọn) Tải thử 1 file Drive thật + (tùy chọn) thử ĐẦY ĐỦ đường tạo bản sao → tải bản sao → xóa bản sao
    if (opts.driveUrl) {
      const id = D.extractDriveId(String(opts.driveUrl));
      tests.driveDownload = await safe(async () => {
        if (!id) return fail('Link Drive không hợp lệ');
        const t0 = Date.now();
        const file = await withTimeout(D.downloadGoogleDriveFile(String(opts.driveUrl), tmp, () => {}), 15 * 60 * 1000, 'Tải Drive');
        const size = fs.statSync(file).size;
        try { fs.unlinkSync(file); } catch (_) {}
        return ok(`Tải ${(size / 1048576).toFixed(1)}MB trong ${((Date.now() - t0) / 1000).toFixed(1)}s`, { bytes: size, ms: Date.now() - t0 });
      });
      if (opts.driveCopyTest) {
        tests.driveCopyFlow = await safe(async () => {
          if (!id) return fail('Link Drive không hợp lệ');
          const steps = [];
          const t0 = Date.now();
          const copy = await D.driveQuota.callScriptLocal('copy', id).catch(e => ({ error: e.message }));
          if (!copy || !copy.copyId) return fail('Tạo bản sao lỗi: ' + ((copy && copy.error) || 'không rõ'));
          steps.push(`tạo bản sao (${copy.via}) ${Date.now() - t0}ms`);
          let size = 0;
          try {
            const file = await withTimeout(D.downloadGoogleDriveFile(`https://drive.google.com/file/d/${copy.copyId}/view`, tmp, () => {}), 15 * 60 * 1000, 'Tải bản sao');
            size = fs.statSync(file).size; try { fs.unlinkSync(file); } catch (_) {}
            steps.push(`tải bản sao ${(size / 1048576).toFixed(1)}MB`);
          } finally {
            const del = await D.driveQuota.callScriptLocal('delete', copy.copyId, copy.src).catch(e => ({ error: e.message }));
            steps.push(del && del.ok ? `xóa bản sao: ${del.result || 'ok'}` : `XÓA BẢN SAO LỖI: ${(del && del.error) || '?'}`);
            if (!(del && del.ok)) return fail(steps.join(' → '));
          }
          return ok(steps.join(' → '), { ms: Date.now() - t0, bytes: size });
        });
      }
    }

    // 7. Lan sang các máy khác trong cụm (mỗi máy tự chạy phần của mình)
    let peersResult;
    if (opts.cluster && opts.scope !== 'local') {
      const peers = D.clusterManager.getNodes().filter(n => n.id !== D.nodeId());
      peersResult = await Promise.all(peers.map(async n => {
        try {
          const r = await D.clusterManager.callNodeApi(n, '/api/diag/selftest', 'POST', { scope: 'local' }, 5 * 60 * 1000);
          if (r && r.statusCode === 200 && r.data && typeof r.data === 'object' && r.data.tests) return r.data;
          return { node: n.id, error: r && r.data && r.data.error ? r.data.error : `HTTP ${r && r.statusCode}${r && (r.statusCode === 404 || r.statusCode === 200) ? ' (máy chạy code cũ)' : ''}` };
        } catch (e) { return { node: n.id, error: e.message }; }
      }));
    }

    const all = Object.values(tests);
    const summary = { ok: all.filter(c => c.status === 'ok').length, warn: all.filter(c => c.status === 'warn').length, fail: all.filter(c => c.status === 'fail').length };
    return { node: D.nodeId(), time: new Date().toISOString(), overall: summary.fail ? 'fail' : summary.warn ? 'warn' : 'ok', summary, tests, ...(peersResult ? { peers: peersResult } : {}) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    selftestRunning = false;
    lastSelftestAt = Date.now();
  }
}

function versionInfo() { return { node: D.nodeId(), ...gitInfo(), files: fileHashes() }; }

module.exports = { init, report, selftest, versionInfo, createToken, revokeToken, tokenInfo, checkToken, fileHashes, CODE_FILES };
