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
// Nhận diện trang báo "hết lượt tải" của Google Drive (nhiều kiểu câu chữ)
const QUOTA_RE = /Quota exceeded|Too many users have viewed or downloaded|can(?:'|&#39;|’|no)t view or download this file at this time|download quota|downloadQuotaExceeded|vượt quá hạn mức/i;
function makeQuotaError() {
  const err = new Error("File này đã vượt quá hạn mức tải xuống của Google Drive trong hôm nay. 👉 Cách sửa: Hãy 'Tạo bản sao' file này trên Drive và dùng link của bản sao đó.");
  err.code = 'DRIVE_QUOTA';
  return err;
}

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
    // Giới hạn thời gian chờ: trước đây không có → Google treo kết nối là luồng kẹt "Đang bắt đầu tải" mãi mãi
    options.timeout = parseInt(process.env.DRIVE_PROBE_TIMEOUT_MS, 10) || 30000;
    const req = transport.get(url, options, (res) => {

      let newCookieString = cookieString;
      if (res.headers['set-cookie']) {
        newCookieString = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
      }

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Bỏ thân phản hồi chuyển hướng để trả socket về pool (trước đây bị giữ → rò rỉ socket, lâu ngày hết 64 socket → treo)
        res.resume();
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
          if (QUOTA_RE.test(htmlBody)) {
            return reject(makeQuotaError());
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
        // Đây là chính nội dung file (chỉ cần header lấy dung lượng) → hủy ngay để không giữ socket (trước đây rò rỉ mỗi lần tải)
        res.destroy();
        return;
      }

      if (res.statusCode === 403 || res.statusCode === 429) {
        let body = '';
        res.on('data', chunk => { if (body.length < 200000) body += chunk; });
        res.on('end', () => {
          if (QUOTA_RE.test(body)) return reject(makeQuotaError());
          reject(new Error(`Bị từ chối quyền truy cập (Code: ${res.statusCode}). File Drive có bật chế độ Chia Sẻ không?`));
        });
        res.on('error', () => reject(new Error(`Bị từ chối quyền truy cập (Code: ${res.statusCode}).`)));
        return;
      }
      res.resume();
      reject(new Error(`Bị từ chối quyền truy cập (Code: ${res.statusCode}). File Drive có bật chế độ Chia Sẻ không?`));
    }).on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Google Drive không phản hồi sau ${Math.round(options.timeout / 1000)} giây (kết nối bị treo).`));
    });
  });
}

// ── BƯỚC 2: Tải Một Phân Đoạn Bằng Lệnh Range Header (Có Timeout & Tự động Thử lại + Resume) ──
function downloadChunk(directUrl, cookie, start, end, chunkPath, threadId, onProgress) {
  const maxRetries = 6;
  const timeoutMs = 20000; // 20s socket inactivity timeout

  return new Promise((resolve, reject) => {
    let attempt = 0;

    function tryDownload() {
      attempt++;
      
      let existingSize = 0;
      if (fs.existsSync(chunkPath)) {
        try {
          const stats = fs.statSync(chunkPath);
          existingSize = stats.size;
        } catch (e) {
          existingSize = 0;
        }
      }

      const expectedSize = end - start + 1;
      if (existingSize >= expectedSize) {
        console.log(`[Thread #${threadId}] Phân đoạn đã đầy đủ (${existingSize} bytes). Bỏ qua.`);
        return resolve();
      }

      // Nếu file tạm bị lỗi dung lượng lớn hơn cả mong đợi -> xóa đi tải lại
      if (existingSize > expectedSize) {
        try { fs.unlinkSync(chunkPath); } catch(_) {}
        existingSize = 0;
      }

      const currentStart = start + existingSize;
      const rangeHeader = `bytes=${currentStart}-${end}`;
      
      if (attempt > 1) {
        console.log(`[Thread #${threadId}] Thử lại lần ${attempt}/${maxRetries}. Range: ${rangeHeader}`);
      }

      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
          'Range': rangeHeader
        },
        agent: directUrl.startsWith('https://') ? httpsAgent : httpAgent,
        timeout: timeoutMs
      };
      if (cookie) options.headers['Cookie'] = cookie;

      const transport = directUrl.startsWith('http://') ? http : https;
      let fileStream;
      let req;
      let isDone = false;
      let progressTimeout = null;

      function resetProgressTimeout() {
        if (progressTimeout) clearTimeout(progressTimeout);
        progressTimeout = setTimeout(() => {
          cleanupResources();
          handleFailure(new Error("Hết thời gian chờ dữ liệu (Data Timeout 25s)"));
        }, 25000);
      }

      function cleanupResources() {
        if (progressTimeout) {
          clearTimeout(progressTimeout);
          progressTimeout = null;
        }
        if (fileStream) {
          try { fileStream.destroy(); } catch (_) {}
        }
        if (req) {
          try { req.destroy(); } catch (_) {}
        }
      }

      // Mở fileStream ở chế độ 'a' (append) nếu đang tiếp tục tải, ngược lại dùng 'w' (write)
      const streamFlags = existingSize > 0 ? 'a' : 'w';
      fileStream = fs.createWriteStream(chunkPath, { flags: streamFlags, highWaterMark: 1024 * 1024 * 4 });

      resetProgressTimeout();

      req = transport.get(directUrl, options, (res) => {
        const ctype = String(res.headers['content-type'] || '').toLowerCase();
        // Nếu Google trả trang HTML (hết quota / cảnh báo virus / lỗi) hoặc 403/429 ở giữa chừng khi tải chunk:
        // tuyệt đối không ghi HTML vào file .mp4! Đọc nội dung để nhận diện lỗi hết lượt tải (DRIVE_QUOTA).
        if (ctype.includes('text/html') || res.statusCode === 403 || res.statusCode === 429) {
          let errBody = '';
          res.on('data', c => { if (errBody.length < 65536) errBody += c.toString('utf8'); });
          res.on('end', () => {
            cleanupResources();
            try { if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath); } catch (_) {}
            if (QUOTA_RE.test(errBody) || ctype.includes('text/html')) {
              if (isDone) return;
              isDone = true;
              return reject(makeQuotaError());
            }
            handleFailure(new Error(`Mã phản hồi HTTP: ${res.statusCode}`));
          });
          res.on('error', (e) => { cleanupResources(); handleFailure(e); });
          return;
        }

        // Khi yêu cầu Range (hoặc tải nối tiếp currentStart > 0), bắt buộc phản hồi phải là 206 Partial Content
        // (chỉ chấp nhận 200 nếu tải 1 luồng từ byte 0 và Content-Length khớp expectedSize)
        const contentLen = parseInt(res.headers['content-length'], 10) || 0;
        const valid200 = res.statusCode === 200 && currentStart === 0 && (!expectedSize || !contentLen || contentLen === expectedSize);
        if (res.statusCode !== 206 && !valid200) {
          res.resume();
          cleanupResources();
          handleFailure(new Error(`Mã phản hồi HTTP không hợp lệ cho Range (${rangeHeader}): ${res.statusCode}`));
          return;
        }

        res.on('data', (chunk) => {
          if (isDone) return;
          resetProgressTimeout();
          fileStream.write(chunk);
          if (onProgress) onProgress(chunk.length);
        });

        res.on('end', () => {
          if (isDone) return;
          fileStream.end();
        });

        res.on('error', (err) => {
          cleanupResources();
          handleFailure(err);
        });
      });

      req.on('timeout', () => {
        cleanupResources();
        handleFailure(new Error(`Hết thời gian chờ phản hồi Socket (${timeoutMs}ms)`));
      });

      req.on('error', (err) => {
        cleanupResources();
        handleFailure(err);
      });

      fileStream.on('finish', () => {
        if (isDone) return;
        // Kiểm tra dung lượng phân đoạn thực tế trên đĩa phải khớp đúng expectedSize (tránh trường hợp kết nối đóng sớm làm thiếu dữ liệu)
        let finalSize = 0;
        try { finalSize = fs.statSync(chunkPath).size; } catch (_) {}
        if (expectedSize > 0 && finalSize < expectedSize) {
          handleFailure(new Error(`Phân đoạn chưa tải đủ dữ liệu (${finalSize}/${expectedSize} bytes)`));
          return;
        }
        if (expectedSize > 0 && finalSize > expectedSize) {
          try { fs.unlinkSync(chunkPath); } catch (_) {}
          handleFailure(new Error(`Phân đoạn vượt kích thước mong đợi (${finalSize}/${expectedSize} bytes)`));
          return;
        }
        isDone = true;
        if (progressTimeout) {
          clearTimeout(progressTimeout);
          progressTimeout = null;
        }
        resolve();
      });

      fileStream.on('error', (err) => {
        cleanupResources();
        handleFailure(err);
      });

      function handleFailure(err) {
        if (isDone) return;
        isDone = true;
        if (progressTimeout) {
          clearTimeout(progressTimeout);
          progressTimeout = null;
        }
        
        console.error(`[Thread #${threadId}] Lỗi ở lần thử ${attempt}: ${err.message}`);
        
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 6000); // Thử lại trễ lũy thừa tối đa 6s
          setTimeout(tryDownload, delay);
        } else {
          reject(new Error(`Tải phân đoạn thất bại sau ${maxRetries} lần thử. Chi tiết: ${err.message}`));
        }
      }
    }

    tryDownload();
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
      if (!info.totalBytes || info.totalBytes < 1024) {
        return reject(new Error(`Không xác định được kích thước hợp lệ của file Drive (${info.totalBytes || 0} bytes).`));
      }
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

        // Kiểm tra tính toàn vẹn của tệp sau khi ghép: đúng dung lượng và không phải trang HTML lỗi
        const mergedStat = fs.statSync(finalDest);
        if (info.totalBytes > 0 && mergedStat.size !== info.totalBytes) {
          try { fs.unlinkSync(finalDest); } catch (_) {}
          throw new Error(`File tải về không khớp dung lượng gốc (${mergedStat.size}/${info.totalBytes} bytes).`);
        }
        const headBuf = Buffer.alloc(Math.min(512, mergedStat.size));
        const fd = fs.openSync(finalDest, 'r');
        try { fs.readSync(fd, headBuf, 0, headBuf.length, 0); } finally { try { fs.closeSync(fd); } catch (_) {} }
        const headStr = headBuf.toString('utf8');
        if (/^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(headStr) || QUOTA_RE.test(headStr)) {
          try { fs.unlinkSync(finalDest); } catch (_) {}
          throw makeQuotaError();
        }

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
  extractDriveId,
  QUOTA_RE,
  downloadChunk,
  getDirectDownloadInfo, // dùng cho test
  _agents: { httpsAgent, httpAgent } // dùng cho test rò rỉ socket
};
