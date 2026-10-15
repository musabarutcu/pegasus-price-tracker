#!/usr/bin/env bash
# Ubuntu sunucuda fiyat çekiciyi kurar (bir kere). Depo ~/pegasus-takip altında olmalı.
# .env dosyası (WORKER_URL, API_SECRET) ayrıca oluşturulur: bkz. sunucu/baglan.sh
set -euo pipefail
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv >/dev/null
[ -d ~/venv ] || python3 -m venv ~/venv
~/venv/bin/pip install -q -r ~/pegasus-takip/checker/requirements.txt
sudo cp ~/pegasus-takip/sunucu/pegasus-takip.service ~/pegasus-takip/sunucu/pegasus-takip.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pegasus-takip.timer
echo "Kuruldu. Loglar: journalctl -u pegasus-takip -f"
