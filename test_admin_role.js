/**
 * test_admin_role.js — Admin phụ (cấp thêm) phải xem được HẾT như admin gốc.
 *  - Quyền "Admin" / "ADMIN" / "Quản trị viên" (Sheet, users.json cũ) đều là admin
 *  - Cấp / hạ quyền có hiệu lực NGAY trên phiên đang đăng nhập (không cần đăng nhập lại)
 *  - Khóa / xóa admin phụ → mất phiên; admin gốc không thể bị hạ quyền / xóa
 * Chạy: node test_admin_role.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const WORK = path.join(os.tmpdir(), 'livenew_admin_role_test');
const SECRET = 'admin-role-test-secret-123456';
const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;
let passed = 0, failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(name, cond, detail = '') {
  if (cond) { console.log(G('  ✓ PASS'), name); passed++; }
  else { console.log(R('  ✗ FAIL'), name, detail ? `→ ${detail}` : ''); failed++; }
}

const now = new Date().toISOString();
const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
function mkUser(id, username, password, role, extra = {}) {
  return { id, username, password, name: username, role, maxStreams: 2, allowedServers: ['all'], expiresAt: null, active: true, notes: '', createdAt: now, updatedAt: now, ...extra };
}

const procs = [];
function start(id, port, { users, sheetUrl } = {}) {
  const dir = path.join(WORK, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(ROOT)) if (/\.js$/.test(f) && !/^test|long_test/.test(f)) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  for (const d of ['videos', 'music', 'temp', 'downloads']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const vid = path.join(dir, 'videos', 'a.mp4');
  fs.writeFileSync(vid, 'fake');
  fs.writeFileSync(path.join(dir, 'cluster_nodes.json'), JSON.stringify([{ id, name: id, ip: '127.0.0.1', port, isMaster: true }]));
  fs.writeFileSync(path.join(dir, 'bot_config.json'), JSON.stringify({ token: '', adminIds: [], password: 'x', polling: false, zalo: { enabled: false }, sentinel: { enabled: false, knownServers: [] } }));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users, null, 2));
  fs.writeFileSync(path.join(dir, 'sheet_config.json'), JSON.stringify({ syncSecret: SECRET, googleSheetScriptUrl: sheetUrl || '', directSheetAuth: true, driveCopyUrls: [] }));
  // 3 luồng hẹn giờ của 3 chủ khác nhau
  const mk = (sid, owner, ownerId, key) => ({ id: sid, name: 'S' + sid, key, file: vid, originalFile: vid, mode: 'loop', minutes: 0, status: 'scheduled', scheduledTime: future, scheduledMode: 'loop', ownerId, ownerUsername: owner, serverId: id, createdAt: now, updatedAt: now });
  fs.writeFileSync(path.join(dir, 'streams_backup.json'), JSON.stringify([
    mk(1, 'admin', 'admin_root', 'aaaa-1111-root-key'),
    mk(2, 'khach', 'u_khach', 'bbbb-2222-khach-key'),
    mk(3, 'khachkhac', 'u_khac', 'cccc-3333-other-key'),
  ]));
  const env = { ...process.env, PORT: String(port), NODE_ID: id, CLUSTER_SECRET: SECRET, STRICT_INTERNAL: '1', SKIP_FFMPEG_CLEANUP: '1', HISTORY_SHEET: '0', SHEET_NODES: '0', AUTO_MIGRATE: '0', DRIVE_AUTO_COPY: '0', NODE_PATH: path.join(ROOT, 'node_modules') };
  delete env.ALLOW_APP_UA;
  const out = [];
  const p = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => out.push(d.toString())); p.stderr.on('data', d => out.push(d.toString()));
  procs.push(p);
  return out;
}
async function req(port, method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
async function waitUp(port) {
  for (let i = 0; i < 40; i++) { try { if ((await req(port, 'GET', '/api/health')).status === 200) return true; } catch (_) {} await sleep(500); }
  return false;
}
async function login(port, u, p) {
  const r = await req(port, 'POST', '/api/login', null, { username: u, password: p });
  return { token: r.data && r.data.token, user: r.data && r.data.user, status: r.status, error: r.data && r.data.error };
}
async function view(port, token) {
  const me = await req(port, 'GET', '/api/me', token);
  const st = await req(port, 'GET', '/api/streams', token);
  const ul = await req(port, 'GET', '/api/users/list', token);
  const si = await req(port, 'GET', '/api/cluster/sysinfo', token);
  const list = Array.isArray(st.data) ? st.data : [];
  return {
    status: me.status,
    role: me.data && me.data.user && me.data.user.role,
    streams: list.length,
    fullKeys: list.filter(s => !String(s.key).includes('****')).length,
    usersList: ul.status,
    restricted: !!(si.data && si.data.restricted),
  };
}
function isFullAdmin(v) { return v.role === 'admin' && v.streams === 3 && v.fullKeys === 3 && v.usersList === 200 && !v.restricted; }

// Mock Google Sheet Web App (URL chứa "script.google.com" để được nhận diện là Web App)
const SHEET_PORT = 3298;
const sheetRows = [
  { username: 'admin', password: 'rootpw', name: 'Root', maxStreams: 999, expiresAt: null, allowedServers: 'All', status: 'Active', role: 'admin' },
  { username: 'sheetboss', password: 'sb123', name: 'Boss Sheet', maxStreams: 1, expiresAt: null, allowedServers: 'vps9', status: 'Active', role: 'Admin' },
  { username: 'qtv', password: 'qtv123', name: 'QTV', maxStreams: 1, expiresAt: null, allowedServers: 'All', status: 'Active', role: 'Quản trị viên' },
  { username: 'khach', password: 'k123', name: 'Khach', maxStreams: 2, expiresAt: null, allowedServers: 'All', status: 'Active', role: 'user' },
];
function startSheet() {
  return new Promise(resolve => {
    const srv = http.createServer((rq, rs) => {
      const u = new URL(rq.url, 'http://x');
      const q = Object.fromEntries(u.searchParams);
      const send = o => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(o)); };
      if (q.secret !== SECRET) return send({ error: 'Secret Key không chính xác!' });
      if (q.action === 'auth') {
        const row = sheetRows.find(r => r.username === String(q.username).toLowerCase());
        if (!row) return send({ error: 'Tài khoản không tồn tại trên Google Sheet!' });
        if (row.password !== q.password) return send({ error: 'Mật khẩu không chính xác!' });
        // Giống Apps Script BẢN CŨ: trả nguyên văn chữ trong cột Quyền Hạn (không viết thường)
        return send({ ok: true, user: { id: 'usr_' + row.username, username: row.username, name: row.name, role: row.role, maxStreams: row.maxStreams, allowedServers: String(row.allowedServers).split(',').map(s => s.trim().toLowerCase()), expiresAt: row.expiresAt } });
      }
      if (q.action === 'ping') return send({ ok: true });
      return send({ ok: true, users: sheetRows });
    });
    srv.listen(SHEET_PORT, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  let sheetSrv;
  try {
    // ───────────────────────── 1. Không dùng Sheet ─────────────────────────
    console.log(Y('\n[ 1 ] Không dùng Sheet — users.json có quyền viết hoa (dữ liệu cũ)'));
    const P = 3231;
    start('role1', P, {
      users: [
        mkUser('admin_root', 'admin', 'rootpw', 'admin'),
        mkUser('u_boss2', 'boss2', 'b2', 'Admin'),
        mkUser('u_boss3', 'boss3', 'b3', ' ADMIN '),
        mkUser('u_khach', 'khach', 'k123', 'user'),
        mkUser('u_khac', 'khachkhac', 'kk', 'user'),
      ],
    });
    assert('Server khởi động', await waitUp(P));

    const root = await login(P, 'admin', 'rootpw');
    const vRoot = await view(P, root.token);
    assert('Admin gốc xem hết (3 luồng, key đầy đủ, quản lý user, thông số máy)', isFullAdmin(vRoot), JSON.stringify(vRoot));

    const b2 = await login(P, 'boss2', 'b2');
    assert('Đăng nhập admin phụ role "Admin" → role trả về là admin', b2.user && b2.user.role === 'admin', JSON.stringify(b2.user));
    const vB2 = await view(P, b2.token);
    assert('Admin phụ "Admin" xem hết như admin gốc', isFullAdmin(vB2), JSON.stringify(vB2));
    const b3 = await login(P, 'boss3', 'b3');
    assert('Admin phụ " ADMIN " (có khoảng trắng) xem hết', isFullAdmin(await view(P, b3.token)));

    const k = await login(P, 'khach', 'k123');
    const vK = await view(P, k.token);
    assert('Khách thường chỉ thấy luồng của mình, bị chặn quản lý user', vK.role === 'user' && vK.streams === 1 && vK.usersList === 403 && vK.restricted, JSON.stringify(vK));

    console.log(Y('\n[ 2 ] Cấp quyền admin cho khách ĐANG đăng nhập → hiệu lực ngay'));
    const up = await req(P, 'POST', '/api/users/save', root.token, { username: 'khach', role: 'Admin' });
    assert('Admin gốc lưu quyền "Admin" cho khách', up.status === 200 && up.data.user.role === 'admin', JSON.stringify(up.data));
    const vK2 = await view(P, k.token);
    assert('Cùng phiên cũ, khách giờ xem hết như admin (không cần đăng nhập lại)', isFullAdmin(vK2), JSON.stringify(vK2));
    const byB2 = await req(P, 'POST', '/api/users/save', b2.token, { username: 'khachkhac', maxStreams: 5 });
    assert('Admin phụ cũng sửa được tài khoản khách', byB2.status === 200);

    console.log(Y('\n[ 3 ] Hạ quyền / khóa → mất quyền ngay'));
    await req(P, 'POST', '/api/users/save', root.token, { username: 'khach', role: 'user' });
    const vK3 = await view(P, k.token);
    assert('Hạ quyền → phiên cũ quay về khách thường ngay', vK3.role === 'user' && vK3.streams === 1 && vK3.usersList === 403, JSON.stringify(vK3));
    await req(P, 'POST', '/api/users/save', root.token, { username: 'boss3', active: false });
    const lockedMe = await req(P, 'GET', '/api/me', b3.token);
    assert('Khóa admin phụ → phiên bị thu hồi (401)', lockedMe.status === 401, `status=${lockedMe.status}`);
    const relog = await login(P, 'boss3', 'b3');
    assert('Admin phụ bị khóa không đăng nhập lại được', relog.status === 401 && !relog.token, JSON.stringify(relog));

    console.log(Y('\n[ 4 ] Bảo vệ admin gốc'));
    const demoteRoot = await req(P, 'POST', '/api/users/save', b2.token, { username: 'admin', role: 'user' });
    const vRoot2 = await view(P, root.token);
    assert('Không thể hạ quyền admin gốc', demoteRoot.status === 200 && demoteRoot.data.user.role === 'admin' && isFullAdmin(vRoot2), JSON.stringify(vRoot2));
    const delRoot = await req(P, 'POST', '/api/users/delete', b2.token, { id: 'admin_root' });
    assert('Không thể xóa admin gốc', delRoot.status === 400, `status=${delRoot.status}`);
    const delB2 = await req(P, 'POST', '/api/users/delete', root.token, { id: 'u_boss2' });
    const afterDel = await req(P, 'GET', '/api/me', b2.token);
    assert('Xóa admin phụ → phiên của họ bị thu hồi', delB2.status === 200 && afterDel.status === 401, `${delB2.status}/${afterDel.status}`);

    // ───────────────────────── 5. Dùng Google Sheet ─────────────────────────
    console.log(Y('\n[ 5 ] Dùng Google Sheet — cột Quyền Hạn ghi "Admin" / "Quản trị viên"'));
    sheetSrv = await startSheet();
    const P2 = 3232;
    start('role2', P2, {
      users: [mkUser('admin_root', 'admin', 'rootpw', 'admin'), mkUser('u_khach', 'khach', 'k123', 'user'), mkUser('u_khac', 'khachkhac', 'kk', 'user')],
      sheetUrl: `http://127.0.0.1:${SHEET_PORT}/script.google.com/macros/s/TEST/exec`,
    });
    assert('Server (có Sheet) khởi động', await waitUp(P2));
    const sb = await login(P2, 'sheetboss', 'sb123');
    assert('Đăng nhập admin từ Sheet ("Admin") → role admin', sb.user && sb.user.role === 'admin', JSON.stringify(sb.user || sb.error));
    const vSb = await view(P2, sb.token);
    assert('Admin từ Sheet xem hết (dù Sheet ghi Server=vps9, 1 luồng)', isFullAdmin(vSb), JSON.stringify(vSb));
    const q = await login(P2, 'qtv', 'qtv123');
    assert('"Quản trị viên" trên Sheet → admin, xem hết', isFullAdmin(await view(P2, q.token)));
    const sbAgain = await login(P2, 'sheetboss', 'sb123');
    assert('Đăng nhập lần 2 (đi đường bộ nhớ đệm) vẫn là admin', isFullAdmin(await view(P2, sbAgain.token)));
    const ks = await login(P2, 'khach', 'k123');
    const vKs = await view(P2, ks.token);
    assert('Khách từ Sheet vẫn bị giới hạn', vKs.role === 'user' && vKs.streams === 1 && vKs.usersList === 403, JSON.stringify(vKs));

    console.log(Y('\n[ 6 ] Đổi Sheet (cấp admin cho khách) → đồng bộ xong là có quyền ngay'));
    sheetRows.find(r => r.username === 'khach').role = 'ADMIN';
    const sync = await req(P2, 'POST', '/api/users/sync-from-sheet', null, { secret: SECRET, rows: sheetRows });
    assert('Đồng bộ Sheet thành công', sync.status === 200, JSON.stringify(sync.data));
    assert('Phiên cũ của khách giờ xem hết như admin', isFullAdmin(await view(P2, ks.token)));
    sheetRows.splice(sheetRows.findIndex(r => r.username === 'qtv'), 1);
    await req(P2, 'POST', '/api/users/sync-from-sheet', null, { secret: SECRET, rows: sheetRows });
    const qGone = await req(P2, 'GET', '/api/me', q.token);
    assert('Admin phụ bị xóa khỏi Sheet → mất phiên', qGone.status === 401, `status=${qGone.status}`);
    assert('Admin gốc vẫn bình thường', isFullAdmin(await view(P2, (await login(P2, 'admin', 'rootpw')).token)));
  } catch (e) {
    console.log(R('LỖI TEST: ' + e.stack));
    failed++;
  } finally {
    procs.forEach(p => { try { p.kill(); } catch (_) {} });
    if (sheetSrv) sheetSrv.close();
    console.log(`\nKết quả: ${G(passed + ' PASS')}, ${failed ? R(failed + ' FAIL') : '0 FAIL'}`);
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  }
})();
