const http = require('http');

const VPS_URL = 'http://57.129.134.155:3131';
const USER_AGENT = 'CyberShieldSecureAgent/1.0';

function fetchApi(path) {
  return new Promise((resolve, reject) => {
    const url = `${VPS_URL}${path}`;
    const req = http.get(url, {
      headers: {
        'User-Agent': USER_AGENT
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ error: 'JSON parse error', raw: data });
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timeout (5s)'));
    });
  });
}

async function run() {
  console.log('==================================================');
  console.log('   CYBER-SHIELD AEGIS - VPS REMOTE DIAGNOSTIC     ');
  console.log('==================================================');
  console.log(`Connecting to VPS at: ${VPS_URL}...`);

  try {
    const sysinfo = await fetchApi('/api/sysinfo');
    console.log('\n[+] KẾT NỐI VPS: THÀNH CÔNG! ✅');
    console.log('--------------------------------------------------');
    console.log('📊 THÔNG TIN HỆ THỐNG VPS:');
    console.log(`  • Platform:   ${sysinfo.platform} (Node: ${sysinfo.nodeVersion})`);
    console.log(`  • CPU Model:  ${sysinfo.cpuModel}`);
    console.log(`  • CPU Load:   ${sysinfo.cpuUsage}%`);
    console.log(`  • RAM:        ${sysinfo.ramUsed} / ${sysinfo.ramTotal} (${sysinfo.ramUsage}%)`);
    console.log(`  • Disk:       ${sysinfo.diskUsed} GB / ${sysinfo.diskTotal} GB (${sysinfo.diskUsage}%)`);
    console.log(`  • Network TX: ${sysinfo.netSpeedTx} | RX: ${sysinfo.netSpeedRx}`);
    console.log(`  • Uptime:     ${sysinfo.vpsUptime}`);
    
    console.log('--------------------------------------------------');
    const streams = await fetchApi('/api/streams');
    console.log(`📺 DANH SÁCH LUỒNG TRÊN VPS (${streams.length} luồng):`);
    
    if (streams.length === 0) {
      console.log('  (Hiện chưa có luồng nào được cấu hình)');
    } else {
      streams.forEach(s => {
        const icon = s.status === 'live' ? '🟢' : (s.status === 'downloading' ? '📥' : (s.status === 'scheduled' ? '🕐' : '⚪'));
        console.log(`  ${icon} Luồng #${s.id} [${s.name || 'Không tên'}]:`);
        console.log(`     - Trạng thái:  ${s.status.toUpperCase()}`);
        console.log(`     - File nguồn:  ${s.originalFile}`);
        console.log(`     - Chế độ phát: ${s.mode} (Thời lượng: ${s.minutes} phút)`);
        console.log(`     - Key YouTube: ${s.key}`);
        if (s.youtubeUrl) console.log(`     - Link YT:     ${s.youtubeUrl}`);
        if (s.lastLog) console.log(`     - Log mới nhất: ${s.lastLog}`);
        console.log('');
      });
    }
  } catch (err) {
    console.error('\n❌ KẾT NỐI VPS THẤT BẠI!');
    console.error('Chi tiết lỗi:', err.message);
  }
  console.log('==================================================');
}

run();
