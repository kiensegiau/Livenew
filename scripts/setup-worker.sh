#!/usr/bin/env bash
# Cài VPS Worker mới và tự vào cụm (Ubuntu/Debian, chạy bằng root).
#
# CÁCH 1 (khuyên dùng) - theo Google Sheet: thêm 1 dòng cho VPS vào tab DANH_SACH_VPS
#   (id | tên | ip | port | vai trò | trạng thái) rồi chạy trên VPS mới:
#   NODES_SHEET_URL='https://docs.google.com/spreadsheets/d/.../edit#gid=NNN' CLUSTER_SECRET=xxxx \
#   REPO_URL=https://github.com/<ban>/Livenew.git bash setup-worker.sh
#   (NODE_ID không bắt buộc: máy tự nhận ra mình nhờ IP public có trong sheet; đặt NODE_ID=vps3 nếu muốn chắc chắn)
#
# CÁCH 2 - tự đăng ký qua Master (không dùng sheet):
#   MASTER_URL=http://IP_MASTER:3131 CLUSTER_SECRET=xxxx NODE_ID=vps3 REPO_URL=... bash setup-worker.sh
#
# CÁCH 3 - CHỈ CÓ 1 VPS (làm Master, không cụm): SINGLE=1 REPO_URL=... bash setup-worker.sh
#   (tạo cluster_nodes.json chỉ có máy này; CLUSTER_SECRET tự sinh nếu không đặt; NODE_ID mặc định vps1)
#
# Biến tuỳ chọn: NODE_NAME, NODE_IP (nếu không tự lấy được IP public), PORT (mặc định 3131),
#                APP_DIR (mặc định /opt/livenew), BRANCH (mặc định main), STRICT_INTERNAL (mặc định 1),
#                NODES_SYNC_SEC (chu kỳ đọc sheet, mặc định 60)
set -euo pipefail

SINGLE="${SINGLE:-0}"
if [ "$SINGLE" = "1" ]; then
  CLUSTER_SECRET="${CLUSTER_SECRET:-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
  NODE_ID="${NODE_ID:-vps1}"
fi
: "${CLUSTER_SECRET:?Thiếu CLUSTER_SECRET (giống các máy khác trong cụm)}"
: "${REPO_URL:?Thiếu REPO_URL (git của dự án)}"
if [ "$SINGLE" != "1" ] && [ -z "${NODES_SHEET_URL:-}" ] && [ -z "${MASTER_URL:-}" ]; then
  echo "Cần NODES_SHEET_URL (theo Google Sheet), MASTER_URL (+NODE_ID) hoặc SINGLE=1 (chỉ có 1 VPS)." >&2; exit 1
fi
if [ -n "${MASTER_URL:-}" ] && [ -z "${NODE_ID:-}" ]; then
  echo "Dùng MASTER_URL thì phải có NODE_ID, vd NODE_ID=vps3" >&2; exit 1
fi
PORT="${PORT:-3131}"
APP_DIR="${APP_DIR:-/opt/livenew}"
BRANCH="${BRANCH:-main}"
STRICT_INTERNAL="${STRICT_INTERNAL:-1}"

echo "==> Cài gói nền (git, ffmpeg, curl)"
apt-get update -y
apt-get install -y git ffmpeg curl ca-certificates

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]; then
  echo "==> Cài Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
command -v pm2 >/dev/null 2>&1 || npm install -g pm2

echo "==> Lấy mã nguồn vào $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all && git -C "$APP_DIR" checkout "$BRANCH" && git -C "$APP_DIR" pull --ff-only
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm install --omit=dev

if [ "$SINGLE" = "1" ]; then
  echo "==> Chế độ 1 VPS: ghi cluster_nodes.json chỉ gồm máy này (Master)"
  IP="${NODE_IP:-$(curl -fsS --max-time 8 http://api.ipify.org || true)}"
  [ -n "$IP" ] || { echo "Không lấy được IP public, đặt NODE_IP=..." >&2; exit 1; }
  printf '[{"id":"%s","name":"%s","ip":"%s","port":%s,"isMaster":true,"isLocal":true}]\n' \
    "$NODE_ID" "${NODE_NAME:-$NODE_ID (Master)}" "$IP" "$PORT" > cluster_nodes.json
  echo "CLUSTER_SECRET (lưu lại nếu sau này thêm VPS): $CLUSTER_SECRET"
fi

echo "==> Mở cổng $PORT (nếu có ufw)"
command -v ufw >/dev/null 2>&1 && ufw allow "$PORT"/tcp || true

echo "==> Chạy bằng PM2"
pm2 delete livenew >/dev/null 2>&1 || true
# Chỉ truyền biến có giá trị (biến rỗng làm server hiểu sai)
ENV_ARGS=(PORT="$PORT" CLUSTER_SECRET="$CLUSTER_SECRET" STRICT_INTERNAL="$STRICT_INTERNAL")
[ -n "${NODE_ID:-}" ]         && ENV_ARGS+=(NODE_ID="$NODE_ID")
[ -n "${MASTER_URL:-}" ]      && ENV_ARGS+=(MASTER_URL="$MASTER_URL")
[ -n "${NODES_SHEET_URL:-}" ] && ENV_ARGS+=(NODES_SHEET_URL="$NODES_SHEET_URL")
[ -n "${NODES_SYNC_SEC:-}" ]  && ENV_ARGS+=(NODES_SYNC_SEC="$NODES_SYNC_SEC")
[ -n "${NODE_NAME:-}" ]       && ENV_ARGS+=(NODE_NAME="$NODE_NAME")
[ -n "${NODE_IP:-}" ]         && ENV_ARGS+=(NODE_IP="$NODE_IP")
env "${ENV_ARGS[@]}" pm2 start server.js --name livenew --update-env
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

echo
echo "Xong. Xem log:  pm2 logs livenew"
echo "  - Theo sheet: tìm '[SheetNodes] ✅'   - Theo Master: tìm '[AutoJoin] ✅'"
echo "Kiểm tra:       curl http://127.0.0.1:$PORT/api/health"
echo "Lưu ý: bot_config.json (Telegram/Zalo) KHÔNG nằm trong git, copy tay nếu máy này cần gửi thông báo."
