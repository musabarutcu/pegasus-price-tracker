"""Pegasus fiyatlarını obilet.com üzerinden çeker.

Pegasus'un kendi sitesi (Akamai) bulut sunucularını engelliyor; obilet ise
Pegasus'tan canlı fiyat alıp listeliyor ve sunucudan gelen isteklere açık.
Uçuş başına Pegasus'un kendi fiyatı ("base") ayrıca veriliyor; obilet'in
hizmet bedeli ("fee") onun üstüne ekleniyor. Biz Pegasus fiyatını kullanıyoruz
(Pegasus sitesindeki fiyatla birebir aynı çıktı).

Cloudflare bot koruması düz isteklere 403 verdiği için curl_cffi ile Chrome'un
TLS parmak izini taklit ediyoruz; tarayıcı gerekmiyor.
"""

import json
import os
import random
import time

from curl_cffi import requests

BASE = "https://www.obilet.com"
AIRLINE = "PC"  # Pegasus

# obilet konum kimlikleri (havalimanı kodu → id). Listede olmayanlar aranıp önbelleğe alınır.
KNOWN_IDS = {
    "SAW": "350_67",
    "IST": "349_5157",
    "ADB": "251_18",
    "ESB": "222_4",
    "AYT": "223_5",
}
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".obilet_ids.json")


def _load_cache():
    try:
        with open(CACHE_FILE, encoding="utf-8") as f:
            return {**KNOWN_IDS, **json.load(f)}
    except (OSError, ValueError):
        return dict(KNOWN_IDS)


def _save_cache(ids):
    extra = {k: v for k, v in ids.items() if KNOWN_IDS.get(k) != v}
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(extra, f)
    except OSError:
        pass


class Obilet:
    def __init__(self, log=print):
        self.s = requests.Session(impersonate="chrome131")
        self.s.headers.update({"Accept-Language": "tr-TR,tr;q=0.9"})
        self.ids = _load_cache()
        self.log = log
        self.warmed = False

    def _xhr(self, referer, json_body=False):
        h = {
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Origin": BASE,
            "Referer": referer,
        }
        if json_body:
            h["Content-Type"] = "application/json"
        return h

    def airport_id(self, code):
        if code in self.ids:
            return self.ids[code]
        ref = f"{BASE}/ucak-bileti"
        if not self.warmed:
            self.s.get(ref, timeout=30)
            self.warmed = True
        r = self.s.post(f"{BASE}/json/ucak-duraklari", headers=self._xhr(ref, True),
                        data=json.dumps({"query": code, "page": 1, "element": "origin"}), timeout=30)
        items = (r.json().get("data") or {}).get("items") or []
        # Kod aramasında ilk sonuç o havalimanı oluyor; "Tümü" (şehir) kayıtlarını atla
        for it in items:
            if not str(it.get("id", "")).endswith("_0"):
                self.ids[code] = it["id"]
                _save_cache(self.ids)
                return it["id"]
        raise ValueError(f"obilet'te {code} havalimanı bulunamadı")

    def search(self, dep, arr, date):
        """Bir gün için Pegasus uçuşları: [{"no", "time", "price", "direct"}]"""
        o, d = self.airport_id(dep), self.airport_id(arr)
        ymd = date.replace("-", "")
        route = f"{o}-{d}/{ymd}"
        path = f"{route}/1a/economy"
        page = f"{BASE}/ucuslar/{path}/all"
        self.s.get(page, timeout=30)  # çerezler (Cloudflare) için arama sayfasını aç
        r = self.s.post(f"{BASE}/json/ucuslar/async/{path}", headers=self._xhr(page), data="", timeout=40)
        r.raise_for_status()
        data = r.json()["data"]

        deadline = time.time() + 45
        while data.get("status") == "Processing" and time.time() < deadline:
            time.sleep(max(1, data.get("next-poll-interval") or 1))
            r = self.s.post(f"{BASE}/json/ucuslar/async/status/{route}", headers=self._xhr(page, True),
                            data=json.dumps({"searchToken": data["search-token"]}), timeout=40)
            r.raise_for_status()
            data = r.json()["data"]

        status = data.get("status")
        if status == "EmptyFlightJourneyList":
            return []
        if status != "Completed":
            raise RuntimeError(f"obilet arama durumu: {status}")

        flights = []
        for j in (data.get("result") or {}).get("outbound-journeys") or []:
            for f in j.get("flights") or []:
                segs = f.get("segments") or []
                if not segs or any(s.get("provider-airline-code") != AIRLINE for s in segs):
                    continue
                if segs[0]["route"]["origin"]["code"] != dep or segs[-1]["route"]["destination"]["code"] != arr:
                    continue
                if not segs[0]["route"]["departure"].startswith(date):
                    continue
                prices = f.get("passenger-prices") or []
                base = (prices[0]["value"] if prices else j["price"])["base"]
                flights.append({
                    "no": segs[0].get("display-flight-number") or f"PC{segs[0].get('code', '')}",
                    "time": segs[0]["route"]["departure"][11:16],
                    "price": float(base),
                    "direct": len(segs) == 1,
                })
        # aynı uçuş farklı paketlerle birden fazla gelebilir: en ucuzu kalsın
        best = {}
        for fl in flights:
            k = (fl["no"], fl["time"])
            if k not in best or fl["price"] < best[k]["price"]:
                best[k] = fl
        return sorted(best.values(), key=lambda x: x["time"])


def fetch_all(queries, log=print, **_):
    """scraper.fetch_all ile aynı arayüz (senkron)."""
    ob = Obilet(log=log)
    results, errors = [], []
    for q in queries:
        ok = 0
        for date in q["dates"]:
            for attempt in range(2):
                try:
                    flights = ob.search(q["dep"], q["arr"], date)
                    results.append({"dep": q["dep"], "arr": q["arr"], "date": date, "flights": flights})
                    ok += 1
                    break
                except Exception as e:
                    if attempt == 1:
                        errors.append(f"{q['dep']}-{q['arr']} {date}: {type(e).__name__}: {str(e)[:120]}")
                    time.sleep(3)
            time.sleep(random.uniform(0.8, 1.6))  # siteye nazik ol
        log(f"  {q['dep']}-{q['arr']}: {ok}/{len(q['dates'])} gün")
    return results, errors


if __name__ == "__main__":
    import sys
    dep, arr, d = sys.argv[1:4]
    for fl in Obilet().search(dep, arr, d):
        print(fl["time"], fl["no"], f"{fl['price']:.2f} TL", "" if fl["direct"] else "(aktarmalı)")
