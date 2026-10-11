const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLUSTER_CONFIG_PATH = process.env.CLUSTER_CONFIG || path.join(__dirname, 'cluster_nodes.json');
const USER_AGENT = 'CyberShieldSecureAgent/1.0';
let rememberedLocalId = null;

// Cấu hình cụm 2 VPS mặc định
let clusterNodes = [
  {
    id: 'vps1',
    name: 'VPS 1 (Chính - Master)',
    ip: '57.129.134.155',
    port: 3131,
    isMaster: true,
    isLocal: false, // Sẽ tự động gán true nếu IP trùng với máy hiện tại
    status: 'online',
    lastSeen: Date.now(),
    telemetry: null
  },
  {
    id: 'vps2',
    name: 'VPS 2 (Phụ - Worker)',
    ip: '51.68.214.167',
    port: 3131,
    isMaster: false,
    isLocal: false,
    status: 'online',
    lastSeen: Date.now(),
    telemetry: null
  }
];

function loadClusterConfig() {
  try {
    if (fs.existsSync(CLUSTER_CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CLUSTER_CONFIG_PATH, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        const loaded = data.filter(n => n && n.id && n.ip).map(normalizeNode);
        if (loaded.length === 0) throw new Error('cluster_nodes.json không có node hợp lệ');
        clusterNodes = loaded;
      }
    } else {
      saveClusterConfig();
    }
  } catch (e) {
    console.error('[ClusterManager] Lỗi đọc cluster_nodes.json:', e.message);
  }
}

function saveClusterConfig() {
  try {
    // Chỉ lưu cấu hình tĩnh, không lưu telemetry/trạng thái tức thời
    const clean = clusterNodes.map(n => ({
      id: n.id, name: n.name, ip: n.ip, port: n.port || 3131,
      isMaster: !!n.isMaster, isLocal: !!n.isLocal
    }));
    const tmp = CLUSTER_CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
    fs.renameSync(tmp, CLUSTER_CONFIG_PATH);
  } catch (e) {
    console.error('[ClusterManager] Lỗi ghi cluster_nodes.json:', e.message);
  }
}

function normalizeNode(n) {
  return {
    id: String(n.id).trim().toLowerCase(),
    name: String(n.name || n.id).trim(),
    ip: String(n.ip).trim(),
    port: parseInt(n.port) || 3131,
    isMaster: !!n.isMaster,
    isLocal: !!n.isLocal,
    status: 'unknown',
    lastSeen: 0,
    telemetry: null
  };
}

function getNode(id) {
  return clusterNodes.find(n => n.id === String(id || '').toLowerCase()) || null;
}

function hasNode(id) {
  return !!getNode(id);
}

// Thêm máy chủ mới vào cụm
function addNode(data) {
  if (!data || !data.id || !data.ip) return { error: 'Thiếu mã máy chủ (id) hoặc địa chỉ IP!' };
  const id = String(data.id).trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,20}$/.test(id)) return { error: 'Mã máy chủ chỉ gồm chữ thường, số, - _ (2-20 ký tự)!' };
  if (!/^[a-zA-Z0-9.\-]{3,100}$/.test(String(data.ip).trim())) return { error: 'Địa chỉ IP/host không hợp lệ!' };
  if (hasNode(id)) return { error: `Mã máy chủ [${id}] đã tồn tại!` };
  if (clusterNodes.some(n => n.ip === String(data.ip).trim() && (n.port || 3131) === (parseInt(data.port) || 3131))) {
    return { error: 'Địa chỉ IP:Port này đã có trong cụm!' };
  }
  const node = normalizeNode({ ...data, id, isMaster: false, isLocal: false });
  clusterNodes.push(node);
  saveClusterConfig();
  return { ok: true, node };
}

// Xóa máy chủ khỏi cụm (không cho xóa máy cục bộ hoặc Master)
function removeNode(id) {
  const node = getNode(id);
  if (!node) return { error: 'Không tìm thấy máy chủ!' };
  if (node.isLocal) return { error: 'Không thể xóa chính máy đang chạy hệ thống này!' };
  if (node.isMaster) return { error: 'Không thể xóa máy chủ chính (Master)!' };
  clusterNodes = clusterNodes.filter(n => n.id !== node.id);
  saveClusterConfig();
  return { ok: true };
}

// Nhận danh sách node từ Master (giữ nguyên cờ isLocal của máy này)
function replaceNodes(list) {
  if (!Array.isArray(list) || list.length === 0) return { error: 'Danh sách node không hợp lệ!' };
  const localId = rememberedLocalId || (clusterNodes.find(n => n.isLocal) || {}).id;
  const next = list.filter(n => n && n.id && n.ip).map(n => {
    const nn = normalizeNode(n);
    nn.isLocal = nn.id === localId;
    return nn;
  });
  if (next.length === 0) return { error: 'Danh sách node rỗng!' };
  clusterNodes = next;
  saveClusterConfig();
  return { ok: true, total: next.length };
}

// Đẩy danh sách node hiện tại sang mọi máy khác trong cụm
async function pushNodesToPeers() {
  const payload = clusterNodes.map(n => ({ id: n.id, name: n.name, ip: n.ip, port: n.port || 3131, isMaster: !!n.isMaster }));
  const results = [];
  for (const node of clusterNodes) {
    if (node.isLocal) continue;
    try {
      const res = await callNodeApi(node, '/api/cluster/sync-nodes', 'POST', { nodes: payload }, 5000);
      results.push({ nodeId: node.id, ok: res.statusCode === 200 });
    } catch (e) {
      results.push({ nodeId: node.id, ok: false, error: e.message });
    }
  }
  return results;
}

// Gom luồng từ TẤT CẢ node từ xa (song song)
async function fetchAllRemoteStreams() {
  const remotes = clusterNodes.filter(n => !n.isLocal);
  const lists = await Promise.all(remotes.map(n => fetchRemoteStreams(n.id)));
  return [].concat(...lists);
}

// Gom lịch sử luồng từ TẤT CẢ node từ xa (song song, lỗi 1 node không ảnh hưởng node khác)
async function fetchAllRemoteHistory() {
  const remotes = clusterNodes.filter(n => !n.isLocal);
  const lists = await Promise.all(remotes.map(async n => {
    try {
      const res = await callNodeApi(n, '/api/history?limit=1000', 'GET', null, 5000);
      return (res.statusCode === 200 && Array.isArray(res.data)) ? res.data.map(e => ({ ...e, serverId: e.serverId || n.id })) : [];
    } catch (_) { return []; }
  }));
  return [].concat(...lists);
}

// Gọi HTTP request an toàn tới Node từ xa
function callNodeApi(node, apiPath, method = 'GET', bodyData = null, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    // Nếu node là máy cục bộ, không cần gọi qua mạng IP public nếu có cờ isLocal
    const targetHost = node.ip;
    const targetPort = node.port || 3131;

    const payload = bodyData ? JSON.stringify(bodyData) : null;
    let clusterSecret = '';
    try { clusterSecret = require('./userManager').getSheetConfig().syncSecret || ''; } catch (_) {}
    const options = {
      hostname: targetHost,
      port: targetPort,
      path: apiPath,
      method: method,
      headers: {
        'User-Agent': USER_AGENT,
        'X-Cluster-Secret': clusterSecret,
        'X-Cluster-Forwarded': '1',
        'Content-Type': 'application/json'
      },
      timeout: timeoutMs
    };

    if (payload) {
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(options, (res) => {
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
      reject(new Error(`Timeout (${timeoutMs}ms) khi kết nối tới ${node.name} (${targetHost})`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// Lấy danh sách các node và thông tin tóm tắt
function getNodes() {
  return clusterNodes.map(n => ({
    id: n.id,
    name: n.name,
    ip: n.ip,
    port: n.port || 3131,
    isMaster: !!n.isMaster,
    isLocal: !!n.isLocal,
    status: n.status || 'unknown',
    telemetry: n.telemetry || null,
    lastSeen: n.lastSeen || 0
  }));
}

// Cập nhật trạng thái telemetry định kỳ cho các node từ xa
async function refreshNodeTelemetry(node) {
  if (node.isLocal) return; // Node cục bộ do server.js tự tính
  try {
    const res = await callNodeApi(node, '/api/sysinfo', 'GET', null, 4000);
    if (res.statusCode === 200 && res.data) {
      node.status = 'online';
      node.lastSeen = Date.now();
      node.telemetry = res.data;
    } else {
      node.status = 'warning';
    }
  } catch (err) {
    node.status = 'offline';
    node.telemetry = null;
  }
}

// Kéo danh sách streams từ node từ xa
async function fetchRemoteStreams(nodeId) {
  const node = clusterNodes.find(n => n.id === nodeId);
  if (!node) return [];
  try {
    const res = await callNodeApi(node, '/api/streams', 'GET', null, 5000);
    if (res.statusCode === 200 && Array.isArray(res.data)) {
      // Đánh dấu serverId lên từng stream để phân biệt
      return res.data.map(s => ({
        ...s,
        serverId: node.id,
        serverName: node.name,
        isRemote: true
      }));
    }
    return [];
  } catch (err) {
    console.error(`[Cluster] Không thể lấy streams từ ${node.name}:`, err.message);
    return [];
  }
}

// Chuyển tiếp hành động (Start, Stop, Restart, Edit) tới Node từ xa
async function forwardStreamAction(nodeId, action, payload) {
  const node = clusterNodes.find(n => n.id === nodeId);
  if (!node) {
    return { error: `Không tìm thấy máy chủ với mã [${nodeId}]` };
  }

  const endpointMap = {
    start: '/api/start',
    stop: '/api/stop',
    restart: '/api/restart',
    edit: '/api/edit',
    clear: '/api/clear'
  };

  const endpoint = endpointMap[action];
  if (!endpoint) {
    return { error: `Hành động không hợp lệ: ${action}` };
  }

  try {
    const res = await callNodeApi(node, endpoint, 'POST', payload, 10000);
    if (res.data) {
      return res.data;
    }
    return { ok: res.statusCode === 200 };
  } catch (err) {
    return { error: `Lỗi kết nối tới ${node.name}: ${err.message}` };
  }
}

// Đồng bộ danh sách người dùng sang các node đối tác
async function syncUsersToPeers(usersData, secretKey) {
  const results = [];
  for (const node of clusterNodes) {
    if (node.isLocal) continue;
    try {
      const res = await callNodeApi(node, '/api/users/sync-from-sheet', 'POST', {
        secret: secretKey,
        rows: usersData
      }, 5000);
      results.push({ nodeId: node.id, ok: true, data: res.data });
      console.log(`[Cluster] 🔄 Đã đồng bộ tài khoản sang ${node.name}: Thành công!`);
    } catch (e) {
      results.push({ nodeId: node.id, ok: false, error: e.message });
      console.error(`[Cluster] ⚠️ Không thể đồng bộ tài khoản sang ${node.name}:`, e.message);
    }
  }
  return results;
}

// Ngưỡng quá tải: node vượt ngưỡng sẽ KHÔNG nhận thêm luồng mới (có thể chỉnh bằng biến môi trường)
const MAX_RAM_PCT = parseInt(process.env.MAX_RAM_PCT) || 90;
const MAX_CPU_PCT = parseInt(process.env.MAX_CPU_PCT) || 95;
const MAX_DISK_PCT = parseInt(process.env.MAX_DISK_PCT) || 95;

// Trả về { full, reason } cho 1 bộ telemetry {cpuUsage, ramUsage, diskUsage}
function nodeCapacity(tel) {
  if (!tel) return { full: false };
  if (tel.capacityFull) return { full: true, reason: String(tel.capacityFull) };
  if (typeof tel.ramUsage === 'number' && tel.ramUsage >= MAX_RAM_PCT) return { full: true, reason: `RAM ${tel.ramUsage}% (giới hạn ${MAX_RAM_PCT}%)` };
  if (typeof tel.cpuUsage === 'number' && tel.cpuUsage >= MAX_CPU_PCT) return { full: true, reason: `CPU ${tel.cpuUsage}% (giới hạn ${MAX_CPU_PCT}%)` };
  if (typeof tel.diskUsage === 'number' && tel.diskUsage >= MAX_DISK_PCT) return { full: true, reason: `Ổ đĩa ${tel.diskUsage}% (giới hạn ${MAX_DISK_PCT}%)` };
  return { full: false };
}

// Đặt chỗ tạm: nhiều lệnh Start đồng thời sẽ không cùng dồn vào 1 máy (telemetry chưa kịp cập nhật)
const RESERVE_TTL_MS = 4000;
const reservations = new Map();
function pendingCount(nodeId) {
  const now = Date.now();
  const arr = (reservations.get(nodeId) || []).filter(t => now - t < RESERVE_TTL_MS);
  reservations.set(nodeId, arr);
  return arr.length;
}
function reserveNode(nodeId) {
  const arr = reservations.get(nodeId) || [];
  arr.push(Date.now());
  reservations.set(nodeId, arr);
}

/**
 * Tự động cân bằng tải và chọn VPS tối ưu nhất để chạy luồng
 * @param {Array<string>} allowedServers - Danh sách server được cấp phép (VD: ['all'] hoặc ['vps1', 'vps2'])
 * @param {Object} localSysinfo - Thông tin tải của VPS cục bộ (CPU, RAM, activeStreams)
 */
async function selectOptimalNode(allowedServers = ['all'], localSysinfo = null) {
  const allowed = (allowedServers || ['all']).map(s => s.toLowerCase());
  const canUseAll = allowed.includes('all');

  // Cập nhật thông tin node cục bộ vào mảng
  if (localSysinfo) {
    const localNode = clusterNodes.find(n => n.isLocal);
    if (localNode) {
      localNode.status = 'online';
      localNode.lastSeen = Date.now();
      localNode.telemetry = {
        cpuUsage: localSysinfo.cpuUsage || 0,
        ramUsage: localSysinfo.ramUsage || 0,
        activeStreams: localSysinfo.activeStreams || 0,
        diskUsage: localSysinfo.diskUsage || 0,
        capacityFull: localSysinfo.capacityFull || null,
        balanceStreams: typeof localSysinfo.balanceStreams === 'number' ? localSysinfo.balanceStreams : (localSysinfo.activeStreams || 0)
      };
    }
  }

  // Lọc các Node được phép sử dụng
  const eligibleNodes = clusterNodes.filter(n => {
    if (canUseAll) return true;
    return allowed.includes(n.id.toLowerCase());
  });

  if (eligibleNodes.length === 0) {
    const fallback = clusterNodes.find(n => n.isLocal) || clusterNodes[0];
    return {
      nodeId: fallback.id,
      nodeName: fallback.name,
      isLocal: !!fallback.isLocal,
      reason: 'Không có cấu hình chỉ định, mặc định chạy trên máy chủ hiện tại'
    };
  }

  if (eligibleNodes.length === 1) {
    const single = eligibleNodes[0];
    return {
      nodeId: single.id,
      nodeName: single.name,
      isLocal: !!single.isLocal,
      reason: `Tài khoản được cố định trên ${single.name}`
    };
  }

  // Cập nhật telemetry mới nhất cho các node từ xa
  await Promise.all(eligibleNodes.map(async (n) => {
    if (!n.isLocal) {
      await refreshNodeTelemetry(n);
    }
  }));

  // Đánh giá các node đang online và còn hoạt động
  const activeCandidates = [];
  for (const n of eligibleNodes) {
    if (n.isLocal) {
      activeCandidates.push(n);
    } else {
      const isRecent = (Date.now() - (n.lastSeen || 0)) < 30000;
      if (n.status === 'online' && isRecent) {
        activeCandidates.push(n);
      } else {
        console.warn(`[Cluster LoadBalancer] ⚠️ ${n.name} (${n.ip}) đang offline hoặc chậm phản hồi. Loại khỏi danh sách điều phối.`);
      }
    }
  }

  // Loại các node đã đầy tài nguyên; nếu tất cả đều đầy -> từ chối nhận luồng mới
  if (activeCandidates.length > 0) {
    const roomy = [];
    const fullInfo = [];
    for (const n of activeCandidates) {
      const cap = nodeCapacity(n.telemetry);
      if (cap.full) fullInfo.push(`${n.name}: ${cap.reason}`);
      else roomy.push(n);
    }
    if (roomy.length === 0) {
      return { nodeId: null, full: true, reason: `Tất cả máy chủ đã đầy tài nguyên, tạm ngưng nhận luồng mới (${fullInfo.join('; ')})` };
    }
    if (fullInfo.length > 0) console.warn(`[Cluster LoadBalancer] 🚫 Bỏ qua node đầy: ${fullInfo.join('; ')}`);
    activeCandidates.length = 0;
    roomy.forEach(n => activeCandidates.push(n));
  }

  // Trường hợp 1 node bị sự cố/chết mạng -> TỰ ĐỘNG CHUYỂN TOÀN BỘ SANG NODE CÒN SỐNG (Failover)
  if (activeCandidates.length === 1) {
    const survivor = activeCandidates[0];
    return {
      nodeId: survivor.id,
      nodeName: survivor.name,
      isLocal: !!survivor.isLocal,
      reason: `Tự động điều phối (Failover): Chỉ còn ${survivor.name} đang hoạt động bình thường!`
    };
  }

  if (activeCandidates.length === 0) {
    const local = clusterNodes.find(n => n.isLocal) || clusterNodes[0];
    if (!eligibleNodes.some(n => n.id === local.id)) {
      return { nodeId: null, full: true, reason: 'Các máy chủ được cấp phép đều đang mất kết nối, vui lòng thử lại sau' };
    }
    return {
      nodeId: local.id,
      nodeName: local.name,
      isLocal: true,
      reason: 'Tất cả các Node từ xa đều mất kết nối, tự động gánh luồng tại máy chủ gốc'
    };
  }

  // Tính điểm tải (Load Score) cho từng Node:
  // Điểm càng THẤP thì máy chủ càng RẢNH (ít tải)
  // Công thức: Score = (Số luồng đang phát * 25) + (CPU% * 0.5) + (RAM% * 0.3)
  const scoredNodes = activeCandidates.map(node => {
    const tel = node.telemetry || {};
    const streamCount = (typeof tel.balanceStreams === 'number' ? tel.balanceStreams : (typeof tel.activeStreams === 'number' ? tel.activeStreams : 0)) + pendingCount(node.id);
    const cpu = typeof tel.cpuUsage === 'number' ? tel.cpuUsage : 15;
    const ram = typeof tel.ramUsage === 'number' ? tel.ramUsage : 30;

    const score = (streamCount * 25) + (cpu * 0.5) + (ram * 0.3);

    return {
      node,
      streamCount,
      cpu,
      ram,
      score
    };
  });

  // Sắp xếp tăng dần theo điểm tải (thấp nhất lên đầu)
  scoredNodes.sort((a, b) => a.score - b.score);

  const best = scoredNodes[0];
  reserveNode(best.node.id);
  const other = scoredNodes[1];

  let reason = `Tự động chọn ${best.node.name}: Đang có ${best.streamCount} luồng (CPU ${best.cpu}%)`;
  if (other) {
    reason += ` - Nhẹ hơn ${other.node.name} (${other.streamCount} luồng, CPU ${other.cpu}%)`;
  }

  return {
    nodeId: best.node.id,
    nodeName: best.node.name,
    isLocal: !!best.node.isLocal,
    reason,
    stats: {
      streamCount: best.streamCount,
      cpu: best.cpu,
      ram: best.ram,
      score: best.score
    }
  };
}

// Khởi chạy vòng quét định kỳ kiểm tra sức khỏe các Node (mỗi 10 giây)
function startClusterHealthcheck() {
  setInterval(() => {
    clusterNodes.forEach(node => {
      if (!node.isLocal) {
        refreshNodeTelemetry(node);
      }
    });
  }, 10000);
}

loadClusterConfig();
startClusterHealthcheck();

module.exports = {
  getNodes,
  callNodeApi,
  fetchRemoteStreams,
  forwardStreamAction,
  syncUsersToPeers,
  refreshNodeTelemetry,
  selectOptimalNode,
  nodeCapacity,
  getNode,
  hasNode,
  addNode,
  removeNode,
  replaceNodes,
  pushNodesToPeers,
  fetchAllRemoteStreams,
  fetchAllRemoteHistory,
  setLocalNode: (localId) => {
    rememberedLocalId = localId;
    clusterNodes.forEach(n => {
      n.isLocal = (n.id === localId);
    });
    saveClusterConfig();
  }
};
