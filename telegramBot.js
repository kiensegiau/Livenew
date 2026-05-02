const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'bot_config.json');

// Hỗ trợ cả cấu hình cũ và mới
let config = { token: "", adminIds: [], password: "live" };
if (fs.existsSync(CONFIG_PATH)) {
  const oldConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  config.token = oldConfig.token || "";
  config.password = oldConfig.password || "live";
  // Chuyển từ adminId (cũ) sang adminIds (mới)
  if (oldConfig.adminId) {
    config.adminIds = [oldConfig.adminId];
  } else if (oldConfig.adminIds) {
    config.adminIds = oldConfig.adminIds;
  }
}

let bot = null;
const activeProgressMessages = new Map(); // streamId -> { messageIdMap: {chatId: msgId}, lastPct }

function saveConfig() {
  // Dọn dẹp config trước khi lưu
  const toSave = {
    token: config.token,
    adminIds: config.adminIds,
    password: config.password
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2));
}

function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[*_`\[]/g, '\\$&');
}

function initBot(actions) {
  if (!config.token) {
    console.log('\n[Telegram Bot] ⚠️ Chưa cấu hình BOT_TOKEN trong bot_config.json.');
    return;
  }

  bot = new TelegramBot(config.token, { polling: true });
  console.log('\n[Telegram Bot] 🤖 Bot đang chạy và lắng nghe lệnh...');

  // Báo cáo định kỳ mỗi 30 phút
  setInterval(() => {
    const list = actions.getStreams();
    if (list.length === 0) return;
    
    let report = '🕒 *BÁO CÁO ĐỊNH KỲ (30 PHÚT)*\n\n';
    list.forEach(s => {
      const icon = s.status === 'live' ? '🟢' : (s.status === 'downloading' ? '⬇️' : (s.status === 'reconnecting' ? '🟡' : (s.status === 'scheduled' ? '🕐' : '⚪')));
      report += `${icon} *#${s.id}*: \`${s.status}\`\n`;
      if (s.startTime) report += `⏱ Live lúc: \`${new Date(s.startTime).toLocaleTimeString()}\`\n`;
      report += `📝 Log: \`${escapeMarkdown(s.lastLog)}\`\n\n`;
    });
    
    broadcast(report);
  }, 30 * 60 * 1000);

  bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    const isAdmin = config.adminIds.includes(chatId);

    if (!isAdmin) {
      if (text === config.password) {
        config.adminIds.push(chatId);
        saveConfig();
        bot.sendMessage(chatId, '✅ Xác thực thành công! Bạn hiện là Admin của hệ thống.\nGõ /help để xem lệnh.');
      } else {
        bot.sendMessage(chatId, '🔒 Vui lòng nhập Mật khẩu để cấp quyền Admin:');
      }
      return;
    }

    // --- Lệnh Admin ---
    if (text.startsWith('/help') || text === '/start') {
      const helpMsg = `
🛠 *YouTube Live Controller*
Lệnh điều khiển:
/status - Trạng thái hệ thống
/live <key> <link> - Phát Loop
/once <key> <link> - Phát 1 lần
/schedule <key> <link> <HH:mm> - Đặt lịch
/stop <id> - Dừng luồng
/restart <id> - Khởi động lại
/clear - Dọn dẹp luồng rác
      `;
      bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
    }
    
    else if (text.startsWith('/status')) {
      const list = actions.getStreams();
      if (list.length === 0) return bot.sendMessage(chatId, '📭 Trống.');
      let reply = '📊 *TRẠNG THÁI:* \n\n';
      list.forEach(s => {
        const icon = s.status === 'live' ? '🟢' : (s.status === 'downloading' ? '⬇️' : (s.status === 'reconnecting' ? '🟡' : (s.status === 'scheduled' ? '🕐' : '⚪')));
        reply += `${icon} *#${s.id}*: \`${s.status}\`\nLog: \`${escapeMarkdown(s.lastLog)}\`\n\n`;
      });
      bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
    }

    else if (text.startsWith('/live ') || text.startsWith('/once ')) {
      const isOnce = text.startsWith('/once ');
      const parts = text.split(' ');
      if (parts.length < 3) return bot.sendMessage(chatId, '❌ Lỗi cú pháp.');
      const result = actions.startStream({ key: parts[1], file: parts.slice(2).join(' '), mode: isOnce ? 'once' : 'loop', minutes: 0 });
      bot.sendMessage(chatId, result.error ? `❌ Lỗi: \`${escapeMarkdown(result.error)}\`` : `✅ Đã tạo luồng *#${result.id}*`, { parse_mode: 'Markdown' });
    }

    else if (text.startsWith('/schedule ')) {
      const parts = text.split(' ');
      if (parts.length < 4) return bot.sendMessage(chatId, '❌ Lỗi cú pháp.');
      const timeStr = parts.pop();
      let scheduledTime = timeStr;
      if (timeStr.includes(':')) scheduledTime = `${new Date().toISOString().split('T')[0]}T${timeStr}`;
      const result = actions.startStream({ key: parts[1], file: parts.slice(2).join(' '), mode: 'scheduled', minutes: 0, scheduledTime });
      bot.sendMessage(chatId, result.error ? `❌ Lỗi: \`${escapeMarkdown(result.error)}\`` : `📅 Đã đặt lịch *#${result.id}* lúc \`${scheduledTime}\``, { parse_mode: 'Markdown' });
    }

    else if (text.startsWith('/stop ')) {
      const id = parseInt(text.split(' ')[1]);
      if (actions.stopStream(id)) bot.sendMessage(chatId, `🛑 Đã dừng #${id}`);
      else bot.sendMessage(chatId, '❌ Lỗi.');
    }

    else if (text.startsWith('/restart ')) {
      const id = parseInt(text.split(' ')[1]);
      const res = actions.restartStream(id);
      bot.sendMessage(chatId, res.error ? `❌ Lỗi: \`${escapeMarkdown(res.error)}\`` : `🚀 Đang chạy lại #${id}...`, { parse_mode: 'Markdown' });
    }

    else if (text.startsWith('/clear')) {
      bot.sendMessage(chatId, `🧹 Đã dọn dẹp ${actions.clearStreams()} luồng.`);
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
      const shouldUpdate = pct === null || pct === 100 || (typeof pct === 'number' && pct - current.lastPct >= 10);
      if (shouldUpdate) {
        bot.editMessageText(text, { chat_id: chatId, message_id: current.messageIds[chatId], parse_mode: 'Markdown' }).catch(() => {});
      }
    }
  });

  if (pct !== null) current.lastPct = pct;
  if (pct === 100) activeProgressMessages.delete(streamId);
}

module.exports = { initBot, broadcast, updateProgress };
