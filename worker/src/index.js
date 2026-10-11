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
const WEBHOOK_VERSION = "2"; // artırılınca webhook ayarları ilk mesajda kendiliğinden yenilenir

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

// ---------------------------------------------------------------- saat

const TIME_PRESETS = {
  sabah: ["06:00", "12:00"],
  ogle: ["12:00", "17:00"],
  oglen: ["12:00", "17:00"],
  ogleden: ["12:00", "17:00"],
  aksam: ["17:00", "24:00"],
  gece: ["00:00", "06:00"],
};

// "8", "08", "8:30", "08:30" → "08:30" | null
function parseClock(s) {
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = +m[1], mi = m[2] ? +m[2] : 0;
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

// Kalkış saati pencerenin içinde mi? (22:00-02:00 gibi gece yarısını aşan aralıklar da olur)
function inWindow(time, from, to) {
  if (!from || !to) return true;
  return from <= to ? time >= from && time <= to : time >= from || time <= to;
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

// Tarih (+ varsa saat aralığı), örn. "20 Kas – 25 Kas · 🕐 08:00–12:00"
function trackDates(t) {
  const d = t.date_from === t.date_to
    ? fmtDate(t.date_from)
    : `${fmtDate(t.date_from, false)} – ${fmtDate(t.date_to, false)}`;
  return t.time_from ? `${d} · 🕐 ${t.time_from}–${t.time_to}` : d;
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

function send(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

const BOT_COMMANDS = [
  { command: "takip", description: "Yeni fiyat takibi başlat" },
  { command: "liste", description: "Takiplerim ve güncel fiyatlar" },
  { command: "iptal", description: "Takip iptal et / çıkar" },
  { command: "kontrol", description: "Fiyatları şimdi kontrol et" },
  { command: "yardim", description: "Kullanım kılavuzu" },
];

// Webhook ayarlarını (butonlar için callback_query dahil) ve komut menüsünü günceller
async function configureWebhook(env, origin, dropPending = false) {
  const r = await tg(env, "setWebhook", {
    url: `${origin}/telegram`,
    secret_token: await webhookSecret(env),
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: dropPending,
  });
  await tg(env, "setMyCommands", { commands: BOT_COMMANDS });
  await setMeta(env, "webhook_v", WEBHOOK_VERSION);
  return r;
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

const HELP = `✈️ <b>Pegasus Fiyat Takip — Kullanım Kılavuzu</b>

Rota ve tarih yaz; ilk fiyatları 1-2 dakikada gönderirim, sonra <b>30 dakikada bir</b> kontrol edip fiyat değişince haber veririm.

<b>1) Takip başlat</b>
<code>/takip istanbul izmir 20.11 25.11</code>
20-25 Kasım arası her günün en ucuz uçuşu; fiyat her değiştiğinde bildirim.

<code>/takip izmir istanbul 23.11</code>
Tek gün.

<b>2) Hedef fiyat</b> (sona bir sayı ekle)
<code>/takip istanbul izmir 20.11 25.11 1400</code>
Sadece fiyat <b>1.400 TL veya altına</b> inince bildirim.

<b>3) Saat aralığı</b>
<code>/takip istanbul izmir 20.11 25.11 saat 08-12</code>
Sadece 08:00-12:00 arası <b>kalkan</b> uçuşlar.
Başka yazımlar: <code>08:30-11:00</code> · <code>saat 18 23</code> · <code>sabah</code> (06-12) · <code>öğle</code> (12-17) · <code>akşam</code> (17-24) · <code>gece</code> (00-06)

Hepsi bir arada:
<code>/takip istanbul izmir 20.11 25.11 akşam 1500</code>

<b>4) Takiplerini gör</b>
/liste — aktif takiplerin, en ucuz fiyatları ve silme butonları

<b>5) Takip iptal et / çıkar</b>
/iptal — listeyi butonlarla gösterir, ❌'ye bas
<code>/iptal 2</code> — 2 numaralı takibi çıkarır (numaralar /liste'de)
<code>/iptal 1 3</code> — birden fazla
<code>/iptal hepsi</code> — tümünü çıkarır
Komutsuz da olur: <code>çıkar 2</code>, <code>sil 1</code>, <code>iptal hepsi</code>

<b>6) Diğer</b>
/kontrol — beklemeden şimdi kontrol et
/yardim — bu kılavuz

<b>Bilmen gerekenler</b>
• <b>İstanbul</b> = Sabiha Gökçen + İstanbul Havalimanı. Sadece biri için <code>saw</code> ya da <code>ist</code> yaz.
• Diğer şehirler: ankara, antalya, trabzon, bodrum, dalaman, kayseri… ya da havalimanı kodu (ESB, AYT, TZX…).
• Tarih: <code>20.11</code>, <code>20.11.2026</code> ya da <code>2026-11-20</code>.
• <code>/takip</code> yazmadan <code>istanbul izmir 20.11 25.11</code> göndermek de olur.
• Kişi başı en fazla ${MAX_TRACKS_PER_USER} takip, her takip en fazla ${MAX_RANGE_DAYS} gün. Tarihi geçen takipler kendiliğinden biter.
• Fiyatlar 1 yetişkin, en ucuz paket (Eco) içindir.`;

const TRACK_USAGE = `Örnekler:
<code>/takip istanbul izmir 20.11 25.11</code>
<code>/takip izmir istanbul 23.11 1400</code>  (hedef fiyat)
<code>/takip istanbul izmir 20.11 25.11 saat 08-12</code>  (saat aralığı)

Tüm seçenekler için /yardim`;

const DELETE_WORDS = new Set(["sil", "iptal", "cikar", "kaldir", "durdur", "vazgec"]);
const LIST_WORDS = new Set(["liste", "listele", "takiplerim", "takipler", "list"]);
const HELP_WORDS = new Set(["start", "yardim", "help", "kilavuz", "komutlar"]);

async function adminId(env) {
  return env.ADMIN_CHAT_ID || (await getMeta(env, "admin_chat_id"));
}

async function isAllowed(env, user) {
  if (!env.ACCESS_CODE) return true;
  if (String(user.chat_id) === String(await adminId(env))) return true;
  return user.allowed === 1;
}

async function getUser(env, chatId, name) {
  await env.DB.prepare("INSERT INTO users (chat_id, name) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name")
    .bind(chatId, name).run();
  if (!(await adminId(env))) await setMeta(env, "admin_chat_id", chatId); // bota ilk yazan = sahibi
  return env.DB.prepare("SELECT * FROM users WHERE chat_id = ?").bind(chatId).first();
}

async function handleUpdate(env, update, ctx) {
  if (update.callback_query) return handleButton(env, update.callback_query);

  const msg = update.message || update.edited_message;
  if (!msg || !msg.text || msg.chat.type !== "private") return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const user = await getUser(env, chatId, msg.from?.first_name || "");

  const [rawCmd, ...args] = text.split(/\s+/);
  const isSlash = rawCmd.startsWith("/");
  const word = norm(isSlash ? rawCmd.split("@")[0] : rawCmd);

  if (!(await isAllowed(env, user))) {
    if (word === "kod" && args[0] && norm(args[0]) === norm(env.ACCESS_CODE)) {
      await env.DB.prepare("UPDATE users SET allowed = 1 WHERE chat_id = ?").bind(chatId).run();
      return send(env, chatId, "🔓 Erişim açıldı!\n\n" + HELP);
    }
    return send(env, chatId, "🔒 Bu bot özel. Erişim kodunu <code>/kod KOD</code> şeklinde gönder.");
  }

  // Komutlar hem "/iptal 2" hem de "iptal 2" / "çıkar 2" şeklinde çalışır
  if (HELP_WORDS.has(word)) return send(env, chatId, HELP);
  if (LIST_WORDS.has(word)) return sendList(env, chatId);
  if (DELETE_WORDS.has(word)) return cmdDelete(env, chatId, args);
  if (word === "kod") return send(env, chatId, "Zaten erişimin var 👍");
  if (word === "durum") return cmdStatus(env, chatId);
  if (word === "takip") return cmdTrack(env, chatId, args, ctx);
  if (word === "kontrol") {
    const ok = await dispatchCheck(env);
    return send(env, chatId, ok ? "🔄 Kontrol başlatıldı, değişiklik varsa 1-2 dakika içinde bildiririm." : "⚠️ Kontrol başlatılamadı.");
  }
  if (isSlash) return send(env, chatId, "Bu komutu tanımadım. /yardim yazarak kullanımı görebilirsin.");

  // Komutsuz yazılan "istanbul izmir 20.11 25.11" gibi mesajları takip olarak dene
  return cmdTrack(env, chatId, text.split(/\s+/), ctx, true);
}

// Sistem durumu (sadece admin): son kontrol, hatalar, kullanıcı/takip sayısı
async function cmdStatus(env, chatId) {
  if (String(chatId) !== String(await adminId(env))) return send(env, chatId, "Bu komut sadece bot sahibine açık.");
  const fmtTime = (iso) => new Date(new Date(iso).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
  const last = JSON.parse((await getMeta(env, "last_run")) || "null");
  const lastOk = await getMeta(env, "last_success");
  const fails = (await getMeta(env, "fail_count")) || "0";
  const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  const tracks = await env.DB.prepare("SELECT COUNT(*) AS n FROM tracks").first();
  const lines = ["🛠 <b>Sistem durumu</b>", ""];
  lines.push(last
    ? `Son kontrol: ${fmtTime(last.at)} — ${last.ok ? `✅ ${last.days} gün çekildi (${last.seconds} sn)` : "❌ başarısız"}`
    : "Son kontrol: henüz yok");
  if (last?.errors?.length) lines.push(`Hatalar:\n<code>${esc(last.errors.join("\n"))}</code>`);
  lines.push(`Son başarılı kontrol: ${lastOk ? fmtTime(lastOk) : "yok"}`);
  lines.push(`Üst üste başarısız: ${fails}`);
  lines.push(`Kullanıcı: ${users.n} · Takip: ${tracks.n}`);
  return send(env, chatId, lines.join("\n"));
}

// Saat aralığını ayıklar: "08-12", "08:30-11:00", "saat 8 12", "10:00 14:00", "sabah"...
function extractTimes(args) {
  const rest = [], clocks = [];
  let preset = null, saatMode = 0;
  for (const a of args) {
    const n = norm(a);
    if (TIME_PRESETS[n]) { preset = TIME_PRESETS[n]; continue; }
    if (n === "saat" || n === "saatler" || n === "saatleri") { saatMode = 2; continue; }
    if (["arasi", "arasinda", "arasindaki", "sonra", "once"].includes(n)) continue;
    const range = a.match(/^(\d{1,2}(?::\d{2})?)[-–](\d{1,2}(?::\d{2})?)$/);
    if (range) {
      clocks.push(range[1], range[2]);
      saatMode = 0;
      continue;
    }
    if (/^\d{1,2}:\d{2}$/.test(a) || (saatMode > 0 && /^\d{1,2}$/.test(a))) {
      clocks.push(a);
      saatMode--;
      continue;
    }
    saatMode = 0;
    rest.push(a);
  }
  if (!clocks.length) return { rest, timeFrom: preset?.[0] ?? null, timeTo: preset?.[1] ?? null, timeError: null };
  if (clocks.length !== 2) return { rest, timeError: "Saat aralığını başlangıç ve bitiş olarak yaz, örn. <code>saat 08-12</code>" };
  const [f, t] = clocks.map(parseClock);
  if (!f || !t) return { rest, timeError: "Saati anlayamadım. Örnek: <code>saat 08-12</code> veya <code>08:30-11:00</code>" };
  if (f === t) return { rest, timeError: "Saat aralığının başı ve sonu aynı olamaz." };
  return { rest, timeFrom: f, timeTo: t, timeError: null };
}

function parseTrackArgs(args, today) {
  const { rest, timeFrom, timeTo, timeError } = extractTimes(args);
  // "istanbul-izmir" veya "20.11-25.11" gibi birleşik yazımları ayır (ISO tarihlere dokunma)
  const tokens = rest
    .flatMap((a) => (/^\d{4}-\d{1,2}-\d{1,2}$/.test(a) ? [a] : a.split(/[-–>]+/)))
    .filter(Boolean);
  const places = [], dates = [];
  let target = null;
  for (const tok of tokens) {
    const clean = tok.replace(/^(hedef|max|<=|≤|<):?/i, "").replace(/(tl|₺)$/i, "");
    if (clean === "" || ["hedef", "tl"].includes(norm(tok))) continue;
    const d = parseDate(clean, today);
    if (d) { dates.push(d); continue; }
    if (/^\d{1,3}(\.\d{3})*$|^\d+$/.test(clean)) {
      target = Number(clean.replace(/\./g, ""));
      continue;
    }
    places.push(tok);
  }
  return { places, dates, target, timeFrom, timeTo, timeError };
}

async function cmdTrack(env, chatId, args, ctx, implicit = false) {
  const today = todayTR();
  if (!args.length) return send(env, chatId, `Nereden nereye, hangi tarihler?\n\n${TRACK_USAGE}`);
  const { places, dates, target, timeFrom, timeTo, timeError } = parseTrackArgs(args, today);

  if (places.length !== 2 || dates.length < 1 || dates.length > 2) {
    return send(env, chatId, implicit ? "Anlayamadım 🤔 /yardim yazarak kullanımı görebilirsin." : `Eksik ya da hatalı bilgi.\n\n${TRACK_USAGE}`);
  }
  if (timeError) return send(env, chatId, timeError);
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
  if (count.n >= MAX_TRACKS_PER_USER) return send(env, chatId, `En fazla ${MAX_TRACKS_PER_USER} takip olabilir. /liste ile bakıp /iptal ile yer açabilirsin.`);

  await env.DB.prepare(
    `INSERT INTO tracks (chat_id, origin, dest, dep_ports, arr_ports, date_from, date_to, target, time_from, time_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(chatId, from.name, to.name, from.ports.join(","), to.ports.join(","), d1, d2, target, timeFrom, timeTo).run();

  ctx.waitUntil(dispatchCheck(env));

  const t = { origin: from.name, dest: to.name, date_from: d1, date_to: d2, time_from: timeFrom, time_to: timeTo };
  const mode = target
    ? `🎯 Fiyat <b>${fmtPrice(target)}</b> veya altına inerse haber vereceğim.`
    : "🔔 Fiyat her değiştiğinde haber vereceğim.";
  return send(env, chatId,
    `✅ Takip eklendi: <b>${trackTitle(t)}</b>\n📅 ${trackDates(t)}\n${mode}\n\n⏳ İlk fiyatlar 1-2 dakika içinde geliyor...\n<i>İptal için: /iptal</i>`);
}

async function userTracks(env, chatId) {
  const { results } = await env.DB.prepare("SELECT * FROM tracks WHERE chat_id = ? ORDER BY id").bind(chatId).all();
  return results;
}

// Takip listesi metni + her takip için ❌ butonu
async function listView(env, chatId, header = "📋 <b>Aktif takiplerin</b>", prefix = "") {
  const tracks = await userTracks(env, chatId);
  if (!tracks.length) {
    return { text: `${prefix}Şu an aktif takibin yok.\n\n${TRACK_USAGE}`, reply_markup: { inline_keyboard: [] } };
  }
  const lines = [prefix + header, ""];
  const buttons = [];
  for (const [i, t] of tracks.entries()) {
    const best = await env.DB.prepare(
      "SELECT * FROM track_prices WHERE track_id = ? AND price IS NOT NULL AND date >= ? ORDER BY price, date LIMIT 1",
    ).bind(t.id, todayTR()).first();
    lines.push(`<b>${i + 1}.</b> ${trackTitle(t)} · ${trackDates(t)}${t.target ? ` · 🎯 ${fmtPrice(t.target)}` : ""}`);
    lines.push(best ? `    En ucuz: <b>${fmtPrice(best.price)}</b> (${fmtDate(best.date)} ${best.time})` : "    Fiyat bekleniyor...");
    buttons.push([{ text: `❌ ${i + 1}. ${t.origin} → ${t.dest} (${fmtDate(t.date_from, false)})`, callback_data: `del:${t.id}` }]);
  }
  if (tracks.length > 1) buttons.push([{ text: "🗑 Hepsini iptal et", callback_data: "delall" }]);
  lines.push("", "İptal etmek için aşağıdaki ❌ butonuna bas ya da <code>/iptal numara</code> yaz.");
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: buttons } };
}

async function sendList(env, chatId, header) {
  const v = await listView(env, chatId, header);
  return send(env, chatId, v.text, { reply_markup: v.reply_markup });
}

async function deleteTrack(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM track_prices WHERE track_id = ?").bind(id),
    env.DB.prepare("DELETE FROM tracks WHERE id = ?").bind(id),
  ]);
}

async function cmdDelete(env, chatId, args) {
  const tracks = await userTracks(env, chatId);
  if (!tracks.length) return send(env, chatId, "İptal edilecek takip yok.");
  if (!args.length) return sendList(env, chatId, "Hangi takibi iptal edeyim? ❌ butonuna bas:");

  if (["hepsi", "tumu", "hepsini", "tum"].includes(norm(args[0]))) {
    for (const t of tracks) await deleteTrack(env, t.id);
    return send(env, chatId, `🗑 ${tracks.length} takibin hepsi iptal edildi.`);
  }

  const nums = [...new Set(args.flatMap((a) => a.split(/[,\s]+/)).map((a) => parseInt(a, 10)))];
  const bad = nums.filter((n) => !n || n < 1 || n > tracks.length);
  if (!nums.length || bad.length) {
    return sendList(env, chatId, `Bu numarada takip yok. Takiplerin 1-${tracks.length} arası numaralı:`);
  }
  const removed = nums.map((n) => tracks[n - 1]);
  for (const t of removed) await deleteTrack(env, t.id);
  return send(env, chatId, "🗑 İptal edildi:\n" + removed.map((t) => `• ${trackTitle(t)} · ${trackDates(t)}`).join("\n"));
}

// Liste mesajındaki ❌ butonları
async function handleButton(env, cq) {
  const chatId = cq.message?.chat?.id;
  const answer = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text });
  if (!chatId || cq.message.chat.type !== "private") return answer("");
  const user = await getUser(env, chatId, cq.from?.first_name || "");
  if (!(await isAllowed(env, user))) return answer("Erişimin yok");

  const refresh = async (header, prefix) => {
    const v = await listView(env, chatId, header, prefix);
    await tg(env, "editMessageText", {
      chat_id: chatId, message_id: cq.message.message_id, text: v.text, parse_mode: "HTML",
      link_preview_options: { is_disabled: true }, reply_markup: v.reply_markup,
    });
  };

  if (cq.data?.startsWith("del:")) {
    const id = Number(cq.data.slice(4));
    const t = await env.DB.prepare("SELECT * FROM tracks WHERE id = ? AND chat_id = ?").bind(id, chatId).first();
    if (!t) { await answer("Bu takip zaten yok"); return refresh(); }
    await deleteTrack(env, id);
    await answer(`İptal edildi: ${t.origin} → ${t.dest}`);
    return refresh("📋 <b>Kalan takiplerin</b>", `🗑 İptal edildi: ${trackTitle(t)} · ${trackDates(t)}\n\n`);
  }
  if (cq.data === "delall") {
    await answer("");
    return tg(env, "editMessageReplyMarkup", {
      chat_id: chatId, message_id: cq.message.message_id,
      reply_markup: { inline_keyboard: [[
        { text: "✅ Evet, hepsini iptal et", callback_data: "delall!" },
        { text: "↩️ Vazgeç", callback_data: "back" },
      ]] },
    });
  }
  if (cq.data === "delall!") {
    const tracks = await userTracks(env, chatId);
    for (const t of tracks) await deleteTrack(env, t.id);
    await answer(`${tracks.length} takip iptal edildi`);
    return refresh(undefined, `🗑 ${tracks.length} takibin hepsi iptal edildi.\n\n`);
  }
  await answer("");
  return refresh();
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
          if (!inWindow(f.time, t.time_from, t.time_to)) continue;
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
      ? `${fmtDate(d)} — ${t.time_from ? "bu saatlerde " : ""}satışta uçuş yok`
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
      lines.push(`❌ ${fmtDate(date)}: ${t.time_from ? "bu saatlerde " : ""}satışta uçuş kalmadı (önce ${fmtPrice(prev.price)})`);
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
  await setMeta(env, "last_run", JSON.stringify({
    at: new Date().toISOString(), ok, days: (body.results || []).length,
    seconds: body.seconds, errors: (body.errors || []).slice(0, 5),
  }));
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
      // Yeni sürümde webhook ayarları değiştiyse (ör. butonlar) ilk mesajda kendiliğinden güncelle
      if ((await getMeta(env, "webhook_v")) !== WEBHOOK_VERSION) ctx.waitUntil(configureWebhook(env, url.origin));
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
      const hook = await configureWebhook(env, url.origin, true);
      const gh = env.GH_TOKEN && env.GH_REPO ? "GitHub bağlantısı ayarlı" : "UYARI: GH_TOKEN / GH_REPO eksik";
      return new Response(`Telegram webhook: ${(await hook.json()).description}\n${gh}\n`);
    }

    return new Response("Pegasus Fiyat Takip çalışıyor ✈️", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(env));
  },
};
