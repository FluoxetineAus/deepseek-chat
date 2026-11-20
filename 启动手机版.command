#!/bin/bash
# 双击本文件即可启动本地服务，然后按提示用 iPhone 打开。
cd "$(dirname "$0")" || exit 1

PORT=8000
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
[ -z "$IP" ] && IP="127.0.0.1"

SERVER_PID=""
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已有服务在运行，直接使用即可。"
else
  node _src/serve.mjs >/tmp/deepseek-serve.log 2>&1 &
  SERVER_PID=$!
  sleep 2
fi

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  lsof -ti tcp:8443 2>/dev/null | xargs kill 2>/dev/null
  echo ""
  echo "服务已停止。"
}
trap cleanup EXIT INT TERM

echo "────────────────────────────────────────"
echo " iPhone 与这台 Mac 连同一个 Wi-Fi，"
echo " 用 Safari 打开："
echo ""
echo "     普通版：http://$IP:$PORT"
echo "     语音版：https://$IP:8443   ← 需要麦克风时用这个"
echo ""
echo " 打开后：分享 → 添加到主屏幕"
echo "────────────────────────────────────────"
echo "（本窗口关掉或按 Ctrl+C 就停止服务）"
echo ""

open "http://127.0.0.1:$PORT" 2>/dev/null

if [ -n "$SERVER_PID" ]; then
  wait "$SERVER_PID" 2>/dev/null
else
  read -r -p "按回车关闭此窗口…" _
fi
