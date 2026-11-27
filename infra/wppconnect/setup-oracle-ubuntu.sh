#!/usr/bin/env bash
set -euo pipefail

# Oracle Cloud Always Free (Ubuntu ARM64/AMD64) setup script for GYMEG WPPConnect + Worker.
# Usage:
#   GYMEG_WPP_WORKER_SECRET="..." WPP_SECRET_KEY="..." bash setup-oracle-ubuntu.sh

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (or with sudo)." >&2
  exit 1
fi

if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl git
  curl -fsSL https://get.docker.com | sh
fi

APP_DIR="/opt/gymeg"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --depth 1 https://github.com/ahmedmorgan86/gymeg.git "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only
fi

cd "$APP_DIR/infra/wppconnect"

if [ ! -f .env ]; then
  if [ -z "${GYMEG_WPP_WORKER_SECRET:-}" ]; then
    read -r -p "Enter GYMEG_WPP_WORKER_SECRET: " GYMEG_WPP_WORKER_SECRET
  fi
  if [ -z "${WPP_SECRET_KEY:-}" ]; then
    WPP_SECRET_KEY="$(openssl rand -hex 24)"
  fi
  cat > .env <<EOF
GYMEG_API_BASE_URL=https://gymeg.vercel.app
GYMEG_WPP_WORKER_SECRET=${GYMEG_WPP_WORKER_SECRET}
WPP_SECRET_KEY=${WPP_SECRET_KEY}
WORKER_POLL_INTERVAL_MS=5000
EOF
  chmod 600 .env
fi

docker compose up -d --build
docker compose ps
echo "GYMEG WPPConnect stack is running 24/7!"
