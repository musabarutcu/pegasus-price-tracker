"""Bir kontrol turu: Worker'dan işleri al, fiyatları çek, sonuçları Worker'a gönder.

Sunucuda her dakika çalışır. Worker "due" demedikçe (yeni takip, /kontrol ya da
son kontrolün üzerinden 30 dakika geçmesi) hiçbir şey yapmadan çıkar; böylece yeni
takiplerin ilk fiyatları ~1 dakikada gelir.

Ortam değişkenleri:
  WORKER_URL  — örn. https://pegasus-takip.<hesap>.workers.dev
  API_SECRET  — Worker'daki API_SECRET ile aynı
  SOURCE      — "obilet" (varsayılan) ya da "pegasus" (Pegasus sitesi; sadece ev internetinde çalışır)

Kendi bilgisayarında sürekli çalıştırmak için:  python check.py --loop 1
"""

import asyncio
import json
import os
import sys
import time
import urllib.request

WORKER_URL = os.environ.get("WORKER_URL", "").rstrip("/")
API_SECRET = os.environ.get("API_SECRET", "")
SOURCE = os.environ.get("SOURCE", "obilet")


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


def fetch(queries):
    if SOURCE == "pegasus":
        from scraper import fetch_all
        return asyncio.run(fetch_all(queries, headless=os.environ.get("HEADLESS") == "1"))
    from obilet import fetch_all
    return fetch_all(queries)


def run_once(force=False):
    jobs = api("/api/jobs")
    if not jobs.get("due", True) and not force:
        return True
    queries = jobs.get("queries", [])
    total = sum(len(q["dates"]) for q in queries)
    print(time.strftime("%H:%M"), f"{len(queries)} rota, {total} gün kontrol ediliyor ({jobs.get('reason', '')})", flush=True)
    if not queries:
        return True

    started = time.time()
    try:
        results, errors = fetch(queries)
    except Exception as e:
        results, errors = [], [f"{type(e).__name__}: {e}"]

    ok = bool(results)
    resp = api("/api/results", {
        "ok": ok,
        "full": jobs.get("full", True),
        "results": results,
        "errors": errors[:20],
        "seconds": round(time.time() - started),
    })
    print(f"  {len(results)} gün çekildi, {len(errors)} hata, {resp.get('notified', 0)} bildirim", flush=True)
    for e in errors[:5]:
        print("  !", e, flush=True)
    return ok


def main():
    if not WORKER_URL or not API_SECRET:
        sys.exit("WORKER_URL ve API_SECRET ortam değişkenleri gerekli")

    if "--loop" in sys.argv:
        minutes = float(sys.argv[sys.argv.index("--loop") + 1])
        while True:
            try:
                run_once()
            except Exception as e:
                print("Hata:", e, flush=True)
            time.sleep(minutes * 60)
    else:
        sys.exit(0 if run_once(force="--force" in sys.argv) else 1)


if __name__ == "__main__":
    main()
