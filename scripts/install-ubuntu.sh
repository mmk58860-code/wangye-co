#!/usr/bin/env bash
set -euo pipefail

APP_NAME="wangye-co"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
SERVICE_NAME="${SERVICE_NAME:-${APP_NAME}}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 root 权限运行：sudo bash scripts/install-ubuntu.sh"
  exit 1
fi

echo "==== wangye-co Ubuntu 安装向导 ===="
read -rp "请输入网页端口 [3000]: " WEB_PORT
WEB_PORT="${WEB_PORT:-3000}"
read -rp "请输入网页账号 [admin]: " WEB_USER
WEB_USER="${WEB_USER:-admin}"
read -rsp "请输入网页密码（至少 8 位）: " WEB_PASS
echo
if [[ "${#WEB_PASS}" -lt 8 ]]; then
  echo "密码至少 8 位"
  exit 1
fi
read -rp "请输入 GitHub 仓库 owner/repo（用于强制升级，可稍后填）: " GITHUB_REPO

echo "安装系统依赖..."
apt-get update
apt-get install -y curl git rsync ca-certificates openssl python3 python3-venv python3-pip
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

mkdir -p "${APP_DIR}"
rsync -a --delete \
  --exclude node_modules \
  --exclude venv \
  --exclude data \
  --exclude .env \
  ./ "${APP_DIR}/"

cd "${APP_DIR}"
cat > .env <<ENV
PORT=${WEB_PORT}
SESSION_SECRET=$(openssl rand -hex 32)
WEB_USERNAME=${WEB_USER}
GITHUB_REPO=${GITHUB_REPO}
PYTHON_BIN=${APP_DIR}/venv/bin/python
ENV

npm install --omit=dev
python3 -m venv venv
venv/bin/python -m pip install --upgrade pip
venv/bin/python -m pip install -r requirements.txt
node scripts/init-config.mjs "${WEB_USER}" "${WEB_PASS}" "${WEB_PORT}" "${GITHUB_REPO}"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<SERVICE
[Unit]
Description=wangye-co TAO subnet dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo "安装完成：http://服务器IP:${WEB_PORT}"
echo "账号：${WEB_USER}"
echo "升级命令：sudo bash ${APP_DIR}/scripts/upgrade.sh"
