#!/usr/bin/env bash
set -euo pipefail

APP_NAME="wangye-co"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
SERVICE_NAME="${SERVICE_NAME:-${APP_NAME}}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 root 权限运行：sudo bash ${APP_DIR}/scripts/upgrade.sh"
  exit 1
fi

cd "${APP_DIR}"
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

REPO="${GITHUB_REPO:-}"
if [[ -z "${REPO}" && -f data/config.json ]]; then
  REPO="$(node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('data/config.json','utf8'));console.log(c.github?.repo||'')")"
fi
if [[ -z "${REPO}" ]]; then
  echo "未设置 GITHUB_REPO。请在 ${APP_DIR}/.env 中设置 GITHUB_REPO=owner/repo 后再升级。"
  exit 1
fi

TMP="$(mktemp -d)"
cleanup() { rm -rf "${TMP}"; }
trap cleanup EXIT

echo "从 GitHub 拉取最新版本：${REPO}"
LATEST_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" || true)"
TARBALL="$(node -e "const j=JSON.parse(process.argv[1]||'{}');console.log(j.tarball_url||'')" "${LATEST_JSON}")"

if [[ -n "${TARBALL}" ]]; then
  curl -fsSL "${TARBALL}" -o "${TMP}/latest.tar.gz"
  mkdir -p "${TMP}/src"
  tar -xzf "${TMP}/latest.tar.gz" -C "${TMP}/src" --strip-components=1
else
  BRANCH="${GITHUB_BRANCH:-main}"
  git clone --depth 1 --branch "${BRANCH}" "https://github.com/${REPO}.git" "${TMP}/src"
fi

echo "同步最新文件，保留 .env、data、node_modules、venv"
rsync -a --delete \
  --exclude .env \
  --exclude data \
  --exclude node_modules \
  --exclude venv \
  "${TMP}/src/" "${APP_DIR}/"

cd "${APP_DIR}"
npm install --omit=dev
if [[ ! -d venv ]]; then
  python3 -m venv venv
fi
venv/bin/python -m pip install --upgrade pip
venv/bin/python -m pip install -r requirements.txt
systemctl restart "${SERVICE_NAME}"
echo "升级完成，服务已重启。"
