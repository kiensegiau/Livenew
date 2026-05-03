const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'bot_config.json');

const { exec } = require('child_process');
function getNetBytes() {
  return new Promise(resolve => {
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
  });
}

let config = { token: "", adminIds: [], password: "live" };
try {
  if (fs.existsSync(CONFIG_PATH)) {
    const oldConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    config.token = oldConfig.token || "";
    config.password = oldConfig.password || "live";
    if (oldConfig.adminId) config.adminIds = [oldConfig.adminId];
    else if (oldConfig.adminIds) config.adminIds = oldConfig.adminIds;
  }
} catch (e) { console.error('Lỗi đọc config:', e.message); }

let bot = null;
const activeProgressMessages = new Map();
const userStates = new Map(); // Lưu trạng thái nhập liệu của người dùng

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      token: config.token,
      adminIds: config.adminIds,
      password: config.password
    }, null, 2));
  } catch (e) { console.error('Lỗi lưu config:', e.message); }
}

function escapeMarkdown(text) {
  if (!text) return '';
  return text.toString().replace(/[*_`\[]/g, '\\$&');
}

function initBot(actions) {
  if (!config.token) return;

  try {
    bot = new TelegramBot(config.token, { polling: true });
    console.log('\n[Telegram Bot] 🤖 Bot đang chạy...');

    bot.setMyCommands([
      { command: 'status', description: '📊 Xem & Điều khiển luồng' },
      { command: 'live', description: '🔄 Phát Loop (Key Link)' },
      { command: 'once', description: '▶️ Phát một lần (Key Link)' },
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
          const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
          const uptimeH = (process.uptime() / 3600).toFixed(1);

          let report = `📊 *BÁO CÁO HỆ THỐNG ĐỊNH KỲ*\n━━━━━━━━━━━━━━━━━━\n`;
          report += `⏱ Uptime: \`${uptimeH}h\` | 🧠 RAM: \`${mem}MB\` | ⚡ CPU: \`${cpuPercent}%\`\n`;
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
              report += `${icon} *#${s.id}*: \`${s.status}\` | \`${escapeMarkdown(logBrief)}\`\n`;
            });
          } else {
            report += `📭 _Hiện không có luồng nào đang hoạt động._`;
          }
          broadcast(report);
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
        return handleWizard(chatId, text, state, actions);
      }

      // Xử lý lệnh
      if (text.startsWith('/help') || text === '/start') {
        const helpMsg = `🛠 *YouTube Live Controller*\n/status - Xem & Điều khiển luồng\n/live <key> <link> - Phát Loop\n/once <key> <link> - Phát 1 lần\n/schedule <key> <link> <HH:mm> [m] - Đặt lịch\n/scheduleonce <key> <link> <HH:mm> - Lịch phát 1 lần\n/log <id> - Xem log chi tiết\n/admins - Danh sách quản trị\n/reboot - Khởi động lại Server\n/clear - Dọn luồng rác`;
        bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
      }
      
      else if (text.startsWith('/status')) {
        const list = actions.getStreams();
        const startUsage = process.cpuUsage();
        const startTime = process.hrtime();
        
        setTimeout(() => {
          const endUsage = process.cpuUsage(startUsage);
          const endTime = process.hrtime(startTime);
          const elapTimeMs = endTime[0] * 1000 + endTime[1] / 1000000;
          const cpuPercent = (100 * (endUsage.user + endUsage.system) / 1000 / elapTimeMs).toFixed(1);
          const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
          const uptime = Math.floor(process.uptime() / 60);

          let sysInfo = `🖥 *Hệ thống:* \`RAM: ${mem}MB\` | \`CPU: ${cpuPercent}%\` | \`Uptime: ${uptime}p\`\n`;

          if (list.length === 0) {
            return bot.sendMessage(chatId, `${sysInfo}━━━━━━━━━━━━━━━━━━\n📭 Hiện chưa có luồng nào.`);
          }
          
          list.forEach(s => {
            const icon = s.status === 'live' ? '🟢' : (s.status === 'downloading' ? '⬇️' : (s.status === 'reconnecting' ? '🟡' : (s.status === 'scheduled' ? '🕐' : '⚪')));
            
            let msgStr = `${icon} *LUỒNG #${s.id}*\n`;
            msgStr += `🖥 *Hệ thống:* \`RAM: ${mem}MB\` | \`CPU: ${cpuPercent}%\` | \`Uptime: ${uptime}p\`\n`;
            msgStr += `━━━━━━━━━━━━━━━━━━\n`;
            msgStr += `Trạng thái: \`${s.status}\`\n`;
          if (s.status === 'live' && s.startTime) msgStr += `⏱ Đã chạy: \`${Math.floor((Date.now() - new Date(s.startTime)) / 60000)} phút\`\n`;
          
          let logBrief = s.lastLog;
          if (s.status === 'live') {
            const time = s.lastLog.match(/time=\S+/);
            const bitrate = s.lastLog.match(/bitrate=\s*\S+/);
            const speed = s.lastLog.match(/speed=\s*\S+/);
            if (time && bitrate && speed) {
              logBrief = `${time[0]} | ${bitrate[0]} | ${speed[0]}`;
            }
          }
          msgStr += `📝 Log: \`${escapeMarkdown(logBrief)}\``;
          const buttons = [];
          if (['live', 'launching', 'reconnecting', 'scheduled', 'downloading'].includes(s.status)) {
            buttons.push([{ text: '🛑 Dừng ngay', callback_data: `stop_${s.id}` }]);
          } else {
            buttons.push([
              { text: '🚀 Khởi động lại', callback_data: `restart_${s.id}` },
              { text: '🗑 Xóa luồng', callback_data: `delete_${s.id}` }
            ]);
          }
          bot.sendMessage(chatId, msgStr, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        });
      }, 1000);
    }

      else if (text === '/live' || text === '/once') {
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

      else if (text.startsWith('/live ') || text.startsWith('/once ')) {
        const isOnce = text.startsWith('/once ');
        const parts = text.split(/\s+/).filter(Boolean);
        if (parts.length < 3) return bot.sendMessage(chatId, '❌ Lỗi: Bạn phải nhập theo mẫu: `/live <Key> <Link>`', { parse_mode: 'Markdown' });
        const result = actions.startStream({ key: parts[1], file: parts.slice(2).join(' '), mode: isOnce ? 'once' : 'loop', minutes: 0 });
        bot.sendMessage(chatId, result.error ? `❌ Lỗi: \`${escapeMarkdown(result.error)}\`` : `✅ Đã tạo luồng *#${result.id}*`, { parse_mode: 'Markdown' });
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
          let datePart = now.toISOString().split('T')[0];
          let scheduledTime = `${datePart}T${timeStr}`;
          if (new Date(scheduledTime).getTime() <= now.getTime()) {
            const tom = new Date(now); tom.setDate(tom.getDate() + 1);
            datePart = tom.toISOString().split('T')[0];
            scheduledTime = `${datePart}T${timeStr}`;
          }
          const result = actions.startStream({ key: parts[1], file: parts.slice(2).join(' '), mode: 'scheduled', scheduledMode: isOnce ? 'once' : 'loop', minutes, scheduledTime });
          if (result.error) bot.sendMessage(chatId, `❌ Lỗi: ${result.error}`);
          else bot.sendMessage(chatId, `📅 *ĐÃ ĐẶT LỊCH # ${result.id}* lúc \`${new Date(scheduledTime).toLocaleString('vi-VN')}\``, { parse_mode: 'Markdown' });
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
      const [action, idStr] = query.data.split('_');
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
          handleWizard(chatId, date, state, actions);
        }
      }
      else if (action === 'wiztime') {
        const hour = idStr.split(':')[0];
        const state = userStates.get(chatId);
        if (state) {
          bot.answerCallbackQuery(query.id);
          handleWizard(chatId, hour, state, actions);
        }
      }
      else if (action === 'wizmin') {
        const mins = idStr;
        const state = userStates.get(chatId);
        if (state) {
          bot.answerCallbackQuery(query.id);
          handleWizard(chatId, mins, state, actions);
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
      if (state.cmd.startsWith('schedule')) {
        state.step = 'date';
        const now = new Date();
        bot.sendMessage(chatId, `📅 Bước 3: Chọn **Ngày phát** từ lịch dưới đây:`, { 
          parse_mode: 'Markdown', 
          reply_markup: generateCalendar(now.getFullYear(), now.getMonth())
        });
      } else {
        const result = actions.startStream({ key: state.data.key, file: state.data.link, mode: state.cmd === 'once' ? 'once' : 'loop', minutes: 0 });
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
      bot.sendMessage(chatId, `⏰ Bước 4: Chọn **Giờ phát** hoặc tự nhập (VD: 14):`, { 
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
      bot.sendMessage(chatId, `⏱ Bước 5: Chọn **Phút** hoặc tự nhập (VD: 05, 15, 30):`, { 
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
      bot.sendMessage(chatId, `⏳ Bước 6: Nhập **Thời lượng phát** (phút) hoặc chọn nhanh:`, { 
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
        scheduledTime 
      });
      
      userStates.delete(chatId);
      if (result.error) bot.sendMessage(chatId, `❌ Lỗi: ${result.error}`);
      else bot.sendMessage(chatId, `📅 *ĐÃ ĐẶT LỊCH # ${result.id}* thành công lúc \`${new Date(scheduledTime).toLocaleString('vi-VN')}\``, { parse_mode: 'Markdown' });
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
        const timePassed = now - (current.lastTime || 0) > 3000; // Giảm xuống 3 giây cho mượt
        const pctJumped = typeof pct === 'number' && (pct - current.lastPct >= 2);
        
        if (pct === null || pct === 100 || pctJumped || timePassed) {
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

module.exports = { initBot, broadcast, updateProgress };
