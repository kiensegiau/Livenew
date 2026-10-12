// Đồng bộ danh sách VPS của cụm từ tab Google Sheet (thêm VPS = thêm 1 dòng, không cần thêm tay trên web).
// (Lần đồng bộ ĐẦU TIÊN trên 1 máy tin hoàn toàn vào sheet kể cả Master - máy mới chưa biết cụm; các lần sau mới chặn đổi Master.)
//
// Cấu hình (chỉ cần trên mỗi VPS): biến môi trường NODES_SHEET_URL = link TAB danh sách VPS
//   (link docs.google.com/spreadsheets/d/.../edit#gid=NNN của tab đó, chia sẻ "Bất kỳ ai có liên kết đều xem được")
//   hoặc 1 URL trả về CSV. Có thể đặt "nodesSheetUrl" trong sheet_config.json thay cho biến môi trường.
//
// Cột (dòng 1 là tiêu đề): id | tên | ip | port | vai trò (Master/Worker) | trạng thái (Active/Inactive)
//
// An toàn:
//  - Không đọc được sheet / sheet rỗng / không đúng 1 Master → giữ nguyên danh sách hiện tại (không xóa máy nào)
//  - Không tự đổi Master: nếu sheet chỉ Master khác với Master hiện tại thì BỎ QUA chỉ định đó và cảnh báo
//  - Không bao giờ gỡ chính máy đang chạy và Master hiện tại khỏi danh sách
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ID_RE = /^[a-z0-9_-]{2,20}$/;
const HOST_RE = /^[a-zA-Z0-9.\-]{3,100}$/;

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], nx = text[i + 1];
    if (c === '"') { if (q && nx === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { row.push(cur.trim()); cur = ''; }
    else if ((c === '\r' || c === '\n') && !q) {
      if (c === '\r' && nx === '\n') i++;
      row.push(cur.trim());
      if (row.some(x => x.length)) rows.push(row);
      row = []; cur = '';
    } else cur += c;
  }
  if (cur.length || row.length) { row.push(cur.trim()); if (row.some(x => x.length)) rows.push(row); }
  return rows;
}

// Trả về { rows: [{id,name,ip,port,isMaster}], warnings: [] } (chỉ gồm các dòng Active, hợp lệ)
function parseNodesCsv(text) {
  const warnings = [];
  const all = parseCsv(String(text || '').replace(/^\uFEFF/, ''));
  if (!all.length) return { rows: [], warnings: ['Sheet rỗng'] };
  const h0 = String(all[0][0] || '').toLowerCase(), h2 = String(all[0][2] || '').toLowerCase();
  const isHeader = ['id', 'mã', 'ma', 'mã máy', 'ma may', 'node'].includes(h0) || ['ip', 'host', 'địa chỉ ip', 'dia chi ip'].includes(h2);
  const data = isHeader ? all.slice(1) : all;
  const rows = [], seen = new Set();
  data.forEach((c, i) => {
    const line = i + (isHeader ? 2 : 1);
    const id = String(c[0] || '').trim().toLowerCase();
    if (!id) return;
    const status = String(c[5] || 'active').trim().toLowerCase();
    if (['inactive', 'lock', 'off', 'tắt', 'tat', 'disabled', 'no'].includes(status)) return;
    const ip = String(c[2] || '').trim();
    const port = parseInt(c[3], 10) || 3131;
    if (!ID_RE.test(id)) { warnings.push(`Dòng ${line}: id "${id}" không hợp lệ (chữ thường/số/-/_ , 2-20 ký tự)`); return; }
    if (!HOST_RE.test(ip) || /^\d+$/.test(ip)) { warnings.push(`Dòng ${line}: IP/host "${ip}" không hợp lệ${/^\d+$/.test(ip) ? ' (toàn chữ số - có thể Google Sheets đã biến IP thành số, hãy đặt cột IP là định dạng Văn bản)' : ''}`); return; }
    if (port < 1 || port > 65535) { warnings.push(`Dòng ${line}: port ${port} không hợp lệ`); return; }
    if (seen.has(id)) { warnings.push(`Dòng ${line}: id "${id}" bị trùng, bỏ qua`); return; }
    seen.add(id);
    const role = String(c[4] || 'worker').trim().toLowerCase();
    rows.push({ id, name: String(c[1] || id).trim() || id, ip, port, isMaster: ['master', 'chính', 'chinh', 'main'].includes(role) });
  });
  return { rows, warnings };
}

// Tính danh sách node mới từ sheet. Trả về { next } hoặc { error } hoặc { unchanged:true }; kèm warnings.
function computePlan(rows, current, localId, opts = {}) {
  const warnings = [];
  if (!rows.length) return { error: 'Sheet không có máy nào ở trạng thái Active', warnings };
  const masters = rows.filter(r => r.isMaster);
  if (masters.length !== 1) return { error: `Sheet phải có ĐÚNG 1 Master (đang có ${masters.length})`, warnings };

  const curMaster = opts.trustMaster ? null : current.find(n => n.isMaster);
  const next = rows.map(r => ({ id: r.id, name: r.name, ip: r.ip, port: r.port, isMaster: r.isMaster }));
  if (curMaster) {
    if (masters[0].id !== curMaster.id) {
      warnings.push(`Sheet chỉ Master là "${masters[0].id}" nhưng Master hiện tại là "${curMaster.id}" → giữ nguyên Master hiện tại (không tự đổi Master)`);
    }
    next.forEach(n => { n.isMaster = (n.id === curMaster.id); });
    if (!next.some(n => n.id === curMaster.id)) {
      warnings.push(`Master hiện tại "${curMaster.id}" không có trong sheet → vẫn giữ lại`);
      next.unshift({ id: curMaster.id, name: curMaster.name, ip: curMaster.ip, port: curMaster.port || 3131, isMaster: true });
    }
  }
  if (localId && !next.some(n => n.id === localId)) {
    const me = current.find(n => n.id === localId);
    if (me) { warnings.push(`Máy này ("${localId}") không có trong sheet → vẫn giữ lại`); next.push({ id: me.id, name: me.name, ip: me.ip, port: me.port || 3131, isMaster: !!me.isMaster }); }
  }
  const sig = list => JSON.stringify(list.map(n => [n.id, n.name, n.ip, n.port || 3131, !!n.isMaster]).sort((a, b) => a[0].localeCompare(b[0])));
  if (sig(next) === sig(current)) return { unchanged: true, warnings };
  return { next, warnings };
}

function toFetchUrl(u) {
  const s = String(u || '').trim();
  if (s.includes('docs.google.com/spreadsheets/d/')) {
    const id = (s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || [])[1];
    if (!id) return null;
    const gid = (s.match(/[#&?]gid=([0-9]+)/) || [])[1] || '0';
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  }
  return /^https?:\/\//.test(s) ? s : null;
}

function fetchText(urlStr, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('Quá nhiều redirect'));
    let u; try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const t = u.protocol === 'https:' ? https : http;
    const req = t.get(urlStr, { headers: { 'User-Agent': 'Mozilla/5.0 (LivenewNodeSync)' }, timeout: 10000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('/') ? `${u.origin}${res.headers.location}` : res.headers.location;
        return resolve(fetchText(next, redirects - 1));
      }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; if (d.length > 1e6) req.destroy(new Error('Dữ liệu quá lớn')); });
      res.on('end', () => res.statusCode === 200 ? resolve(d) : reject(new Error(`HTTP ${res.statusCode}`)));
    });
    req.on('timeout', () => req.destroy(new Error('Hết thời gian chờ (10s)')));
    req.on('error', reject);
  });
}

function init({ clusterManager, userManager, localNodeId, notify }) {
  const state = { enabled: false, lastOk: null, lastError: null, lastChange: null, warnings: [], nodes: 0 };
  const cfgUrl = () => {
    if (process.env.NODES_SHEET_URL) return process.env.NODES_SHEET_URL;
    const sc = (userManager && userManager.getSheetConfig && userManager.getSheetConfig()) || {};
    if (sc.nodesSheetUrl) return sc.nodesSheetUrl;
    // Dùng luôn Web App Apps Script đã cấu hình cho khách (action=getNodes) → không phải cấu hình thêm
    return /script\.google\.com/.test(sc.googleSheetScriptUrl || '') ? sc.googleSheetScriptUrl : '';
  };
  const intervalSec = Math.max(5, parseInt(process.env.NODES_SYNC_SEC, 10) || 60);
  let busy = false, lastWarnKey = '';
  const MARKER = process.env.SHEET_NODES_MARKER || path.join(__dirname, '.sheet_nodes_synced');

  async function syncNow() {
    if (busy) return state;
    const url = cfgUrl();
    if (!url) return state;
    state.enabled = true;
    busy = true;
    try {
      const isScript = /script\.google\.com/.test(url);
      const secret = (userManager && userManager.getSheetConfig && userManager.getSheetConfig().syncSecret) || '';
      const fu = isScript ? `${url}${url.includes('?') ? '&' : '?'}action=getNodes&secret=${encodeURIComponent(secret)}` : toFetchUrl(url);
      if (!fu) throw new Error('NODES_SHEET_URL không hợp lệ');
      let text = await fetchText(fu);
      if (isScript || text.trim().startsWith('{')) {
        let j; try { j = JSON.parse(text); } catch (_) { throw new Error('Web App trả dữ liệu không phải JSON'); }
        if (j.error) throw new Error(`Web App: ${j.error}`);
        if (!j.ok || !Array.isArray(j.nodes)) throw new Error('Web App phản hồi không hợp lệ (cần cập nhật Apps Script có action getNodes)');
        const q = v => `"${String(v).replace(/"/g, '""')}"`;
        text = 'id,name,ip,port,role,status\n' + j.nodes.map(r => r.map(q).join(',')).join('\n');
      }
      const { rows, warnings } = parseNodesCsv(text);
      const lid = typeof localNodeId === 'function' ? localNodeId() : null;
      const plan = computePlan(rows, clusterManager.getNodes(), lid, { trustMaster: !fs.existsSync(MARKER) });
      state.warnings = warnings.concat(plan.warnings || []);
      { const wk = state.warnings.join('|'); if (wk !== lastWarnKey) { lastWarnKey = wk; state.warnings.forEach(w => console.warn(`[SheetNodes] ⚠️ ${w}`)); } }
      if (plan.error) throw new Error(plan.error);
      state.lastOk = new Date().toISOString();
      state.lastError = null;
      if (plan.unchanged) { state.nodes = clusterManager.getNodes().length; try { fs.writeFileSync(MARKER, new Date().toISOString()); } catch (_) {} return state; }
      const before = clusterManager.getNodes().map(n => n.id);
      const r = clusterManager.replaceNodes(plan.next);
      if (r && r.error) throw new Error(r.error);
      const after = clusterManager.getNodes().map(n => n.id);
      try { fs.writeFileSync(MARKER, new Date().toISOString()); } catch (_) {}
      state.nodes = after.length;
      state.lastChange = new Date().toISOString();
      const added = after.filter(x => !before.includes(x)), removed = before.filter(x => !after.includes(x));
      console.log(`[SheetNodes] ✅ Cập nhật cụm từ sheet: ${after.length} máy` + (added.length ? ` | +${added.join(',')}` : '') + (removed.length ? ` | -${removed.join(',')}` : ''));
      if (typeof notify === 'function' && (added.length || removed.length)) {
        try { notify(`🖥️ *CỤM VPS THAY ĐỔI (từ Google Sheet)*\n━━━━━━━━━━━━━━━━━━\n${added.length ? `➕ Thêm: ${added.join(', ')}\n` : ''}${removed.length ? `➖ Gỡ: ${removed.join(', ')}\n` : ''}📊 Tổng: *${after.length}* máy`); } catch (_) {}
      }
    } catch (e) {
      state.lastError = e.message;
      console.warn(`[SheetNodes] ⚠️ Không đồng bộ được từ sheet (giữ nguyên danh sách hiện tại): ${e.message}`);
    } finally { busy = false; }
    return state;
  }

  if (cfgUrl()) {
    state.enabled = true;
    console.log(`[SheetNodes] Bật đồng bộ danh sách VPS từ Google Sheet (mỗi ${intervalSec}s)`);
    syncNow();
    setInterval(syncNow, intervalSec * 1000).unref();
  }
  return { syncNow, getState: () => ({ ...state }) };
}

module.exports = { init, parseNodesCsv, computePlan, toFetchUrl };
