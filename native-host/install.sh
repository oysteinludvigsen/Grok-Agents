#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Grok Agent — Native Messaging Host installer for macOS / Linux
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.grok.agent"
HOST_SCRIPT="$SCRIPT_DIR/grok_agent_host.py"

# Make the host executable
chmod +x "$HOST_SCRIPT"

# ── Detect OS ────────────────────────────────────────────────────────

OS="$(uname -s)"
declare -a DIRS=()

case "$OS" in
  Darwin)
    DIRS+=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    )
    ;;
  Linux)
    DIRS+=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
    )
    ;;
  *)
    echo "Unsupported OS: $OS — use install.ps1 for Windows."
    exit 1
    ;;
esac

# ── Collect extension ID ─────────────────────────────────────────────

echo "============================================"
echo "  Grok Agent — Native Host Installer"
echo "============================================"
echo ""
echo "Load the extension first, then find its ID at:"
echo "  chrome://extensions  or  edge://extensions"
echo ""
read -rp "Extension ID (leave blank to allow all origins): " EXT_ID

if [[ -z "$EXT_ID" ]]; then
  ORIGINS='"chrome-extension://*/"'
  echo ""
  echo "NOTE: Allowing all extension origins. Pin to a specific ID for"
  echo "      better security by re-running this script later."
else
  ORIGINS="\"chrome-extension://${EXT_ID}/\""
fi

# ── Write manifests ──────────────────────────────────────────────────

INSTALLED=0

for DIR in "${DIRS[@]}"; do
  mkdir -p "$DIR"
  cat > "${DIR}/${HOST_NAME}.json" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Grok Agent Native Messaging Host",
  "path": "${HOST_SCRIPT}",
  "type": "stdio",
  "allowed_origins": [${ORIGINS}]
}
EOF
  echo "  Installed → ${DIR}/${HOST_NAME}.json"
  INSTALLED=$((INSTALLED + 1))
done

echo ""
echo "Done — installed to ${INSTALLED} location(s)."
echo "Restart your browser, then click 'Test Connection' in the extension popup."
