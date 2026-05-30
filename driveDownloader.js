const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

// Cấu hình Keep-Alive Agent để tối ưu hóa kết nối TCP, giảm thời gian handshake và tận dụng băng thông VPS 1Gbps tốt hơn
const keepAliveTimeout = 15000;
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  keepAliveMsecs: keepAliveTimeout
});
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  keepAliveMsecs: keepAliveTimeout
});

function extractDriveId(url) {
  if (!url || typeof url !== 'string') return null;
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

// ── BƯỚC 1: Lấy URL Tải Cuối Cùng & Cookie Bypass từ Google ──
function getDirectDownloadInfo(url, cookieString, attempt) {
  return new Promise((resolve, reject) => {
    if (attempt > 4) return reject(new Error("Quá số vòng Redirect tối đa của Google Drive."));

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
        return resolve(getDirectDownloadInfo(redirectUrl, newCookieString, attempt + 1));
      }

      if (res.statusCode === 200 && res.headers['content-type'] && res.headers['content-type'].includes('text/html')) {
        let htmlBody = '';
        res.on('data', chunk => htmlBody += chunk);
        res.on('end', () => {
          if (htmlBody.includes("Quota exceeded")) {
            return reject(new Error("File này đã vượt quá hạn mức tải xuống của Google Drive trong hôm nay. 👉 Cách sửa: Hãy 'Tạo bản sao' file này trên Drive và dùng link của bản sao đó."));
          }

          const actionMatch = htmlBody.match(/action="([^"]+)"/i);
          const confirmMatch = htmlBody.match(/name="confirm"\s+value="([^"]+)"/i) 
                            || htmlBody.match(/confirm=([a-zA-Z0-9_\-]+)/i)
                            || htmlBody.match(/"confirm":"([a-zA-Z0-9_\-]+)"/i);
          
          const uuidMatch = htmlBody.match(/name="uuid"\s+value="([^"]+)"/i);
          const idMatch = htmlBody.match(/name="id"\s+value="([^"]+)"/i) 
                       || htmlBody.match(/id=([a-zA-Z0-9_\-]+)/i);

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
            return reject(new Error("Giải mã Bypass Virus thất bại. Google có thể đang yêu cầu đăng nhập hoặc link bị giới hạn."));
          }
        });
        return;
      }

      if (res.statusCode === 200) {
        let totalBytes = parseInt(res.headers['content-length'], 10) || 0;
        resolve({ directUrl: url, cookie: newCookieString, totalBytes });
        return;
      }

      reject(new Error(`Bị từ chối quyền truy cập (Code: ${res.statusCode}). File Drive có bật chế độ Chia Sẻ không?`));
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
      },
      agent: directUrl.startsWith('https://') ? httpsAgent : httpAgent
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
        try { fs.unlinkSync(chunkPath); } catch (_) {}
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

// ── BƯỚC 4: ĐIỀU PHỐI ĐA LUỒNG DOWNLOAD CHÍNH ──
function downloadGoogleDriveFile(driveUrl, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const fileId = extractDriveId(driveUrl);
    if (!fileId) return reject(new Error("Link Google Drive không hợp lệ!"));

    const initialUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    
    getDirectDownloadInfo(initialUrl, "", 1).then(async (info) => {
      // Xác định số lượng luồng: File lớn hơn 50MB mới chia 4 luồng, file nhỏ tải 1 luồng tránh overhead
      const CONCURRENCY = info.totalBytes > 50 * 1024 * 1024 ? 4 : 1;
      const TEMP_DIR = path.join(destPath, `temp_chunks_${fileId}_${Date.now()}`);
      
      if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

      const chunkSize = Math.ceil(info.totalBytes / CONCURRENCY);
      const tasks = [];
      const chunkPaths = [];
      
      let downloadedBytes = 0;
      let lastReport = Date.now();
      let lastReportBytes = 0;

      // Interval đo tốc độ và báo cáo về server.js qua callback onProgress
      const progressInterval = setInterval(() => {
        const now = Date.now();
        const elapsed = now - lastReport;
        if (elapsed >= 1000) {
          const pct = info.totalBytes ? Math.round((downloadedBytes / info.totalBytes) * 100) : null;
          const speedBytesPerSec = (downloadedBytes - lastReportBytes) / (elapsed / 1000);
          
          if (onProgress) {
            onProgress(downloadedBytes, info.totalBytes, pct, speedBytesPerSec);
          }
          
          lastReport = now;
          lastReportBytes = downloadedBytes;
        }
      }, 1000);

      // Tạo và kích hoạt các luồng tải song song
      for (let i = 0; i < CONCURRENCY; i++) {
        const start = i * chunkSize;
        const end = Math.min((i + 1) * chunkSize - 1, info.totalBytes - 1);
        const chunkPath = path.join(TEMP_DIR, `chunk_${i}.tmp`);
        chunkPaths.push(chunkPath);

        tasks.push(
          downloadChunk(info.directUrl, info.cookie, start, end, chunkPath, i + 1, (bytesRead) => {
            downloadedBytes += bytesRead;
          })
        );
      }

      try {
        // Đợi tất cả các luồng hoàn tất
        await Promise.all(tasks);
        clearInterval(progressInterval);

        // Báo cáo hoàn thành 100%
        if (onProgress) {
          onProgress(info.totalBytes, info.totalBytes, 100, 0);
        }

        // Tạo tên tệp video chính thức
        const filename = `drive_video_${Date.now()}.mp4`;
        const finalDest = path.join(destPath, filename);

        // Hợp nhất các phân đoạn thành tệp video duy nhất
        await mergeFiles(chunkPaths, finalDest);

        // Dọn dẹp thư mục tạm của phân đoạn
        try { fs.rmdirSync(TEMP_DIR); } catch (_) {}
        
        resolve(finalDest);
      } catch (err) {
        clearInterval(progressInterval);
        // Dọn dẹp rác nếu gặp sự cố trong quá trình tải/hợp nhất
        try {
          chunkPaths.forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
          fs.rmdirSync(TEMP_DIR);
        } catch (_) {}
        reject(err);
      }

    }).catch(reject);
  });
}

module.exports = {
  downloadGoogleDriveFile,
  extractDriveId
};
