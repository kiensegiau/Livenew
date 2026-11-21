const { migrateStream, streams } = require('./migrate_stream');

// Danh sách các luồng cần chuyển (đã hoàn thành #2 và #5)
const streamIds = [6, 8, 9, 12, 13, 16, 17, 18, 21, 27, 29, 30, 31, 32];

const NEW_MASTER_IP = '57.129.135.140';
const NEW_WORKER_IP = '57.129.194.73';

async function runBatch() {
  console.log(`================================================================`);
  console.log(`📋 BẮT ĐẦU CHUYỂN TỰ ĐỘNG LẦN LƯỢT ${streamIds.length} LUỒNG CÒN LẠI`);
  console.log(`⚠️ QUY TẮC AN TOÀN: TẢI VIDEO THÀNH CÔNG 100% MỚI DỪNG CŨ VÀ BẬT MỚI`);
  console.log(`================================================================\n`);

  let count = 0;
  for (let i = 0; i < streamIds.length; i++) {
    const id = streamIds[i];
    // Phân bổ xen kẽ giữa VPS 1 (Master) và VPS 2 (Worker) để cân bằng tải
    const targetServerId = (i % 2 === 0) ? 'vps1' : 'vps2';
    const targetIp = (targetServerId === 'vps2') ? NEW_WORKER_IP : NEW_MASTER_IP;

    console.log(`\n--------------------------------------------------------------`);
    console.log(`[Tiến trình: ${i + 1}/${streamIds.length}] Đang xử lý Luồng #${id} -> Chuyển sang ${targetServerId}...`);
    console.log(`--------------------------------------------------------------`);

    try {
      const res = await migrateStream(id, targetIp, targetServerId);
      if (res && res.ok) {
        count++;
        console.log(`✅ [${i + 1}/${streamIds.length}] Luồng #${id} "${res.name}" đã hoàn tất!`);
      }
    } catch (err) {
      console.error(`❌ [${i + 1}/${streamIds.length}] BỎ QUA Luồng #${id} do lỗi: ${err.message}`);
      console.error(`🛡️ Luồng #${id} trên VPS cũ vẫn giữ nguyên, không bị ảnh hưởng.`);
    }

    // Nghỉ 3 giây giữa các luồng
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`\n================================================================`);
  console.log(`🎉 HOÀN TẤT ĐỢT CHUYỂN! ĐÃ CHUYỂN THÀNH CÔNG: ${count}/${streamIds.length} LUỒNG.`);
  console.log(`================================================================`);
}

runBatch();
