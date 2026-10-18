/**
 * test_drive_quota.js — Drive "HẾT LƯỢT TẢI" → tự tạo bản sao qua Apps Script → tải bản sao → xóa bản sao.
 * Chạy: node test_drive_quota.js
 *
 * Không chạm Google/YouTube thật:
 *  - Chạy CHÍNH file google_apps_script.js trong vm với DriveApp giả (ổ Drive trong RAM).
 *  - Web App giả (HTTP) gọi doGet của script đó. Máy Master có link Web App, Worker KHÔNG có link (phải nhờ Master).
 *  - driveDownloader giả: id bắt đầu "X"/"Z" → lỗi hết lượt tải (DRIVE_QUOTA); bản sao (id "CP...") tải được.
 *    "Z" = file Script không mở được (không chia sẻ). Mọi lượt tải được ghi lại (drive_calls.json).
 *  - ffmpeg.exe giả (test_fixtures/fake_ffmpeg.cs).
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');

const ROOT = __dirname;
const WORK = path.join(os.tmpdir(), 'livenew_drive_quota_test');
const SECRET = 'quota-test-secret';
const SHEET_PORT = 3299;
const NODES = [
  { id: 'vps1', name: 'VPS 1', ip: '127.0.0.1', port: 3211, isMaster: true },
  { id: 'vps2', name: 'VPS 2', ip: '127.0.0.1', port: 3212, isMaster: false },
];
const FAKE_FF = path.join(WORK, 'fake_ffmpeg.exe');
const URL_MAIN = `http://127.0.0.1:${SHEET_PORT}/exec?node=vps1`;
const URL_A = `http://127.0.0.1:${SHEET_PORT}/a/exec`;
const URL_B = `http://127.0.0.1:${SHEET_PORT}/b/exec`;

const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;
let passed = 0, failed = 0;
const procs = {}, logs = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(name, cond, detail = '') {
  if (cond) { console.log(G('  ✓ PASS'), name); passed++; }
  else { console.log(R('  ✗ FAIL'), name, detail ? `→ ${detail}` : ''); failed++; }
}
async function waitFor(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } return null; }

// ── Drive giả trong RAM ──
function makeDrive() {
  const files = new Map(), folders = new Map();
  let seq = 0;
  const iter = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  const mkFolder = name => { const f = { name, getName: () => name, getFiles: () => iter([...files.values()].filter(x => !x.trashed && x.parents.includes(name)).map(wrap)), createFile: (n, content) => { seq++; return wrap(addFile('TF' + String(seq).padStart(10, '0') + 'test', n, [name], { size: String(content).length })); } }; folders.set(name, f); return f; };
  function addFile(id, name, parents = ['root'], extra = {}) { const f = { id, name, desc: '', parents, trashed: false, created: new Date(), size: 1234, sharing: null, ...extra }; files.set(id, f); return f; }
  function wrap(f) {
    return {
      getId: () => f.id, getName: () => f.name, getSize: () => f.size,
      getDescription: () => f.desc, setDescription: d => { f.desc = d; },
      getParents: () => iter(f.parents.map(p => folders.get(p) || { getName: () => p })),
      getDateCreated: () => f.created,
      isTrashed: () => f.trashed, setTrashed: t => { f.trashed = !!t; },
      setSharing: (a, p) => { f.sharing = `${a}/${p}`; },
      makeCopy: (name, folder) => { seq++; const c = addFile('CP' + String(seq).padStart(10, '0') + 'copy', name, [folder.getName()], { size: f.size }); return wrap(c); },
    };
  }
  const DriveApp = {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { VIEW: 'VIEW' },
    getFoldersByName: n => iter(folders.has(n) ? [folders.get(n)] : []),
    createFolder: n => mkFolder(n),
    getFileById: id => { const f = files.get(id); if (!f || f.noAccess) throw new Error('No item with the given ID could be found, or you do not have permission to access it.'); return wrap(f); },
    searchFiles: q => iter(/trashed = true/.test(q) ? [...files.values()].filter(f => f.trashed && f.name.includes('[TAM]')).map(wrap) : []),
  };
  // Drive REST API giả (UrlFetchApp): mode.rest = 204 → xóa vĩnh viễn, khác → lỗi
  const mode = { rest: 204 }, restCalls = [];
  const UrlFetchApp = { fetch: (url, opt) => { restCalls.push({ url, method: opt.method, auth: opt.headers && opt.headers.Authorization }); const m = url.match(/\/files\/([^?]+)/); if (mode.rest === 204 && m) files.delete(decodeURIComponent(m[1])); return { getResponseCode: () => mode.rest }; } };
  const ScriptApp = { getOAuthToken: () => 'token-gia' };
  return { DriveApp, files, folders, addFile, UrlFetchApp, ScriptApp, mode, restCalls };
}

function loadAppsScript(drive, withRest = false, file = 'google_apps_script.js') {
  const ctx = {
    DriveApp: drive.DriveApp,
    ...(withRest ? { UrlFetchApp: drive.UrlFetchApp, ScriptApp: drive.ScriptApp } : {}),
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheets: () => [], getSheetByName: () => null, insertSheet: () => null }), getUi: () => ({}) },
    ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate: d => d.toISOString().slice(0, 10) },
    Logger: { log() {} },
    console,
  };
  vm.createContext(ctx);
  const setSecret = file === 'google_apps_script.js' ? `DEFAULT_CONFIG.SYNC_SECRET = ${JSON.stringify(SECRET)};` : `CAU_HINH.SECRET = ${JSON.stringify(SECRET)};`;
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8') + `\n${setSecret}`, ctx);
  return { doGet: params => JSON.parse(ctx.doGet({ parameter: params }).s), ctx };
}

const STUB = `
const real = require('./driveDownloader_real.js');
const fs = require('fs'), path = require('path');
async function downloadGoogleDriveFile(url, dir, onProgress) {
  const log = path.join(__dirname, 'drive_calls.json');
  let calls = []; try { calls = JSON.parse(fs.readFileSync(log, 'utf8')); } catch (_) {}
  calls.push(url); fs.writeFileSync(log, JSON.stringify(calls));
  const id = real.extractDriveId(url) || 'x';
  await new Promise(r => setTimeout(r, 300));
  if (id[0] === 'X' || id[0] === 'Z') {
    const e = new Error("File này đã vượt quá hạn mức tải xuống của Google Drive trong hôm nay. 👉 Cách sửa: Hãy 'Tạo bản sao' file này trên Drive và dùng link của bản sao đó.");
    e.code = 'DRIVE_QUOTA'; throw e;
  }
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
  fs.writeFileSync(path.join(dir, 'cluster_nodes.json'), JSON.stringify(NODES));
  fs.writeFileSync(path.join(dir, 'bot_config.json'), JSON.stringify({ token: '', adminIds: [], password: 'x', polling: false, zalo: { enabled: false }, sentinel: { enabled: false, knownServers: [] } }));
  // CHỈ Master có link; Worker không có → phải nhờ Master.
  // Master: link Google Sheet (/exec) + 2 Apps Script RIÊNG tạo bản sao trên 2 Gmail khác nhau (/a/exec, /b/exec)
  const cfg = { syncSecret: SECRET, directSheetAuth: false };
  if (n.isMaster) { cfg.googleSheetScriptUrl = URL_MAIN; cfg.driveCopyUrls = [URL_A, URL_B]; }
  fs.writeFileSync(path.join(dir, 'sheet_config.json'), JSON.stringify(cfg));
}
function start(n, extraEnv = {}) {
  const out = []; logs[n.id] = out;
  const p = spawn(process.execPath, ['server.js'], {
    cwd: dirOf(n),
    env: { ...process.env, PORT: String(n.port), NODE_ID: n.id, CLUSTER_SECRET: SECRET, STRICT_INTERNAL: '1', SKIP_FFMPEG_CLEANUP: '1', HISTORY_SHEET: '0', SHEET_NODES: '0', AUTO_MIGRATE: '0', NODE_PATH: path.join(ROOT, 'node_modules'), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', d => out.push(d.toString()));
  p.stderr.on('data', d => out.push(d.toString()));
  procs[n.id] = p;
}
const kill = id => new Promise(res => { const p = procs[id]; if (!p || p.exitCode !== null) return res(); p.once('exit', res); p.kill(); setTimeout(res, 3000); });
const N = id => NODES.find(n => n.id === id);
async function call(nodeId, method, p, body, headersExtra) {
  const headers = { 'Content-Type': 'application/json', 'X-Cluster-Secret': SECRET, ...(headersExtra || {}) };
  Object.keys(headers).forEach(k => headers[k] === null && delete headers[k]);
  const r = await fetch(`http://127.0.0.1:${N(nodeId).port}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
const healthy = async id => !!(await waitFor(async () => (await call(id, 'GET', '/api/health')).status === 200, 20000));
const driveCalls = id => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(N(id)), 'drive_calls.json'), 'utf8')); } catch (_) { return []; } };
const getS = async (sid, serverId) => ((await call('vps1', 'GET', '/api/streams')).data || []).find(s => s.id === sid && s.serverId === serverId);
const waitStatus = (sid, st, serverId, ms = 20000) => waitFor(async () => { const s = await getS(sid, serverId); return s && s.status === st ? s : null; }, ms);
const drive = id => `https://drive.google.com/file/d/${id}/view?usp=sharing`;
const id26 = (c, n) => (c.repeat(25) + n).slice(0, 26);
const logText = id => (logs[id] || []).join('');

async function run() {
  fs.mkdirSync(WORK, { recursive: true });
  execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/out:' + FAKE_FF, path.join(ROOT, 'test_fixtures', 'fake_ffmpeg.cs')]);

  console.log(Y('\n[ 1 ] Apps Script copyDriveFile / deleteDriveCopy (chạy thật trong Drive giả)'));
  {
    const d = makeDrive();
    const ORIG = id26('X', '1');
    d.addFile(ORIG, 'video goc.mp4');
    d.addFile(id26('Z', '1'), 'khong chia se.mp4', ['root'], { noAccess: true });
    const { doGet } = loadAppsScript(d);
    assert('Sai secret → từ chối', !!doGet({ secret: 'sai', action: 'copyDriveFile', id: ORIG }).error);
    assert('ID bậy → từ chối', !!doGet({ secret: SECRET, action: 'copyDriveFile', id: '../x' }).error);
    const c = doGet({ secret: SECRET, action: 'copyDriveFile', id: ORIG });
    const cf = c.copyId && d.files.get(c.copyId);
    assert('Tạo bản sao OK', c.ok && !!cf, JSON.stringify(c));
    assert('Bản sao nằm trong LIVE_BAN_SAO_TAM, có dấu, tên [TAM], chia sẻ bất kỳ ai có link', cf && cf.parents[0] === 'LIVE_BAN_SAO_TAM' && cf.desc === 'livenew-temp-copy' && /^\[TAM\] video goc/.test(cf.name) && cf.sharing === 'ANYONE_WITH_LINK/VIEW', JSON.stringify(cf));
    const delOrig = doGet({ secret: SECRET, action: 'deleteDriveCopy', id: ORIG });
    assert('XÓA FILE GỐC → bị từ chối, file gốc còn nguyên', !!delOrig.error && !d.files.get(ORIG).trashed, JSON.stringify(delOrig));
    // File có dấu nhưng KHÔNG nằm trong thư mục tạm → cũng từ chối
    d.addFile(id26('M', '1'), 'gia dau.mp4', ['root'], { desc: 'livenew-temp-copy' });
    assert('File giả dấu nhưng ngoài thư mục tạm → từ chối', !!doGet({ secret: SECRET, action: 'deleteDriveCopy', id: id26('M', '1') }).error && !d.files.get(id26('M', '1')).trashed);
    const del = doGet({ secret: SECRET, action: 'deleteDriveCopy', id: c.copyId });
    assert('Không gọi được REST → xóa bản sao bằng cách cho vào Thùng rác', del.ok && del.result === 'trashed' && cf.trashed, JSON.stringify(del));
    assert('Xóa lại lần 2 → OK (không lỗi)', doGet({ secret: SECRET, action: 'deleteDriveCopy', id: c.copyId }).ok);
    const z = doGet({ secret: SECRET, action: 'copyDriveFile', id: id26('Z', '1') });
    assert('File Script không mở được → báo lỗi rõ', !!z.error && /không mở được file gốc/.test(z.error), JSON.stringify(z));
    // Bản sao sót > 6 giờ được tự dọn ở lần tạo bản sao kế tiếp
    const c2 = doGet({ secret: SECRET, action: 'copyDriveFile', id: ORIG });
    d.files.get(c2.copyId).created = new Date(Date.now() - 7 * 3600e3);
    const c3 = doGet({ secret: SECRET, action: 'copyDriveFile', id: ORIG });
    assert('Bản sao sót > 6 giờ tự bị dọn', d.files.get(c2.copyId).trashed && !d.files.get(c3.copyId).trashed);
    // Có Drive API nâng cao → xóa hẳn
    const removed = [];
    const { doGet: doGet2, ctx } = loadAppsScript(d);
    ctx.Drive = { Files: { remove: id => { removed.push(id); d.files.delete(id); } } };
    const del3 = doGet2({ secret: SECRET, action: 'deleteDriveCopy', id: c3.copyId });
    assert('Bật Drive API → xóa hẳn (không vào Thùng rác)', del3.ok && del3.result === 'deleted' && removed[0] === c3.copyId, JSON.stringify(del3));

    console.log(Y('\n[ 1b ] XÓA VĨNH VIỄN qua Drive REST API (không cần bật dịch vụ nâng cao)'));
    const { doGet: doR, ctx: ctxR } = loadAppsScript(d, true);
    const c4 = doR({ secret: SECRET, action: 'copyDriveFile', id: ORIG });
    const nRest = d.restCalls.length;
    const del4 = doR({ secret: SECRET, action: 'deleteDriveCopy', id: c4.copyId });
    const call4 = d.restCalls[nRest];
    assert('Xóa bản sao → "deleted", file biến mất hẳn (không nằm Thùng rác)', del4.ok && del4.result === 'deleted' && !d.files.has(c4.copyId), JSON.stringify(del4));
    assert('Gọi DELETE đúng file bản sao, kèm token của Script', call4 && call4.method === 'delete' && call4.url.includes('/drive/v3/files/' + c4.copyId) && call4.auth === 'Bearer token-gia', JSON.stringify(call4));
    const nRest2 = d.restCalls.length;
    doR({ secret: SECRET, action: 'deleteDriveCopy', id: ORIG });
    assert('Yêu cầu xóa file gốc → KHÔNG gọi DELETE, file gốc còn', d.restCalls.length === nRest2 && d.files.has(ORIG) && !d.files.get(ORIG).trashed);
    // REST lỗi (403) → rơi vào Thùng rác; lần tạo bản sao sau REST OK → dọn vĩnh viễn khỏi Thùng rác
    d.mode.rest = 403;
    const c5 = doR({ secret: SECRET, action: 'copyDriveFile', id: ORIG });
    const del5 = doR({ secret: SECRET, action: 'deleteDriveCopy', id: c5.copyId });
    assert('REST lỗi → tạm cho vào Thùng rác', del5.ok && del5.result === 'trashed' && d.files.get(c5.copyId).trashed, JSON.stringify(del5));
    d.mode.rest = 204;
    const trashedBefore = [...d.files.values()].filter(f => f.trashed && f.name.includes('[TAM]')).length;
    const c6 = doR({ secret: SECRET, action: 'copyDriveFile', id: ORIG });
    const trashedAfter = [...d.files.values()].filter(f => f.trashed && f.name.includes('[TAM]')).length;
    assert('Lần tạo bản sao kế tiếp → bản sao tạm kẹt trong Thùng rác bị xóa vĩnh viễn', trashedBefore > 0 && trashedAfter === 0 && !d.files.has(c5.copyId) && c6.ok, JSON.stringify({ trashedBefore, trashedAfter }));
    assert('File gốc vẫn còn nguyên sau khi dọn', d.files.has(ORIG) && !d.files.get(ORIG).trashed);
    doR({ secret: SECRET, action: 'deleteDriveCopy', id: c6.copyId });
    const logs1 = []; ctxR.Logger = { log: s => logs1.push(s) };
    ctxR.capQuyenDrive();
    assert('capQuyenDrive() tự kiểm tra → báo "XÓA VĨNH VIỄN hoạt động", không để lại file thử', logs1.some(s => /XÓA VĨNH VIỄN hoạt động/.test(s)) && ![...d.files.values()].some(f => /kiem-tra-xoa/.test(f.name)), JSON.stringify(logs1));
    d.mode.rest = 403;
    const logs2 = []; ctxR.Logger = { log: s => logs2.push(s) };
    ctxR.capQuyenDrive();
    assert('capQuyenDrive() khi REST lỗi → cảnh báo bật Drive API', logs2.some(s => /Bật Dịch vụ/.test(s)), JSON.stringify(logs2));
    d.mode.rest = 204;
  }

  console.log(Y('\n[ 1c ] Apps Script RIÊNG google_apps_script_copy.js (không cần Sheet)'));
  {
    const d = makeDrive();
    const ORIG = id26('X', '9');
    d.addFile(ORIG, 'video rieng.mp4');
    const { doGet, ctx } = loadAppsScript(d, true, 'google_apps_script_copy.js');
    const p = doGet({ secret: SECRET, action: 'ping' });
    assert('ping → ok, type drive-copy', p.ok && p.type === 'drive-copy', JSON.stringify(p));
    assert('Sai secret → từ chối', !!doGet({ secret: 'sai', action: 'copyDriveFile', id: ORIG }).error);
    assert('Hành động lạ → \"Hành động không hợp lệ\"', /Hành động không hợp lệ/.test(doGet({ secret: SECRET, action: 'getUsers' }).error || ''));
    const c = doGet({ secret: SECRET, action: 'copyDriveFile', id: ORIG });
    assert('Tạo bản sao OK trong LIVE_BAN_SAO_TAM', c.ok && d.files.get(c.copyId) && d.files.get(c.copyId).parents[0] === 'LIVE_BAN_SAO_TAM', JSON.stringify(c));
    assert('Xóa file gốc → từ chối', !!doGet({ secret: SECRET, action: 'deleteDriveCopy', id: ORIG }).error && d.files.has(ORIG));
    const del = doGet({ secret: SECRET, action: 'deleteDriveCopy', id: c.copyId });
    assert('Xóa bản sao → xóa vĩnh viễn', del.ok && del.result === 'deleted' && !d.files.has(c.copyId), JSON.stringify(del));
    const lg = []; ctx.Logger = { log: s => lg.push(s) };
    ctx.capQuyenDrive();
    assert('capQuyenDrive() tự kiểm tra xóa vĩnh viễn', lg.some(s => /XÓA VĨNH VIỄN hoạt động/.test(s)), JSON.stringify(lg));
  }

  console.log(Y('\n[ 2 ] Cụm 2 VPS + 3 Web App giả: Sheet (/exec), Script riêng A (/a/exec, Gmail 1), Script riêng B (/b/exec, Gmail 2)'));
  // Mỗi Gmail 1 ổ Drive riêng; file gốc (chia sẻ bất kỳ ai có link) mở được từ mọi Gmail
  const dMain = makeDrive(), dA = makeDrive(), dB = makeDrive();
  const IDS = { A: id26('X', 'A'), B: id26('X', 'B'), F: id26('X', 'F'), C: id26('X', 'C'), Z: id26('Z', 'Z'), O: id26('X', 'O'), D: id26('X', 'D'), M: id26('X', 'M'), K: id26('X', 'K') };
  for (const dd of [dMain, dA, dB]) Object.values(IDS).forEach(id => dd.addFile(id, `video ${id.slice(-1)}.mp4`, ['root'], id[0] === 'Z' ? { noAccess: true } : {}));
  const sMain = loadAppsScript(dMain, true).doGet;
  const sA = loadAppsScript(dA, true, 'google_apps_script_copy.js').doGet;
  const sB = loadAppsScript(dB, true, 'google_apps_script_copy.js').doGet;
  const reqs = [];
  const mode = { a403: false, aOld: false, bOld: false, failDelete: false };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const params = Object.fromEntries(u.searchParams);
    const who = u.pathname === '/exec' ? 'main' : u.pathname === '/a/exec' ? 'a' : u.pathname === '/b/exec' ? 'b' : u.pathname;
    reqs.push({ who, action: params.action, id: params.id });
    if (who === 'a' && mode.a403) { res.writeHead(403, { 'Content-Type': 'text/html' }); res.end('<html>Truy cập bị từ chối</html>'); return; }
    if (!['main', 'a', 'b'].includes(who)) { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<html>Not found</html>'); return; }
    let out;
    const fn = who === 'main' ? sMain : who === 'a' ? sA : sB;
    if (((who === 'a' && mode.aOld) || (who === 'b' && mode.bOld)) && params.action === 'copyDriveFile') out = { error: 'Hành động không hợp lệ' };
    else if (mode.failDelete && params.action === 'deleteDriveCopy') out = { error: 'Lỗi Drive giả lập' };
    else { try { out = fn(params); } catch (e) { out = { error: e.message }; } }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  await new Promise(r => srv.listen(SHEET_PORT, '127.0.0.1', r));
  const copiesOf = dd => [...dd.files.values()].filter(f => f.parents.includes('LIVE_BAN_SAO_TAM') && !/kiem-tra-xoa/.test(f.name));
  const liveCopies = () => [dMain, dA, dB].flatMap(dd => copiesOf(dd).filter(f => !f.trashed));
  const since = n => reqs.slice(n);
  const copyReqs = (arr, who) => arr.filter(q => q.action === 'copyDriveFile' && (!who || q.who === who));
  const delReqs = (arr, who) => arr.filter(q => q.action === 'deleteDriveCopy' && (!who || q.who === who));
  let K = 0;
  const startOn = (id, serverId = 'vps1') => call('vps1', 'POST', '/api/start', { key: `q-aaaa-bbbb-${String(++K).padStart(4, '0')}`, file: drive(id), mode: 'loop', minutes: 0, name: 'Luồng ' + id.slice(-1), serverId });

  try {
    NODES.forEach(prepare);
    NODES.forEach(n => start(n));
    for (const n of NODES) assert(`${n.id} khởi động`, await healthy(n.id));

    console.log(Y('\n[ 3 ] Master: hết lượt tải → Script #1 (A) tạo bản sao → tải bản sao → LIVE → A xóa vĩnh viễn'));
    let n0 = reqs.length;
    const r3 = await startOn(IDS.A);
    const s3 = r3.data && r3.data.id;
    const st3 = await waitStatus(s3, 'live', 'vps1');
    assert('Luồng LIVE được dù file gốc hết lượt tải', !!st3, JSON.stringify(await getS(s3, 'vps1')));
    const dc = driveCalls('vps1');
    assert('Tải link gốc trước, sau đó tải bản sao (CP...)', dc.length === 2 && dc[0].includes(IDS.A) && /\/d\/CP\d+copy\//.test(dc[1]), JSON.stringify(dc));
    assert('Lần 1 dùng Script A (không đụng Script B, không đụng Sheet)', copyReqs(since(n0), 'a').length === 1 && copyReqs(since(n0)).length === 1 && copyReqs(since(n0))[0].id === IDS.A, JSON.stringify(since(n0)));
    assert('A xóa vĩnh viễn bản sao của chính nó', !!(await waitFor(() => delReqs(since(n0), 'a').length === 1 && copiesOf(dA).length === 0)), JSON.stringify({ r: since(n0), c: copiesOf(dA) }));
    assert('Link gốc của luồng vẫn là link gốc', st3 && String(st3.originalFile).includes(IDS.A), st3 && st3.originalFile);

    console.log(Y('\n[ 4 ] Worker KHÔNG có link → nhờ Master; lần 2 xoay sang Script #2 (B); xóa đúng B'));
    n0 = reqs.length;
    const r4 = await startOn(IDS.B, 'vps2');
    const s4 = r4.data && r4.data.id;
    assert('Luồng trên Worker LIVE', !!(await waitStatus(s4, 'live', 'vps2')), JSON.stringify(await getS(s4, 'vps2')));
    const dc4 = driveCalls('vps2');
    assert('Worker tải gốc rồi tải bản sao', dc4.length === 2 && dc4[0].includes(IDS.B) && /\/d\/CP\d+copy\//.test(dc4[1]), JSON.stringify(dc4));
    assert('Lần 2 dùng Script B (xoay vòng)', copyReqs(since(n0), 'b').length === 1 && copyReqs(since(n0)).length === 1, JSON.stringify(since(n0)));
    assert('Xóa gửi ĐÚNG Script B (không hỏi A)', !!(await waitFor(() => delReqs(since(n0), 'b').length === 1 && copiesOf(dB).length === 0)) && delReqs(since(n0), 'a').length === 0, JSON.stringify(since(n0)));

    console.log(Y('\n[ 5 ] Script A lỗi 403 → tự chuyển sang Script B, luồng vẫn LIVE'));
    mode.a403 = true;
    n0 = reqs.length;
    const r5 = await startOn(IDS.F);
    assert('Luồng LIVE', !!(await waitStatus(r5.data && r5.data.id, 'live', 'vps1')), JSON.stringify(await getS(r5.data && r5.data.id, 'vps1')));
    const cr5 = copyReqs(since(n0));
    assert('Thử A trước (lỗi) rồi B (thành công)', cr5.length === 2 && cr5[0].who === 'a' && cr5[1].who === 'b', JSON.stringify(cr5));
    assert('Bản sao của B bị xóa, A không còn bản sao nào', !!(await waitFor(() => copiesOf(dB).length === 0 && copiesOf(dA).length === 0)));
    assert('Log ghi rõ Script #1 lỗi 403', /Script #1.*403/.test(logText('vps1')));

    console.log(Y('\n[ 6 ] Script A vừa lỗi → 10 phút đẩy xuống cuối: lần sau (đến lượt A) vẫn thử B trước'));
    n0 = reqs.length;
    const r6a = await startOn(IDS.C); // lượt này B đứng đầu
    await waitStatus(r6a.data && r6a.data.id, 'live', 'vps1');
    const n1 = reqs.length;
    mode.a403 = false; // A đã sửa xong nhưng vẫn đang trong 10 phút \"nghỉ\"
    const r6b = await startOn(IDS.O); // lượt này đúng ra A đứng đầu
    await waitStatus(r6b.data && r6b.data.id, 'live', 'vps1');
    assert('Lượt của A vẫn dùng B trước (A đang bị nghỉ do lỗi gần đây)', copyReqs(since(n1)).length === 1 && copyReqs(since(n1))[0].who === 'b', JSON.stringify(copyReqs(since(n1))));
    await waitFor(() => liveCopies().length === 0);

    console.log(Y('\n[ 7 ] File không mở được từ CẢ 2 Script → báo lỗi gộp lý do từng Script'));
    const r7 = await startOn(IDS.Z);
    const st7 = await waitStatus(r7.data && r7.data.id, 'ended', 'vps1');
    assert('\"ended\" + \"KHÔNG tự tạo được bản sao\" + lý do của Script #1 và #2', st7 && /KHÔNG tự tạo được bản sao/.test(st7.lastLog || '') && /Script #1/.test(st7.lastLog || '') && /Script #2/.test(st7.lastLog || '') && /không mở được file gốc/.test(st7.lastLog || ''), st7 && st7.lastLog);
    assert('Không có bản sao rác', liveCopies().length === 0);

    console.log(Y('\n[ 8 ] Cả 2 Script là bản cũ/không đúng code → báo cần dán google_apps_script_copy.js'));
    mode.aOld = mode.bOld = true;
    const r8 = await startOn(IDS.D);
    const st8 = await waitStatus(r8.data && r8.data.id, 'ended', 'vps1');
    assert('Báo \"chưa có chức năng tạo bản sao\" + capQuyenDrive', st8 && /chưa có chức năng tạo bản sao/.test(st8.lastLog || '') && /capQuyenDrive/.test(st8.lastLog || ''), st8 && st8.lastLog);
    mode.aOld = mode.bOld = false;

    console.log(Y('\n[ 9 ] Xóa bản sao lỗi → luồng VẪN LIVE, có cảnh báo'));
    mode.failDelete = true;
    const r9 = await startOn(IDS.K);
    assert('Luồng LIVE', !!(await waitStatus(r9.data && r9.data.id, 'live', 'vps1')));
    assert('Log cảnh báo không xóa được bản sao', !!(await waitFor(() => /Không xóa được bản sao tạm/.test(logText('vps1')))));
    mode.failDelete = false;
    liveCopies().forEach(f => { f.trashed = true; });

    console.log(Y('\n[ 10 ] Bảo mật /api/cluster/drive-copy'));
    const noAuth = await call('vps1', 'POST', '/api/cluster/drive-copy', { action: 'copy', id: IDS.A }, { 'X-Cluster-Secret': null });
    assert('Không đăng nhập → bị chặn', noAuth.status === 401 || noAuth.status === 403, JSON.stringify(noAuth));
    const wrong = await call('vps1', 'POST', '/api/cluster/drive-copy', { action: 'copy', id: IDS.A }, { 'X-Cluster-Secret': 'sai-secret-xx' });
    assert('Sai secret → bị chặn', wrong.status === 401 || wrong.status === 403, JSON.stringify(wrong));
    const delOrig = await call('vps1', 'POST', '/api/cluster/drive-copy', { action: 'delete', id: IDS.A });
    assert('Yêu cầu xóa FILE GỐC → mọi Script từ chối, file gốc còn', !!(delOrig.data && delOrig.data.error) && [dA, dB, dMain].every(dd => dd.files.has(IDS.A) && !dd.files.get(IDS.A).trashed), JSON.stringify(delOrig));
    n0 = reqs.length;
    await call('vps1', 'POST', '/api/cluster/drive-copy', { action: 'delete', id: IDS.B, src: `http://127.0.0.1:${SHEET_PORT}/evil/exec` });
    assert('src lạ (không nằm trong danh sách) bị bỏ qua — không gọi tới link lạ (chống lộ secret)', since(n0).every(q => q.who !== '/evil/exec') && since(n0).length > 0, JSON.stringify(since(n0)));
    const badAct = await call('vps1', 'POST', '/api/cluster/drive-copy', { action: 'rm', id: IDS.A });
    assert('Hành động lạ → báo lỗi', !!(badAct.data && badAct.data.error), JSON.stringify(badAct));

    console.log(Y('\n[ 11 ] Trang quản trị: kiểm tra / lưu danh sách / lấy code'));
    const ck = await call('vps1', 'POST', '/api/drive-copy/check', { urls: [URL_A, URL_B, `http://127.0.0.1:${SHEET_PORT}/nope/exec`] });
    const res11 = (ck.data && ck.data.results) || [];
    assert('Kiểm tra: A OK, B OK, link sai báo lỗi', res11.length === 3 && res11[0].ok && res11[1].ok && !res11[2].ok, JSON.stringify(res11));
    const ck2 = await call('vps1', 'POST', '/api/drive-copy/check', { urls: [URL_A] }, { 'X-Cluster-Secret': null });
    assert('Không đăng nhập → không kiểm tra được', ck2.status === 401 || ck2.status === 403, JSON.stringify(ck2));
    const scr = await call('vps1', 'GET', '/api/drive-copy/script');
    assert('Lấy code Script riêng, đã điền sẵn secret cụm', scr.status === 200 && scr.data && scr.data.code.includes('function copyDriveFile') && scr.data.code.includes(JSON.stringify(SECRET)) && !scr.data.code.includes('DOI_SECRET_NAY_GIONG'), scr.data && scr.data.error);
    const cfg11 = await call('vps1', 'GET', '/api/sheet/config');
    assert('Cấu hình có driveCopyUrls (2 link)', cfg11.data && Array.isArray(cfg11.data.driveCopyUrls) && cfg11.data.driveCopyUrls.length === 2, JSON.stringify(cfg11.data && cfg11.data.driveCopyUrls));

    console.log(Y('\n[ 12 ] Xóa danh sách Script riêng → tự dùng link Google Sheet (nếu Script Sheet có chức năng)'));
    const sv = await call('vps1', 'POST', '/api/drive-copy/config', { urls: [] });
    assert('Lưu danh sách rỗng OK', sv.data && sv.data.ok && sv.data.urls.length === 0, JSON.stringify(sv.data));
    n0 = reqs.length;
    const r12 = await startOn(IDS.M);
    assert('Luồng LIVE', !!(await waitStatus(r12.data && r12.data.id, 'live', 'vps1')));
    assert('Bản sao tạo + xóa qua Script Google Sheet (/exec)', !!(await waitFor(() => copyReqs(since(n0), 'main').length === 1 && delReqs(since(n0), 'main').length === 1 && copiesOf(dMain).length === 0)), JSON.stringify(since(n0)));
    const sv2 = await call('vps1', 'POST', '/api/drive-copy/config', { urls: `${URL_A}\n${URL_B}\n${URL_A}\nkhong-phai-link` });
    assert('Lưu lại (chuỗi nhiều dòng): bỏ trùng, bỏ link sai, kiểm tra 2/2 OK', sv2.data && sv2.data.urls.length === 2 && sv2.data.results.length === 2 && sv2.data.results.every(r => r.ok), JSON.stringify(sv2.data));

    console.log(Y('\n[ 13 ] Tắt tính năng DRIVE_AUTO_COPY=0 → giữ lỗi cũ, không gọi Script; danh sách vẫn còn sau khởi động lại'));
    await kill('vps1');
    start(N('vps1'), { DRIVE_AUTO_COPY: '0' });
    assert('vps1 khởi động lại', await healthy('vps1'));
    const cfg13 = await call('vps1', 'GET', '/api/sheet/config');
    assert('Danh sách Script riêng vẫn còn (đã lưu file)', cfg13.data && cfg13.data.driveCopyUrls && cfg13.data.driveCopyUrls.length === 2);
    n0 = reqs.length;
    const r13 = await startOn(IDS.A);
    const st13 = await waitStatus(r13.data && r13.data.id, 'ended', 'vps1');
    assert('Báo lỗi hết lượt tải kiểu cũ', st13 && /vượt quá hạn mức/.test(st13.lastLog || ''), st13 && st13.lastLog);
    assert('Không gọi copyDriveFile', copyReqs(since(n0)).length === 0);
  } finally {
    for (const n of NODES) await kill(n.id);
    srv.close();
  }
}

run().catch(e => { console.error(R('LỖI TEST:'), e); failed++; }).finally(() => {
  if (failed) for (const n of NODES) { console.log(Y(`\n--- log ${n.id} (cuối) ---`)); console.log(logText(n.id).slice(-3000)); }
  console.log(`\nKết quả: ${G(passed + ' PASS')}, ${failed ? R(failed + ' FAIL') : '0 FAIL'}`);
  process.exit(failed ? 1 : 0);
});
