const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'bot_config.json');

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
  } catch (e) {
    console.error('Lỗi khởi tạo Bot:', e.message);
    return;
  }

  // Báo cáo định kỳ mỗi 30 phút
  setInterval(() => {
    try {
      const list = actions.getStreams();
      if (list.length === 0 && process.uptime() > 3600) return;
      
      const startUsage = process.cpuUsage();
      const startTime = process.hrtime();
      
      setTimeout(() => {
        try {
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
        } catch (e) { console.error('Lỗi báo cáo (nội):', e.message); }
      }, 1000);
    } catch (e) { console.error('Lỗi báo cáo (ngoại):', e.message); }
  }, 30 * 60 * 1000);

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
            // Trích xuất bitrate và speed từ log FFmpeg để hiển thị gọn
            const bitrate = s.lastLog.match(/bitrate=[^\s]*/);
            const speed = s.lastLog.match(/speed=[^\s]*/);
            if (bitrate && speed) logBrief = `${bitrate[0]} ${speed[0]}`;
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

      else if (text.startsWith('/live ') || text.startsWith('/once ')) {
        const isOnce = text.startsWith('/once ');
        const parts = text.split(' ');
        if (parts.length < 3) return bot.sendMessage(chatId, '❌ Lỗi cú pháp.');
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
    } catch (e) { console.error('Lỗi nút bấm:', e.message); }
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
  try {
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
  } catch (e) { console.error('Lỗi cập nhật tiến độ:', e.message); }
}

module.exports = { initBot, broadcast, updateProgress };
