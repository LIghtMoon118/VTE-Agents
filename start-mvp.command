#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "启动 VTE Agent MVP..."
echo "工作目录: $SCRIPT_DIR"
echo ""

npm start
