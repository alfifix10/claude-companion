#!/usr/bin/env bash
# Claude Companion - one-time setup (macOS / Linux).
# Double-click on macOS (Finder), or run: bash SETUP-Mac-Linux.command
set -u
cd "$(dirname "$0")"
EXT_ID="bciopdghgdndoedlgbbcffgaebjbkago"

echo "=================================================="
echo "   Claude Companion  -  One-time Setup"
echo "=================================================="
echo
echo "This sets up everything except loading the extension"
echo "(the last manual step, shown at the end)."
echo

# [1/4] Node.js -------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "[X] Node.js is not installed."
  echo "    Install the LTS version from https://nodejs.org  then run this again."
  command -v open >/dev/null 2>&1 && open https://nodejs.org || true
  read -r -p "Press Enter to exit..."
  exit 1
fi
echo "[1/4] Node.js $(node -v) found."

# [2/4] Claude CLI ----------------------------------------------------------
if command -v claude >/dev/null 2>&1; then
  echo "[2/4] Claude CLI already installed."
else
  echo "[2/4] Installing Claude CLI ..."
  npm install -g @anthropic-ai/claude-code
fi

# [3/4] Login (needs a Claude Max subscription) -----------------------------
echo "[3/4] Logging in to Claude (a browser window may open) ..."
claude login || true

# [4/4] Register the local native host --------------------------------------
echo "[4/4] Setting up the local host ..."
bash ./install.sh "$EXT_ID"

echo
echo "=================================================="
echo "  Almost done! Final step, in your browser:"
echo "    1) Open   chrome://extensions"
echo "    2) Turn on  \"Developer mode\""
echo "    3) Click  \"Load unpacked\"  and choose:"
echo "         $(pwd)/extension"
echo "=================================================="
read -r -p "Done. Press Enter to close..."
