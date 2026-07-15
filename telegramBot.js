const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const http = require('http');

const CONFIG_PATH = path.join(__dirname, 'bot_config.json');

const { exec } = require('child_process');
const os = require('os');

function getNetBytes() {
  return new Promise(resolve => {
    if (os.platform() === 'win32') {
      exec('netstat -e', (err, stdout) => {
        try {
          if (!err && stdout) {
            const bytesLine = stdout.split('\n').find(l => l.trim().startsWith('Bytes'));
            if (bytesLine) {
              const parts = bytesLine.trim().split(/\s+/);
              return resolve({ rx: parseInt(parts[1]) || 0, tx: parseInt(parts[2]) || 0 });
            }
          }
        } catch (e) {}
        resolve({ rx: 0, tx: 0 });
      });
    } else {
      // Linux: Đọc từ /proc/net/dev - Cải tiến dùng Regex để tránh lỗi dính chữ
      exec('cat /proc/net/dev', (err, stdout) => {
        try {
          if (!err && stdout) {
            const lines = stdout.split('\n');
            let totalRx = 0, totalTx = 0;
            lines.forEach(line => {
              if (line.includes(':')) {
                // Tách phần số liệu sau dấu hai chấm
                const dataPart = line.split(':')[1].trim();
                const parts = dataPart.split(/\s+/);
                if (parts.length >= 16) {
                  totalRx += parseInt(parts[0]) || 0;
                  totalTx += parseInt(parts[8]) || 0;
                }
              }
            });
            return resolve({ rx: totalRx, tx: totalTx });
          }
        } catch (e) {}
        resolve({ rx: 0, tx: 0 });
      });
    }
  });
}

function getDiskUsage() {
  return new Promise(resolve => {
    if (os.platform() === 'win32') {
      exec('wmic logicaldisk get size,freespace,caption', (err, stdout) => {
        try {
          if (!err && stdout) {
            const lines = stdout.trim().split('\n').slice(1);
            const cDrive = lines.find(l => l.includes('C:'));
            if (cDrive) {
              const [caption, free, size] = cDrive.trim().split(/\s+/);
              const used = parseInt(size) - parseInt(free);
              const pct = (used / parseInt(size) * 100).toFixed(0);
              return resolve(`${(used/1024/1024/1024).toFixed(1)}/${(parseInt(size)/1024/1024/1024).toFixed(1)}GB (${pct}%)`);
            }
          }
        } catch (e) {}
        resolve('N/A');
      });
    } else {
      // Linux: df -h / - Xử lý trường hợp tên thiết bị dài gây xuống dòng
      exec('df -h /', (err, stdout) => {
        try {
          if (!err && stdout) {
            const lines = stdout.trim().split('\n');
            // Dòng cuối cùng thường chứa dữ liệu, nhưng nếu bị xuống dòng thì dữ liệu nằm ở dòng cuối
            const lastLine = lines[lines.length - 1].trim();
            const parts = lastLine.split(/\s+/);
            
            if (parts.length >= 5) {
              // Cấu trúc: Filesystem Size Used Avail Use% Mounted
              // Nếu parts.length là 6 -> [FS, Size, Used, Avail, Use%, Mount]
              // Nếu parts.length là 5 (do xuống dòng) -> [Size, Used, Avail, Use%, Mount]
              const size = parts.length === 6 ? parts[1] : parts[0];
              const used = parts.length === 6 ? parts[2] : parts[1];
              const pct = parts.length === 6 ? parts[4] : parts[3];
              return resolve(`${used}/${size} (${pct})`);
            }
          }
        } catch (e) {}
        resolve('N/A');
      });
    }
  });
}

let config = { token: "", adminIds: [], password: "live", polling: true, zalo: { enabled: false, serverUrl: "", threadId: "" } };
try {
  if (fs.existsSync(CONFIG_PATH)) {
    const oldConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    config = { ...config, ...oldConfig };
    if (oldConfig.adminId && (!config.adminIds || config.adminIds.length === 0)) {
      config.adminIds = [oldConfig.adminId];
    }
  }
} catch (e) { console.error('Lỗi đọc config:', e.message); }

let bot = null;
const activeProgressMessages = new Map();
const userStates = new Map(); // Lưu trạng thái nhập liệu của người dùng

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) { console.error('Lỗi lưu config:', e.message); }
}

function sendToZalo(text) {
  if (!config.zalo || !config.zalo.enabled || !config.zalo.serverUrl) return;

  const urlStr = config.zalo.serverUrl;
  const threadId = config.zalo.threadId;
  if (!threadId) return;

  try {
    const url = new URL(urlStr);
    const cleanText = text.replace(/\*/g, '').replace(/`/g, '');
    const payload = JSON.stringify({
      threadId: String(threadId),
      type: "Group",
      message: cleanText
    });

    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    if (config.zalo.apiKey) {
      options.headers['x-api-key'] = config.zalo.apiKey;
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[Zalo] Gửi báo cáo định kỳ thành công: ${data}`);
      });
    });

    req.on('error', (e) => {
      console.error(`[Zalo] Lỗi gửi báo cáo định kỳ: ${e.message}`);
    });

    req.write(payload);
    req.end();
  } catch (err) {
    console.error('[Zalo] Lỗi khởi tạo cấu hình gửi tin nhắn:', err.message);
  }
}

let serverIp = 'Unknown';
function detectPublicIp() {
  const options = {
    hostname: 'api.ipify.org',
    port: 80,
    path: '/',
    method: 'GET',
    timeout: 3000
  };
  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      serverIp = data.trim();
    });
  });
  req.on('error', () => {
    try {
      const interfaces = os.networkInterfaces();
      for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
          const alias = iface[i];
          if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
            serverIp = alias.address;
            return;
          }
        }
      }
    } catch (err) {}
  });
  req.end();
}
detectPublicIp();

function escapeMarkdown(text) {
  if (!text) return '';
  return text.toString().replace(/[*_`\[]/g, '\\$&');
}

function initBot(actions) {
  // === KHỞI ĐỘNG AEGIS SENTINEL (TỰ ĐỘNG PHÁT HIỆN VÀ KIỂM TRA CHÉO GIỮA CÁC VPS) ===
  if (config.sentinel && config.sentinel.enabled && Array.isArray(config.sentinel.knownServers)) {
    const startSentinel = () => {
      // Chờ phát hiện xong IP của chính mình mới bắt đầu chạy
      if (serverIp === 'Unknown') {
        setTimeout(startSentinel, 2000);
        return;
      }

      // Lọc ra danh sách các server đối phương (bỏ qua IP của chính mình)
      const peers = config.sentinel.knownServers
        .map(ip => ip.trim())
        .filter(ip => ip !== serverIp && ip.length > 0);

      if (peers.length === 0) {
        console.log('[Sentinel] Không tìm thấy server đối phương nào khác để kiểm tra chéo.');
        return;
      }

      console.log(`[Sentinel] 🛡️ Hệ thống tự động bắt đầu giám sát các Peer: [${peers.join(', ')}]`);

      // Quản lý trạng thái & thống kê cho từng peer
      const peerStates = new Map();
      peers.forEach(peerIp => {
        peerStates.set(peerIp, {
          status: 'online',
          lastAlertTime: 0,
          totalPings: 0,
          successPings: 0,
          failPings: 0,
          incidents: [],
          currentIncident: null
        });
      });

      const ALERT_COOLDOWN_MS = 15 * 60 * 1000;

      const checkAllPeers = () => {
        peers.forEach(peerIp => {
          try {
            const options = {
              hostname: peerIp,
              port: 3131,
              path: '/api/sysinfo',
              method: 'GET',
              timeout: 5000,
              headers: {
                'User-Agent': 'CyberShieldSecureAgent/1.0'
              }
            };

            const req = http.request(options, (res) => {
              let data = '';
              res.on('data', chunk => data += chunk);
              res.on('end', () => {
                let isSuccess = false;
                try {
                  if (res.statusCode === 200) {
                    const json = JSON.parse(data);
                    if (json && json.platform) isSuccess = true;
                  }
                } catch (e) {}
                handlePeerResult(peerIp, isSuccess);
              });
            });

            req.on('error', () => handlePeerResult(peerIp, false));
            req.on('timeout', () => { req.destroy(); handlePeerResult(peerIp, false); });
            req.end();
          } catch (err) {
            console.error(`[Sentinel] Lỗi ping tới ${peerIp}:`, err.message);
          }
        });
      };

      const handlePeerResult = (peerIp, isSuccess) => {
        const state = peerStates.get(peerIp);
        if (!state) return;

        state.totalPings++;
        if (isSuccess) {
          state.successPings++;
        } else {
          state.failPings++;
        }

        const now = Date.now();
        const peerUrlStr = `http://${peerIp}:3131`;
        const timeStr = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

        if (isSuccess) {
          if (state.status === 'offline') {
            state.status = 'online';

            // Kết thúc sự cố hiện tại
            if (state.currentIncident) {
              state.currentIncident.upAt = timeStr;
              state.currentIncident.durationSec = Math.floor((now - state.currentIncident.downTimestamp) / 1000);
              state.incidents.push(state.currentIncident);
              state.currentIncident = null;
            }

            const msg = `🟢 *[SENTINEL ALERT] CHẠY LẠI THÀNH CÔNG!*\n━━━━━━━━━━━━━━━━━━\n🖥️ Server Peer: *${peerIp}*\n🔗 Địa chỉ: \`${peerUrlStr}\`\n💬 Trạng thái: Đã khôi phục hoạt động bình thường.`;
            console.log(`[Sentinel] ${msg}`);
            broadcast(msg);
            sendToZalo(msg);
          }
        } else {
          if (state.status === 'online') {
            state.status = 'offline';
            state.lastAlertTime = now;

            // Bắt đầu sự cố mới
            state.currentIncident = {
              downAt: timeStr,
              upAt: null,
              downTimestamp: now,
              durationSec: 0
            };

            const msg = `🚨 *[SENTINEL ALERT] MẤT KẾT NỐI SERVER!* \n━━━━━━━━━━━━━━━━━━\n🖥️ Server Peer: *${peerIp}*\n🔗 Địa chỉ: \`${peerUrlStr}\`\n💬 Cảnh báo: Server đối phương không phản hồi! Có thể Node.js bị crash hoặc VPS đã sập.`;
            console.error(`[Sentinel] ${msg}`);
            broadcast(msg);
            sendToZalo(msg);
          } else {
            if (now - state.lastAlertTime > ALERT_COOLDOWN_MS) {
              state.lastAlertTime = now;
              const msg = `⚠️ *[SENTINEL WARNING] SERVER PEER VẪN SẬP!*\n━━━━━━━━━━━━━━━━━━\n🖥️ Server Peer: *${peerIp}*\n🔗 Địa chỉ: \`${peerUrlStr}\`\n💬 Trạng thái: Chưa thể khôi phục kết nối.`;
              broadcast(msg);
              sendToZalo(msg);
            }
          }
        }
      };

      // --- LOGIC GỬI BÁO CÁO GIÁM SÁT HẰNG NGÀY LÚC 00:00 GIỜ VN ---
      let lastDailyReportDate = '';
      
      const checkTimeAndSendDailyReport = () => {
        try {
          const vnDateObj = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
          const [datePart, timePart] = vnDateObj.split(' ');
          const [hh, mm] = timePart.split(':');

          if (hh === '00' && mm === '00' && lastDailyReportDate !== datePart) {
            lastDailyReportDate = datePart;

            const [y, m, d] = datePart.split('-');
            const displayDate = `${d}/${m}/${y}`;

            let report = `📊 *BÁO CÁO GIÁM SÁT HẰNG NGÀY (SENTINEL)*\n`;
            report += `📅 Ngày: \`${displayDate}\`\n`;
            report += `🖥️ IP Server: \`${serverIp}\`\n`;
            report += `━━━━━━━━━━━━━━━━━━\n\n`;

            peerStates.forEach((state, peerIp) => {
              const total = state.totalPings || 0;
              const success = state.successPings || 0;
              const fail = state.failPings || 0;
              const successPct = total > 0 ? (success / total * 100).toFixed(2) : '0.00';
              const failPct = total > 0 ? (fail / total * 100).toFixed(2) : '0.00';
              const statusText = state.status === 'online' ? 'ONLINE 🟢' : 'OFFLINE 🔴';

              report += `🖥️ *Đối phương: ${peerIp}*\n`;
              report += `  • Trạng thái hiện tại: \`${statusText}\`\n`;
              report += `  • Tổng số lần ping: \`${total}\`\n`;
              report += `  • Thành công: \`${success}\` (${successPct}%)\n`;
              report += `  • Thất bại: \`${fail}\` (${failPct}%)\n`;
              
              if (state.incidents.length > 0) {
                report += `  • Chi tiết sự cố hôm nay:\n`;
                state.incidents.forEach((inc, idx) => {
                  const durationText = formatDurationText(inc.durationSec);
                  report += `    ${idx + 1}. 🚨 Sập lúc \`${inc.downAt}\` -> Khôi phục lúc \`${inc.upAt || 'Chưa khôi phục'}\` (${durationText})\n`;
                });
              } else {
                report += `  • Chi tiết sự cố: \`Không có sự cố nào (Ổn định 100% 🛡️)\`\n`;
              }
              report += `\n`;

              // Reset thống kê cho ngày mới
              state.totalPings = 0;
              state.successPings = 0;
              state.failPings = 0;
              state.incidents = [];
              if (state.status === 'offline' && state.currentIncident) {
                state.currentIncident.downAt = '00:00:00';
                state.currentIncident.downTimestamp = Date.now();
              }
            });

            broadcast(report);
            sendToZalo(report);
          }
        } catch (err) {
          console.error('[Sentinel] Lỗi gửi báo cáo hằng ngày:', err.message);
        }
      };

      function formatDurationText(sec) {
        if (sec < 60) return `${sec} giây`;
        const mins = Math.floor(sec / 60);
        const remSec = sec % 60;
        if (mins < 60) return `${mins} phút ${remSec} giây`;
        const hours = Math.floor(mins / 60);
        const remMins = mins % 60;
        return `${hours} giờ ${remMins} phút`;
      }

      // Kiểm tra thời gian mỗi 10 giây
      setInterval(checkTimeAndSendDailyReport, 10000);

      const intervalMs = config.sentinel.intervalMs || 60000;
      setInterval(checkAllPeers, intervalMs);
      checkAllPeers();
    };

    startSentinel();
  }

  // === KÍCH HOẠT KẾT NỐI TELEGRAM BOT HỆ THỐNG ===
  // Tự động tắt polling khi chạy ở máy Windows (Local) để tránh tranh chấp với VPS (Linux)
  const isLocalWindows = os.platform() === 'win32';
  const effectivePolling = isLocalWindows ? false : config.polling;

  if (!config.token || effectivePolling === false) {
    console.log('[Telegram Bot] ⚠️ Bỏ qua khởi tạo Bot hoặc Polling (đã tắt hoặc đang chạy ở Local Windows).');
    return;
  }

  try {
    bot = new TelegramBot(config.token, { polling: true });
    console.log('\n[Telegram Bot] 🤖 Bot đang chạy...');

    bot.setMyCommands([
      { command: 'status', description: '📊 Xem & Điều khiển luồng' },
      { command: 'live', description: '🔄 Phát Loop (Key Link)' },
      { command: 'once', description: '▶️ Phát một lần (Key Link)' },
      { command: 'limit', description: '⏱️ Hẹn giờ tắt (Key Link Mins)' },
      { command: 'schedule', description: '🕐 Đặt lịch (Key Link HH:mm [m])' },
      { command: 'log', description: '📝 Xem nhật ký chi tiết' },
      { command: 'admins', description: '👥 Quản lý quản trị viên' },
      { command: 'reboot', description: '♻️ Khởi động lại Server' },
      { command: 'clear', description: '🧹 Dọn dẹp luồng rác' },
      { command: 'help', description: '❓ Hướng dẫn sử dụng' }
    ]);
  } catch (e) {
    console.error('Lỗi khởi tạo Bot:', e.message);
    return;
  }

  // Hàm gửi báo cáo định kỳ
  const sendPeriodicReport = async () => {
    try {
      const list = actions.getStreams();
      const startUsage = process.cpuUsage();
      const startTime = process.hrtime();
      const netStart = await getNetBytes();
      
      setTimeout(async () => {
        try {
          const endUsage = process.cpuUsage(startUsage);
          const endTime = process.hrtime(startTime);
          const netEnd = await getNetBytes();

          const elapTimeMs = endTime[0] * 1000 + endTime[1] / 1000000;
          const elapSec = elapTimeMs / 1000;
          const rxSpeedMbps = ((netEnd.rx - netStart.rx) * 8 / 1024 / 1024 / elapSec).toFixed(1);
          const txSpeedMbps = ((netEnd.tx - netStart.tx) * 8 / 1024 / 1024 / elapSec).toFixed(1);

          const cpuPercent = (100 * (endUsage.user + endUsage.system) / 1000 / elapTimeMs).toFixed(1);
          const active = list.filter(s => s.status === 'live').length;
          
          // RAM Hệ thống
          const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
          const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
          const usedMem = (totalMem - freeMem).toFixed(1);
          const disk = await getDiskUsage();
          const uptimeH = (os.uptime() / 3600).toFixed(1);

          let report = `📊 *BÁO CÁO HỆ THỐNG ĐỊNH KỲ*\n`;
          report += `🖥️ IP Server: \`${serverIp}\`\n`;
          report += `━━━━━━━━━━━━━━━━━━\n`;
          report += `⏱ Uptime: \`${uptimeH}h\` | 🧠 RAM: \`${usedMem}/${totalMem}GB\`\n`;
          report += `💽 Disk: \`${disk}\` | ⚡ CPU: \`${cpuPercent}%\`\n`;
          report += `🌐 Mạng: ⬇️ \`${rxSpeedMbps} Mbps\` | ⬆️ \`${txSpeedMbps} Mbps\`\n`;
          report += `📺 Luồng: \`${active}/${list.length}\` đang chạy\n\n`;

          if (list.length > 0) {
            list.forEach(s => {
              const icon = s.status === 'live' ? '🟢' : (s.status === 'downloading' ? '⬇️' : (s.status === 'reconnecting' ? '🟡' : (s.status === 'scheduled' ? '🕐' : '⚪')));
              let logBrief = s.lastLog || '...';
              if (s.status === 'live') {
                const time = s.lastLog.match(/time=\S+/);
                const bitrate = s.lastLog.match(/bitrate=\s*\S+/);
                const speed = s.lastLog.match(/speed=\s*\S+/);
                if (time && bitrate && speed) {
                  logBrief = `${time[0]} | ${bitrate[0]} | ${speed[0]}`;
                }
              }
              let dualText = '';
              if (s.dualStream) {
                if (s.status === 'live') {
                  const actA = (s.streamAActive !== false) ? '🟢' : '🔴';
                  const actB = (s.streamBActive !== false) ? '🟢' : '🔴';
                  dualText = ` [Song song ⚡ A:${actA} B:${actB}]`;
                } else {
                  dualText = ' [Song song ⚡]';
                }
              }
              report += `${icon} *#${s.id}*${s.name ? ` (${escapeMarkdown(s.name)})` : ''}${dualText}: \`${s.status}\` | \`${escapeMarkdown(logBrief)}\`\n`;
            });
          } else {
            report += `📭 _Hiện không có luồng nào đang hoạt động._`;
          }
          broadcast(report);
          sendToZalo(report);
        } catch (e) { console.error('Lỗi báo cáo (nội):', e.message); }
      }, 1000);
    } catch (e) { console.error('Lỗi báo cáo (ngoại):', e.message); }
  };

  // Gửi ngay 1 bản khi khởi động để kiểm tra
  sendPeriodicReport();
  // Duy trì mỗi 30 phút
  setInterval(sendPeriodicReport, 30 * 60 * 1000);

  bot.on('message', (msg) => {
    try {
      const chatId = msg.chat.id;
      const text = msg.text || '';
      
      if (!config.adminIds.includes(chatId)) {
        if (text === config.password) {
          config.adminIds.push(chatId);
          saveConfig();
          bot.sendMessage(chatId, '✅ Xác thực thành công! Bạn hiện là Admin.');
        } else if (text.length > 0 && !text.startsWith('/')) {
          bot.sendMessage(chatId, '🔒 Vui lòng nhập Mật khẩu Admin:');
        }
        return;
      }

      // HỦY LỆNH ĐANG NHẬP DỞ
      if (text === '/cancel') {
        userStates.delete(chatId);
        return bot.sendMessage(chatId, '🚫 Đã hủy thao tác.');
      }

      // XỬ LÝ NHẬP LIỆU THEO BƯỚC (WIZARD MODE)
      const state = userStates.get(chatId);
      if (state && !text.startsWith('/')) {
        if (state.cmd === 'edit') {
          return handleEditInput(chatId, text, state, actions);
        }
        return handleWizard(chatId, text, state, actions);
      }

      // Xử lý lệnh
      if (text.startsWith('/help') || text === '/start') {
        const helpMsg = `🛠 *YouTube Live Controller*\n/status - Xem & Điều khiển luồng\n/live <key> <link> - Phát Loop\n/once <key> <link> - Phát 1 lần\n/limit <key> <link> <m> - Hẹn giờ tắt\n/schedule <key> <link> <HH:mm> [m] - Đặt lịch\n/scheduleonce <key> <link> <HH:mm> - Lịch phát 1 lần\n/log <id> - Xem log chi tiết\n/admins - Danh sách quản trị\n/reboot - Khởi động lại Server\n/clear - Dọn luồng rác`;
        bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
      }
      
      else if (text.startsWith('/status')) {
        const list = actions.getStreams();
        const startUsage = process.cpuUsage();
        const startTime = process.hrtime();
        
        getNetBytes().then(netStart => {
          setTimeout(async () => {
            try {
              const endUsage = process.cpuUsage(startUsage);
              const endTime = process.hrtime(startTime);
              const netEnd = await getNetBytes();

              const elapTimeMs = endTime[0] * 1000 + endTime[1] / 1000000;
              const elapSec = elapTimeMs / 1000;
              const rxSpeedMbps = ((netEnd.rx - netStart.rx) * 8 / 1024 / 1024 / elapSec).toFixed(1);
              const txSpeedMbps = ((netEnd.tx - netStart.tx) * 8 / 1024 / 1024 / elapSec).toFixed(1);
              const cpuPercent = (100 * (endUsage.user + endUsage.system) / 1000 / elapTimeMs).toFixed(1);
              
              const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
              const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
              const usedMem = (totalMem - freeMem).toFixed(1);
              
              const disk = await getDiskUsage();
              const uptimeH = (os.uptime() / 3600).toFixed(1);

              let sysInfo = `📊 *TRẠNG THÁI HỆ THỐNG*\n━━━━━━━━━━━━━━━━━━\n`;
              sysInfo += `⏱ Uptime: \`${uptimeH}h\` | 🧠 RAM: \`${usedMem}/${totalMem}GB\`\n`;
              sysInfo += `💽 Disk: \`${disk}\` | ⚡ CPU: \`${cpuPercent}%\`\n`;
              sysInfo += `🌐 Mạng: ⬇️ \`${rxSpeedMbps} Mbps\` | ⬆️ \`${txSpeedMbps} Mbps\`\n`;

              if (list.length === 0) {
                return bot.sendMessage(chatId, `${sysInfo}━━━━━━━━━━━━━━━━━━\n📭 Hiện chưa có luồng nào.`, { parse_mode: 'Markdown' });
              }
              
              let fullMsg = sysInfo + `━━━━━━━━━━━━━━━━━━\n📺 *DANH SÁCH LUỒNG PHÁT:*\n\n`;
              const allButtons = [];

              list.forEach(s => {
                const icon = s.status === 'live' ? '🟢' : (s.status === 'downloading' ? '📥' : (s.status === 'reconnecting' ? '🟡' : (s.status === 'scheduled' ? '🕐' : '⚪')));
                
                let streamStr = `${icon} *LUỒNG #${s.id}*${s.name ? ` - *${escapeMarkdown(s.name)}*` : ''}\n`;
                streamStr += `├─ Trạng thái: \`${s.status.toUpperCase()}\`\n`;
                const protection = s.dualStream ? 'Song song A+B ⚡' : 'Đơn luồng 📡';
                streamStr += `├─ Chế độ: \`${protection}\`\n`;
                if (s.status === 'live' && s.startTime) {
                  streamStr += `├─ Đã chạy: \`${Math.floor((Date.now() - new Date(s.startTime)) / 60000)} phút\`\n`;
                }
                
                let logBrief = s.lastLog;
                if (s.status === 'live') {
                  const time = s.lastLog.match(/time=\S+/);
                  const bitrate = s.lastLog.match(/bitrate=\s*\S+/);
                  const speed = s.lastLog.match(/speed=\s*\S+/);
                  if (time && bitrate && speed) {
                    logBrief = `${time[0]} | ${bitrate[0]} | ${speed[0]}`;
                  }
                }

                if (s.dualStream && s.status === 'live') {
                  const statusA = (s.streamAActive !== false) ? '🟢 OK' : '🔴 LỖI';
                  const statusB = (s.streamBActive !== false) ? '🟢 OK' : '🔴 LỖI';
                  const logA = (s.streamAActive !== false) ? logBrief : (s.streamALog || 'Mất kết nối A');
                  const logB = (s.streamBActive !== false) ? logBrief : (s.streamBLog || 'Mất kết nối B');
                  streamStr += `├─ 🇺🇸 Server A: \`${statusA}\` (\`${escapeMarkdown(logA)}\`)\n`;
                  streamStr += `└─ 🇸🇬 Server B: \`${statusB}\` (\`${escapeMarkdown(logB)}\`)\n\n`;
                } else {
                  streamStr += `└─ Log: \`${escapeMarkdown(logBrief)}\`\n\n`;
                }
                fullMsg += streamStr;

                // Thêm hàng nút bấm cho từng luồng
                if (['live', 'launching', 'reconnecting', 'scheduled', 'downloading'].includes(s.status)) {
                  allButtons.push([
                    { text: `🛑 Dừng #${s.id}`, callback_data: `stop_${s.id}` },
                    { text: `⚙️ Sửa #${s.id}`, callback_data: `edit_${s.id}` }
                  ]);
                } else {
                  allButtons.push([
                    { text: `🚀 Chạy #${s.id}`, callback_data: `restart_${s.id}` },
                    { text: `⚙️ Sửa #${s.id}`, callback_data: `edit_${s.id}` },
                    { text: `🗑 Xóa #${s.id}`, callback_data: `delete_${s.id}` }
                  ]);
                }
              });

              bot.sendMessage(chatId, fullMsg, { 
                parse_mode: 'Markdown', 
                reply_markup: { inline_keyboard: allButtons } 
              });
            } catch(e) {
              console.error('Lỗi khi xử lý lệnh status:', e);
              bot.sendMessage(chatId, `❌ Lỗi lấy status: ${e.message}`);
            }
          }, 1000);
        }).catch(e => console.error(e));
      }

      else if (text === '/live' || text === '/once' || text === '/limit') {
        userStates.set(chatId, { cmd: text.substring(1), step: 'key', data: {} });
        bot.sendMessage(chatId, `🚀 *CHẾ ĐỘ THIẾT LẬP NHANH*\nBước 1: Vui lòng dán **Stream Key** của bạn:`, { 
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ Hủy thao tác', callback_data: 'cancel_wizard' }]] }
        });
      }

      else if (text === '/schedule' || text === '/scheduleonce') {
        userStates.set(chatId, { cmd: text.substring(1), step: 'key', data: {} });
        bot.sendMessage(chatId, `🕐 *CHẾ ĐỘ ĐẶT LỊCH NHANH*\nBước 1: Vui lòng dán **Stream Key** của bạn:`, { 
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ Hủy thao tác', callback_data: 'cancel_wizard' }]] }
        });
      }

      else if (text.startsWith('/live ') || text.startsWith('/once ') || text.startsWith('/limit ')) {
        const isOnce = text.startsWith('/once ');
        const isLimit = text.startsWith('/limit ');
        const parts = text.split(/\s+/).filter(Boolean);
        
        if (isLimit && parts.length < 4) {
          return bot.sendMessage(chatId, '❌ Lỗi: Bạn phải nhập theo mẫu: `/limit <Key> <Link> <Số_Phút>`', { parse_mode: 'Markdown' });
        } else if (!isLimit && parts.length < 3) {
          return bot.sendMessage(chatId, '❌ Lỗi: Bạn phải nhập theo mẫu: `/live <Key> <Link>`', { parse_mode: 'Markdown' });
        }
        
        let minutes = 0;
        let file = parts.slice(2).join(' ');
        if (isLimit) {
          minutes = parseInt(parts[parts.length - 1]) || 0;
          if (minutes <= 0) return bot.sendMessage(chatId, '❌ Lỗi: Số phút hẹn giờ phải lớn hơn 0!');
          parts.pop(); // Remove minutes
          file = parts.slice(2).join(' ');
        }
        
        const result = actions.startStream({ key: parts[1], file: file, mode: isOnce ? 'once' : 'loop', minutes: minutes });
        if (result.error) {
          bot.sendMessage(chatId, `❌ Lỗi: \`${escapeMarkdown(result.error)}\``, { parse_mode: 'Markdown' });
        } else {
          const displayFile = result.file ? path.basename(result.file) : 'Google Drive Video';
          let playModeText = isOnce ? 'Phát một lần' : 'Phát lặp vô hạn';
          if (isLimit) playModeText = `Hẹn giờ tắt (${minutes} phút)`;
          bot.sendMessage(chatId, `🚀 *ĐÃ TẠO LUỒNG #${result.id} THÀNH CÔNG*\n━━━━━━━━━━━━━━━━━━\n🎞 Video: \`${displayFile}\`\n🔄 Chế độ: \`${playModeText}\`\n📡 Chế độ phát: \`Song song A+B ⚡ (Bảo vệ tối đa)\``, { parse_mode: 'Markdown' });
        }
      }

      else if (text.startsWith('/schedule') && !text.startsWith('/status')) {
          // Xử lý chung cho /schedule và /scheduleonce
          const isOnce = text.startsWith('/scheduleonce');
          const parts = text.split(' ');
          if (parts.length < 4) return bot.sendMessage(chatId, '❌ Lỗi cú pháp.');
          let minutes = 0;
          if (!isNaN(parseInt(parts[parts.length - 1])) && !parts[parts.length - 1].includes(':')) minutes = parseInt(parts.pop());
          const timeStr = parts.pop();
          const now = new Date();
          let datePart = now.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).split(' ')[0];
          let scheduledTime = `${datePart}T${timeStr}`;
          
          // Parse và so sánh với giờ hiện tại tuyệt đối theo múi giờ Việt Nam (+07:00)
          const targetTime = new Date(scheduledTime + '+07:00').getTime();
          if (targetTime <= now.getTime()) {
            const tom = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            datePart = tom.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).split(' ')[0];
            scheduledTime = `${datePart}T${timeStr}`;
          }
          
          const result = actions.startStream({ key: parts[1], file: parts.slice(2).join(' '), mode: 'scheduled', scheduledMode: isOnce ? 'once' : 'loop', minutes, scheduledTime });
          if (result.error) bot.sendMessage(chatId, `❌ Lỗi: ${result.error}`);
          else {
            const displayTime = new Date(scheduledTime + '+07:00').toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
            bot.sendMessage(chatId, `📅 *ĐÃ ĐẶT LỊCH # ${result.id} THÀNH CÔNG*\n━━━━━━━━━━━━━━━━━━\n⏰ Thời gian: \`${displayTime}\`\n📡 Chế độ phát: \`Song song A+B ⚡ (Bảo vệ tối đa)\``, { parse_mode: 'Markdown' });
          }
      }

      else if (text.startsWith('/log ')) {
        const id = parseInt(text.split(' ')[1]);
        const logs = actions.getLogs(id);
        bot.sendMessage(chatId, `📜 *LOG #${id}:*\n\n\`\`\`\n${escapeMarkdown(logs)}\n\`\`\``, { parse_mode: 'Markdown' });
      }

      else if (text.startsWith('/admins')) {
        let msg = `👥 *ADMINS:* \n` + config.adminIds.map((id, i) => `${i+1}. \`${id}\``).join('\n');
        bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      }

      else if (text.startsWith('/reboot')) {
        bot.sendMessage(chatId, '🔄 *REBOOTING...*');
        setTimeout(() => actions.rebootServer(), 1000);
      }

      else if (text.startsWith('/clear')) {
        bot.sendMessage(chatId, `🧹 Đã dọn dẹp ${actions.clearStreams()} luồng.`);
      }
    } catch (e) {
      console.error('Lỗi xử lý tin nhắn:', e);
      broadcast(`❌ *LỖI HỆ THỐNG:* \`${e.message}\``);
    }
  });

  bot.on('callback_query', (query) => {
    try {
      const chatId = query.message.chat.id;
      if (!config.adminIds.includes(chatId)) return;
      const parts = query.data.split('_');
      const action = parts[0];
      const idStr = parts.slice(1).join('_');
      const id = parseInt(idStr);
      
      if (action === 'stop') {
        if (actions.stopStream(id)) {
          bot.answerCallbackQuery(query.id, { text: `Đã dừng #${id}` });
          bot.editMessageText(`🛑 *LUỒNG #${id}* Đã dừng.`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
        }
      } else if (action === 'restart') {
        const res = actions.restartStream(id);
        if (res.error) bot.answerCallbackQuery(query.id, { text: `Lỗi: ${res.error}`, show_alert: true });
        else {
          bot.answerCallbackQuery(query.id, { text: `Đang khởi động lại #${id}` });
          bot.editMessageText(`🚀 *LUỒNG #${id}* Đang khởi động lại...`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
        }
      } else if (action === 'delete') {
        if (actions.deleteStream(id)) {
          bot.answerCallbackQuery(query.id, { text: `Đã xóa luồng #${id}` });
          bot.editMessageText(`🗑 *LUỒNG #${id}* Đã được gỡ bỏ khỏi danh sách.`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
        }
      } 
      else if (action === 'edit') {
        const list = actions.getStreams();
        const s = list.find(x => x.id === id);
        if (!s) return bot.answerCallbackQuery(query.id, { text: 'Không tìm thấy luồng!' });
        
        bot.answerCallbackQuery(query.id);
        userStates.set(chatId, { cmd: 'edit', id: id, step: 'menu', data: { ...s } });
        
        let timingText = '';
        if (s.mode === 'scheduled') {
          const displayTime = new Date(s.scheduledTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
          timingText = `🕐 Đặt lịch phát (${displayTime})`;
        } else {
          timingText = `⚡ Đăng ngay lập tức`;
        }

        let playbackText = '';
        const finalMode = s.mode === 'scheduled' ? s.scheduledMode : s.mode;
        if (finalMode === 'once') {
          playbackText = `▶️ Phát một lần`;
        } else if (s.minutes > 0) {
          playbackText = `⏱️ Hẹn giờ tắt (${s.minutes} phút)`;
        } else {
          playbackText = `🔁 Vòng lặp vô hạn`;
        }

        const keyHint = s.key ? (s.key.substring(0, 6) + '****') : 'Chưa có key';

        let msgText = `⚙️ *CHỈNH SỬA CẤU HÌNH LUỒNG #${id}*\n━━━━━━━━━━━━━━━━━━\n`;
        msgText += `🏷️ Tên: *${escapeMarkdown(s.name || 'Mặc định')}*\n`;
        msgText += `🎞️ Video: \`${s.originalFile || s.file}\`\n`;
        msgText += `🔑 Stream Key: \`${keyHint}\`\n`;
        msgText += `⚡ Thời điểm phát: \`${timingText}\`\n`;
        msgText += `🔁 Hình thức phát: \`${playbackText}\`\n\n`;
        msgText += `Vui lòng chọn trường thông tin bạn muốn cập nhật:`;
        
        const menuButtons = [
          [{ text: '📝 Đổi tên gợi nhớ', callback_data: `editfield_name_${id}` }],
          [{ text: '🎞️ Đổi Tệp Video / Link Drive', callback_data: `editfield_file_${id}` }],
          [{ text: '🔑 Đổi Stream Key mới', callback_data: `editfield_key_${id}` }],
          [{ text: '⚡ Sửa Thời Điểm Phát (Đăng ngay / Đặt lịch)', callback_data: `editfield_timing_${id}` }],
          [{ text: '🔁 Sửa Hình Thức Phát (Loop / Một Lần / Hẹn Giờ)', callback_data: `editfield_playback_${id}` }],
          [{ text: '❌ Hủy thao tác', callback_data: 'cancel_wizard' }]
        ];
        bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: menuButtons } });
      }
      else if (action === 'editfield') {
        const [field, streamIdStr] = idStr.split('_');
        const streamId = parseInt(streamIdStr);
        const state = userStates.get(chatId);
        if (state && state.cmd === 'edit') {
          state.step = `edit_${field}`;
          bot.answerCallbackQuery(query.id);
          
          if (field === 'name') {
            bot.sendMessage(chatId, `📝 *Sửa Tên Gợi Nhớ (Luồng #${streamId}):*\nNhập tên mới hoặc gửi \`/cancel\` để giữ nguyên:`, { parse_mode: 'Markdown' });
          } else if (field === 'file') {
            bot.sendMessage(chatId, `🎞️ *Sửa tệp Video / Drive (Luồng #${streamId}):*\nNhập đường dẫn tệp mới hoặc link Google Drive mới:`, { parse_mode: 'Markdown' });
          } else if (field === 'key') {
            bot.sendMessage(chatId, `🔑 *Sửa Stream Key (Luồng #${streamId}):*\nNhập khóa luồng YouTube Stream Key mới:`, { parse_mode: 'Markdown' });
          } else if (field === 'timing') {
            const timingSelector = [
              [{ text: '⚡ Đăng Ngay Lập Tức', callback_data: `edittiming_now_${streamId}` }],
              [{ text: '🕐 Đặt Lịch Phát sóng', callback_data: `edittiming_sched_${streamId}` }],
              [{ text: '❌ Quay lại', callback_data: `edit_${streamId}` }]
            ];
            bot.sendMessage(chatId, `⚡ *Chọn thời điểm phát sóng mới cho Luồng #${streamId}:*`, { 
              parse_mode: 'Markdown', 
              reply_markup: { inline_keyboard: timingSelector } 
            });
          } else if (field === 'playback') {
            const playbackSelector = [
              [{ text: '🔁 Vòng Lặp Vô Hạn', callback_data: `editplayback_loop_${streamId}` }],
              [{ text: '▶️ Phát Một Lần', callback_data: `editplayback_once_${streamId}` }],
              [{ text: '⏱️ Hẹn Giờ Tắt', callback_data: `editplayback_limit_${streamId}` }],
              [{ text: '❌ Quay lại', callback_data: `edit_${streamId}` }]
            ];
            bot.sendMessage(chatId, `🔁 *Chọn hình thức phát mới cho Luồng #${streamId}:*`, { 
              parse_mode: 'Markdown', 
              reply_markup: { inline_keyboard: playbackSelector } 
            });
          }
        }
      }
      else if (action === 'edittiming') {
        const [timing, streamIdStr] = idStr.split('_');
        const streamId = parseInt(streamIdStr);
        const state = userStates.get(chatId);
        if (state && state.cmd === 'edit') {
          bot.answerCallbackQuery(query.id);
          if (timing === 'now') {
            const currentMode = state.data.mode === 'scheduled' ? state.data.scheduledMode : state.data.mode;
            state.data.mode = currentMode || 'loop';
            state.data.scheduledTime = null;
            saveEditChanges(chatId, state, actions);
          } else if (timing === 'sched') {
            state.step = 'edit_schedule_date';
            const now = new Date();
            bot.sendMessage(chatId, `📅 *Đặt Lịch Phát mới (Luồng #${streamId}):*\nChọn **Ngày phát** mới từ lịch bên dưới:`, { 
              parse_mode: 'Markdown', 
              reply_markup: generateCalendar(now.getFullYear(), now.getMonth())
            });
          }
        }
      }
      else if (action === 'editplayback') {
        const [playback, streamIdStr] = idStr.split('_');
        const streamId = parseInt(streamIdStr);
        const state = userStates.get(chatId);
        if (state && state.cmd === 'edit') {
          bot.answerCallbackQuery(query.id);
          const isScheduled = state.data.mode === 'scheduled';
          
          if (playback === 'loop') {
            if (isScheduled) {
              state.data.scheduledMode = 'loop';
            } else {
              state.data.mode = 'loop';
            }
            state.data.minutes = 0;
            saveEditChanges(chatId, state, actions);
          } else if (playback === 'once') {
            if (isScheduled) {
              state.data.scheduledMode = 'once';
            } else {
              state.data.mode = 'once';
            }
            state.data.minutes = 0;
            saveEditChanges(chatId, state, actions);
          } else if (playback === 'limit') {
            if (isScheduled) {
              state.step = 'edit_sched_minutes';
            } else {
              state.step = 'edit_minutes';
            }
            bot.sendMessage(chatId, `⏱️ *Hẹn Giờ Tắt (Luồng #${streamId}):*\nNhập số phút hoạt động trước khi tự động tắt (ví dụ: 120):`, { parse_mode: 'Markdown' });
          }
        }
      }
      else if (action === 'editschedmode') {
        const [schedMode, streamIdStr] = idStr.split('_');
        const state = userStates.get(chatId);
        if (state && state.cmd === 'edit') {
          bot.answerCallbackQuery(query.id);
          if (schedMode === 'loop') {
            state.data.scheduledMode = 'loop';
            state.data.minutes = 0;
            saveEditChanges(chatId, state, actions);
          } else if (schedMode === 'once') {
            state.data.scheduledMode = 'once';
            state.data.minutes = 0;
            saveEditChanges(chatId, state, actions);
          } else if (schedMode === 'limit') {
            state.step = 'edit_sched_minutes';
            bot.sendMessage(chatId, `⏱️ *Hẹn Giờ Tắt cho Lịch Phát (Luồng #${state.id}):*\nNhập số phút hoạt động trước khi tự động tắt (ví dụ: 120):`, { parse_mode: 'Markdown' });
          }
        }
      }
      // Xử lý Wizard Callbacks
      else if (action === 'cancel') {
        userStates.delete(chatId);
        bot.answerCallbackQuery(query.id, { text: 'Đã hủy thao tác' });
        bot.editMessageText('🚫 Thao tác thiết lập đã được hủy.', { chat_id: chatId, message_id: query.message.message_id });
      }
      else if (action === 'calnav') {
        const [y, m] = idStr.split('_').map(Number);
        const newDate = new Date(y, m, 1);
        bot.answerCallbackQuery(query.id);
        bot.editMessageReplyMarkup(generateCalendar(newDate.getFullYear(), newDate.getMonth()), { chat_id: chatId, message_id: query.message.message_id });
      }
      else if (action === 'wizdate') {
        const date = idStr; // Lấy YYYY-MM-DD từ idStr
        const state = userStates.get(chatId);
        if (state) {
          bot.answerCallbackQuery(query.id);
          if (state.cmd === 'edit') {
            state.data.editDate = date;
            state.step = 'edit_schedule_time';
            const quickTimes = [
              [{ text: '00:00', callback_data: 'wiztime_00:00' }, { text: '02:00', callback_data: 'wiztime_02:00' }, { text: '04:00', callback_data: 'wiztime_04:00' }, { text: '06:00', callback_data: 'wiztime_06:00' }],
              [{ text: '08:00', callback_data: 'wiztime_08:00' }, { text: '10:00', callback_data: 'wiztime_10:00' }, { text: '12:00', callback_data: 'wiztime_12:00' }, { text: '14:00', callback_data: 'wiztime_14:00' }],
              [{ text: '16:00', callback_data: 'wiztime_16:00' }, { text: '18:00', callback_data: 'wiztime_18:00' }, { text: '20:00', callback_data: 'wiztime_20:00' }, { text: '22:00', callback_data: 'wiztime_22:00' }],
              [{ text: '❌ Hủy thao tác', callback_data: 'cancel_wizard' }]
            ];
            bot.sendMessage(chatId, `⏰ *Sửa Lịch Phát (Luồng #${state.id}):*\nChọn **Giờ phát** mới hoặc tự nhập (VD: 14):`, { 
              parse_mode: 'Markdown', 
              reply_markup: { inline_keyboard: quickTimes } 
            });
          } else {
            handleWizard(chatId, date, state, actions);
          }
        }
      }
      else if (action === 'wiztime') {
        const hour = idStr.split(':')[0];
        const state = userStates.get(chatId);
        if (state) {
          bot.answerCallbackQuery(query.id);
          if (state.cmd === 'edit') {
            state.data.editHour = hour;
            state.step = 'edit_schedule_minute';
            const quickMins = [
              [{ text: ':00', callback_data: 'wizmin_00' }, { text: ':05', callback_data: 'wizmin_05' }, { text: ':10', callback_data: 'wizmin_10' }],
              [{ text: ':15', callback_data: 'wizmin_15' }, { text: ':20', callback_data: 'wizmin_20' }, { text: ':25', callback_data: 'wizmin_25' }],
              [{ text: ':30', callback_data: 'wizmin_30' }, { text: ':35', callback_data: 'wizmin_35' }, { text: ':40', callback_data: 'wizmin_40' }],
              [{ text: ':45', callback_data: 'wizmin_45' }, { text: ':50', callback_data: 'wizmin_50' }, { text: ':55', callback_data: 'wizmin_55' }],
              [{ text: '❌ Hủy thao tác', callback_data: 'cancel_wizard' }]
            ];
            bot.sendMessage(chatId, `⏱ *Sửa Lịch Phát (Luồng #${state.id}):*\nChọn **Phút phát** mới hoặc tự nhập (VD: 15):`, { 
              parse_mode: 'Markdown', 
              reply_markup: { inline_keyboard: quickMins } 
            });
          } else {
            handleWizard(chatId, hour, state, actions);
          }
        }
      }
      else if (action === 'wizmin') {
        const mins = idStr;
        const state = userStates.get(chatId);
        if (state) {
          bot.answerCallbackQuery(query.id);
          if (state.cmd === 'edit') {
            state.data.editHour = state.data.editHour || '00';
            state.data.editMinute = mins;
            
            const timeStr = `${String(state.data.editHour).padStart(2, '0')}:${String(state.data.editMinute).padStart(2, '0')}`;
            state.data.scheduledTime = `${state.data.editDate}T${timeStr}`;
            state.data.mode = 'scheduled';
            
            const schedSelector = [
              [{ text: '🔄 Lặp Phát Lịch', callback_data: `editschedmode_loop_${state.id}` }],
              [{ text: '▶️ Phát 1 Lần Lịch', callback_data: `editschedmode_once_${state.id}` }]
            ];
            bot.sendMessage(chatId, `🕐 *Sửa Đặt Lịch (Luồng #${state.id}):*\nChọn chế độ phát khi đến giờ lịch trình:`, {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: schedSelector }
            });
          } else {
            handleWizard(chatId, mins, state, actions);
          }
        }
      }
      else if (action === 'wizdur') {
        const dur = idStr;
        const state = userStates.get(chatId);
        if (state) {
          bot.answerCallbackQuery(query.id);
          handleWizard(chatId, dur, state, actions);
        }
      }
      else if (action === 'wizskipname') {
        const state = userStates.get(chatId);
        if (state) {
          bot.answerCallbackQuery(query.id);
          handleWizard(chatId, '__SKIP_NAME__', state, actions);
        }
      }
    } catch (e) { console.error('Lỗi nút bấm:', e.message); }
  });
}

function generateCalendar(year, month) {
  const labels = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
  const rows = [];
  
  // Tiêu đề Tháng Năm
  rows.push([{ text: `📅 Tháng ${month + 1} - ${year}`, callback_data: 'ignore' }]);
  
  // Thứ trong tuần
  rows.push(labels.map(l => ({ text: l, callback_data: 'ignore' })));
  
  const firstDay = new Date(year, month, 1).getDay(); // 0 (CN) -> 6 (T7)
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  
  let currentDay = 1;
  // Điều chỉnh firstDay cho phù hợp T2 là đầu tuần (T2=1, ..., CN=0)
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;

  for (let i = 0; i < 6; i++) {
    const row = [];
    for (let j = 0; j < 7; j++) {
      if (i === 0 && j < startOffset) {
        row.push({ text: ' ', callback_data: 'ignore' });
      } else if (currentDay > daysInMonth) {
        row.push({ text: ' ', callback_data: 'ignore' });
      } else {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(currentDay).padStart(2, '0')}`;
        row.push({ text: currentDay.toString(), callback_data: `wizdate_${dateStr}` });
        currentDay++;
      }
    }
    rows.push(row);
    if (currentDay > daysInMonth) break;
  }
  
  // Nút điều hướng tháng
  rows.push([
    { text: '◀️ Tháng trước', callback_data: `calnav_${year}_${month - 1}` },
    { text: 'Tháng sau ▶️', callback_data: `calnav_${year}_${month + 1}` }
  ]);
  rows.push([{ text: '❌ Hủy thao tác', callback_data: 'cancel_wizard' }]);
  
  return { inline_keyboard: rows };
}

function broadcast(message) {
  if (bot && config.adminIds && config.adminIds.length > 0) {
    console.log(`[System] 📢 Đang gửi báo cáo tới ${config.adminIds.length} quản trị viên...`);
    config.adminIds.forEach(id => {
      bot.sendMessage(id, message, { parse_mode: 'Markdown' }).catch(e => console.error(`Lỗi gửi tới ${id}:`, e.message));
    });
  } else {
    console.log('[System] ⚠️ Không có quản trị viên nào để gửi báo cáo.');
  }
}

function handleWizard(chatId, text, state, actions) {
  try {
    if (state.step === 'key') {
      state.data.key = text;
      state.step = 'link';
      bot.sendMessage(chatId, `🔗 Bước 2: Vui lòng dán **Link Google Drive**:`, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Hủy thao tác', callback_data: 'cancel_wizard' }]] }
      });
    } 
    else if (state.step === 'link') {
      state.data.link = text;
      state.step = 'name';
      bot.sendMessage(chatId, `📝 Bước 3: Vui lòng nhập **Tên Luồng** (hoặc nhấn nút dưới để bỏ qua dùng mặc định):`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '⏭️ Bỏ qua (Dùng mặc định)', callback_data: 'wizskipname' }],
          [{ text: '❌ Hủy thao tác', callback_data: 'cancel_wizard' }]
        ]}
      });
    }
    else if (state.step === 'name') {
      const streamName = text === '__SKIP_NAME__' ? '' : text;
      state.data.name = streamName;
      if (state.cmd.startsWith('schedule')) {
        state.step = 'date';
        const now = new Date();
        bot.sendMessage(chatId, `📅 Bước 4: Chọn **Ngày phát** từ lịch dưới đây:`, { 
          parse_mode: 'Markdown', 
          reply_markup: generateCalendar(now.getFullYear(), now.getMonth())
        });
      } else {
        const result = actions.startStream({ key: state.data.key, file: state.data.link, mode: state.cmd === 'once' ? 'once' : 'loop', minutes: 0, name: state.data.name });
        userStates.delete(chatId);
        bot.sendMessage(chatId, result.error ? `❌ Lỗi: \`${escapeMarkdown(result.error)}\`` : `✅ Đã tạo luồng *#${result.id}* thành công!`, { parse_mode: 'Markdown' });
      }
    }
    else if (state.step === 'date') {
      state.data.date = text;
      state.step = 'time';
      const quickTimes = [
        [{ text: '00:00', callback_data: 'wiztime_00:00' }, { text: '02:00', callback_data: 'wiztime_02:00' }, { text: '04:00', callback_data: 'wiztime_04:00' }, { text: '06:00', callback_data: 'wiztime_06:00' }],
        [{ text: '08:00', callback_data: 'wiztime_08:00' }, { text: '10:00', callback_data: 'wiztime_10:00' }, { text: '12:00', callback_data: 'wiztime_12:00' }, { text: '14:00', callback_data: 'wiztime_14:00' }],
        [{ text: '16:00', callback_data: 'wiztime_16:00' }, { text: '18:00', callback_data: 'wiztime_18:00' }, { text: '20:00', callback_data: 'wiztime_20:00' }, { text: '22:00', callback_data: 'wiztime_22:00' }],
        [{ text: '❌ Hủy thao tác', callback_data: 'cancel_wizard' }]
      ];
      bot.sendMessage(chatId, `⏰ Bước 5: Chọn **Giờ phát** hoặc tự nhập (VD: 14):`, { 
        parse_mode: 'Markdown', 
        reply_markup: { inline_keyboard: quickTimes } 
      });
    }
    else if (state.step === 'time') {
      state.data.hour = text;
      state.step = 'minute';
      const quickMins = [
        [{ text: ':00', callback_data: 'wizmin_00' }, { text: ':05', callback_data: 'wizmin_05' }, { text: ':10', callback_data: 'wizmin_10' }],
        [{ text: ':15', callback_data: 'wizmin_15' }, { text: ':20', callback_data: 'wizmin_20' }, { text: ':25', callback_data: 'wizmin_25' }],
        [{ text: ':30', callback_data: 'wizmin_30' }, { text: ':35', callback_data: 'wizmin_35' }, { text: ':40', callback_data: 'wizmin_40' }],
        [{ text: ':45', callback_data: 'wizmin_45' }, { text: ':50', callback_data: 'wizmin_50' }, { text: ':55', callback_data: 'wizmin_55' }],
        [{ text: '❌ Hủy thao tác', callback_data: 'cancel_wizard' }]
      ];
      bot.sendMessage(chatId, `⏱ Bước 6: Chọn **Phút** hoặc tự nhập (VD: 05, 15, 30):`, { 
        parse_mode: 'Markdown', 
        reply_markup: { inline_keyboard: quickMins } 
      });
    }
    else if (state.step === 'minute') {
      state.data.minute = text;
      state.step = 'duration';
      const quickDurs = [
        [{ text: '🔄 Phát lặp (0)', callback_data: 'wizdur_0' }, { text: '1h', callback_data: 'wizdur_60' }, { text: '6h', callback_data: 'wizdur_360' }],
        [{ text: '❌ Hủy thao tác', callback_data: 'cancel_wizard' }]
      ];
      bot.sendMessage(chatId, `⏳ Bước 7: Nhập **Thời lượng phát** (phút) hoặc chọn nhanh:`, { 
        parse_mode: 'Markdown', 
        reply_markup: { inline_keyboard: quickDurs } 
      });
    }
    else if (state.step === 'duration') {
      const minutes = parseInt(text) || 0;
      const isOnce = state.cmd === 'scheduleonce';
      const timeStr = `${String(state.data.hour).padStart(2, '0')}:${String(state.data.minute).padStart(2, '0')}`;
      const scheduledTime = `${state.data.date}T${timeStr}`;
      
      const result = actions.startStream({ 
        key: state.data.key, 
        file: state.data.link, 
        mode: 'scheduled', 
        scheduledMode: isOnce ? 'once' : 'loop', 
        minutes, 
        scheduledTime,
        name: state.data.name
      });
      
      userStates.delete(chatId);
      if (result.error) bot.sendMessage(chatId, `❌ Lỗi: ${result.error}`);
      else {
        const displayTime = new Date(scheduledTime + '+07:00').toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        bot.sendMessage(chatId, `📅 *ĐÃ ĐẶT LỊCH # ${result.id}* thành công lúc \`${displayTime}\``, { parse_mode: 'Markdown' });
      }
    }
  } catch (e) {
    userStates.delete(chatId);
    bot.sendMessage(chatId, `❌ Có lỗi xảy ra trong quá trình nhập: ${e.message}`);
  }
}

function updateProgress(streamId, pct, text) {
  if (!bot || !config.adminIds) return;
  try {
    let current = activeProgressMessages.get(streamId);
    if (!current) {
      current = { messageIds: {}, lastPct: pct || 0 };
      activeProgressMessages.set(streamId, current);
    }
    config.adminIds.forEach(chatId => {
      if (!current.messageIds[chatId]) {
        if (current._sending) return; // Đang gửi tin nhắn đầu, không gửi thêm
        current._sending = true;
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).then(m => {
          current.messageIds[chatId] = m.message_id;
          current._sending = false;
          current.lastTime = Date.now();
        }).catch(() => { current._sending = false; });
      } else {
        const now = Date.now();
        // Giới hạn tối thiểu 4 giây mới sửa tin nhắn tiến độ 1 lần để tránh bị Telegram chặn 429
        const timePassed = now - (current.lastTime || 0) > 4000; 
        
        if (pct === null || pct === 100 || timePassed) {
          if (current._editing) return; // Đang sửa tin nhắn cũ, đợi tí
          current._editing = true;
          bot.editMessageText(text, { chat_id: chatId, message_id: current.messageIds[chatId], parse_mode: 'Markdown' })
            .then(() => {
              current._editing = false;
              current.lastTime = Date.now();
              if (typeof pct === 'number') current.lastPct = pct;
            })
            .catch(() => { current._editing = false; });
        }
      }
    });
    if (pct === 100) activeProgressMessages.delete(streamId);
  } catch (e) { console.error('Lỗi cập nhật tiến độ:', e.message); }
}

function handleEditInput(chatId, text, state, actions) {
  try {
    const id = state.id;
    if (state.step === 'edit_name') {
      state.data.name = text;
      saveEditChanges(chatId, state, actions);
    } 
    else if (state.step === 'edit_file') {
      state.data.file = text;
      state.data.originalFile = text;
      saveEditChanges(chatId, state, actions);
    } 
    else if (state.step === 'edit_key') {
      state.data.key = text;
      saveEditChanges(chatId, state, actions);
    }
    else if (state.step === 'edit_minutes') {
      const minutes = parseInt(text) || 0;
      if (minutes <= 0) {
        return bot.sendMessage(chatId, '❌ Lỗi: Số phút hẹn giờ phải lớn hơn 0. Vui lòng nhập lại:');
      }
      state.data.mode = 'loop';
      state.data.minutes = minutes;
      saveEditChanges(chatId, state, actions);
    }
    else if (state.step === 'edit_sched_minutes') {
      const minutes = parseInt(text) || 0;
      if (minutes <= 0) {
        return bot.sendMessage(chatId, '❌ Lỗi: Số phút hẹn giờ phải lớn hơn 0. Vui lòng nhập lại:');
      }
      state.data.scheduledMode = 'loop';
      state.data.minutes = minutes;
      saveEditChanges(chatId, state, actions);
    }
    else if (state.step === 'edit_schedule_time') {
      state.data.editHour = text;
      state.step = 'edit_schedule_minute';
      bot.sendMessage(chatId, `⏱ Nhập **Phút phát** mới (0 - 59):`);
    }
    else if (state.step === 'edit_schedule_minute') {
      state.data.editMinute = text;
      
      const timeStr = `${String(state.data.editHour).padStart(2, '0')}:${String(state.data.editMinute).padStart(2, '0')}`;
      state.data.scheduledTime = `${state.data.editDate}T${timeStr}`;
      state.data.mode = 'scheduled';
      
      const schedSelector = [
        [{ text: '🔁 Vòng Lặp Vô Hạn', callback_data: `editschedmode_loop_${state.id}` }],
        [{ text: '▶️ Phát Một Lần', callback_data: `editschedmode_once_${state.id}` }],
        [{ text: '⏱️ Hẹn Giờ Tắt', callback_data: `editschedmode_limit_${state.id}` }],
        [{ text: '❌ Quay lại menu', callback_data: `edit_${state.id}` }]
      ];
      bot.sendMessage(chatId, `🕐 *Sửa Đặt Lịch (Luồng #${state.id}):*\nChọn chế độ phát khi đến giờ lịch trình:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: schedSelector }
      });
    }
  } catch (e) {
    userStates.delete(chatId);
    bot.sendMessage(chatId, `❌ Có lỗi khi lưu thay đổi: ${e.message}`);
  }
}

function saveEditChanges(chatId, state, actions) {
  try {
    const result = actions.editStream({
      id: state.id,
      name: state.data.name,
      key: state.data.key,
      file: state.data.originalFile || state.data.file,
      mode: state.data.mode,
      minutes: state.data.minutes,
      scheduledTime: state.data.scheduledTime,
      scheduledMode: state.data.scheduledMode
    });
    
    userStates.delete(chatId);
    
    if (result.error) {
      bot.sendMessage(chatId, `❌ Thất bại khi lưu cấu hình: ${result.error}`);
    } else {
      let detailMsg = `✅ *ĐÃ CẬP NHẬT CẤU HÌNH LUỒNG #${state.id} THÀNH CÔNG!*\n━━━━━━━━━━━━━━━━━━\n`;
      detailMsg += `🏷️ Tên mới: *${escapeMarkdown(state.data.name || 'Mặc định')}*\n`;
      detailMsg += `🎞️ Video mới: \`${state.data.originalFile || state.data.file}\`\n`;
      
      let timingText = '';
      if (state.data.mode === 'scheduled') {
        const displayTime = new Date(state.data.scheduledTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        timingText = `🕐 Đặt lịch phát (${displayTime})`;
      } else {
        timingText = `⚡ Đăng ngay lập tức`;
      }

      let playbackText = '';
      const finalMode = state.data.mode === 'scheduled' ? state.data.scheduledMode : state.data.mode;
      if (finalMode === 'once') {
        playbackText = `▶️ Phát một lần`;
      } else if (state.data.minutes > 0) {
        playbackText = `⏱️ Hẹn giờ tắt (${state.data.minutes} phút)`;
      } else {
        playbackText = `🔁 Vòng lặp vô hạn`;
      }

      detailMsg += `⚡ Thời điểm phát mới: \`${timingText}\`\n`;
      detailMsg += `🔁 Hình thức phát mới: \`${playbackText}\`\n`;
      detailMsg += `📡 Chế độ phát: \`Song song A+B ⚡ (Bảo vệ tối đa)\``;
      
      bot.sendMessage(chatId, detailMsg, { parse_mode: 'Markdown' });
    }
  } catch (e) {
    userStates.delete(chatId);
    bot.sendMessage(chatId, `❌ Lỗi lưu cấu hình: ${e.message}`);
  }
}

module.exports = { initBot, broadcast, updateProgress, sendToZalo };
