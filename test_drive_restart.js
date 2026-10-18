/**
 * test_drive_restart.js — ĐỦ trường hợp: đổi link Google Drive / Khởi động lại / Sửa / Khởi động lại server → có tải lại từ Drive đúng lúc không.
 * Chạy: node test_drive_restart.js
 *
 * Không chạm Google/YouTube thật:
 *  - driveDownloader giả: ghi lại link được tải (drive_calls.json), tạo file video giả. Link có id bắt đầu bằng
 *    "S" tải chậm 3s, "E" luôn lỗi (giả lập file Drive không có quyền).
 *  - ffmpeg.exe giả (test_fixtures/fake_ffmpeg.cs, biên dịch bằng csc của .NET Framework): ghi lại file được phát
 *    (ffmpeg_calls.txt), chạy "live" tới khi nhận 'q'. Link http / file không tồn tại → thoát lỗi như ffmpeg thật.
 *  - 2 VPS giả: vps1 Master (3201), vps2 Worker (3202).
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const WORK = path.join(os.tmpdir(), 'livenew_drive_restart_test');
const SECRET = 'drive-test-secret';
const NODES = [
  { id: 'vps1', name: 'VPS 1', ip: '127.0.0.1', port: 3201, isMaster: true },
  { id: 'vps2', name: 'VPS 2', ip: '127.0.0.1', port: 3202, isMaster: false },
];
const FAKE_FF = path.join(WORK, 'fake_ffmpeg.exe');

const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;
let passed = 0, failed = 0;
const procs = {}, logs = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(name, cond, detail = '') {
  if (cond) { console.log(G('  ✓ PASS'), name); passed++; }
  else { console.log(R('  ✗ FAIL'), name, detail ? `→ ${detail}` : ''); failed++; }
}
async function waitFor(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } return null; }

const STUB = `
const real = require('./driveDownloader_real.js');
const fs = require('fs'), path = require('path');
async function downloadGoogleDriveFile(url, dir, onProgress) {
  const log = path.join(__dirname, 'drive_calls.json');
  let calls = []; try { calls = JSON.parse(fs.readFileSync(log, 'utf8')); } catch (_) {}
  calls.push(url); fs.writeFileSync(log, JSON.stringify(calls));
  const id = real.extractDriveId(url) || 'x';
  await new Promise(r => setTimeout(r, id[0] === 'S' ? 3000 : 400));
  if (id[0] === 'E') throw new Error('Không có quyền truy cập file (giả lập)');
  if (onProgress) onProgress(50, 100, 50, 1000);
  const f = path.join(dir, 'drive_video_' + id + '_' + Date.now() + '.mp4');
  fs.writeFileSync(f, 'video-gia-' + id);
  return f;
}
module.exports = { ...real, downloadGoogleDriveFile };
`;

const dirOf = n => path.join(WORK, n.id);
function prepare(n) {
  const dir = dirOf(n);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(ROOT)) if (/\.js$/.test(f) && !/^test|long_test/.test(f)) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.renameSync(path.join(dir, 'driveDownloader.js'), path.join(dir, 'driveDownloader_real.js'));
  fs.writeFileSync(path.join(dir, 'driveDownloader.js'), STUB);
  fs.copyFileSync(FAKE_FF, path.join(dir, 'ffmpeg.exe'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  for (const d of ['videos', 'music', 'temp', 'downloads']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'videos', 'local.mp4'), 'video-local');
  fs.writeFileSync(path.join(dir, 'cluster_nodes.json'), JSON.stringify(NODES));
  fs.writeFileSync(path.join(dir, 'bot_config.json'), JSON.stringify({ token: '', adminIds: [], password: 'x', polling: false, zalo: { enabled: false }, sentinel: { enabled: false, knownServers: [] } }));
  fs.writeFileSync(path.join(dir, 'sheet_config.json'), JSON.stringify({ syncSecret: SECRET, directSheetAuth: false }));
}
function start(n) {
  const out = []; logs[n.id] = out;
  const p = spawn(process.execPath, ['server.js'], {
    cwd: dirOf(n),
    env: { ...process.env, PORT: String(n.port), NODE_ID: n.id, CLUSTER_SECRET: SECRET, STRICT_INTERNAL: '1', SKIP_FFMPEG_CLEANUP: '1', HISTORY_SHEET: '0', SHEET_NODES: '0', AUTO_MIGRATE: '0', NODE_PATH: path.join(ROOT, 'node_modules') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', d => out.push(d.toString()));
  p.stderr.on('data', d => out.push(d.toString()));
  procs[n.id] = p;
}
const kill = id => new Promise(res => { const p = procs[id]; if (!p || p.exitCode !== null) return res(); p.once('exit', res); p.kill(); setTimeout(res, 3000); });
const N = id => NODES.find(n => n.id === id);
async function call(nodeId, method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token; else headers['X-Cluster-Secret'] = SECRET;
  const r = await fetch(`http://127.0.0.1:${N(nodeId).port}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
const healthy = async id => !!(await waitFor(async () => (await call(id, 'GET', '/api/health')).status === 200, 20000));
const driveCalls = id => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(N(id)), 'drive_calls.json'), 'utf8')); } catch (_) { return []; } };
const ffCalls = id => { try { return fs.readFileSync(path.join(dirOf(N(id)), 'ffmpeg_calls.txt'), 'utf8').split(/\r?\n/).filter(Boolean); } catch (_) { return []; } };
const files = id => fs.readdirSync(path.join(dirOf(N(id)), 'downloads')).filter(f => f.startsWith('drive_video_'));
const hasFile = (id, did) => files(id).some(f => f.startsWith('drive_video_' + did));
// Luồng theo góc nhìn Master (gồm cả luồng trên Worker)
const getS = async (sid, serverId = 'vps1', token) => ((await call('vps1', 'GET', '/api/streams', null, token)).data || []).find(s => s.id === sid && s.serverId === serverId);
const waitStatus = (sid, st, serverId = 'vps1', ms = 15000) => waitFor(async () => { const s = await getS(sid, serverId); return s && s.status === st ? s : null; }, ms);
const later = (h = 2) => { const d = new Date(Date.now() + h * 3600e3), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`; };
const ago = () => { const d = new Date(Date.now() - 3600e3), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`; };
const drive = id => `https://drive.google.com/file/d/${id}/view?usp=sharing`;
const id26 = (c, n) => (c.repeat(25) + n).slice(0, 26);
const L = { A: id26('A', '1'), B: id26('B', '2'), C: id26('C', '3'), D: id26('D', '4'), F: id26('F', '6'), G: id26('G', '7'), H: id26('H', '8'), J: id26('J', '9'), K: id26('K', '0'), M: id26('M', '1'), P: id26('P', '2'), Q: id26('Q', '3'), S: id26('S', '5'), E: id26('E', '5') };
const stopS = (sid, serverId = 'vps1') => call('vps1', 'POST', '/api/stop', { id: sid, serverId });
const restartS = (sid, serverId = 'vps1') => call('vps1', 'POST', '/api/restart', { id: sid, serverId });
const editS = (sid, patch, serverId = 'vps1') => call('vps1', 'POST', '/api/edit', { id: sid, serverId, minutes: 0, ...patch });
const lastFF = id => ffCalls(id).slice(-1)[0] || '';

async function run() {
  fs.mkdirSync(WORK, { recursive: true });
  execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/out:' + FAKE_FF, path.join(ROOT, 'test_fixtures', 'fake_ffmpeg.cs')]);
  NODES.forEach(prepare);
  NODES.forEach(start);
  for (const n of NODES) assert(`${n.id} khởi động`, await healthy(n.id));

  console.log(Y('\n[ 1 ] Tạo luồng Drive chạy ngay (link A) → tải rồi phát FILE ĐÃ TẢI (không phát thẳng link)'));
  const K1 = 'k1-aaaa-bbbb-cccc-0001';
  const r1 = await call('vps1', 'POST', '/api/start', { key: K1, file: drive(L.A), mode: 'loop', minutes: 0, name: 'Luồng 1', serverId: 'vps1' });
  const s1 = r1.data && r1.data.id;
  assert('Tạo luồng OK, trạng thái "downloading"', s1 !== undefined && r1.data.status === 'downloading', JSON.stringify(r1));
  assert('Tải xong → LIVE', !!(await waitStatus(s1, 'live')));
  assert('Gọi tải Drive đúng 1 lần link A', driveCalls('vps1').length === 1 && driveCalls('vps1')[0].includes(L.A), JSON.stringify(driveCalls('vps1')));
  assert('ffmpeg phát file đã tải về (drive_video_A...)', /drive_video_A/.test(lastFF('vps1')), lastFF('vps1'));

  console.log(Y('\n[ 2 ] Đang live → nhấn Khởi động lại → bị từ chối, không tải gì'));
  const rr = await restartS(s1);
  assert('Bị từ chối "đang chạy"', rr.status === 400 && /đang chạy/i.test((rr.data || {}).error || ''), JSON.stringify(rr));
  assert('Không tải thêm', driveCalls('vps1').length === 1);

  console.log(Y('\n[ 3 ] Đang live → Sửa sang link B → dừng bản cũ, tải B, phát B'));
  const ffBefore = ffCalls('vps1').length;
  const e3 = await editS(s1, { key: K1, file: drive(L.B), mode: 'loop', name: 'Luồng 1' });
  assert('Sửa OK', e3.status === 200, JSON.stringify(e3));
  assert('Tải link B', !!(await waitFor(() => driveCalls('vps1').length === 2 && driveCalls('vps1')[1].includes(L.B))), JSON.stringify(driveCalls('vps1')));
  assert('Live lại với video B', !!(await waitFor(async () => { const s = await getS(s1); return s && s.status === 'live' && /drive_video_B/.test(lastFF('vps1')) && ffCalls('vps1').length === ffBefore + 1; })), JSON.stringify({ ff: ffCalls('vps1') }));
  const s3 = await getS(s1);
  assert('Link gốc giờ là link B', s3 && String(s3.originalFile).includes(L.B));
  assert('File video cũ (A) bị xóa sau khi ffmpeg cũ thoát (trước đây bị bỏ sót)', !!(await waitFor(() => !hasFile('vps1', L.A), 10000)), JSON.stringify(files('vps1')));

  console.log(Y('\n[ 4 ] Dừng → file tạm bị dọn → Khởi động lại → tự tải lại link B rồi phát'));
  await stopS(s1);
  await waitStatus(s1, 'stopped');
  assert('Dừng xong: file video B bị dọn khỏi đĩa', !!(await waitFor(() => !hasFile('vps1', L.B), 10000)), JSON.stringify(files('vps1')));
  const r4 = await restartS(s1);
  assert('Khởi động lại OK (trước đây báo "File video tạm đã được dọn")', r4.status === 200 && r4.data && r4.data.ok, JSON.stringify(r4));
  assert('Tải lại link B', !!(await waitFor(() => driveCalls('vps1').length === 3 && driveCalls('vps1')[2].includes(L.B))), JSON.stringify(driveCalls('vps1')));
  assert('Live với video B mới tải', !!(await waitFor(async () => { const s = await getS(s1); return s && s.status === 'live' && /drive_video_B/.test(lastFF('vps1')); })));

  console.log(Y('\n[ 5 ] Dừng → Sửa sang link C (đang tắt) → chỉ lưu; Khởi động lại → tải C, phát C'));
  await stopS(s1); await waitStatus(s1, 'stopped');
  const e5 = await editS(s1, { key: K1, file: drive(L.C), mode: 'loop', name: 'Luồng 1' });
  assert('Sửa OK', e5.status === 200, JSON.stringify(e5));
  await sleep(1200);
  const s5 = await getS(s1);
  assert('Đang tắt: vẫn "stopped", CHƯA tải', s5 && s5.status === 'stopped' && driveCalls('vps1').length === 3, JSON.stringify({ st: s5 && s5.status, n: driveCalls('vps1').length }));
  assert('Không còn file video cũ (B) trên đĩa', !!(await waitFor(() => !hasFile('vps1', L.B), 8000)), JSON.stringify(files('vps1')));
  const ffBad = ffCalls('vps1').length;
  const r5 = await restartS(s1);
  assert('Khởi động lại OK', r5.status === 200, JSON.stringify(r5));
  assert('Tải link C', !!(await waitFor(() => driveCalls('vps1').length === 4 && driveCalls('vps1')[3].includes(L.C))), JSON.stringify(driveCalls('vps1')));
  assert('Live với video C, ffmpeg KHÔNG bao giờ nhận link Drive', !!(await waitFor(async () => { const s = await getS(s1); return s && s.status === 'live' && /drive_video_C/.test(lastFF('vps1')); })) && ffCalls('vps1').slice(ffBad).every(f => !/^http/i.test(f)), JSON.stringify(ffCalls('vps1').slice(ffBad)));

  console.log(Y('\n[ 6 ] Dừng → chỉ đổi Stream Key (giữ link C) → Khởi động lại → tải lại C (file cũ đã dọn)'));
  await stopS(s1); await waitStatus(s1, 'stopped');
  const K1b = 'k1-aaaa-bbbb-cccc-000b';
  await editS(s1, { key: K1b, file: drive(L.C), mode: 'loop', name: 'Luồng 1' });
  await sleep(800);
  assert('Đổi key khi tắt: chưa tải', driveCalls('vps1').length === 4);
  const r6 = await restartS(s1);
  assert('Khởi động lại OK', r6.status === 200, JSON.stringify(r6));
  assert('Tải lại link C, live với key mới', !!(await waitFor(async () => { const s = await getS(s1); return driveCalls('vps1').length === 5 && s && s.status === 'live' && s.key === K1b; })), JSON.stringify(driveCalls('vps1')));
  await stopS(s1); await waitStatus(s1, 'stopped');

  console.log(Y('\n[ 7 ] Đang tải (link chậm) → nhấn Khởi động lại → từ chối; nhấn Dừng → tải xong KHÔNG phát, dọn file'));
  const K7 = 'k7-aaaa-bbbb-cccc-0007';
  const r7 = await call('vps1', 'POST', '/api/start', { key: K7, file: drive(L.S), mode: 'loop', minutes: 0, name: 'Luồng chậm', serverId: 'vps1' });
  const s7 = r7.data && r7.data.id;
  await sleep(500);
  const r7b = await restartS(s7);
  assert('Khởi động lại khi đang tải → từ chối', r7b.status === 400, JSON.stringify(r7b));
  const ff7 = ffCalls('vps1').length;
  await stopS(s7);
  await sleep(4000);
  const st7 = await getS(s7);
  assert('Dừng khi đang tải: vẫn "stopped", không chạy ffmpeg', st7 && st7.status === 'stopped' && ffCalls('vps1').length === ff7, JSON.stringify({ st: st7 && st7.status, ff: ffCalls('vps1').slice(ff7) }));
  assert('File vừa tải xong bị dọn', !hasFile('vps1', L.S), JSON.stringify(files('vps1')));

  console.log(Y('\n[ 8 ] Link Drive lỗi (không có quyền) → báo lỗi; Khởi động lại → thử tải lại; sửa link đúng → chạy'));
  const K8 = 'k8-aaaa-bbbb-cccc-0008';
  const r8 = await call('vps1', 'POST', '/api/start', { key: K8, file: drive(L.E), mode: 'loop', minutes: 0, name: 'Luồng lỗi', serverId: 'vps1' });
  const s8 = r8.data && r8.data.id;
  const st8 = await waitStatus(s8, 'ended');
  assert('Tải lỗi → "ended" + lý do "Lỗi tải Drive"', st8 && /Lỗi tải Drive/.test(st8.lastLog || ''), JSON.stringify(st8 && st8.lastLog));
  const nE = driveCalls('vps1').filter(u => u.includes(L.E)).length;
  const r8b = await restartS(s8);
  assert('Khởi động lại → thử tải lại link lỗi', r8b.status === 200 && !!(await waitFor(() => driveCalls('vps1').filter(u => u.includes(L.E)).length === nE + 1)), JSON.stringify(r8b));
  await waitStatus(s8, 'ended');
  await editS(s8, { key: K8, file: drive(L.F), mode: 'loop', name: 'Luồng lỗi' });
  const r8c = await restartS(s8);
  assert('Sửa sang link đúng F + Khởi động lại → tải F, live', r8c.status === 200 && !!(await waitFor(async () => { const s = await getS(s8); return s && s.status === 'live' && /drive_video_F/.test(lastFF('vps1')); })), JSON.stringify(r8c));
  await stopS(s8); await waitStatus(s8, 'stopped');

  console.log(Y('\n[ 9 ] Drive → file trên máy (videos/local.mp4): Khởi động lại → phát file máy, KHÔNG tải'));
  const localPath = path.join(dirOf(N('vps1')), 'videos', 'local.mp4');
  await editS(s1, { key: K1b, file: localPath, mode: 'loop', name: 'Luồng 1' });
  const n9 = driveCalls('vps1').length;
  const r9 = await restartS(s1);
  assert('Khởi động lại OK', r9.status === 200, JSON.stringify(r9));
  assert('Phát file máy, không tải Drive', !!(await waitFor(async () => { const s = await getS(s1); return s && s.status === 'live' && lastFF('vps1') === localPath; })) && driveCalls('vps1').length === n9, JSON.stringify({ ff: lastFF('vps1'), n: driveCalls('vps1').length - n9 }));
  await stopS(s1); await waitStatus(s1, 'stopped');
  assert('Dừng: file của người dùng KHÔNG bị xóa', fs.existsSync(localPath));

  console.log(Y('\n[ 10 ] File trên máy → Drive H: Khởi động lại → tải H'));
  await editS(s1, { key: K1b, file: drive(L.H), mode: 'loop', name: 'Luồng 1' });
  const r10 = await restartS(s1);
  assert('Tải H rồi live', r10.status === 200 && !!(await waitFor(async () => { const s = await getS(s1); return s && s.status === 'live' && /drive_video_H/.test(lastFF('vps1')); })), JSON.stringify(r10));
  await stopS(s1); await waitStatus(s1, 'stopped');

  console.log(Y('\n[ 11 ] Trùng Stream Key với luồng khác đang chạy → Khởi động lại bị chặn, KHÔNG tải'));
  // Luồng 1 đang tắt (key K1b) → một luồng khác bật lên dùng chính key K1b
  const r11a = await call('vps1', 'POST', '/api/start', { key: K1b, file: localPath, mode: 'loop', minutes: 0, name: 'Đang giữ key', serverId: 'vps1' });
  assert('Luồng khác dùng key K1b đang live', !!(r11a.data && r11a.data.id !== undefined && await waitStatus(r11a.data.id, 'live')), JSON.stringify(r11a));
  const n11 = driveCalls('vps1').length;
  const r11 = await restartS(s1);
  assert('Bị chặn vì trùng key', r11.status === 400 && /key/i.test((r11.data || {}).error || ''), JSON.stringify(r11));
  await sleep(1000);
  assert('Không tải Drive khi bị chặn', driveCalls('vps1').length === n11);
  await stopS(r11a.data.id); await waitStatus(r11a.data.id, 'stopped');

  console.log(Y('\n[ 12 ] Sửa sang Drive + đặt lịch nhưng giờ đã qua → báo lỗi, không tải, luồng vẫn tắt'));
  const n12 = driveCalls('vps1').length;
  const e12 = await editS(s1, { key: K1b, file: drive(L.J), mode: 'scheduled', scheduledTime: ago(), scheduledMode: 'loop', name: 'Luồng 1' });
  assert('Báo lỗi giờ đã qua', !!(e12.data && e12.data.error) && /qua/.test(e12.data.error), JSON.stringify(e12));
  await sleep(800);
  const s12 = await getS(s1);
  assert('Không tải, trạng thái "stopped"', driveCalls('vps1').length === n12 && s12 && s12.status === 'stopped', JSON.stringify({ n: driveCalls('vps1').length - n12, st: s12 && s12.status }));

  console.log(Y('\n[ 13 ] Đặt lịch: sửa sang Drive J + giờ tương lai → tải ngay rồi chờ lịch; đang chờ lịch sửa sang K → tải K'));
  const e13 = await editS(s1, { key: K1b, file: drive(L.J), mode: 'scheduled', scheduledTime: later(3), scheduledMode: 'loop', name: 'Luồng 1' });
  assert('Sửa OK', e13.status === 200, JSON.stringify(e13));
  assert('Tải J → chờ lịch, có file J', !!(await waitFor(async () => { const s = await getS(s1); return s && s.status === 'scheduled' && hasFile('vps1', L.J) && driveCalls('vps1').slice(-1)[0].includes(L.J); })), JSON.stringify(await getS(s1)));
  const e13b = await editS(s1, { key: K1b, file: drive(L.K), mode: 'scheduled', scheduledTime: later(3), scheduledMode: 'loop', name: 'Luồng 1' });
  assert('Đang chờ lịch đổi link K → tải K → vẫn chờ lịch', e13b.status === 200 && !!(await waitFor(async () => { const s = await getS(s1); return s && s.status === 'scheduled' && hasFile('vps1', L.K) && String(s.originalFile).includes(L.K); })), JSON.stringify(await getS(s1)));

  console.log(Y('\n[ 14 ] Khách hàng: khách tạo luồng Drive, admin đổi link khi đang live → luồng VẪN thuộc khách'));
  const u = await call('vps1', 'POST', '/api/users/save', { username: 'khach1', password: 'pass-khach-1', name: 'Khách 1', maxStreams: 3 });
  assert('Tạo tài khoản khách', u.status === 200, JSON.stringify(u));
  const lg = await fetch('http://127.0.0.1:3201/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'khach1', password: 'pass-khach-1' }) }).then(r => r.json());
  const tk = lg && lg.token;
  assert('Khách đăng nhập', !!tk, JSON.stringify(lg));
  const K14 = 'k14-aaaa-bbbb-cccc-014';
  const r14 = await call('vps1', 'POST', '/api/start', { key: K14, file: drive(L.M), mode: 'loop', minutes: 0, name: 'Luồng của khách', serverId: 'vps1' }, tk);
  const s14 = r14.data && r14.data.id;
  await waitStatus(s14, 'live');
  const s14a = await getS(s14);
  assert('Luồng do khách tạo thuộc khach1', s14a && s14a.ownerUsername === 'khach1', JSON.stringify([r14, s14a && s14a.ownerUsername]));
  await editS(s14, { key: K14, file: drive(L.P), mode: 'loop', name: 'Luồng của khách' }); // admin sửa
  await waitFor(async () => { const s = await getS(s14); return s && s.status === 'live' && /drive_video_P/.test(lastFF('vps1')); });
  const s14b = await getS(s14);
  assert('Sau khi đổi link: chủ luồng vẫn là khach1 (trước đây bị đổi thành admin)', s14b && s14b.ownerUsername === 'khach1', JSON.stringify(s14b && s14b.ownerUsername));
  const mine = await getS(s14, 'vps1', tk);
  assert('Khách vẫn thấy và quản lý được luồng', !!mine && mine.status === 'live');
  await stopS(s14); await waitStatus(s14, 'stopped');
  const r14c = await call('vps1', 'POST', '/api/restart', { id: s14, serverId: 'vps1' }, tk);
  assert('Khách tự Khởi động lại (file đã dọn) → tải lại P, vẫn của khách', r14c.status === 200 && !!(await waitFor(async () => { const s = await getS(s14); return s && s.status === 'live' && s.ownerUsername === 'khach1'; })), JSON.stringify(r14c));
  await stopS(s14); await waitStatus(s14, 'stopped');

  console.log(Y('\n[ 15 ] Điều phối chéo: luồng trên Worker (vps2), thao tác từ Master'));
  const K15 = 'k15-aaaa-bbbb-cccc-015';
  const r15 = await call('vps1', 'POST', '/api/start', { key: K15, file: drive(L.Q), mode: 'loop', minutes: 0, name: 'Luồng trên Worker', serverId: 'vps2' });
  const s15 = r15.data && r15.data.id;
  assert('Worker tải Q và live', !!(await waitStatus(s15, 'live', 'vps2')) && driveCalls('vps2').some(x => x.includes(L.Q)) && !driveCalls('vps1').some(x => x.includes(L.Q)), JSON.stringify({ v1: driveCalls('vps1').length, v2: driveCalls('vps2') }));
  await stopS(s15, 'vps2'); await waitStatus(s15, 'stopped', 'vps2');
  await editS(s15, { key: K15, file: drive(L.D), mode: 'loop', name: 'Luồng trên Worker' }, 'vps2');
  const r15b = await restartS(s15, 'vps2');
  assert('Sửa link D + Khởi động lại từ Master → WORKER tải D và live', r15b.status === 200 && !!(await waitFor(async () => { const s = await getS(s15, 'vps2'); return s && s.status === 'live' && /drive_video_D/.test(lastFF('vps2')); })), JSON.stringify(r15b));
  await stopS(s15, 'vps2'); await waitStatus(s15, 'stopped', 'vps2');
  assert('Dừng: Worker dọn file D', !!(await waitFor(() => !hasFile('vps2', L.D), 10000)), JSON.stringify(files('vps2')));
  const r15c = await restartS(s15, 'vps2');
  assert('Khởi động lại lần nữa (file đã dọn) → Worker tải lại D', r15c.status === 200 && !!(await waitFor(() => driveCalls('vps2').filter(x => x.includes(L.D)).length === 2)), JSON.stringify(driveCalls('vps2')));
  await waitStatus(s15, 'live', 'vps2');
  // Bấm Dừng rồi Khởi động lại NGAY (ffmpeg cũ chưa kịp thoát, file còn) → dùng lại file, không cần tải
  const n15 = driveCalls('vps2').length;
  await stopS(s15, 'vps2');
  const r15d = await restartS(s15, 'vps2');
  assert('Dừng rồi Khởi động lại ngay → live lại bằng file sẵn có, không tải', r15d.status === 200 && !!(await waitStatus(s15, 'live', 'vps2')) && driveCalls('vps2').length === n15, JSON.stringify({ r15d, dl: driveCalls('vps2').slice(n15) }));
  await sleep(3000);
  assert('File đang phát KHÔNG bị ffmpeg cũ dọn mất', hasFile('vps2', L.D) && (await getS(s15, 'vps2')).status === 'live', JSON.stringify(files('vps2')));

  console.log(Y('\n[ 16 ] Khởi động lại SERVER (Worker vps2): live + file còn → phát lại file cũ, KHÔNG tải'));
  const n16 = driveCalls('vps2').length, ff16 = ffCalls('vps2').length;
  await kill('vps2'); start(N('vps2')); await healthy('vps2');
  assert('Phát lại ngay file đã có, không tải Drive', !!(await waitFor(async () => { const s = await getS(s15, 'vps2'); return s && s.status === 'live' && ffCalls('vps2').length > ff16; }, 20000)) && driveCalls('vps2').length === n16 && /drive_video_D/.test(lastFF('vps2')), JSON.stringify({ dl: driveCalls('vps2').length - n16, ff: ffCalls('vps2').slice(ff16) }));

  console.log(Y('\n[ 17 ] Khởi động lại SERVER: live + file bị mất → tự tải lại rồi phát'));
  await kill('vps2');
  for (const f of files('vps2')) fs.rmSync(path.join(dirOf(N('vps2')), 'downloads', f));
  start(N('vps2')); await healthy('vps2');
  assert('Tải lại D và live', !!(await waitFor(async () => { const s = await getS(s15, 'vps2'); return s && s.status === 'live' && driveCalls('vps2').length === n16 + 1; }, 20000)), JSON.stringify(driveCalls('vps2')));

  console.log(Y('\n[ 18 ] Khởi động lại SERVER (Master vps1): đang chờ lịch + file mất → tải lại; file còn → không tải'));
  await kill('vps1');
  for (const f of files('vps1')) fs.rmSync(path.join(dirOf(N('vps1')), 'downloads', f));
  const n18 = driveCalls('vps1').length;
  start(N('vps1')); await healthy('vps1');
  assert('Chờ lịch + file mất → tải lại K, vẫn chờ lịch', !!(await waitFor(async () => { const s = await getS(s1); return s && s.status === 'scheduled' && hasFile('vps1', L.K) && driveCalls('vps1').length === n18 + 1; }, 20000)), JSON.stringify({ dl: driveCalls('vps1').slice(n18), s: await getS(s1) }));
  await kill('vps1'); start(N('vps1')); await healthy('vps1');
  await sleep(3000);
  assert('Khởi động lại lần nữa (file còn) → không tải', driveCalls('vps1').length === n18 + 1, JSON.stringify(driveCalls('vps1').slice(n18)));

  console.log(Y('\n[ 19 ] Khởi động lại SERVER khi đang tải dở → tải lại'));
  const K19 = 'k19-aaaa-bbbb-cccc-019';
  const r19 = await call('vps1', 'POST', '/api/start', { key: K19, file: drive(L.S), mode: 'loop', minutes: 0, name: 'Tải dở', serverId: 'vps1' });
  await sleep(800);
  const nS = driveCalls('vps1').filter(x => x.includes(L.S)).length;
  await kill('vps1'); start(N('vps1')); await healthy('vps1');
  assert('Tải lại link đang tải dở và live', !!(await waitFor(async () => { const s = await getS(r19.data.id); return s && s.status === 'live' && driveCalls('vps1').filter(x => x.includes(L.S)).length === nS + 1; }, 25000)), JSON.stringify(driveCalls('vps1').slice(-3)));
}

(async () => {
  let code = 0;
  try { await run(); } catch (e) { console.error(R('Lỗi test:'), e); code = 1; }
  for (const id of Object.keys(procs)) await kill(id);
  if (failed > 0) for (const id of Object.keys(logs)) console.log(`\n--- log ${id} ---\n` + logs[id].join('').split('\n').filter(l => /Stream|Drive|Lỗi|lỗi|Cleanup|Restart/.test(l)).slice(-25).join('\n'));
  console.log(`\n═══ Kết quả: ${passed} PASS  ${failed} FAIL ═══`);
  process.exit(failed > 0 || code ? 1 : 0);
})();
