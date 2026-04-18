#!/bin/bash
# Claude Companion - macOS / Linux installer
#
# Registers the native messaging host for every Chromium browser, auto-
# detects the extension ID, and wires Claude Code MCP.
#
# Usage:
#   ./install.sh                            # auto-detect everything
#   ./install.sh <ext-id-1> <ext-id-2>      # explicit IDs

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$SCRIPT_DIR/host"
WRAPPER="$HOST_DIR/native-host-wrapper.sh"
MANIFEST="$HOST_DIR/com.anthropic.claude_companion.json"
HOST_NAME="com.anthropic.claude_companion"
MCP_SERVER="$HOST_DIR/mcp-server.js"

# ────────────────────────────────────────────────────────────────────────
# 1. Verify Node.js
# ────────────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
    echo "Error: node not found. Install Node.js v18+ from https://nodejs.org" >&2
    exit 1
fi
NODE_PATH="$(command -v node)"
echo "[1/5] Node.js: $NODE_PATH"

# ────────────────────────────────────────────────────────────────────────
# 2. Install host deps
# ────────────────────────────────────────────────────────────────────────
if [ ! -d "$HOST_DIR/node_modules" ]; then
    echo "[2/5] Installing host dependencies..."
    (cd "$HOST_DIR" && npm install --silent)
else
    echo "[2/5] Host dependencies ready."
fi

# ────────────────────────────────────────────────────────────────────────
# 3. Auto-detect extension IDs (or use args)
# ────────────────────────────────────────────────────────────────────────
detect_ids() {
    # Search browser profile Preferences for an unpacked extension whose path
    # contains our folder name.
    local needle="claude-companion"
    local roots=()
    case "$(uname)" in
        Darwin)
            roots+=("$HOME/Library/Application Support/Google/Chrome")
            roots+=("$HOME/Library/Application Support/BraveSoftware/Brave-Browser")
            roots+=("$HOME/Library/Application Support/Microsoft Edge")
            roots+=("$HOME/Library/Application Support/Chromium")
            roots+=("$HOME/Library/Application Support/Arc/User Data")
            roots+=("$HOME/Library/Application Support/Vivaldi")
            ;;
        Linux)
            roots+=("$HOME/.config/google-chrome")
            roots+=("$HOME/.config/BraveSoftware/Brave-Browser")
            roots+=("$HOME/.config/microsoft-edge")
            roots+=("$HOME/.config/chromium")
            roots+=("$HOME/.config/vivaldi")
            ;;
    esac
    local ids=()
    for root in "${roots[@]}"; do
        [ -d "$root" ] || continue
        # Look in each profile's Preferences + Secure Preferences
        while IFS= read -r -d '' prefs; do
            # Grep for our folder path, extract the extension id (parent directory name)
            if grep -q "$needle" "$prefs" 2>/dev/null; then
                # Parse the JSON: extensions.settings.<id>.path contains our path
                node -e '
                    const fs = require("fs");
                    try {
                        const d = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
                        const s = d?.extensions?.settings || {};
                        for (const [id, e] of Object.entries(s)) {
                            if ((e.path || "").toLowerCase().includes(process.argv[2])) {
                                console.log(id);
                            }
                        }
                    } catch {}
                ' "$prefs" "$needle" 2>/dev/null
            fi
        done < <(find "$root" -maxdepth 3 \( -name "Preferences" -o -name "Secure Preferences" \) -print0 2>/dev/null)
    done | sort -u
}

if [ "$#" -eq 0 ]; then
    echo "[3/5] Scanning browsers for the extension..."
    DETECTED="$(detect_ids)"
    if [ -z "$DETECTED" ]; then
        echo "  No installed extension detected." >&2
        echo "  → Load unpacked extension in your browser first, then re-run." >&2
        echo "    Folder: $SCRIPT_DIR/extension" >&2
        exit 1
    fi
    IDS=($DETECTED)
    for id in "${IDS[@]}"; do echo "  → $id"; done
else
    IDS=("$@")
    echo "[3/5] Using provided IDs: ${IDS[*]}"
fi

# ────────────────────────────────────────────────────────────────────────
# 4. Write wrapper + manifest + install per-browser
# ────────────────────────────────────────────────────────────────────────
cat > "$WRAPPER" <<WRAP
#!/bin/sh
exec "$NODE_PATH" "$HOST_DIR/native-host.js" "\$@"
WRAP
chmod +x "$WRAPPER"

# Build JSON manifest
ORIGINS=""
for i in "${!IDS[@]}"; do
    [ "$i" -gt 0 ] && ORIGINS="$ORIGINS,"
    ORIGINS="$ORIGINS
    \"chrome-extension://${IDS[$i]}/\""
done

cat > "$MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Claude Companion Native Messaging Host",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": [$ORIGINS
  ]
}
EOF

echo "[4/5] Installing host manifest in:"
install_host() {
    local name="$1" dir="$2"
    if [ ! -d "$(dirname "$dir")" ]; then return; fi
    mkdir -p "$dir"
    cp "$MANIFEST" "$dir/$HOST_NAME.json"
    echo "      $name"
}

case "$(uname)" in
    Darwin)
        install_host "Chrome"    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        install_host "Edge"      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
        install_host "Brave"     "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
        install_host "Chromium"  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
        install_host "Arc"       "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
        install_host "Vivaldi"   "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts"
        ;;
    Linux)
        install_host "Chrome"    "$HOME/.config/google-chrome/NativeMessagingHosts"
        install_host "Edge"      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
        install_host "Brave"     "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
        install_host "Chromium"  "$HOME/.config/chromium/NativeMessagingHosts"
        install_host "Vivaldi"   "$HOME/.config/vivaldi/NativeMessagingHosts"
        ;;
    *)
        echo "Unsupported OS: $(uname). Use install.ps1 on Windows." >&2
        exit 1
        ;;
esac

# ────────────────────────────────────────────────────────────────────────
# 5. Wire Claude Code MCP (if CLI is present)
# ────────────────────────────────────────────────────────────────────────
if command -v claude &>/dev/null; then
    echo "[5/5] Registering MCP server with Claude Code..."
    claude mcp remove claude-companion >/dev/null 2>&1 || true
    if claude mcp add --scope user claude-companion -- node "$MCP_SERVER" >/dev/null 2>&1; then
        echo "      MCP registered."
    else
        echo "      Could not auto-register. Run manually:"
        echo "        claude mcp add --scope user claude-companion -- node \"$MCP_SERVER\""
    fi
else
    echo "[5/5] Claude Code CLI not found. After installing:"
    echo "      npm install -g @anthropic-ai/claude-code"
    echo "      claude login"
    echo "      claude mcp add --scope user claude-companion -- node \"$MCP_SERVER\""
fi

echo ""
echo "Done! Close all browser windows and reopen — registry/manifests are re-read on startup."
