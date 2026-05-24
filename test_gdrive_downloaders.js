const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const https = require('https');
const http = require('http');

// Colors
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const B = (s) => `\x1b[36m${s}\x1b[0m`;

// Target dir
const TEMP_DIR = path.join(__dirname, 'temp_downloads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Extract file ID
function extractDriveId(url) {
  let m = url.match(/\/file\/d\/([a-zA-Z0-9_\-]+)/);
  if (m) return m[1];
  m = url.match(/[?&]id=([a-zA-Z0-9_\-]+)/);
  if (m) return m[1];
  m = url.match(/\/u\/\d+\/d\/([a-zA-Z0-9_\-]+)/);
  if (m) return m[1];
  m = url.match(/\/open\?id=([a-zA-Z0-9_\-]+)/);
  if (m) return m[1];
  return null;
}

// Format speed
function formatSpeed(bytesPerSec) {
  const MB = bytesPerSec / 1024 / 1024;
  return `${MB.toFixed(1)} MB/s (${(MB * 8).toFixed(1)} Mbps)`;
}

// Format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// -------------------------------------------------------------
// METHOD A: Native Node.js Stream Downloader (From App)
// -------------------------------------------------------------
const keepAliveTimeout = 15000;
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: keepAliveTimeout });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: keepAliveTimeout });

function fetchUrl(url, cookieString, attempt, destPath, resolve, reject) {
  if (attempt > 3) return reject(new Error("Quá số vòng Redirect."));

  const options = { 
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    },
    agent: url.startsWith('https://') ? httpsAgent : httpAgent
  };
  if (cookieString) options.headers['Cookie'] = cookieString;

  const transport = url.startsWith('http://') ? http : https;
  transport.get(url, options, (res) => {
    let newCookieString = cookieString;
    if (res.headers['set-cookie']) {
      newCookieString = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
    }

    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      let redirectUrl = res.headers.location;
      const confirmTokenMatch = newCookieString.match(/download_warning_[^=]+=([^;]+)/);
      if (confirmTokenMatch && !redirectUrl.includes('confirm=')) {
        redirectUrl += `&confirm=${confirmTokenMatch[1]}`;
      }
      return fetchUrl(redirectUrl, newCookieString, attempt + 1, destPath, resolve, reject);
    }

    if (res.statusCode === 200 && res.headers['content-type'] && res.headers['content-type'].includes('text/html')) {
      let htmlBody = '';
      res.on('data', chunk => htmlBody += chunk);
      res.on('end', () => {
        if (htmlBody.includes("Quota exceeded")) {
          return reject(new Error("Quota exceeded"));
        }
        const actionMatch = htmlBody.match(/action="([^"]+)"/i);
        const confirmMatch = htmlBody.match(/name="confirm"\s+value="([^"]+)"/i) 
                          || htmlBody.match(/confirm=([a-zA-Z0-9_\-]+)/i)
                          || htmlBody.match(/"confirm":"([a-zA-Z0-9_\-]+)"/i);
        const idMatch = htmlBody.match(/name="id"\s+value="([^"]+)"/i) || htmlBody.match(/id=([a-zA-Z0-9_\-]+)/i);
        const uuidMatch = htmlBody.match(/name="uuid"\s+value="([^"]+)"/i);

        if (confirmMatch) {
          const confirmToken = confirmMatch[1];
          const fileId = idMatch ? idMatch[1] : extractDriveId(url);
          const finalAction = actionMatch ? actionMatch[1].replace(/&amp;/g, '&') : "https://drive.google.com/uc";
          let bypassUrl = finalAction;
          if (!bypassUrl.includes('?')) bypassUrl += '?';
          if (!bypassUrl.includes('id=')) bypassUrl += `&id=${fileId}`;
          bypassUrl += `&export=download&confirm=${confirmToken}`;
          if (uuidMatch) bypassUrl += `&uuid=${uuidMatch[1]}`;
          return fetchUrl(bypassUrl, newCookieString, attempt + 1, destPath, resolve, reject);
        } else {
          return reject(new Error("Không tìm thấy confirm token"));
        }
      });
      return;
    }

    if (res.statusCode === 200) {
      let totalBytes = parseInt(res.headers['content-length'], 10) || 0;
      const fileStream = fs.createWriteStream(destPath, { highWaterMark: 1024 * 1024 * 4 });
      
      const { PassThrough } = require('stream');
      const bufferBridge = new PassThrough({ highWaterMark: 1024 * 1024 * 4 });
      res.pipe(bufferBridge).pipe(fileStream);

      let lastReport = Date.now();
      let lastReportBytes = 0;

      const progressInterval = setInterval(() => {
        const downloadedBytes = fileStream.bytesWritten;
        const now = Date.now();
        const timePassed = now - lastReport;
        if (timePassed >= 1000) {
          const pct = totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
          const speedBytesPerSec = (downloadedBytes - lastReportBytes) / (timePassed / 1000);
          
          process.stdout.write(`    ⏳ Tiến độ: ${pct}% | Đã tải: ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)} | Tốc độ: ${formatSpeed(speedBytesPerSec)}\r`);
          
          lastReport = now;
          lastReportBytes = downloadedBytes;
        }
      }, 1000);

      fileStream.on('finish', () => {
        clearInterval(progressInterval);
        fileStream.close();
      });
      fileStream.on('close', () => resolve(totalBytes));
      fileStream.on('error', (err) => {
        clearInterval(progressInterval);
        reject(err);
      });
      return;
    }
    reject(new Error(`Bị từ chối (Code: ${res.statusCode})`));
  }).on('error', reject);
}

function downloadMethodA(fileId, destPath) {
  return new Promise((resolve, reject) => {
    const initialUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    fetchUrl(initialUrl, "", 1, destPath, resolve, reject);
  });
}

// -------------------------------------------------------------
// METHOD B: Python 'gdown' Downloader
// -------------------------------------------------------------
function downloadMethodB(fileId, destPath) {
  return new Promise((resolve, reject) => {
    console.log(Y('    Checking if python gdown is installed...'));
    try {
      execSync('gdown --version', { stdio: 'ignore' });
    } catch (_) {
      return reject(new Error("Chưa cài đặt 'gdown'. Cách sửa trên VPS: chạy lệnh 'pip install gdown' hoặc 'sudo apt install python3-gdown'"));
    }

    console.log(G('    ✅ gdown sẵn sàng. Bắt đầu tải...'));
    const gdownProcess = spawn('gdown', [
      '--id', fileId,
      '-O', destPath,
      '--no-cookies'
    ]);

    gdownProcess.stdout.on('data', (data) => {
      process.stdout.write(`    [gdown] ${data.toString().trim()}\r`);
    });

    gdownProcess.stderr.on('data', (data) => {
      process.stdout.write(`    [gdown] ${data.toString().trim()}\r`);
    });

    gdownProcess.on('close', (code) => {
      if (code === 0) {
        if (fs.existsSync(destPath)) {
          const stats = fs.statSync(destPath);
          resolve(stats.size);
        } else {
          reject(new Error("File không xuất hiện sau khi gdown báo hoàn thành."));
        }
      } else {
        reject(new Error(`gdown thoát với mã lỗi: ${code}`));
      }
    });
  });
}

// -------------------------------------------------------------
// METHOD C: Shell Wget Downloader with Cookie confirmation
// -------------------------------------------------------------
function downloadMethodC(fileId, destPath) {
  return new Promise((resolve, reject) => {
    console.log(Y('    Bắt đầu tải bằng wget với Cookie confirmation...'));
    
    // Command to parse confirm token and download in one line
    const cmd = `wget --load-cookies /tmp/cookies.txt "https://docs.google.com/uc?export=download&confirm=$(wget --quiet --save-cookies /tmp/cookies.txt --keep-session-cookies --no-check-certificate 'https://docs.google.com/uc?export=download&id=${fileId}' -O- | sed -rn 's/.*confirm=([0-9A-Za-z_&=-]+).*/\\1\\n/p')&id=${fileId}" -O "${destPath}" && rm -rf /tmp/cookies.txt`;

    const shellProcess = spawn('bash', ['-c', cmd]);

    shellProcess.on('error', (err) => {
      reject(new Error("Không tìm thấy 'bash' shell trên hệ điều hành này (Lỗi này bình thường trên Windows)."));
    });

    shellProcess.stderr.on('data', (data) => {
      // wget logs speed to stderr
      const str = data.toString();
      if (str.includes('%') || str.includes('MB/s') || str.includes('KB/s')) {
        process.stdout.write(`    [wget] ${str.trim().slice(-100)}\r`);
      }
    });

    shellProcess.on('close', (code) => {
      if (code === 0) {
        if (fs.existsSync(destPath)) {
          const stats = fs.statSync(destPath);
          resolve(stats.size);
        } else {
          reject(new Error("File không xuất hiện sau khi wget hoàn tất."));
        }
      } else {
        reject(new Error(`wget thoát với mã lỗi: ${code}`));
      }
    });
  });
}

// -------------------------------------------------------------
// CORE RUNNER
// -------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const driveUrl = args[0];

  if (!driveUrl) {
    console.log(R('❌ LỖI: Vui lòng nhập link Google Drive làm tham số!'));
    console.log(Y('👉 Ví dụ: node test_gdrive_downloaders.js "https://drive.google.com/file/d/1A2B3C.../view"'));
    process.exit(1);
  }

  const fileId = extractDriveId(driveUrl);
  if (!fileId) {
    console.log(R('❌ LỖI: Link Google Drive không hợp lệ!'));
    process.exit(1);
  }

  console.log(B('\n═════════════════════════════════════════════════════════'));
  console.log(B(`  Google Drive Downloader VPS Optimization Test Suite`));
  console.log(B(`  File ID: ${fileId}`));
  console.log(B('═════════════════════════════════════════════════════════\n'));

  const results = [];

  // --- METHOD A ---
  console.log(Y('🚀 [METHOD A] Trình tải Javascript Native (Dùng luồng bộ đệm 4MB của App)'));
  const fileA = path.join(TEMP_DIR, `method_a_${Date.now()}.mp4`);
  const startA = Date.now();
  try {
    const size = await downloadMethodA(fileId, fileA);
    const timeSec = (Date.now() - startA) / 1000;
    const speed = size / timeSec;
    results.push({ method: 'Native App JS (4MB Buffer)', size, timeSec, speedStr: formatSpeed(speed), speedRaw: speed, status: 'SUCCESS' });
    console.log(G('\n    ✓ SUCCESS in ' + timeSec.toFixed(1) + 's (' + formatSpeed(speed) + ')\n'));
  } catch (e) {
    results.push({ method: 'Native App JS (4MB Buffer)', size: 0, timeSec: 0, speedStr: 'N/A', speedRaw: 0, status: 'FAILED: ' + e.message });
    console.log(R(`    ✗ FAILED: ${e.message}\n`));
  } finally {
    try { fs.unlinkSync(fileA); } catch (_) {}
  }

  // --- METHOD B ---
  console.log(Y('🚀 [METHOD B] Trình tải Python gdown (Bộ công cụ tối ưu hóa chuyên biệt của Google)'));
  const fileB = path.join(TEMP_DIR, `method_b_${Date.now()}.mp4`);
  const startB = Date.now();
  try {
    const size = await downloadMethodB(fileId, fileB);
    const timeSec = (Date.now() - startB) / 1000;
    const speed = size / timeSec;
    results.push({ method: 'Python gdown (Chuyên biệt)', size, timeSec, speedStr: formatSpeed(speed), speedRaw: speed, status: 'SUCCESS' });
    console.log(G('\n    ✓ SUCCESS in ' + timeSec.toFixed(1) + 's (' + formatSpeed(speed) + ')\n'));
  } catch (e) {
    results.push({ method: 'Python gdown (Chuyên biệt)', size: 0, timeSec: 0, speedStr: 'N/A', speedRaw: 0, status: 'FAILED: ' + e.message });
    console.log(R(`    ✗ FAILED: ${e.message}\n`));
  } finally {
    try { fs.unlinkSync(fileB); } catch (_) {}
  }

  // --- METHOD C ---
  console.log(Y('🚀 [METHOD C] Trình tải Wget Shell (Chạy lệnh hệ điều hành Linux trực tiếp)'));
  const fileC = path.join(TEMP_DIR, `method_c_${Date.now()}.mp4`);
  const startC = Date.now();
  try {
    const size = await downloadMethodC(fileId, fileC);
    const timeSec = (Date.now() - startC) / 1000;
    const speed = size / timeSec;
    results.push({ method: 'Linux Wget Shell (Native OS)', size, timeSec, speedStr: formatSpeed(speed), speedRaw: speed, status: 'SUCCESS' });
    console.log(G('\n    ✓ SUCCESS in ' + timeSec.toFixed(1) + 's (' + formatSpeed(speed) + ')\n'));
  } catch (e) {
    results.push({ method: 'Linux Wget Shell (Native OS)', size: 0, timeSec: 0, speedStr: 'N/A', speedRaw: 0, status: 'FAILED: ' + e.message });
    console.log(R(`    ✗ FAILED: ${e.message}\n`));
  } finally {
    try { fs.unlinkSync(fileC); } catch (_) {}
  }

  // Clear temp dir
  try { fs.rmdirSync(TEMP_DIR); } catch (_) {}

  // -------------------------------------------------------------
  // PRINT RECOMMENDATION REPORT
  // -------------------------------------------------------------
  console.log(B('═══════════════════════════════════════════════════════════════════════════════════════'));
  console.log(B('  BẢNG SO SÁNH HIỆU NĂNG TẢI TRÊN VPS (GOOGE DRIVE DOWNLOADER COMPARE)'));
  console.log(B('═══════════════════════════════════════════════════════════════════════════════════════'));
  
  console.log(String('Phương Pháp Tải').padEnd(30) + ' | ' + String('Dung Lượng').padEnd(12) + ' | ' + String('Thời Gian').padEnd(12) + ' | ' + String('Tốc Độ Trung Bình').padEnd(25) + ' | ' + 'Trạng Thái');
  console.log('-'.repeat(95));
  
  results.forEach(r => {
    const sizeStr = r.size ? formatBytes(r.size) : '0 MB';
    const timeStr = r.timeSec ? `${r.timeSec.toFixed(1)}s` : 'N/A';
    console.log(
      r.method.padEnd(30) + ' | ' +
      sizeStr.padEnd(12) + ' | ' +
      timeStr.padEnd(12) + ' | ' +
      r.speedStr.padEnd(25) + ' | ' +
      (r.status === 'SUCCESS' ? G(r.status) : R(r.status))
    );
  });
  console.log(B('═══════════════════════════════════════════════════════════════════════════════════════\n'));

  // Recommend best method
  const successful = results.filter(r => r.status === 'SUCCESS');
  if (successful.length > 0) {
    successful.sort((a, b) => b.speedRaw - a.speedRaw);
    console.log(G(`👉 PHƯƠNG PHÁP TỐI ƯU NHẤT CHO VPS CỦA BẠN: ${successful[0].method}`));
    console.log(Y(`   Tốc độ tối đa đạt được: ${successful[0].speedStr}`));
  } else {
    console.log(R('❌ Tất cả các phương pháp tải đều thất bại. Hãy kiểm tra lại link Google Drive hoặc quyền chia sẻ của tệp.'));
  }
  console.log();
}

main().catch(console.error);
