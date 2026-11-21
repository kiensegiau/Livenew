/**
 * ====================================================================
 *   APPS SCRIPT GẮN GOOGLE SHEET: ĐỌC DỮ LIỆU YOUTUBE STUDIO
 * ====================================================================
 *  Dùng API chính thức của Google, chỉ cấp quyền ĐỌC.
 *
 *  CÀI ĐẶT:
 *   1. Tạo 1 Google Sheet mới → Tiện ích mở rộng → Apps Script.
 *   2. Dịch vụ (+) → thêm 2 dịch vụ:
 *        • YouTube Data API v3     (mã định danh: YouTube)
 *        • YouTube Analytics API   (mã định danh: YouTubeAnalytics)
 *   3. Dán toàn bộ file này vào Code.gs → Lưu.
 *   4. Chọn hàm chayTatCa → ▶ Chạy → cấp quyền.
 *      ⚠️ Khi Google hỏi chọn tài khoản/kênh: chọn ĐÚNG KÊNH cần lấy số liệu.
 *   5. Quay lại Sheet, tải lại trang → có menu "📊 YT Studio".
 *
 *  LƯU Ý:
 *   - 1 lần cấp quyền = 1 kênh. Gmail có nhiều kênh thương hiệu → mỗi kênh
 *     làm 1 bản Sheet/Script riêng (hoặc cấp quyền lại bằng kênh khác).
 *   - Số liệu Analytics (view, giờ xem, sub, doanh thu) trễ 24–48 giờ, giống Studio.
 *   - Doanh thu chỉ có khi kênh đã bật kiếm tiền.
 * ====================================================================
 */

const TZ = 'Asia/Ho_Chi_Minh';
const SO_NGAY = 28; // Khoảng báo cáo

function onOpen() {
  SpreadsheetApp.getUi().createMenu('📊 YT Studio')
    .addItem('Cập nhật tất cả', 'chayTatCa')
    .addSeparator()
    .addItem('Tổng quan kênh', 'capNhatTongQuan')
    .addItem('Báo cáo theo ngày', 'baoCaoTheoNgay')
    .addItem('Top video', 'topVideo')
    .addItem('Live đang phát', 'liveDangPhat')
    .addSeparator()
    .addItem('Tự động cập nhật 7h sáng mỗi ngày', 'caiLichTuDong')
    .addToUi();
}

function chayTatCa() {
  capNhatTongQuan();
  baoCaoTheoNgay();
  topVideo();
  liveDangPhat();
}

// ─── 1. Tổng quan kênh ───────────────────────────────────────────────
function capNhatTongQuan() {
  const r = YouTube.Channels.list('snippet,statistics', { mine: true });
  const rows = (r.items || []).map(c => [
    c.snippet.title, c.id,
    Number(c.statistics.subscriberCount || 0),
    Number(c.statistics.viewCount || 0),
    Number(c.statistics.videoCount || 0),
    homNay_('yyyy-MM-dd HH:mm')
  ]);
  ghiSheet_('TONG_QUAN', ['Kênh', 'Channel ID', 'Người đăng ký', 'Tổng lượt xem', 'Số video', 'Cập nhật lúc'], rows);
}

// ─── 2. Báo cáo theo ngày (giống tab Analytics của Studio) ───────────
function baoCaoTheoNgay() {
  const { start, end } = khoangNgay_();
  const base = 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments';
  const r = YouTubeAnalytics.Reports.query({
    ids: 'channel==MINE', startDate: start, endDate: end,
    metrics: base, dimensions: 'day', sort: 'day'
  });

  // Doanh thu (bỏ qua nếu kênh chưa bật kiếm tiền)
  const revenue = {};
  try {
    const m = YouTubeAnalytics.Reports.query({
      ids: 'channel==MINE', startDate: start, endDate: end,
      metrics: 'estimatedRevenue,cpm,playbackBasedCpm', dimensions: 'day', sort: 'day'
    });
    (m.rows || []).forEach(x => { revenue[x[0]] = x.slice(1); });
  } catch (e) { /* chưa kiếm tiền hoặc không có quyền doanh thu */ }

  const rows = (r.rows || []).map(x => {
    const rv = revenue[x[0]] || ['', '', ''];
    return [x[0], x[1], Math.round(x[2] / 60 * 10) / 10, x[3], x[4], x[5], x[4] - x[5], x[6], x[7], rv[0], rv[1], rv[2]];
  });
  ghiSheet_('THEO_NGAY',
    ['Ngày', 'Lượt xem', 'Giờ xem', 'Thời lượng xem TB (giây)', 'Sub tăng', 'Sub giảm', 'Sub ròng', 'Like', 'Bình luận', 'Doanh thu ($)', 'CPM', 'CPM theo lượt phát'],
    rows);
}

// ─── 3. Top video trong khoảng báo cáo ───────────────────────────────
function topVideo() {
  const { start, end } = khoangNgay_();
  const r = YouTubeAnalytics.Reports.query({
    ids: 'channel==MINE', startDate: start, endDate: end,
    metrics: 'views,estimatedMinutesWatched,averageViewPercentage,subscribersGained',
    dimensions: 'video', sort: '-views', maxResults: 25
  });
  const list = r.rows || [];
  const titles = {};
  if (list.length) {
    const v = YouTube.Videos.list('snippet', { id: list.map(x => x[0]).join(',') });
    (v.items || []).forEach(it => { titles[it.id] = it.snippet.title; });
  }
  const rows = list.map(x => [
    titles[x[0]] || '', 'https://youtu.be/' + x[0], x[1],
    Math.round(x[2] / 60 * 10) / 10, Math.round(x[3] * 10) / 10 + '%', x[4]
  ]);
  ghiSheet_('TOP_VIDEO', ['Tiêu đề', 'Link', 'Lượt xem', 'Giờ xem', '% xem TB', 'Sub tăng'], rows);
}

// ─── 4. Live đang phát + mắt xem hiện tại ────────────────────────────
function liveDangPhat() {
  const b = YouTube.LiveBroadcasts.list('snippet', { broadcastStatus: 'active', broadcastType: 'all', maxResults: 50 });
  const ids = (b.items || []).map(x => x.id);
  let rows = [];
  if (ids.length) {
    const v = YouTube.Videos.list('snippet,liveStreamingDetails,statistics', { id: ids.join(',') });
    rows = (v.items || []).map(it => [
      it.snippet.title, 'https://youtu.be/' + it.id,
      Number((it.liveStreamingDetails || {}).concurrentViewers || 0),
      Number(it.statistics.viewCount || 0),
      Number(it.statistics.likeCount || 0),
      (it.liveStreamingDetails || {}).actualStartTime || '',
      homNay_('yyyy-MM-dd HH:mm')
    ]);
  }
  ghiSheet_('LIVE_HIEN_TAI', ['Tiêu đề', 'Link', 'Mắt xem', 'Lượt xem', 'Like', 'Bắt đầu lúc', 'Cập nhật lúc'], rows);
}

// ─── Lịch tự động ────────────────────────────────────────────────────
function caiLichTuDong() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'chayTatCa')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('chayTatCa').timeBased().everyDays(1).atHour(7).inTimezone(TZ).create();
  SpreadsheetApp.getActive().toast('Đã cài tự động cập nhật lúc 7h sáng mỗi ngày');
}

// ─── Hàm phụ ─────────────────────────────────────────────────────────
function khoangNgay_() {
  const end = new Date(Date.now() - 24 * 3600 * 1000);
  const start = new Date(end.getTime() - (SO_NGAY - 1) * 24 * 3600 * 1000);
  const f = d => Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  return { start: f(start), end: f(end) };
}

function homNay_(fmt) {
  return Utilities.formatDate(new Date(), TZ, fmt);
}

function ghiSheet_(name, headers, rows) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  else sh.getRange(2, 1).setValue('(Không có dữ liệu)');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, headers.length);
}
