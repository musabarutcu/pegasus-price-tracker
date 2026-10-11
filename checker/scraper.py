"""Pegasus fiyat çekici.

Pegasus'un sitesi Akamai bot korumasının arkasında. Düz HTTP istekleri ve
headless tarayıcılar engelleniyor; bu yüzden gerçek Chrome'u (patchright ile,
görünür pencere / Linux'ta sanal ekran) açıp sitenin kendi
/pegasus/availability servisini sayfanın içinden çağırıyoruz.

Her istek seçilen günün bir öncesini ve sonrasını da döndürür (3 gün).
"""

import asyncio
import json
import random
from datetime import date, timedelta

from patchright.async_api import async_playwright

BOOKING_URL = (
    "https://web.flypgs.com/booking?language=tr&adultCount=1&currency=TL&dateOption=1"
    "&departurePort={dep}&arrivalPort={arr}&departureDate={d}"
)
DEFAULT_VERSION = "3.76.0.3"

FETCH_JS = """async ([body, version]) => {
  const r = await fetch('/pegasus/availability', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'X-PLATFORM': 'web',
      'X-VERSION': version,
    },
    body: JSON.stringify(body),
  });
  return [r.status, await r.text()];
}"""


def _body(dep, arr, d):
    return {
        "flightSearchList": [{"departurePort": dep, "arrivalPort": arr, "departureDate": d}],
        "adultCount": 1, "childCount": 0, "infantCount": 0,
        "currency": "TL", "dateOption": 1,
        "ffRedemption": False, "totalPoints": None,
        "personnelFlightSearch": False, "expatPnr": False,
        "operationCode": "TK", "affiliate": {"id": None},
        "bookingType": "BOOKING",
    }


def centers_for(dates):
    """Bir istek (merkez gün ±1) 3 gün kapsar; tüm tarihleri kapsayan en az merkezi seç."""
    days = sorted(date.fromisoformat(d) for d in set(dates))
    centers, covered_until = [], None
    for d in days:
        if covered_until and d <= covered_until:
            continue
        c = d + timedelta(days=1)
        centers.append(c)
        covered_until = c + timedelta(days=1)
    # Bugünden önceki bir merkez kabul edilmez; ilk gün bugünse merkez yine yarın olur, sorun yok.
    return [c.isoformat() for c in centers]


def parse_flights(data):
    """API cevabını {tarih: [uçuşlar]} sözlüğüne çevirir."""
    out = {}
    for route in data.get("departureRouteList") or []:
        for day in route.get("dailyFlightList") or []:
            flights = []
            for f in day.get("flightList") or []:
                fare = f.get("fare") or {}
                amount = (fare.get("shownFare") or {}).get("amount")
                if amount is None:
                    continue  # satışa kapalı / dolu
                flights.append({
                    "no": f"{f.get('airline', 'PC')}{f.get('flightNo', '')}",
                    "time": (f.get("departureDateTime") or "")[11:16],
                    "price": float(amount),
                    "direct": not f.get("hasConnectedFlight"),
                })
            out[day["date"]] = flights
    return out


async def fetch_all(queries, headless=False, log=print):
    """queries: [{"dep": "SAW", "arr": "ADB", "dates": ["2026-11-20", ...]}]

    Dönüş: (results, errors)
      results: [{"dep", "arr", "date", "flights": [...]}]  — sadece istenen tarihler
    """
    results, errors = [], []
    if not queries:
        return results, errors

    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=headless)
        ctx = await browser.new_context(locale="tr-TR", timezone_id="Europe/Istanbul")
        page = await ctx.new_page()

        version = {"v": DEFAULT_VERSION}

        def on_request(req):
            v = req.headers.get("x-version")
            if v and "/pegasus/" in req.url:
                version["v"] = v

        page.on("request", on_request)

        q0 = queries[0]
        first = centers_for(q0["dates"])[0]
        await page.goto(BOOKING_URL.format(dep=q0["dep"], arr=q0["arr"], d=first),
                        wait_until="networkidle", timeout=90_000)
        await page.wait_for_timeout(2000)

        for q in queries:
            wanted = set(q["dates"])
            found = {}
            for c in centers_for(q["dates"]):
                status, text = None, ""
                for attempt in range(3):
                    status, text = await page.evaluate(FETCH_JS, [_body(q["dep"], q["arr"], c), version["v"]])
                    if status in (200, 400):  # 400: Pegasus bu rotada uçmuyor, tekrar deneme
                        break
                    await page.wait_for_timeout(3000 * (attempt + 1))
                if status != 200:
                    errors.append(f"{q['dep']}-{q['arr']} {c}: HTTP {status}")
                    log(f"  ! {q['dep']}-{q['arr']} {c}: HTTP {status} {text[:80]!r}")
                    continue
                found.update(parse_flights(json.loads(text)))
                await page.wait_for_timeout(random.randint(900, 1800))

            for d in sorted(wanted):
                if d in found:
                    results.append({"dep": q["dep"], "arr": q["arr"], "date": d, "flights": found[d]})
            log(f"  {q['dep']}-{q['arr']}: {len([d for d in wanted if d in found])}/{len(wanted)} gün")

        await browser.close()
    return results, errors


if __name__ == "__main__":
    import sys
    dep, arr, d1 = sys.argv[1:4]
    d2 = sys.argv[4] if len(sys.argv) > 4 else d1
    a, b = date.fromisoformat(d1), date.fromisoformat(d2)
    ds = [(a + timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]
    res, errs = asyncio.run(fetch_all([{"dep": dep, "arr": arr, "dates": ds}]))
    for r in res:
        best = min(r["flights"], key=lambda f: f["price"]) if r["flights"] else None
        print(r["date"], f"{best['price']:.0f} TL {best['time']} {best['no']}" if best else "uçuş yok",
              f"({len(r['flights'])} uçuş)")
    if errs:
        print("HATALAR:", errs)
