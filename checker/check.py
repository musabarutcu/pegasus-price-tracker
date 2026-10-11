"""Bir kontrol turu: Worker'dan işleri al, fiyatları çek, sonuçları Worker'a gönder.

Ortam değişkenleri:
  WORKER_URL  — örn. https://pegasus-takip.<hesap>.workers.dev
  API_SECRET  — Worker'daki API_SECRET ile aynı
  HEADLESS    — "1" ise pencere açmadan dener (Akamai genelde engeller; varsayılan 0)

Kendi bilgisayarında sürekli çalıştırmak için:  python check.py --loop 30
"""

import asyncio
import json
import os
import sys
import time
import urllib.request

from scraper import fetch_all

WORKER_URL = os.environ.get("WORKER_URL", "").rstrip("/")
API_SECRET = os.environ.get("API_SECRET", "")


def api(path, payload=None):
    req = urllib.request.Request(
        WORKER_URL + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": f"Bearer {API_SECRET}", "Content-Type": "application/json",
                 "User-Agent": "pegasus-takip-checker"},
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def run_once():
    jobs = api("/api/jobs")
    queries = jobs.get("queries", [])
    total = sum(len(q["dates"]) for q in queries)
    print(f"{len(queries)} rota, {total} gün kontrol edilecek")
    if not queries:
        return True

    started = time.time()
    try:
        results, errors = asyncio.run(fetch_all(queries, headless=os.environ.get("HEADLESS") == "1"))
    except Exception as e:  # tarayıcı açılamadı vb.
        results, errors = [], [f"{type(e).__name__}: {e}"]

    ok = bool(results)
    resp = api("/api/results", {
        "ok": ok,
        "results": results,
        "errors": errors[:20],
        "seconds": round(time.time() - started),
    })
    print(f"{len(results)} gün çekildi, {len(errors)} hata, {resp.get('notified', 0)} bildirim gönderildi")
    return ok


def main():
    if not WORKER_URL or not API_SECRET:
        sys.exit("WORKER_URL ve API_SECRET ortam değişkenleri gerekli")

    if "--loop" in sys.argv:
        minutes = int(sys.argv[sys.argv.index("--loop") + 1])
        while True:
            try:
                run_once()
            except Exception as e:
                print("Hata:", e)
            time.sleep(minutes * 60)
    else:
        sys.exit(0 if run_once() else 1)


if __name__ == "__main__":
    main()
