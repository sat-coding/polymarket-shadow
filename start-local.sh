#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "▶ Creating .data directory..."
mkdir -p .data

echo "▶ Loading env vars..."
if [ -f /home/node/.openclaw/.env ]; then
  export $(grep -E 'ANTHROPIC_API_KEY|BRAVE_API_KEY' /home/node/.openclaw/.env | grep -v '^#' | xargs)
else
  echo "WARNING: /home/node/.openclaw/.env not found"
fi

# Kill any existing server on port 3002
if lsof -ti :3002 > /dev/null 2>&1; then
  echo "▶ Killing existing process on port 3002..."
  kill $(lsof -ti :3002) 2>/dev/null || true
  sleep 1
fi

echo "▶ Building Next.js..."
npm run build

echo "▶ Starting server on port 3002..."
nohup npm start -- -p 3002 > /tmp/polymarket-shadow.log 2>&1 &
SERVER_PID=$!

echo "▶ Waiting for server to be ready..."
for i in $(seq 1 15); do
  if curl -sf http://localhost:3002/api/markets > /dev/null 2>&1; then
    echo "✓ Server is up!"
    break
  fi
  sleep 1
done

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Dashboard: http://localhost:3002             ║"
echo "║  Server PID: $SERVER_PID                          ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Optional: Run the background scanner:"
echo "  APP_URL=http://localhost:3002 node scripts/scanner.mjs"
echo ""
echo "Server logs: tail -f /tmp/polymarket-shadow.log"
