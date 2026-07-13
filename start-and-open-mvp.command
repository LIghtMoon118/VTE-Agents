#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT=8787
URL="http://localhost:${PORT}"

if lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
  echo "检测到 ${PORT} 端口已有服务，直接打开 ${URL}"
  open "$URL"
  exit 0
fi

echo "启动 VTE Agent MVP 并打开浏览器..."

osascript <<EOF
tell application "Terminal"
  activate
  do script "cd \"$SCRIPT_DIR\" && npm start"
end tell
EOF

for i in {1..20}; do
  if lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
    open "$URL"
    echo "已打开 ${URL}"
    exit 0
  fi
  sleep 1
done

echo "服务似乎尚未成功启动，请查看新开的 Terminal 窗口。"
