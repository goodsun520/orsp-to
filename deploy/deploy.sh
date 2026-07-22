#!/usr/bin/env bash
# Builds locally, syncs to a configured server, and restarts the systemd service.
# Runtime source data and local environment files are never copied or deleted.
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_CONFIG="${DEPLOY_CONFIG:-$LOCAL_DIR/.deploy.env}"

if [[ -f "$DEPLOY_CONFIG" ]]; then
  # shellcheck disable=SC1090
  source "$DEPLOY_CONFIG"
fi

: "${DEPLOY_HOST:?Set DEPLOY_HOST or create .deploy.env from .deploy.env.example}"
: "${SSH_KEY:?Set SSH_KEY or create .deploy.env from .deploy.env.example}"

DEPLOY_USER="${DEPLOY_USER:-ubuntu}"
REMOTE_DIR="${REMOTE_DIR:-/opt/orsp-legado-adapter}"
REMOTE_OWNER="${REMOTE_OWNER:-$DEPLOY_USER}"
NODE_BIN_DIR="${NODE_BIN_DIR:-/opt/nodejs/bin}"
SITE_URL="${SITE_URL:-https://book.openany.shop}"
HOST="$DEPLOY_USER@$DEPLOY_HOST"

if [[ ! -f "$SSH_KEY" ]]; then
  echo "SSH key not found: $SSH_KEY" >&2
  exit 1
fi

SSH=(ssh -i "$SSH_KEY")

remote() {
  "${SSH[@]}" "$HOST" "$@"
}

echo "==> Building locally"
(cd "$LOCAL_DIR" && npm run build)

echo "==> Syncing source + build output to $HOST:$REMOTE_DIR"
remote "sudo mkdir -p '$REMOTE_DIR' && sudo chown '$REMOTE_OWNER:$REMOTE_OWNER' '$REMOTE_DIR'"
rsync -az --delete \
  --exclude node_modules \
  --exclude data \
  --exclude .git \
  --exclude '.env*' \
  --exclude '.deploy.env*' \
  --exclude '*.local.md' \
  --exclude .playwright-cli \
  --exclude output \
  --exclude coverage \
  --exclude secrets.env \
  --exclude keys \
  -e "ssh -i $SSH_KEY" \
  "$LOCAL_DIR"/ "$HOST:$REMOTE_DIR/"

echo "==> Installing production dependencies"
remote "cd '$REMOTE_DIR' && PATH='$NODE_BIN_DIR':\$PATH npm ci --omit=dev"

echo "==> Ensuring a stable anonymous-metrics secret"
remote "
  sudo touch '$REMOTE_DIR/secrets.env'
  sudo chown '$REMOTE_OWNER:$REMOTE_OWNER' '$REMOTE_DIR/secrets.env'
  sudo chmod 600 '$REMOTE_DIR/secrets.env'
  if ! grep -q '^STATS_HASH_KEY=' '$REMOTE_DIR/secrets.env'; then
    printf 'STATS_HASH_KEY=%s\n' \$(openssl rand -hex 32) >> '$REMOTE_DIR/secrets.env'
  fi
"

echo "==> Installing systemd units"
remote "sudo cp '$REMOTE_DIR/deploy/orsp-legado-adapter.service' /etc/systemd/system/orsp-legado-adapter.service"
remote "sudo cp '$REMOTE_DIR/deploy/orsp-source-audit.service' /etc/systemd/system/orsp-source-audit.service"
remote "sudo cp '$REMOTE_DIR/deploy/orsp-source-audit.timer' /etc/systemd/system/orsp-source-audit.timer"
remote "sudo systemctl daemon-reload && sudo systemctl enable --now orsp-source-audit.timer"

# Certbot may rewrite the production vhost in place, so only install the plain
# HTTP template when the vhost does not already exist.
echo "==> Installing nginx vhost on first deploy only"
remote "
  if [ ! -e /etc/nginx/sites-available/book.openany.shop.conf ]; then
    sudo cp '$REMOTE_DIR/deploy/nginx-book.openany.shop.conf' /etc/nginx/sites-available/book.openany.shop.conf
    sudo ln -sf /etc/nginx/sites-available/book.openany.shop.conf /etc/nginx/sites-enabled/book.openany.shop.conf
    sudo nginx -t && sudo systemctl reload nginx
    echo 'Installed fresh vhost; configure TLS before exposing production traffic.'
  else
    echo 'Existing nginx vhost preserved.'
  fi
"

echo "==> Restarting service"
remote "sudo mkdir -p '$REMOTE_DIR/data/sources'"
remote "sudo chown -R '$REMOTE_OWNER:$REMOTE_OWNER' '$REMOTE_DIR/data'"
remote "sudo systemctl enable --now orsp-legado-adapter && sudo systemctl restart orsp-legado-adapter"

echo "==> Done. Check: curl -s '$SITE_URL/api/sources'"
