// Pegasus Fiyat Takip — Cloudflare Worker
//
// Görevleri:
//  - Telegram botunun komutlarını anında cevaplar (/takip, /liste, /sil ...)
//  - Takipleri D1 veritabanında tutar
//  - Yeni takipte ve 30 dakikada bir GitHub Actions'taki fiyat kontrolünü tetikler
//  - Actions'tan gelen fiyatları önceki fiyatlarla karşılaştırıp bildirim gönderir
//
// Ortam değişkenleri (wrangler secret / vars):
//  TELEGRAM_TOKEN  BotFather'dan alınan token                  (secret)
//  API_SECRET      Actions ile Worker arasındaki ortak şifre     (secret)
//  GH_TOKEN        GitHub fine-grained token (Actions: write)    (secret)
//  GH_REPO         "kullanici/repo"                              (var)
//  ACCESS_CODE     Boş değilse bota erişim için /kod gerekir      (secret, opsiyonel)
//  ADMIN_CHAT_ID   Hata uyarılarının gideceği chat id; boşsa bota ilk yazan kişi admin olur (opsiyonel)

const MAX_TRACKS_PER_USER = 10;
const MAX_RANGE_DAYS = 31;
const MAX_DAYS_AHEAD = 330;
const WORKFLOW_FILE = "check.yml";

// ---------------------------------------------------------------- yerler

const PLACES = {
  istanbul: { name: "İstanbul", ports: ["SAW", "IST"] },
  saw: { name: "İstanbul Sabiha Gökçen", ports: ["SAW"] },
  sabiha: { name: "İstanbul Sabiha Gökçen", ports: ["SAW"] },
  sabihagokcen: { name: "İstanbul Sabiha Gökçen", ports: ["SAW"] },
  ist: { name: "İstanbul Havalimanı", ports: ["IST"] },
  izmir: { name: "İzmir", ports: ["ADB"] },
  adb: { name: "İzmir", ports: ["ADB"] },
  ankara: { name: "Ankara", ports: ["ESB"] },
  antalya: { name: "Antalya", ports: ["AYT"] },
  trabzon: { name: "Trabzon", ports: ["TZX"] },
  kayseri: { name: "Kayseri", ports: ["ASR"] },
  gaziantep: { name: "Gaziantep", ports: ["GZT"] },
  antep: { name: "Gaziantep", ports: ["GZT"] },
  diyarbakir: { name: "Diyarbakır", ports: ["DIY"] },
  bodrum: { name: "Bodrum", ports: ["BJV"] },
  dalaman: { name: "Dalaman", ports: ["DLM"] },
  samsun: { name: "Samsun", ports: ["SZF"] },
  erzurum: { name: "Erzurum", ports: ["ERZ"] },
  van: { name: "Van", ports: ["VAN"] },
  malatya: { name: "Malatya", ports: ["MLX"] },
  elazig: { name: "Elazığ", ports: ["EZS"] },
  sanliurfa: { name: "Şanlıurfa", ports: ["GNY"] },
  urfa: { name: "Şanlıurfa", ports: ["GNY"] },
  mardin: { name: "Mardin", ports: ["MQM"] },
  batman: { name: "Batman", ports: ["BAL"] },
  hatay: { name: "Hatay", ports: ["HTY"] },
  konya: { name: "Konya", ports: ["KYA"] },
  kars: { name: "Kars", ports: ["KSY"] },
  mus: { name: "Muş", ports: ["MSR"] },
};

function norm(s) {
  return s
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
    .replace(/[^a-z0-9]/g, "");
}

function findPlace(token) {
  const key = norm(token);
  if (PLACES[key]) return PLACES[key];
  if (/^[a-z]{3}$/.test(key)) {
    const code = key.toUpperCase();
    return { name: code, ports: [code] };
  }
  return null;
}

// ---------------------------------------------------------------- tarih

const MONTHS = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];
const DAYS = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];

function todayTR() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
}

function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function fmtDate(iso, withDay = true) {
  const d = new Date(iso + "T00:00:00Z");
  const s = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withDay ? `${s} ${DAYS[d.getUTCDay()]}` : s;
}

// "20.11.2026", "20.11", "20/11/26", "2026-11-20"  →  "2026-11-20" | null
function parseDate(token, today) {
  let y, m, d;
  let mt = token.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mt) [, y, m, d] = mt.map(Number);
  else {
    mt = token.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/);
    if (!mt) return null;
    d = +mt[1]; m = +mt[2];
    y = mt[3] ? (mt[3].length === 2 ? 2000 + +mt[3] : +mt[3]) : null;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const build = (yy) => {
    const iso = `${yy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const chk = new Date(iso + "T00:00:00Z");
    return chk.getUTCMonth() + 1 === m ? iso : null; // 31 Şubat gibi tarihleri ele
  };
  if (y) return build(y);
  const ty = +today.slice(0, 4);
  const cand = build(ty);
  if (cand && cand >= today) return cand;
  return build(ty + 1);
}

// ---------------------------------------------------------------- biçim

function fmtPrice(p) {
  return p.toLocaleString("tr-TR", { maximumFractionDigits: 2 }) + " TL";
}

function bookingLink(route, date) {
  const [dep, arr] = route.split("-");
  return `https://web.flypgs.com/booking?language=tr&adultCount=1&currency=TL&dateOption=1&departurePort=${dep}&arrivalPort=${arr}&departureDate=${date}`;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function trackTitle(t) {
  return `${esc(t.origin)} → ${esc(t.dest)}`;
}

function trackDates(t) {
  return t.date_from === t.date_to
    ? fmtDate(t.date_from)
    : `${fmtDate(t.date_from, false)} – ${fmtDate(t.date_to, false)}`;
}

function routeLabel(route) {
  return route.replace("-", "→");
}

function flightInfo(b) {
  return `${b.time} ${routeLabel(b.route)}${b.direct === false ? " (aktarmalı)" : ""}`;
}

// ---------------------------------------------------------------- telegram

async function tg(env, method, body) {
  if (env.DEBUG_LOG) console.log("TG", method, JSON.stringify(body));
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.log("Telegram hatası", method, r.status, await r.text());
  return r;
}

function send(env, chatId, text) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function webhookSecret(env) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tg:" + env.API_SECRET));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

// ---------------------------------------------------------------- github

async function dispatchCheck(env) {
  if (!env.GH_TOKEN || !env.GH_REPO) return false;
  const r = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pegasus-takip-worker",
      },
      body: JSON.stringify({ ref: env.GH_BRANCH || "main" }),
    },
  );
  if (!r.ok) console.log("GitHub dispatch hatası", r.status, await r.text());
  return r.ok;
}

// ---------------------------------------------------------------- meta

async function getMeta(env, key) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

function setMeta(env, key, value) {
  return env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, String(value)).run();
}

// ---------------------------------------------------------------- komutlar

const HELP = `✈️ <b>Pegasus Fiyat Takip</b>

Rota ve tarih aralığını yaz, ilk fiyatları hemen göndereyim, sonra 30 dakikada bir kontrol edip fiyat değişince haber vereyim.

<b>Takip başlat</b>
<code>/takip istanbul izmir 20.11 25.11</code>
→ fiyat her değiştiğinde bildirir

<code>/takip izmir istanbul 23.11 1400</code>
→ tek gün; sadece fiyat 1.400 TL veya altına inerse bildirir

<b>Diğer komutlar</b>
/liste — takiplerin ve güncel en ucuz fiyatlar
/sil 2 — 2 numaralı takibi siler (/sil hepsi)
/kontrol — fiyatları şimdi kontrol et
/yardim — bu mesaj

<i>İstanbul = Sabiha Gökçen + İstanbul Havalimanı. Sadece birini istersen "saw" veya "ist" yaz. Diğer şehirler: ankara, antalya, trabzon... ya da havalimanı kodu (ESB, AYT...).</i>`;

async function adminId(env) {
  return env.ADMIN_CHAT_ID || (await getMeta(env, "admin_chat_id"));
}

async function isAllowed(env, user) {
  if (!env.ACCESS_CODE) return true;
  if (String(user.chat_id) === String(await adminId(env))) return true;
  return user.allowed === 1;
}

async function handleUpdate(env, update, ctx) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text || msg.chat.type !== "private") return;
  const chatId = msg.chat.id;
  const name = msg.from?.first_name || "";
  const text = msg.text.trim();

  await env.DB.prepare("INSERT INTO users (chat_id, name) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name")
    .bind(chatId, name).run();
  const user = await env.DB.prepare("SELECT * FROM users WHERE chat_id = ?").bind(chatId).first();
  if (!(await adminId(env))) await setMeta(env, "admin_chat_id", chatId); // bota ilk yazan = sahibi

  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.startsWith("/") ? norm(rawCmd.split("@")[0]) : "";

  if (!(await isAllowed(env, user))) {
    if (cmd === "kod" && args[0] && norm(args[0]) === norm(env.ACCESS_CODE)) {
      await env.DB.prepare("UPDATE users SET allowed = 1 WHERE chat_id = ?").bind(chatId).run();
      return send(env, chatId, "🔓 Erişim açıldı!\n\n" + HELP);
    }
    return send(env, chatId, "🔒 Bu bot özel. Erişim kodunu <code>/kod KOD</code> şeklinde gönder.");
  }

  switch (cmd) {
    case "start":
    case "yardim":
    case "help":
      return send(env, chatId, HELP);
    case "kod":
      return send(env, chatId, "Zaten erişimin var 👍");
    case "takip":
      return cmdTrack(env, chatId, args, ctx);
    case "liste":
      return cmdList(env, chatId);
    case "sil":
      return cmdDelete(env, chatId, args);
    case "kontrol": {
      const ok = await dispatchCheck(env);
      return send(env, chatId, ok ? "🔄 Kontrol başlatıldı, değişiklik varsa 1-2 dakika içinde bildiririm." : "⚠️ Kontrol başlatılamadı.");
    }
    case "":
      // Komutsuz yazılan "istanbul izmir 20.11 25.11" gibi mesajları da takip olarak dene
      return cmdTrack(env, chatId, text.split(/\s+/), ctx, true);
    default:
      return send(env, chatId, "Bu komutu tanımadım. /yardim yazarak kullanımı görebilirsin.");
  }
}

function parseTrackArgs(args, today) {
  // "istanbul-izmir" veya "20.11-25.11" gibi birleşik yazımları ayır (ISO tarihlere dokunma)
  const tokens = args
    .flatMap((a) => (/^\d{4}-\d{1,2}-\d{1,2}$/.test(a) ? [a] : a.split(/[-–>]+/)))
    .filter(Boolean);
  const places = [], dates = [];
  let target = null;
  for (const tok of tokens) {
    const clean = tok.replace(/^(hedef|max|<=|≤|<):?/i, "").replace(/(tl|₺)$/i, "");
    const d = parseDate(clean, today);
    if (d) { dates.push(d); continue; }
    if (/^\d{1,3}(\.\d{3})*$|^\d+$/.test(clean) && clean !== "") {
      target = Number(clean.replace(/\./g, ""));
      continue;
    }
    if (clean === "") continue;
    places.push(tok);
  }
  return { places, dates, target };
}

async function cmdTrack(env, chatId, args, ctx, implicit = false) {
  const today = todayTR();
  const { places, dates, target } = parseTrackArgs(args, today);
  const usage = "Örnek: <code>/takip istanbul izmir 20.11 25.11</code> veya hedef fiyatla <code>/takip izmir istanbul 23.11 1400</code>";

  if (places.length !== 2 || dates.length < 1 || dates.length > 2) {
    return send(env, chatId, implicit ? "Anlayamadım 🤔 /yardim yazarak kullanımı görebilirsin." : `Eksik ya da hatalı bilgi.\n${usage}`);
  }
  const from = findPlace(places[0]);
  const to = findPlace(places[1]);
  if (!from) return send(env, chatId, `"${esc(places[0])}" şehrini tanımadım. Havalimanı kodu da yazabilirsin (örn. SAW, ADB).`);
  if (!to) return send(env, chatId, `"${esc(places[1])}" şehrini tanımadım. Havalimanı kodu da yazabilirsin (örn. SAW, ADB).`);
  if (from.ports.some((p) => to.ports.includes(p))) return send(env, chatId, "Kalkış ve varış aynı olamaz.");

  let [d1, d2] = dates.length === 2 ? dates : [dates[0], dates[0]];
  if (d2 < d1) [d1, d2] = [d2, d1];
  if (d1 < today) return send(env, chatId, "Geçmiş bir tarih girdin.");
  if (daysBetween(d1, d2) + 1 > MAX_RANGE_DAYS) return send(env, chatId, `Tarih aralığı en fazla ${MAX_RANGE_DAYS} gün olabilir.`);
  if (daysBetween(today, d2) > MAX_DAYS_AHEAD) return send(env, chatId, "Bu kadar ileri bir tarih için henüz satış yok.");
  if (target !== null && (target < 100 || target > 100000)) return send(env, chatId, "Hedef fiyat mantıklı görünmüyor.");

  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM tracks WHERE chat_id = ?").bind(chatId).first();
  if (count.n >= MAX_TRACKS_PER_USER) return send(env, chatId, `En fazla ${MAX_TRACKS_PER_USER} takip olabilir. /liste ve /sil ile yer açabilirsin.`);

  await env.DB.prepare(
    "INSERT INTO tracks (chat_id, origin, dest, dep_ports, arr_ports, date_from, date_to, target) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(chatId, from.name, to.name, from.ports.join(","), to.ports.join(","), d1, d2, target).run();

  ctx.waitUntil(dispatchCheck(env));

  const t = { origin: from.name, dest: to.name, date_from: d1, date_to: d2 };
  const mode = target
    ? `🎯 Fiyat <b>${fmtPrice(target)}</b> veya altına inerse haber vereceğim.`
    : "🔔 Fiyat her değiştiğinde haber vereceğim.";
  return send(env, chatId, `✅ Takip eklendi: <b>${trackTitle(t)}</b>\n📅 ${trackDates(t)}\n${mode}\n\n⏳ İlk fiyatlar 1-2 dakika içinde geliyor...`);
}

async function userTracks(env, chatId) {
  const { results } = await env.DB.prepare("SELECT * FROM tracks WHERE chat_id = ? ORDER BY id").bind(chatId).all();
  return results;
}

async function cmdList(env, chatId) {
  const tracks = await userTracks(env, chatId);
  if (!tracks.length) return send(env, chatId, "Henüz takibin yok. Örnek: <code>/takip istanbul izmir 20.11 25.11</code>");
  const lines = ["📋 <b>Takiplerin</b>", ""];
  for (const [i, t] of tracks.entries()) {
    const best = await env.DB.prepare(
      "SELECT * FROM track_prices WHERE track_id = ? AND price IS NOT NULL AND date >= ? ORDER BY price, date LIMIT 1",
    ).bind(t.id, todayTR()).first();
    lines.push(`<b>${i + 1}.</b> ${trackTitle(t)} · ${trackDates(t)}${t.target ? ` · 🎯 ${fmtPrice(t.target)}` : ""}`);
    lines.push(best ? `    En ucuz: <b>${fmtPrice(best.price)}</b> (${fmtDate(best.date)} ${best.time})` : "    Fiyat bekleniyor...");
  }
  lines.push("", "Silmek için: /sil numara");
  return send(env, chatId, lines.join("\n"));
}

async function deleteTrack(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM track_prices WHERE track_id = ?").bind(id),
    env.DB.prepare("DELETE FROM tracks WHERE id = ?").bind(id),
  ]);
}

async function cmdDelete(env, chatId, args) {
  const tracks = await userTracks(env, chatId);
  if (!tracks.length) return send(env, chatId, "Silinecek takip yok.");
  if (args[0] && norm(args[0]) === "hepsi") {
    for (const t of tracks) await deleteTrack(env, t.id);
    return send(env, chatId, `🗑 ${tracks.length} takip silindi.`);
  }
  const n = parseInt(args[0], 10);
  if (!n || n < 1 || n > tracks.length) return send(env, chatId, "Hangi takibi sileyim? Örnek: <code>/sil 1</code> (numaralar /liste'de)");
  const t = tracks[n - 1];
  await deleteTrack(env, t.id);
  return send(env, chatId, `🗑 Silindi: ${trackTitle(t)} · ${trackDates(t)}`);
}

// ---------------------------------------------------------------- Actions API

async function activeTracks(env) {
  const { results } = await env.DB.prepare("SELECT * FROM tracks WHERE date_to >= ?").bind(todayTR()).all();
  return results;
}

async function apiJobs(env) {
  const today = todayTR();
  const byPair = new Map();
  for (const t of await activeTracks(env)) {
    const days = dateRange(t.date_from < today ? today : t.date_from, t.date_to);
    for (const dep of t.dep_ports.split(",")) {
      for (const arr of t.arr_ports.split(",")) {
        const key = `${dep}-${arr}`;
        if (!byPair.has(key)) byPair.set(key, new Set());
        days.forEach((d) => byPair.get(key).add(d));
      }
    }
  }
  const queries = [...byPair].map(([key, set]) => {
    const [dep, arr] = key.split("-");
    return { dep, arr, dates: [...set].sort() };
  });
  return { queries };
}

// Bir takip için gün gün en ucuz uçuş. undefined = o gün için veri gelmedi.
function bestForTrack(t, fares, today) {
  const out = {};
  const from = t.date_from < today ? today : t.date_from;
  for (const date of dateRange(from, t.date_to)) {
    let seen = false, best = null;
    for (const dep of t.dep_ports.split(",")) {
      for (const arr of t.arr_ports.split(",")) {
        const flights = fares.get(`${dep}-${arr}|${date}`);
        if (!flights) continue;
        seen = true;
        for (const f of flights) {
          if (!best || f.price < best.price || (f.price === best.price && f.time < best.time)) {
            best = { price: f.price, time: f.time, flight: f.no, route: `${dep}-${arr}`, direct: f.direct !== false };
          }
        }
      }
    }
    if (seen) out[date] = best || { price: null, time: null, flight: null, route: null };
  }
  return out;
}

function initialMessage(t, best) {
  const dates = Object.keys(best).sort();
  const priced = dates.filter((d) => best[d].price !== null);
  const cheapest = priced.reduce((a, d) => (a === null || best[d].price < best[a].price ? d : a), null);
  const lines = [`✈️ <b>${trackTitle(t)}</b> · ${trackDates(t)}`, ""];
  for (const d of dates) {
    const b = best[d];
    lines.push(b.price === null
      ? `${fmtDate(d)} — satışta uçuş yok`
      : `${fmtDate(d)} — <b>${fmtPrice(b.price)}</b> · ${flightInfo(b)}${d === cheapest && priced.length > 1 ? " ⭐" : ""}`);
  }
  const missing = dateRange(t.date_from < todayTR() ? todayTR() : t.date_from, t.date_to).filter((d) => !best[d]);
  if (missing.length) lines.push(`<i>${missing.length} gün için fiyat alınamadı, sonraki kontrolde denenecek.</i>`);
  lines.push("");
  if (cheapest && t.target !== null && best[cheapest].price <= t.target) {
    lines.push(`🎯 <b>Şu an zaten hedefin altında!</b> Daha da düşerse yine haber vereceğim.`);
  }
  if (cheapest) lines.push(`🔗 <a href="${bookingLink(best[cheapest].route, cheapest)}">En ucuz günü Pegasus'ta aç</a>`);
  lines.push(t.target
    ? `🎯 30 dakikada bir kontrol edeceğim; fiyat ${fmtPrice(t.target)} veya altına inerse haber vereceğim.`
    : "🔔 30 dakikada bir kontrol edeceğim; fiyat değişirse haber vereceğim.");
  return lines.join("\n");
}

function changeMessage(t, changes) {
  const hit = t.target !== null;
  const lines = [hit
    ? `🎯 <b>Hedef fiyat yakalandı!</b> ${trackTitle(t)} (≤ ${fmtPrice(t.target)})`
    : `🔔 <b>Fiyat değişti</b> · ${trackTitle(t)}`, ""];
  let linkDate = null;
  for (const { date, prev, cur } of changes) {
    if (cur.price === null) {
      lines.push(`❌ ${fmtDate(date)}: satışta uçuş kalmadı (önce ${fmtPrice(prev.price)})`);
      continue;
    }
    const was = prev && prev.price !== null ? prev.price : null;
    const arrow = was === null ? "🆕" : cur.price < was ? "⬇️" : "⬆️";
    const old = was === null ? "" : `<s>${fmtPrice(was)}</s> → `;
    lines.push(`${arrow} ${fmtDate(date)}: ${old}<b>${fmtPrice(cur.price)}</b> · ${flightInfo(cur)}`);
    if (!linkDate || cur.price < changes.find((c) => c.date === linkDate).cur.price) linkDate = date;
  }
  if (linkDate) {
    const c = changes.find((x) => x.date === linkDate).cur;
    lines.push("", `🔗 <a href="${bookingLink(c.route, linkDate)}">${fmtDate(linkDate, false)} uçuşunu Pegasus'ta aç</a>`);
  }
  return lines.join("\n");
}

async function apiResults(env, body) {
  const ok = body.ok && Array.isArray(body.results) && body.results.length > 0;
  if (!ok) {
    const fails = Number((await getMeta(env, "fail_count")) || 0) + 1;
    await setMeta(env, "fail_count", fails);
    const admin = await adminId(env);
    if (fails === 3 && admin) {
      await send(env, admin,
        `⚠️ Pegasus fiyatları 3 kez üst üste çekilemedi.\n<code>${esc((body.errors || []).slice(0, 3).join("\n") || "bilinmeyen hata")}</code>`);
    }
    return { notified: 0 };
  }

  const prevFails = Number((await getMeta(env, "fail_count")) || 0);
  if (prevFails) await setMeta(env, "fail_count", 0);
  if (prevFails >= 3) {
    const admin = await adminId(env);
    if (admin) await send(env, admin, "✅ Fiyat kontrolü tekrar çalışıyor.");
  }
  await setMeta(env, "last_success", new Date().toISOString());

  const fares = new Map();
  for (const r of body.results) fares.set(`${r.dep}-${r.arr}|${r.date}`, r.flights || []);

  const today = todayTR();
  let notified = 0;
  for (const t of await activeTracks(env)) {
    const best = bestForTrack(t, fares, today);
    if (!Object.keys(best).length) continue;

    const { results: rows } = await env.DB.prepare("SELECT * FROM track_prices WHERE track_id = ?").bind(t.id).all();
    const prev = Object.fromEntries(rows.map((r) => [r.date, r]));

    let message = null;
    if (!t.initialized) {
      message = initialMessage(t, best);
    } else {
      const changes = [];
      for (const [date, cur] of Object.entries(best)) {
        const p = prev[date];
        if (!p) continue; // daha önce hiç veri yoktu; sessizce kaydet
        if (t.target !== null) {
          const hit = cur.price !== null && cur.price <= t.target &&
            (p.price === null || p.price > t.target || cur.price < p.price);
          if (hit) changes.push({ date, prev: p, cur });
        } else if (p.price !== cur.price) {
          changes.push({ date, prev: p, cur });
        }
      }
      if (changes.length) message = changeMessage(t, changes.sort((a, b) => a.date.localeCompare(b.date)));
    }

    const stmts = Object.entries(best).map(([date, b]) =>
      env.DB.prepare(
        `INSERT INTO track_prices (track_id, date, price, time, flight, route) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(track_id, date) DO UPDATE SET price = excluded.price, time = excluded.time, flight = excluded.flight, route = excluded.route`,
      ).bind(t.id, date, b.price, b.time, b.flight, b.route));
    if (!t.initialized) stmts.push(env.DB.prepare("UPDATE tracks SET initialized = 1 WHERE id = ?").bind(t.id));
    await env.DB.batch(stmts);

    if (message) {
      await send(env, t.chat_id, message);
      notified++;
    }
  }
  return { notified };
}

// ---------------------------------------------------------------- zamanlanmış görev

async function scheduled(env) {
  const today = todayTR();
  const { results: expired } = await env.DB.prepare("SELECT * FROM tracks WHERE date_to < ?").bind(today).all();
  for (const t of expired) {
    await deleteTrack(env, t.id);
    await send(env, t.chat_id, `⌛ Takip sona erdi: ${trackTitle(t)} · ${trackDates(t)}`);
  }
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM tracks WHERE date_to >= ?").bind(today).first();
  if (active.n > 0) await dispatchCheck(env);
}

// ---------------------------------------------------------------- giriş noktası

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/telegram" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await webhookSecret(env))) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      try {
        await handleUpdate(env, update, ctx);
      } catch (e) {
        console.log("Komut hatası", e.stack || e);
      }
      return new Response("ok");
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.headers.get("Authorization") !== `Bearer ${env.API_SECRET}`) return json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/jobs") return json(await apiJobs(env));
      if (url.pathname === "/api/results" && request.method === "POST") return json(await apiResults(env, await request.json()));
      return json({ error: "not found" }, 404);
    }

    // Kurulum: tarayıcıda https://<worker>/setup?key=<API_SECRET> aç
    if (url.pathname === "/setup") {
      if (url.searchParams.get("key") !== env.API_SECRET) return new Response("forbidden", { status: 403 });
      const hook = await tg(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: await webhookSecret(env),
        allowed_updates: ["message"],
        drop_pending_updates: true,
      });
      await tg(env, "setMyCommands", {
        commands: [
          { command: "takip", description: "Yeni fiyat takibi başlat" },
          { command: "liste", description: "Takiplerim ve güncel fiyatlar" },
          { command: "sil", description: "Takip sil" },
          { command: "kontrol", description: "Fiyatları şimdi kontrol et" },
          { command: "yardim", description: "Kullanım" },
        ],
      });
      const gh = env.GH_TOKEN && env.GH_REPO ? "GitHub bağlantısı ayarlı" : "UYARI: GH_TOKEN / GH_REPO eksik";
      return new Response(`Telegram webhook: ${(await hook.json()).description}\n${gh}\n`);
    }

    return new Response("Pegasus Fiyat Takip çalışıyor ✈️", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(env));
  },
};
