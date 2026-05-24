const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Colors
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const B = (s) => `\x1b[36m${s}\x1b[0m`;

const CONCURRENCY = 4; // Tải 4 luồng song song để vắt kiệt băng thông VPS 1Gbps
const TEMP_DIR = path.join(__dirname, 'temp_chunks');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

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

function formatSpeed(bytesPerSec) {
  const MB = bytesPerSec / 1024 / 1024;
  return `${MB.toFixed(1)} MB/s (${(MB * 8).toFixed(1)} Mbps)`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ── BƯỚC 1: Lấy URL Tải Cuối Cùng & Cookie Bypass từ Google ──
function getDirectDownloadInfo(url, cookieString, attempt) {
  return new Promise((resolve, reject) => {
    if (attempt > 4) return reject(new Error("Quá nhiều vòng redirect."));

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      }
    };
    if (cookieString) options.headers['Cookie'] = cookieString;

    const transport = url.startsWith('http://') ? http : https;
    transport.get(url, options, (res) => {
      let newCookieString = cookieString;
      if (res.headers['set-cookie']) {
        newCookieString = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
      }

      // Nếu redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        const confirmTokenMatch = newCookieString.match(/download_warning_[^=]+=([^;]+)/);
        if (confirmTokenMatch && !redirectUrl.includes('confirm=')) {
          redirectUrl += `&confirm=${confirmTokenMatch[1]}`;
        }
        return resolve(getDirectDownloadInfo(redirectUrl, newCookieString, attempt + 1));
      }

      // Nếu trúng trang HTML Bypass Virus
      if (res.statusCode === 200 && res.headers['content-type'] && res.headers['content-type'].includes('text/html')) {
        let htmlBody = '';
        res.on('data', chunk => htmlBody += chunk);
        res.on('end', () => {
          if (htmlBody.includes("Quota exceeded")) {
            return reject(new Error("File này đã vượt quá hạn mức tải của Google Drive hôm nay."));
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
            return resolve(getDirectDownloadInfo(bypassUrl, newCookieString, attempt + 1));
          } else {
            return reject(new Error("Không tìm thấy mã xác nhận Virus. Google có thể đang yêu cầu đăng nhập."));
          }
        });
        return;
      }

      if (res.statusCode === 200) {
        let totalBytes = parseInt(res.headers['content-length'], 10) || 0;
        resolve({ directUrl: url, cookie: cookieString, totalBytes });
        return;
      }

      reject(new Error(`Server từ chối (Code: ${res.statusCode})`));
    }).on('error', reject);
  });
}

// ── BƯỚC 2: Tải Một Phân Đoạn Bằng Lệnh Range Header ──
function downloadChunk(directUrl, cookie, start, end, chunkPath, threadId, onProgress) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Range': `bytes=${start}-${end}`
      }
    };
    if (cookie) options.headers['Cookie'] = cookie;

    const transport = directUrl.startsWith('http://') ? http : https;
    
    // Tăng buffer size của fileStream lên 4MB để tối ưu I/O đĩa
    const fileStream = fs.createWriteStream(chunkPath, { highWaterMark: 1024 * 1024 * 4 });

    transport.get(directUrl, options, (res) => {
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        return reject(new Error(`Luồng #${threadId} bị từ chối với Code: ${res.statusCode}`));
      }

      res.on('data', (chunk) => {
        fileStream.write(chunk);
        if (onProgress) onProgress(chunk.length);
      });

      res.on('end', () => {
        fileStream.end();
      });

      fileStream.on('finish', () => {
        resolve();
      });

      fileStream.on('error', (err) => {
        fileStream.close();
        reject(err);
      });
    }).on('error', reject);
  });
}

// ── BƯỚC 3: Hợp Nhất Các Phân Đoạn Thành Tệp Hoàn Chỉnh ──
function mergeFiles(chunkPaths, destPath) {
  return new Promise((resolve, reject) => {
    const mainWriteStream = fs.createWriteStream(destPath, { highWaterMark: 1024 * 1024 * 4 });
    
    function mergeNext(index) {
      if (index >= chunkPaths.length) {
        mainWriteStream.end();
        return;
      }
      
      const chunkPath = chunkPaths[index];
      const readStream = fs.createReadStream(chunkPath, { highWaterMark: 1024 * 1024 * 4 });
      readStream.pipe(mainWriteStream, { end: false });
      
      readStream.on('end', () => {
        // Xóa chunk tạm ngay sau khi hợp nhất xong để tiết kiệm đĩa
        fs.unlinkSync(chunkPath);
        mergeNext(index + 1);
      });

      readStream.on('error', (err) => {
        reject(err);
      });
    }

    mainWriteStream.on('finish', () => {
      resolve();
    });

    mainWriteStream.on('error', (err) => {
      reject(err);
    });

    mergeNext(0);
  });
}

// ── BƯỚC 4: ĐIỀU PHỐI ĐA LUỒNG SONG SONG ──
async function downloadMultiThreaded(driveUrl, destPath) {
  const fileId = extractDriveId(driveUrl);
  if (!fileId) throw new Error("Link Google Drive không hợp lệ!");

  console.log(Y('🚀 Bước 1: Đang phân tích mã xác thực và lấy link tải trực tiếp...'));
  const initialUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const info = await getDirectDownloadInfo(initialUrl, "", 1);

  console.log(G(`    ✅ Nhận link tải thành công! Dung lượng tệp: ${formatBytes(info.totalBytes)}`));
  console.log(Y(`🚀 Bước 2: Chia tệp thành ${CONCURRENCY} phần để tải song song...`));

  const chunkSize = Math.ceil(info.totalBytes / CONCURRENCY);
  const tasks = [];
  const chunkPaths = [];
  
  let downloadedBytes = 0;
  let lastReport = Date.now();
  let lastReportBytes = 0;

  // Interval đo tốc độ tổng
  const speedInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastReport;
    if (elapsed >= 1000) {
      const pct = Math.round((downloadedBytes / info.totalBytes) * 100);
      const speed = (downloadedBytes - lastReportBytes) / (elapsed / 1000);
      
      process.stdout.write(`    ⚡ [ĐANG TẢI ĐA LUỒNG] Tiến độ: ${pct}% | Đã tải: ${formatBytes(downloadedBytes)} / ${formatBytes(info.totalBytes)} | Tốc độ gộp: ${formatSpeed(speed)}\r`);
      
      lastReport = now;
      lastReportBytes = downloadedBytes;
    }
  }, 1000);

  // Tạo và chạy các luồng
  for (let i = 0; i < CONCURRENCY; i++) {
    const start = i * chunkSize;
    const end = Math.min((i + 1) * chunkSize - 1, info.totalBytes - 1);
    const chunkPath = path.join(TEMP_DIR, `chunk_${i}.tmp`);
    chunkPaths.push(chunkPath);

    console.log(B(`    ├─ Luồng #${i + 1}: bytes ${formatBytes(start)} ➔ ${formatBytes(end)}`));

    tasks.push(
      downloadChunk(info.directUrl, info.cookie, start, end, chunkPath, i + 1, (bytesRead) => {
        downloadedBytes += bytesRead;
      })
    );
  }

  console.log(Y('\n🔥 BẮT ĐẦU VẮT KIỆT BĂNG THÔNG VPS 1GBPS...'));
  
  // Đợi tất cả hoàn thành
  await Promise.all(tasks);
  clearInterval(speedInterval);
  process.stdout.write(`    ⚡ [ĐANG TẢI ĐA LUỒNG] Tiến độ: 100% | Đã tải: ${formatBytes(info.totalBytes)} / ${formatBytes(info.totalBytes)} | Hoàn tất!\n`);

  console.log(G('\n✓ Đã tải xong cả 4 phân đoạn!'));
  console.log(Y('🚀 Bước 3: Đang hợp nhất các phân đoạn thành tệp hoàn chỉnh...'));
  
  const startMerge = Date.now();
  await mergeFiles(chunkPaths, destPath);
  console.log(G(`✓ Hợp nhất thành công trong ${((Date.now() - startMerge) / 1000).toFixed(1)} giây!`));

  // Dọn dẹp thư mục tạm
  try { fs.rmdirSync(TEMP_DIR); } catch (_) {}
}

async function main() {
  const args = process.argv.slice(2);
  const driveUrl = args[0];

  if (!driveUrl) {
    console.log(R('❌ LỖI: Vui lòng nhập link Google Drive!'));
    process.exit(1);
  }

  const destFile = path.join(__dirname, `multithread_video_${Date.now()}.mp4`);
  const start = Date.now();

  try {
    await downloadMultiThreaded(driveUrl, destFile);
    const timeSec = (Date.now() - start) / 1000;
    const size = fs.statSync(destFile).size;
    const speed = size / timeSec;

    console.log(B('\n═══════════════════════════════════════════════════════════════════════════════════════'));
    console.log(G(' 🎉 KẾT QUẢ ĐẠT TỐC ĐỘ CỰC ĐẠI (SAY HELLO TO 1GBPS NETWORK CARD)'));
    console.log(B('═══════════════════════════════════════════════════════════════════════════════════════'));
    console.log(` Dung lượng tải thực: ${G(formatBytes(size))}`);
    console.log(` Tổng thời gian tải:  ${G(timeSec.toFixed(1) + ' giây')}`);
    console.log(` Tốc độ trung bình:   ${G(formatSpeed(speed))}`);
    console.log(B('═══════════════════════════════════════════════════════════════════════════════════════\n'));

    // Dọn dẹp tệp tải hoàn chỉnh
    fs.unlinkSync(destFile);
  } catch (e) {
    console.log(R(`\n❌ Quá trình tải thất bại: ${e.message}`));
    // Dọn dẹp rác nếu lỗi
    try { fs.unlinkSync(destFile); } catch (_) {}
    try {
      for (let i = 0; i < CONCURRENCY; i++) {
        fs.unlinkSync(path.join(TEMP_DIR, `chunk_${i}.tmp`));
      }
    } catch (_) {}
    try { fs.rmdirSync(TEMP_DIR); } catch (_) {}
  }
}

main().catch(console.error);
