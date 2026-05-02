const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'bot_config.json');

let config = { token: "", adminId: null, password: "live" };
if (fs.existsSync(CONFIG_PATH)) {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} else {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let bot = null;

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function initBot(actions) {
  if (!config.token) {
    console.log('\n[Telegram Bot] ⚠️ Chưa cấu hình BOT_TOKEN trong bot_config.json.');
    console.log('[Telegram Bot] Bot sẽ không hoạt động cho đến khi có Token.');
    return;
  }

  bot = new TelegramBot(config.token, { polling: true });
  console.log('\n[Telegram Bot] 🤖 Bot đang chạy và lắng nghe lệnh...');

  bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    // Xác thực Admin
    if (config.adminId && chatId !== config.adminId) {
      // Có người lạ nhắn tin
      bot.sendMessage(chatId, '❌ Bạn không có quyền điều khiển Server này.');
      return;
    }

    if (!config.adminId) {
      if (text === config.password) {
        config.adminId = chatId;
        saveConfig();
        bot.sendMessage(chatId, '✅ Xác thực thành công! Bạn hiện là Admin của hệ thống.\nGõ /help để xem các lệnh điều khiển.');
      } else {
        bot.sendMessage(chatId, '🔒 Vui lòng nhập Mật khẩu (Password) để cấp quyền điều khiển Server:');
      }
      return;
    }

    // --- Lệnh cho Admin ---
    if (text.startsWith('/help') || text === '/start') {
      const helpMsg = `
🛠 *YouTube Live Controller*
Danh sách lệnh điều khiển:
/status - Xem tất cả luồng đang chạy
/live <key> <link_drive_hoac_mp4> - Mở nhanh luồng Loop
/stop <id> - Dừng một luồng
/restart <id> - Khởi động lại luồng
/clear - Xóa danh sách luồng đã tắt
      `;
      bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
    }
    
    else if (text.startsWith('/status')) {
      const list = actions.getStreams();
      if (list.length === 0) {
        bot.sendMessage(chatId, '📭 Hiện không có luồng nào.');
        return;
      }
      let reply = '📊 *TRẠNG THÁI LUỒNG:*\n\n';
      list.forEach(s => {
        const icon = s.status === 'live' ? '🟢' : (s.status === 'downloading' ? '⬇️' : (s.status === 'reconnecting' ? '🟡' : '⚪'));
        reply += `${icon} *#${s.id}* - Status: \`${s.status}\`\n`;
        reply += `Log: _${s.lastLog || 'N/A'}_\n\n`;
      });
      bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
    }

    else if (text.startsWith('/live ')) {
      const parts = text.split(' ');
      if (parts.length < 3) {
        bot.sendMessage(chatId, '❌ Lỗi cú pháp. Vui lòng dùng:\n`/live <stream_key> <link>`', { parse_mode: 'Markdown' });
        return;
      }
      const key = parts[1];
      const file = parts.slice(2).join(' ');
      
      const result = actions.startStream({ key, file, mode: 'loop', minutes: 0 });
      if (result.error) {
        bot.sendMessage(chatId, `❌ Lỗi: ${result.error}`);
      } else {
        bot.sendMessage(chatId, `✅ Đã tạo luồng *#${result.id}* (Status: ${result.status})`, { parse_mode: 'Markdown' });
      }
    }

    else if (text.startsWith('/stop ')) {
      const id = parseInt(text.split(' ')[1]);
      if (isNaN(id)) return bot.sendMessage(chatId, '❌ Vui lòng nhập ID hợp lệ.');
      const res = actions.stopStream(id);
      if (res) bot.sendMessage(chatId, `🛑 Đã gửi lệnh dừng luồng #${id}`);
      else bot.sendMessage(chatId, `❌ Không tìm thấy luồng #${id} hoặc luồng đã dừng.`);
    }

    else if (text.startsWith('/restart ')) {
      const id = parseInt(text.split(' ')[1]);
      if (isNaN(id)) return bot.sendMessage(chatId, '❌ Vui lòng nhập ID hợp lệ.');
      const res = actions.restartStream(id);
      if (res.error) bot.sendMessage(chatId, `❌ Lỗi: ${res.error}`);
      else bot.sendMessage(chatId, `🚀 Đang khởi động lại luồng #${id}...`);
    }

    else if (text.startsWith('/clear')) {
      const count = actions.clearStreams();
      bot.sendMessage(chatId, `🧹 Đã dọn dẹp ${count} luồng rác.`);
    }
  });

  bot.on('polling_error', (error) => {
    // console.log(error.code);  // Mute polling errors to avoid console spam
  });
}

function broadcast(message) {
  if (bot && config.adminId) {
    bot.sendMessage(config.adminId, message, { parse_mode: 'Markdown' }).catch(e => {});
  }
}

module.exports = { initBot, broadcast };
