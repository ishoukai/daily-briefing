#!/bin/bash
# ラッパースクリプト: macOS Keychain から ANTHROPIC_API_KEY を取得して auto-briefing を実行
# LaunchAgent (com.briefing.daily) から呼ばれる想定

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# macOS Keychain から API キーを取得
export ANTHROPIC_API_KEY="$(security find-generic-password -s 'ANTHROPIC_API_KEY' -a 'daily-briefing' -w 2>/dev/null)"

if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "ERROR: ANTHROPIC_API_KEY not found in Keychain." >&2
  echo "Run: security add-generic-password -s 'ANTHROPIC_API_KEY' -a 'daily-briefing' -w 'your-key-here'" >&2
  exit 1
fi

cd /Users/kazuyaishida/daily-briefing
exec /opt/homebrew/opt/node@20/bin/node src/auto-briefing.js
