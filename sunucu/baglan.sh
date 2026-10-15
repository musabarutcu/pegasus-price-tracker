#!/usr/bin/env bash
# Yeni bir API_SECRET üretir; Worker'a, Telegram webhook'una ve sunucudaki .env'ye yazar.
# Şifre ekrana hiç yazılmaz. Kullanım: sunucu/baglan.sh ubuntu@SUNUCU_IP [ssh-anahtarı]
set -euo pipefail
HOST="$1"; KEY="${2:-$HOME/.ssh/pegasus_oracle}"
cd "$(dirname "$0")/../worker"
URL=$(npx wrangler deploy 2>&1 | grep -o 'https://[a-z0-9.-]*\.workers\.dev' | head -1)
[ -n "$URL" ] || { echo "Worker adresi bulunamadı"; exit 1; }
S=$(openssl rand -hex 24)
printf %s "$S" | npx wrangler secret put API_SECRET >/dev/null
sleep 10
curl -s -X POST -H "Authorization: Bearer $S" "$URL/setup"
printf 'WORKER_URL=%s\nAPI_SECRET=%s\n' "$URL" "$S" | ssh -i "$KEY" "$HOST" 'umask 077; mkdir -p ~/pegasus-takip; cat > ~/pegasus-takip/.env'
unset S
echo "Bağlandı: $URL"
