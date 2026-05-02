const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'bot_config.json');

let config = { token: "", adminIds: [], password: "live" };
if (fs.existsSync(CONFIG_PATH)) {
  const oldConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  config.token = oldConfig.token || "";
  config.password = oldConfig.password || "live";
  if (oldConfig.adminId) config.adminIds = [oldConfig.adminId];
  else if (oldConfig.adminIds) config.adminIds = oldConfig.adminIds;
}

let bot = null;
const activeProgressMessages = new Map();

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    token: config.token,
    adminIds: config.adminIds,
    password: config.password
  }, null, 2));
}

function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[*_`\[]/g, '\\$&');
}

function initBot(actions) {
  if (!config.token) return console.log('\n[Telegram Bot] ⚠️ Chưa cấu hình BOT_TOKEN.');

  bot = new TelegramBot(config.token, { polling: true });
  console.log('\n[Telegram Bot] 🤖 Bot đang chạy và lắng nghe lệnh...');

  // Báo cáo định kỳ mỗi 30 phút
  setInterval(() => {
    const list = actions.getStreams();
    if (list.length === 0 && process.uptime() > 3600) return;
    const startUsage = process.cpuUsage();
    const startTime = process.hrtime();
    setTimeout(() => {
      const endUsage = process.cpuUsage(startUsage);
      const endTime = process.hrtime(startTime);
      const elapTimeMs = endTime[0] * 1000 + endTime[1] / 1000000;
      const cpuPercent = (100 * (endUsage.user + endUsage.system) / 1000 / elapTimeMs).toFixed(1);
      const active = list.filter(s => s.status === 'live').length;
      const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      const uptime = Math.floor(process.uptime() / 60);

      let report = `📊 *BÁO CÁO HỆ THỐNG ĐỊNH KỲ*\n━━━━━━━━━━━━━━━━━━\n`;
      report += `⏱ Uptime: \`${uptime}p\` | 🧠 RAM: \`${mem}MB\` | ⚡ CPU: \`${cpuPercent}%\`\n`;
      report += `📺 Đang chạy: \`${active}/${list.length}\`\n\n`;

      if (list.length > 0) {
        list.forEach(s => {
          const icon = s.status === 'live' ? '🟢' : (s.status === 'downloading' ? '⬇️' : (s.status === 'reconnecting' ? '🟡' : (s.status === 'scheduled' ? '🕐' : '⚪')));
          report += `${icon} *#${s.id}*: \`${s.status}\` | Log: \`${escapeMarkdown(s.lastLog)}\`\n`;
        });
      }
      broadcast(report);
    }, 1000);
  }, 30 * 60 * 1000);

  bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    if (!config.adminIds.includes(chatId)) {
      if (text === config.password) {
        config.adminIds.push(chatId);
        saveConfig();
        bot.sendMessage(chatId, '✅ Xác thực thành công! Bạn hiện là Admin.');
      } else {
        bot.sendMessage(chatId, '🔒 Vui lòng nhập Mật khẩu Admin:');
      }
      return;
    }

    if (text.startsWith('/help') || text === '/start') {
      const helpMsg = `🛠 *YouTube Live Controller*\n/status - Xem & Điều khiển luồng\n/live <key> <link> - Phát Loop\n/once <key> <link> - Phát 1 lần\n/schedule <key> <link> <HH:mm> [m] - Đặt lịch (m: số phút phát)\n/scheduleonce <key> <link> <HH:mm> - Đặt lịch phát 1 lần\n/log <id> - Xem log chi tiết\n/clear - Dọn luồng rác`;
      bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
    }
    
    else if (text.startsWith('/status')) {
      const list = actions.getStreams();
      if (list.length === 0) return bot.sendMessage(chatId, '📭 Trống.');
      
      bot.sendMessage(chatId, '📊 *DANH SÁCH LUỒNG ĐANG CHẠY:*', { parse_mode: 'Markdown' });
      
      list.forEach(s => {
        const icon = s.status === 'live' ? '🟢' : (s.status === 'downloading' ? '⬇️' : (s.status === 'reconnecting' ? '🟡' : (s.status === 'scheduled' ? '🕐' : '⚪')));
        let msgStr = `${icon} *LUỒNG #${s.id}*\n`;
        msgStr += `Status: \`${s.status}\`\n`;
        
        if (s.status === 'live' && s.startTime) {
          const liveTime = Math.floor((Date.now() - new Date(s.startTime)) / 60000);
          msgStr += `⏱ Đã chạy: \`${liveTime} phút\`\n`;
        }
        
        if (s.scheduledTime) {
          msgStr += `📅 Lịch: \`${s.scheduledTime}\`\n`;
        }

        msgStr += `Log: \`${escapeMarkdown(s.lastLog)}\``;
        
        const buttons = [];
        if (['live', 'launching', 'reconnecting', 'scheduled', 'downloading'].includes(s.status)) {
          buttons.push([{ text: '🛑 Dừng ngay', callback_data: `stop_${s.id}` }]);
        } else {
          buttons.push([{ text: '🚀 Khởi động lại', callback_data: `restart_${s.id}` }]);
        }
        
        bot.sendMessage(chatId, msgStr, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons }
        });
      });
    }

    else if (text.startsWith('/live ') || text.startsWith('/once ')) {
      const isOnce = text.startsWith('/once ');
      const parts = text.split(' ');
      if (parts.length < 3) return bot.sendMessage(chatId, '❌ Lỗi cú pháp.');
      const result = actions.startStream({ key: parts[1], file: parts.slice(2).join(' '), mode: isOnce ? 'once' : 'loop', minutes: 0 });
      bot.sendMessage(chatId, result.error ? `❌ Lỗi: \`${escapeMarkdown(result.error)}\`` : `✅ Đã tạo luồng *#${result.id}*`, { parse_mode: 'Markdown' });
    }

    else if (text.startsWith('/schedule ') || text.startsWith('/scheduleonce ')) {
      const isOnce = text.startsWith('/scheduleonce ');
      const parts = text.split(' ');
      if (parts.length < 4) return bot.sendMessage(chatId, `❌ Lỗi cú pháp.\n\nMẫu: \`${isOnce ? '/scheduleonce' : '/schedule'} <key> <link> <HH:mm> [số_phút]\``, { parse_mode: 'Markdown' });
      
      let minutes = 0;
      let timeStr = "";
      
      // Nếu phần cuối là số -> đó là số phút giới hạn
      if (!isNaN(parseInt(parts[parts.length - 1])) && !parts[parts.length - 1].includes(':')) {
        minutes = parseInt(parts.pop());
      }
      timeStr = parts.pop();
      
      const key = parts[1];
      const file = parts.slice(2).join(' ');

      const now = new Date();
      let datePart = now.toISOString().split('T')[0];
      let scheduledTime = `${datePart}T${timeStr}`;

      if (new Date(scheduledTime).getTime() <= now.getTime()) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        datePart = tomorrow.toISOString().split('T')[0];
        scheduledTime = `${datePart}T${timeStr}`;
      }
      
      // Lưu scheduledMode để server.js biết khi kích hoạt
      const result = actions.startStream({ key, file, mode: 'scheduled', scheduledMode: isOnce ? 'once' : 'loop', minutes, scheduledTime });
      if (result.error) {
        bot.sendMessage(chatId, `❌ Lỗi: \`${escapeMarkdown(result.error)}\``, { parse_mode: 'Markdown' });
      } else {
        const displayTime = new Date(scheduledTime).toLocaleString('vi-VN');
        let confirmMsg = `📅 *ĐẶT LỊCH THÀNH CÔNG!*\n━━━━━━━━━━━━━━━━━━\n🔹 ID: *#${result.id}*\n⏰ Bắt đầu: \`${displayTime}\`\n🔄 Chế độ: \`${isOnce ? 'Phát 1 lần' : 'Phát Lặp lại'}\``;
        if (minutes > 0) confirmMsg += `\n⏳ Thời gian chạy: \`${minutes} phút\``;
        bot.sendMessage(chatId, confirmMsg, { parse_mode: 'Markdown' });
      }
    }

    else if (text.startsWith('/log ')) {
      const id = parseInt(text.split(' ')[1]);
      if (isNaN(id)) return bot.sendMessage(chatId, '❌ Vui lòng nhập ID hợp lệ.');
      const logs = actions.getLogs(id);
      bot.sendMessage(chatId, `📜 *LOG CHI TIẾT LUỒNG #${id}:*\n\n\`\`\`\n${escapeMarkdown(logs)}\n\`\`\``, { parse_mode: 'Markdown' });
    }

    else if (text.startsWith('/admins')) {
      let msg = `👥 *DANH SÁCH ADMIN (${config.adminIds.length}):*\n\n`;
      config.adminIds.forEach((id, index) => {
        msg += `${index + 1}. ID: \`${id}\` ${id === chatId ? '*(Bạn)*' : ''}\n`;
      });
      bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    }

    else if (text.startsWith('/clear')) {
      bot.sendMessage(chatId, `🧹 Đã dọn dẹp ${actions.clearStreams()} luồng.`);
    }
  });

  // Xử lý bấm nút
  bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    if (!config.adminIds.includes(chatId)) return;

    const [action, idStr] = data.split('_');
    const id = parseInt(idStr);

    if (action === 'stop') {
      if (actions.stopStream(id)) {
        bot.answerCallbackQuery(query.id, { text: `Đã dừng luồng #${id}` });
        bot.editMessageText(`🛑 *LUỒNG #${id}* Đã dừng theo yêu cầu.`, {
          chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown'
        });
      }
    } else if (action === 'restart') {
      const res = actions.restartStream(id);
      if (res.error) {
        bot.answerCallbackQuery(query.id, { text: `Lỗi: ${res.error}`, show_alert: true });
      } else {
        bot.answerCallbackQuery(query.id, { text: `Đang khởi động lại #${id}` });
        bot.editMessageText(`🚀 *LUỒNG #${id}* Đang khởi động lại...`, {
          chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown'
        });
      }
    }
  });
}

function broadcast(message) {
  if (bot && config.adminIds) {
    config.adminIds.forEach(id => {
      bot.sendMessage(id, message, { parse_mode: 'Markdown' }).catch(() => {});
    });
  }
}

function updateProgress(streamId, pct, text) {
  if (!bot || !config.adminIds) return;
  let current = activeProgressMessages.get(streamId);
  if (!current) {
    current = { messageIds: {}, lastPct: pct || 0 };
    activeProgressMessages.set(streamId, current);
  }
  config.adminIds.forEach(chatId => {
    if (!current.messageIds[chatId]) {
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).then(m => {
        current.messageIds[chatId] = m.message_id;
      }).catch(() => {});
    } else {
      if (pct === null || pct === 100 || (typeof pct === 'number' && pct - current.lastPct >= 10)) {
        bot.editMessageText(text, { chat_id: chatId, message_id: current.messageIds[chatId], parse_mode: 'Markdown' }).catch(() => {});
      }
    }
  });
  if (pct !== null) current.lastPct = pct;
  if (pct === 100) activeProgressMessages.delete(streamId);
}

module.exports = { initBot, broadcast, updateProgress };
