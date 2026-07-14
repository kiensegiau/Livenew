const fs = require('fs');
const path = require('path');
const http = require('http');

const CONFIG_PATH = path.join(__dirname, 'bot_config.json');

// Đọc cấu hình
let config = { zalo: { enabled: false, serverUrl: "", threadId: "" } };
if (fs.existsSync(CONFIG_PATH)) {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function sendToZalo(text) {
  if (!config.zalo || !config.zalo.enabled || !config.zalo.serverUrl) {
    console.error('Zalo chưa được bật trong config hoặc thiếu serverUrl!');
    return;
  }

  const urlStr = config.zalo.serverUrl;
  const threadId = config.zalo.threadId;
  if (!threadId) {
    console.error('Thiếu threadId!');
    return;
  }

  try {
    const url = new URL(urlStr);
    const cleanText = text.replace(/\*/g, '').replace(/`/g, '');
    const payload = JSON.stringify({
      threadId: String(threadId),
      type: "Group",
      message: cleanText
    });

    console.log('--- Payload gửi đi ---');
    console.log(payload);
    console.log('----------------------');

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

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[Zalo] Kết quả: ${data}`);
      });
    });

    req.on('error', (e) => {
      console.error(`[Zalo] Lỗi gửi: ${e.message}`);
    });

    req.write(payload);
    req.end();
  } catch (err) {
    console.error('[Zalo] Lỗi:', err.message);
  }
}

// Giả lập báo cáo định kỳ
const mockReport = `📊 *BÁO CÁO HỆ THỐNG ĐỊNH KỲ*
━━━━━━━━━━━━━━━━━━
⏱ Uptime: \`13.5h\` | 🧠 RAM: \`1.2/11.4GB\`
💽 Disk: \`53.8/95.8GB (56%)\` | ⚡ CPU: \`12.5%\`
🌐 Mạng: ⬇️ \`4.5 Mbps\` | ⬆️ \`137.8 Mbps\`
📺 Luồng: \`8/8\` đang chạy

🟢 *#19* (Luồng live 1): \`live\` | \`time=00:00:56.03 | speed=0.991x\`
🟢 *#29* (295- live thông): \`live\` | \`time=00:00:56.53 | speed=1.01x\`
📭 _Thử nghiệm tiếng Việt: ă â ê ô ơ ư đ_`;

sendToZalo(mockReport);
