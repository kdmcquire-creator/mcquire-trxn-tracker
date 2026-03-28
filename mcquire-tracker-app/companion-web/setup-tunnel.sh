#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# McQuire Companion Web — Cloudflare Tunnel Setup
# ─────────────────────────────────────────────────────────────────────────────
#
# Prerequisites:
#   1. Install cloudflared:
#      - Windows: winget install cloudflare.cloudflared
#      - macOS:   brew install cloudflared
#      - Linux:   See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
#
#   2. Have a domain on Cloudflare (nameservers pointing to CF)
#
# This script sets up a NAMED tunnel with a custom subdomain.
# For a quick temporary tunnel (no domain needed), just run:
#   cloudflared tunnel --url http://localhost:3000
# ─────────────────────────────────────────────────────────────────────────────

set -e

TUNNEL_NAME="mcquire-companion"
# Change this to your desired subdomain, e.g. tracker.yourdomain.com
HOSTNAME="${1:-tracker.moonsmoke.com}"
PORT="${2:-3000}"

echo "=== McQuire Companion — Cloudflare Tunnel Setup ==="
echo ""

# Step 1: Login to Cloudflare (opens browser)
echo "[1/4] Authenticating with Cloudflare..."
cloudflared tunnel login

# Step 2: Create the tunnel
echo ""
echo "[2/4] Creating tunnel '${TUNNEL_NAME}'..."
cloudflared tunnel create "${TUNNEL_NAME}"

# Step 3: Get tunnel UUID
TUNNEL_ID=$(cloudflared tunnel list --output json | grep -o "\"id\":\"[^\"]*\"" | head -1 | cut -d'"' -f4)
echo "     Tunnel ID: ${TUNNEL_ID}"

# Step 4: Create config file
CRED_FILE="$HOME/.cloudflared/${TUNNEL_ID}.json"
CONFIG_FILE="$HOME/.cloudflared/config-mcquire.yml"

echo ""
echo "[3/4] Writing config to ${CONFIG_FILE}..."
cat > "${CONFIG_FILE}" << EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CRED_FILE}

ingress:
  - hostname: ${HOSTNAME}
    service: http://localhost:${PORT}
  - service: http_status:404
EOF

# Step 5: Create DNS record
echo ""
echo "[4/4] Creating DNS record for ${HOSTNAME}..."
cloudflared tunnel route dns "${TUNNEL_NAME}" "${HOSTNAME}"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To start the tunnel, run:"
echo "  cloudflared tunnel --config ${CONFIG_FILE} run ${TUNNEL_NAME}"
echo ""
echo "To install as a system service (auto-starts on boot):"
echo "  sudo cloudflared service install --config ${CONFIG_FILE}"
echo ""
echo "Your companion app will be accessible at: https://${HOSTNAME}"
echo ""
echo "Don't forget to:"
echo "  1. Copy .env.example to .env and set MCQUIRE_DB_PATH and MCQUIRE_PIN"
echo "  2. Run 'npm install && npm run build' in the companion-web directory"
echo "  3. Start the server with 'npm start'"
