/**
 * test_youtube_viewer.js - Kiểm tra module youtubeViewer.js
 */
const assert = require('assert');
const http = require('http');
const { extractYouTubeVideoId, fetchLiveStats, startYouTubePoller, stopYouTubePoller } = require('./youtubeViewer');

async function runTests() {
  console.log('[ TEST ] Bắt đầu kiểm tra youtubeViewer.js...');

  // 1. Kiểm tra trích xuất Video ID từ các định dạng link YouTube
  console.log('\n[ 1 ] Trích xuất Video ID');
  const cases = [
    { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', expected: 'dQw4w9WgXcQ' },
    { url: 'https://youtu.be/dQw4w9WgXcQ', expected: 'dQw4w9WgXcQ' },
    { url: 'https://youtube.com/live/dQw4w9WgXcQ?feature=share', expected: 'dQw4w9WgXcQ' },
    { url: 'https://www.youtube.com/embed/dQw4w9WgXcQ', expected: 'dQw4w9WgXcQ' },
    { url: 'dQw4w9WgXcQ', expected: 'dQw4w9WgXcQ' },
    { url: 'https://www.youtube.com/watch?v=AbC_12-34Xy&t=10s', expected: 'AbC_12-34Xy' },
    { url: '', expected: null },
    { url: 'https://google.com', expected: null }
  ];

  cases.forEach(({ url, expected }) => {
    const actual = extractYouTubeVideoId(url);
    assert.strictEqual(actual, expected, `Link: ${url} -> Phải là ${expected}, nhưng nhận ${actual}`);
    console.log(`  ✓ PASS Link '${url}' -> '${actual}'`);
  });

  // 2. Tạo Mock Apps Script Server để kiểm tra fetchLiveStats
  console.log('\n[ 2 ] Gọi Apps Script Server (Mock test)');
  let mockCalled = false;
  const mockServer = http.createServer((req, res) => {
    mockCalled = true;
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.searchParams.get('action') === 'live_stats') {
      const vids = url.searchParams.get('videoIds').split(',');
      const items = {};
      vids.forEach(v => {
        items[v] = {
          viewers: 550,
          views: 12500,
          likes: 430,
          isLive: true,
          title: 'Top Hits 2026 Live'
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, items }));
    } else {
      res.writeHead(400);
      res.end('Bad Request');
    }
  });

  await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
  const port = mockServer.address().port;
  const scriptUrl = `http://127.0.0.1:${port}/exec`;

  try {
    const stats = await fetchLiveStats(['dQw4w9WgXcQ', 'https://youtu.be/AbC_12-34Xy'], { scriptUrl });
    assert.strictEqual(mockCalled, true, 'Server mock phải được gọi');
    assert.ok(stats['dQw4w9WgXcQ'], 'Phải có data của video 1');
    assert.strictEqual(stats['dQw4w9WgXcQ'].viewers, 550);
    assert.strictEqual(stats['dQw4w9WgXcQ'].likes, 430);
    console.log('  ✓ PASS Đọc stats thành công từ Mock Apps Script');

    // 3. Kiểm tra Poller tích hợp
    console.log('\n[ 3 ] Kiểm tra Poller');
    const mockStreams = [
      { id: 1, status: 'live', youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ' },
      { id: 2, status: 'stopped', youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ' },
      { id: 3, status: 'live', youtubeUrl: '' }
    ];

    let pollerUpdated = false;
    startYouTubePoller({
      getStreams: () => mockStreams,
      getScriptUrl: () => scriptUrl,
      intervalMs: 1000,
      onUpdated: () => { pollerUpdated = true; }
    });

    await new Promise(r => setTimeout(r, 6000));
    stopYouTubePoller();

    assert.strictEqual(mockStreams[0].viewers, 550, 'Stream 1 phải có viewers = 550');
    assert.strictEqual(mockStreams[1].viewers, undefined, 'Stream 2 (stopped) không được cập nhật');
    assert.strictEqual(pollerUpdated, true, 'onUpdated callback phải được gọi');
    console.log('  ✓ PASS Poller tự động cập nhật mắt xem vào stream object');

  } finally {
    mockServer.close();
  }

  console.log('\n═══ TẤT CẢ TEST YOUTUBE VIEWER HOÀN THÀNH XUẤT SẮC! ═══\n');
}

runTests().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
