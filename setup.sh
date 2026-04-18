#!/bin/bash
# Claude Companion — One-click setup bootstrap (macOS / Linux)
# Ensures Node.js is present, then launches the wizard in your browser.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WIZARD="$SCRIPT_DIR/setup/wizard.mjs"

hdr() { echo -e "\n   \033[36m$1\033[0m"; echo -e "   \033[90m$(printf '%0.s─' {1..60})\033[0m"; }

echo ""
echo -e "  \033[33m🤖 مرافق كلود — Setup Wizard\033[0m"
echo ""

# 1. Check Node
hdr "فحص Node.js..."
if ! command -v node >/dev/null 2>&1; then
    echo -e "   \033[31m✗ Node.js غير مُثبَّت.\033[0m"
    echo ""
    if command -v brew >/dev/null 2>&1; then
        echo -ne "   تثبيت عبر Homebrew؟ [Y/n]: "
        read ans
        ans="${ans:-Y}"
        if [[ "$ans" =~ ^[Yy]$ ]]; then
            brew install node
        else
            echo "   حمّل من https://nodejs.org"; exit 1
        fi
    elif command -v apt-get >/dev/null 2>&1; then
        echo -ne "   تثبيت عبر apt؟ [Y/n]: "
        read ans
        ans="${ans:-Y}"
        if [[ "$ans" =~ ^[Yy]$ ]]; then
            sudo apt-get install -y nodejs npm
        else
            exit 1
        fi
    else
        echo "   حمّل Node من https://nodejs.org ثم أعد التشغيل."
        exit 1
    fi
fi
echo -e "   \033[32m✓ Node.js موجود: $(which node)\033[0m"

# 2. Host deps
hdr "تجهيز تبعيات الـ host..."
if [ ! -d "$SCRIPT_DIR/host/node_modules" ]; then
    (cd "$SCRIPT_DIR/host" && npm install --silent)
    echo -e "   \033[32m✓ تم التثبيت\033[0m"
else
    echo -e "   \033[32m✓ التبعيات موجودة\033[0m"
fi

# 3. Launch wizard
hdr "فتح المعالج في متصفحك..."
echo -e "   URL: \033[90mhttp://127.0.0.1:5557\033[0m"
echo ""
echo -e "   \033[33mℹ  أبقِ هذه النافذة مفتوحة حتى تنتهي\033[0m"
echo ""

node "$WIZARD"
