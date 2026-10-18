/**
 * test_diagnostics.js — Cổng kiểm tra sâu /api/diag*
 *  - Phân quyền: không đăng nhập / khách → 401; admin gốc + admin phụ + máy trong cụm → 200
 *  - Mã kiểm tra từ xa: chỉ mở /api/diag*, KHÔNG mở /api/streams, /api/users..., không tự tạo mã mới; thu hồi → hết tác dụng
 *  - Báo cáo không lộ stream key đầy đủ; gom được báo cáo máy khác trong cụm
 *  - Tự kiểm tra: FFmpeg thật (mã hóa + tee/fifo A/B), ổ đĩa, mạng, phát hiện máy khác chạy code KHÁC
 * Chạy: node test_diagnostics.js   (cần ffmpeg thật trong PATH cho máy A; ~1-2 phút)
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const WORK = path.join(os.tmpdir(), 'livenew_diag_test');
const SECRET = 'diag-test-secret-1234567890';
const FAKE_FF = path.join(WORK, 'fake_ffmpeg.exe');
const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;
let passed = 0, failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(name, cond, detail = '') {
  if (cond) { console.log(G('  ✓ PASS'), name); passed++; }
  else { console.log(R('  ✗ FAIL'), name, detail ? `→ ${String(detail).slice(0, 600)}` : ''); failed++; }
}
const now = new Date().toISOString();
const mkUser = (id, username, password, role) => ({ id, username, password, name: username, role, maxStreams: 2, allowedServers: ['all'], expiresAt: null, active: true, notes: '', createdAt: now, updatedAt: now });
const USERS = [mkUser('admin_root', 'admin', 'rootpw', 'admin'), mkUser('u_boss2', 'boss2', 'b2pw', 'admin'), mkUser('u_khach', 'khach', 'k123', 'user')];
const KEY = 'bbbb-2222-khach-key';
const NODES = [{ id: 'dgA', name: 'dgA', ip: '127.0.0.1', port: 3261, isMaster: true }, { id: 'dgB', name: 'dgB', ip: '127.0.0.1', port: 3262, isMaster: false }];

const procs = [];
function start(id, port, { realFF, streams, tweak } = {}) {
  const dir = path.join(WORK, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(ROOT)) if (/\.js$/.test(f) && !/^test|long_test/.test(f)) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  for (const d of ['videos', 'music', 'temp', 'downloads']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'videos', 'a.mp4'), 'fake');
  if (!realFF) fs.copyFileSync(FAKE_FF, path.join(dir, 'ffmpeg.exe'));
  if (tweak) tweak(dir);
  fs.writeFileSync(path.join(dir, 'cluster_nodes.json'), JSON.stringify(NODES));
  fs.writeFileSync(path.join(dir, 'bot_config.json'), JSON.stringify({ token: '', adminIds: [], password: 'x', polling: false, zalo: { enabled: false }, sentinel: { enabled: false, knownServers: [] } }));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(USERS, null, 2));
  fs.writeFileSync(path.join(dir, 'sheet_config.json'), JSON.stringify({ syncSecret: SECRET, googleSheetScriptUrl: '', directSheetAuth: false, driveCopyUrls: [] }));
  if (streams) fs.writeFileSync(path.join(dir, 'streams_backup.json'), JSON.stringify(streams(dir)));
  const env = { ...process.env, PORT: String(port), NODE_ID: id, CLUSTER_SECRET: SECRET, STRICT_INTERNAL: '1', SKIP_FFMPEG_CLEANUP: '1', HISTORY_SHEET: '0', SHEET_NODES: '0', AUTO_MIGRATE: '0', DRIVE_AUTO_COPY: '0', NODE_PATH: path.join(ROOT, 'node_modules') };
  delete env.ALLOW_APP_UA;
  const out = [];
  const p = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => out.push(d.toString())); p.stderr.on('data', d => out.push(d.toString()));
  procs.push(p);
  return { dir, out, port };
}
async function req(port, method, p, { token, diag, peer, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (diag) headers['X-Diag-Token'] = diag;
  if (peer) headers['X-Cluster-Secret'] = SECRET;
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text();
  let data = null; try { data = JSON.parse(raw); } catch (_) {}
  return { status: r.status, data, raw };
}
async function waitUp(port) {
  for (let i = 0; i < 40; i++) { try { if ((await req(port, 'GET', '/api/health')).status === 200) return true; } catch (_) {} await sleep(500); }
  return false;
}
const login = async (port, u, p) => ((await req(port, 'POST', '/api/login', { body: { username: u, password: p } })).data || {}).token;
const sha10 = f => crypto.createHash('sha1').update(fs.readFileSync(f).toString('utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 10);

// ── Phần 0: kiểm tra mã trong tiến trình (hết hạn / sai mã / thu hồi) ──
function unitTokenTests() {
  console.log(Y('\n[ 0 ] Mã kiểm tra: băm, hạn dùng, thu hồi (kiểm tra trực tiếp module)'));
  const diag = require('./diagnostics');
  let cfg = {};
  diag.init({ userManager: { getSheetConfig: () => cfg, updateSheetConfig: c => { cfg = { ...cfg, ...c }; return cfg; } } });
  const t = diag.createToken(24);
  assert('Tạo mã có tiền tố diag_ và hạn ~24h', /^diag_[0-9a-f]{36}$/.test(t.token) && Math.abs(Date.parse(t.expiresAt) - Date.now() - 864e5) < 5000);
  assert('Chỉ lưu bản băm, không lưu mã gốc', cfg.diagTokenHash && !JSON.stringify(cfg).includes(t.token));
  assert('Mã đúng → hợp lệ', diag.checkToken(t.token) === true);
  assert('Mã sai / rỗng → từ chối', !diag.checkToken(t.token + 'x') && !diag.checkToken('') && !diag.checkToken(undefined));
  assert('Giới hạn hạn dùng tối đa 7 ngày', diag.createToken(10000).hours === 168);
  const t2 = diag.createToken(1);
  assert('Tạo mã mới → mã cũ mất hiệu lực', !diag.checkToken(t.token) && diag.checkToken(t2.token));
  cfg.diagTokenExpires = new Date(Date.now() - 1000).toISOString();
  assert('Mã hết hạn → từ chối', !diag.checkToken(t2.token) && diag.tokenInfo().active === false);
  const t3 = diag.createToken(1); diag.revokeToken();
  assert('Thu hồi → từ chối', !diag.checkToken(t3.token));
}

(async () => {
  try {
    unitTokenTests();
    fs.mkdirSync(WORK, { recursive: true });
    execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/out:' + FAKE_FF, path.join(ROOT, 'test_fixtures', 'fake_ffmpeg.cs')]);
    let hasFF = true; try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (_) { hasFF = false; }
    if (!hasFF) console.log(Y('  (Không có ffmpeg thật trong PATH → phần FFmpeg của máy A sẽ báo lỗi)'));

    const future = new Date(Date.now() + 3 * 864e5).toISOString();
    const A = start('dgA', 3261, { realFF: true });
    const B = start('dgB', 3262, {
      // Máy B: sửa nhẹ giao diện để giả lập "chạy code khác" + có 1 luồng hẹn giờ với stream key thật
      tweak: dir => fs.appendFileSync(path.join(dir, 'public', 'index.html'), '\n<!-- ban cu -->\n'),
      streams: dir => [{ id: 7, name: 'Luồng khách', key: KEY, file: path.join(dir, 'videos', 'a.mp4'), originalFile: path.join(dir, 'videos', 'a.mp4'), mode: 'scheduled', minutes: 0, status: 'scheduled', scheduledTime: future, scheduledMode: 'loop', ownerId: 'u_khach', ownerUsername: 'khach', serverId: 'dgb', createdAt: now, updatedAt: now }],
    });
    assert('2 máy khởi động', (await waitUp(A.port)) && (await waitUp(B.port)));
    await sleep(1500);

    console.log(Y('\n[ 1 ] Phân quyền cổng kiểm tra'));
    const root = await login(A.port, 'admin', 'rootpw');
    const boss2 = await login(A.port, 'boss2', 'b2pw');
    const khach = await login(A.port, 'khach', 'k123');
    assert('Đăng nhập được 3 tài khoản', root && boss2 && khach);
    assert('Không đăng nhập → 401', (await req(A.port, 'GET', '/api/diag')).status === 401);
    assert('Tài khoản khách → 401', (await req(A.port, 'GET', '/api/diag', { token: khach })).status === 401);
    assert('Mã kiểm tra bịa → 401', (await req(A.port, 'GET', '/api/diag', { diag: 'diag_' + 'a'.repeat(36) })).status === 401);
    const rRoot = await req(A.port, 'GET', '/api/diag', { token: root });
    assert('Admin gốc → 200', rRoot.status === 200, rRoot.raw);
    assert('Admin phụ (boss2) → 200', (await req(A.port, 'GET', '/api/diag', { token: boss2 })).status === 200);
    assert('Máy trong cụm (secret) → 200', (await req(A.port, 'GET', '/api/diag', { peer: true })).status === 200);

    console.log(Y('\n[ 2 ] Nội dung báo cáo máy A'));
    const rep = rRoot.data || {};
    const want = ['version', 'node', 'resources', 'ffmpeg', 'folders', 'streams', 'cluster', 'security', 'users', 'sheet', 'driveCopy', 'telegram', 'history', 'cleanup', 'failover', 'recentErrors'];
    const missing = want.filter(k => !(rep.checks && rep.checks[k] && ['ok', 'warn', 'fail'].includes(rep.checks[k].status)));
    assert('Đủ 16 mục kiểm tra, mỗi mục có trạng thái', missing.length === 0, 'thiếu: ' + missing.join(','));
    assert('Có tổng kết ok/warn/fail + overall', rep.summary && typeof rep.summary.ok === 'number' && ['ok', 'warn', 'fail'].includes(rep.overall));
    assert('Dấu vân tay server.js khớp file trên máy dev', rep.checks.version.data.files['server.js'] === sha10(path.join(ROOT, 'server.js')), JSON.stringify(rep.checks.version.data.files));
    assert('Nhận đúng vai trò Master', rep.checks.node.data.role === 'Master' && rep.checks.node.data.roleConfirmed === true, rep.checks.node.detail);
    assert('Cụm: máy dgb phản hồi', rep.checks.cluster.status === 'ok' && rep.checks.cluster.data.peers.some(p => p.id === 'dgb' && p.ok), rep.checks.cluster.detail + ' ' + JSON.stringify(rep.checks.cluster.data));
    assert('Bảo mật: không còn cảnh báo admin/admin (đã bị khóa)', rep.checks.security.status === 'ok' && !/auth_config/.test(rep.checks.security.detail), rep.checks.security.detail);
    const aa = await req(A.port, 'POST', '/api/login', { body: { username: 'admin', password: 'admin' } });
    assert('Đăng nhập admin/admin mặc định → 401 (bị khóa)', aa.status === 401 && !(aa.data && aa.data.token) && /mặc định/.test((aa.data && aa.data.error) || ''), aa.raw);
    assert('admin/admin không vào được /api/streams', (await req(A.port, 'GET', '/api/streams', { token: aa.data && aa.data.token })).status === 401);
    assert('Tài khoản: liệt kê 2 admin', /admin, boss2|boss2, admin/.test(rep.checks.users.detail), rep.checks.users.detail);
    assert('Báo cáo không chứa mật khẩu', !/rootpw|b2pw|k123/.test(rRoot.raw));
    if (hasFF) assert('FFmpeg thật được nhận diện', rep.checks.ffmpeg.status === 'ok' && /ffmpeg version/i.test(rep.checks.ffmpeg.detail), rep.checks.ffmpeg.detail);

    console.log(Y('\n[ 3 ] Mã kiểm tra từ xa qua HTTP'));
    assert('Khách không tạo được mã', (await req(A.port, 'POST', '/api/diag/token', { token: khach, body: { hours: 1 } })).status === 401);
    assert('Máy trong cụm không tạo được mã (403)', (await req(A.port, 'POST', '/api/diag/token', { peer: true, body: { hours: 1 } })).status === 403);
    const tk = await req(A.port, 'POST', '/api/diag/token', { token: root, body: { hours: 24 } });
    const T = tk.data && tk.data.token;
    assert('Admin tạo mã thành công', tk.status === 200 && /^diag_/.test(T || ''), tk.raw);
    assert('Trạng thái mã: đang hoạt động', ((await req(A.port, 'GET', '/api/diag/token', { token: root })).data || {}).active === true);
    assert('Mã → xem báo cáo được (200)', (await req(A.port, 'GET', '/api/diag', { diag: T })).status === 200);
    assert('Mã → KHÔNG xem được /api/streams', (await req(A.port, 'GET', '/api/streams', { diag: T })).status === 401);
    assert('Mã → KHÔNG xem được /api/users/list', (await req(A.port, 'GET', '/api/users/list', { diag: T })).status === 401);
    assert('Mã → KHÔNG dừng được luồng (/api/stop)', (await req(A.port, 'POST', '/api/stop', { diag: T, body: { id: 7, serverId: 'dgB' } })).status === 401);
    assert('Mã → KHÔNG tự tạo mã mới (403)', (await req(A.port, 'POST', '/api/diag/token', { diag: T, body: { hours: 168 } })).status === 403);
    assert('Mã → KHÔNG thu hồi được (403)', (await req(A.port, 'POST', '/api/diag/token/revoke', { diag: T })).status === 403);
    assert('Mã của máy A không dùng được trên máy B', (await req(B.port, 'GET', '/api/diag', { diag: T })).status === 401);

    console.log(Y('\n[ 4 ] Gom báo cáo cả cụm (?cluster=1) bằng mã'));
    const cl = await req(A.port, 'GET', '/api/diag?cluster=1', { diag: T });
    const pB = cl.data && (cl.data.peers || []).find(p => p.node === 'dgb');
    assert('Có báo cáo máy dgB', cl.status === 200 && pB && pB.checks, cl.raw.slice(0, 400));
    assert('dgB nhận đúng vai trò Worker', pB && pB.checks.node.data.role === 'Worker', pB && pB.checks.node.detail);
    const sB = pB && pB.checks.streams.data.list.find(s => s.id === 7);
    assert('Thấy luồng #7 của dgB, key bị che', sB && sB.key === '••••-key' && sB.owner === 'khach', JSON.stringify(sB));
    const st7 = sB && sB.status;
    assert('Toàn bộ phản hồi KHÔNG chứa stream key đầy đủ', !cl.raw.includes(KEY));
    assert('scope=version trả dấu vân tay code', ((await req(A.port, 'GET', '/api/diag?scope=version', { diag: T })).data || {}).files['diagnostics.js'] === sha10(path.join(ROOT, 'diagnostics.js')));

    console.log(Y('\n[ 5 ] Tự kiểm tra đầy đủ (chạy thử thật)'));
    const t0 = Date.now();
    const st = await req(A.port, 'POST', '/api/diag/selftest', { diag: T, body: { cluster: true } });
    console.log(`    (mất ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    const tests = (st.data && st.data.tests) || {};
    assert('Tự kiểm tra trả 200 + đủ mục', st.status === 200 && ['ffmpegEncode', 'ffmpegTeeFifo', 'disk', 'network', 'clusterAuth', 'sheet', 'driveCopyScripts'].every(k => tests[k]), st.raw.slice(0, 500));
    if (hasFF) {
      assert('FFmpeg mã hóa 720p libx264/aac OK', tests.ffmpegEncode && tests.ffmpegEncode.status !== 'fail', tests.ffmpegEncode && tests.ffmpegEncode.detail);
      assert('Phát song song A+B (copy+tee+fifo) OK, 2 nhánh có dữ liệu', tests.ffmpegTeeFifo && tests.ffmpegTeeFifo.status === 'ok' && tests.ffmpegTeeFifo.data.a > 10000 && tests.ffmpegTeeFifo.data.b > 10000, tests.ffmpegTeeFifo && tests.ffmpegTeeFifo.detail);
    }
    assert('Ổ đĩa ghi/đọc 20MB đúng dữ liệu', tests.disk && tests.disk.status !== 'fail', tests.disk && tests.disk.detail);
    assert('Mạng: có kết quả YouTube A/B, Drive, Script, Telegram', tests.network && tests.network.data && ['youtubeA', 'youtubeB', 'drive', 'script', 'telegram'].every(k => k in tests.network.data), tests.network && tests.network.detail);
    console.log('    Mạng:', tests.network && tests.network.detail);
    assert('Phát hiện dgB chạy code KHÁC (public/index.html)', tests.clusterAuth && tests.clusterAuth.status === 'warn' && /dgb.*public\/index\.html/.test(tests.clusterAuth.detail), tests.clusterAuth && tests.clusterAuth.detail);
    const peerST = st.data && (st.data.peers || []).find(p => p.node === 'dgb');
    assert('dgB cũng tự kiểm tra (lan sang cụm)', peerST && peerST.tests && peerST.tests.disk, JSON.stringify(st.data && st.data.peers).slice(0, 400));
    assert('Thư mục tạm diag_tmp đã được dọn', !fs.existsSync(path.join(A.dir, 'diag_tmp')) || fs.readdirSync(path.join(A.dir, 'diag_tmp')).length === 0);
    const again = await req(A.port, 'POST', '/api/diag/selftest', { diag: T, body: {} });
    assert('Chạy lại ngay → bị chặn 30s (429)', again.status === 429, again.raw);
    const stillLive = await req(B.port, 'GET', '/api/streams', { peer: true });
    assert('Luồng #7 trên dgB không bị đụng tới (còn nguyên, giữ trạng thái)', Array.isArray(stillLive.data) && stillLive.data.some(s => s.id === 7 && s.status === st7 && s.key === KEY), stillLive.raw.slice(0, 300));

    console.log(Y('\n[ 6 ] Thu hồi mã'));
    assert('Admin thu hồi mã', (await req(A.port, 'POST', '/api/diag/token/revoke', { token: root })).status === 200);
    assert('Mã đã thu hồi → 401', (await req(A.port, 'GET', '/api/diag', { diag: T })).status === 401);
    assert('sheet_config.json không chứa mã gốc', !fs.readFileSync(path.join(A.dir, 'sheet_config.json'), 'utf8').includes(T));
  } catch (e) {
    console.log(R('LỖI TEST: ' + e.stack));
    failed++;
  } finally {
    procs.forEach(p => { try { p.kill(); } catch (_) {} });
    console.log(`\nKết quả: ${G(passed + ' PASS')}, ${failed ? R(failed + ' FAIL') : '0 FAIL'}`);
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  }
})();
