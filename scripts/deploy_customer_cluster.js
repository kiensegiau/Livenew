const { Client } = require('ssh2');
const fs = require('fs');

const VPS1 = {
  id: 'vps1',
  name: 'VPS 1 (Chính - Master)',
  ip: '57.129.135.140',
  isMaster: true
};

const VPS2 = {
  id: 'vps2',
  name: 'VPS 2 (Phụ - Worker)',
  ip: '57.129.194.73',
  isMaster: false
};

const SSH_USER = 'ubuntu';
const SSH_PASS = 'kienkaka2001';

// Read users from backup fetched earlier
const usersContent = fs.readFileSync('users_khach.json', 'utf8');

function executeRemote(ip, script, label) {
  return new Promise((resolve, reject) => {
    console.log(`[${label}] Bắt đầu kết nối SSH tới ${ip}...`);
    const conn = new Client();
    conn.on('ready', () => {
      console.log(`[${label}] Đã kết nối! Đang thực thi script...`);
      conn.exec(script, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }
        let stdout = '';
        let stderr = '';
        stream.on('data', d => {
          const str = d.toString();
          stdout += str;
          process.stdout.write(`[${label}] ${str}`);
        });
        stream.stderr.on('data', d => {
          const str = d.toString();
          stderr += str;
          process.stderr.write(`[${label} ERR] ${str}`);
        });
        stream.on('close', (code) => {
          conn.end();
          console.log(`[${label}] Lệnh hoàn tất với mã thoát: ${code}`);
          resolve({ code, stdout, stderr });
        });
      });
    }).on('error', err => {
      reject(err);
    }).connect({
      host: ip,
      port: 22,
      username: SSH_USER,
      password: SSH_PASS,
      readyTimeout: 30000
    });
  });
}

function generateSetupScript(node) {
  const isVps1 = node.id === 'vps1';
  const clusterNodes = JSON.stringify([
    { id: 'vps1', name: 'VPS 1 (Chính - Master)', ip: VPS1.ip, port: 3131, isMaster: true, isLocal: isVps1 },
    { id: 'vps2', name: 'VPS 2 (Phụ - Worker)', ip: VPS2.ip, port: 3131, isMaster: false, isLocal: !isVps1 }
  ], null, 2);

  const sheetConfig = JSON.stringify({
    syncSecret: '9368f38294314bbcf6ffc3ebbac4892a',
    googleSheetScriptUrl: '',
    directSheetAuth: false,
    driveCopyUrls: [],
    lastSyncTime: null,
    youtubeStatsScriptUrl: 'https://script.google.com/macros/s/AKfycbxYgYyp4MHxYQ8HoovJwywvwgLCrpETZ71Kha6L4Pzva3nvv65p95ZXQnQvzNh1GVmiLw/exec'
  }, null, 2);

  const botConfig = JSON.stringify({
    token: '',
    adminIds: [],
    password: '',
    polling: false,
    zalo: { enabled: false, serverUrl: '', threadId: '' },
    sentinel: { enabled: false, knownServers: [], intervalMs: 60000 }
  }, null, 2);

  // We embed everything into bash script
  return `
echo "kienkaka2001" | sudo -S -E bash -c '
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ffmpeg ca-certificates speedtest-cli
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2
'

cd /home/ubuntu
rm -rf /home/ubuntu/Livenew
git clone https://github.com/kiensegiau/Livenew.git /home/ubuntu/Livenew
cd /home/ubuntu/Livenew
npm install --omit=dev
mkdir -p videos logs temp_drive downloads temp

cat > bot_config.json << 'EOF'
${botConfig}
EOF

cat > sheet_config.json << 'EOF'
${sheetConfig}
EOF

cat > cluster_nodes.json << 'EOF'
${clusterNodes}
EOF

cat > users.json << 'EOF'
${usersContent}
EOF

cp users.json users_backup.json

pm2 delete live-controller 2>/dev/null || true
pm2 start server.js --name live-controller
pm2 save

echo "kienkaka2001" | sudo -S env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ubuntu --hp /home/ubuntu || true
pm2 save

echo "=== SPEEDTEST ==="
speedtest-cli
echo "SETUP_SUCCESS"
`;
}

async function main() {
  console.log('🚀 Bắt đầu cài đặt đồng thời 2 VPS cho Cụm Khách...');
  
  const p1 = executeRemote(VPS1.ip, generateSetupScript(VPS1), 'VPS 1 (Master)');
  const p2 = executeRemote(VPS2.ip, generateSetupScript(VPS2), 'VPS 2 (Worker)');

  try {
    const [res1, res2] = await Promise.all([p1, p2]);
    console.log('\n🎉 CẢ 2 VPS ĐÃ CÀI ĐẶT XONG!');
  } catch (err) {
    console.error('❌ Lỗi cài đặt:', err);
  }
}

main();
