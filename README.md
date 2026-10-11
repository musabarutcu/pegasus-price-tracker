# ✈️ Pegasus Fiyat Takip

Telegram botuna rota ve tarih aralığı yazıyorsun, bot ilk fiyatları hemen gönderiyor, sonra **30 dakikada bir** Pegasus'u kontrol edip **fiyat değişince** (ya da belirlediğin **hedef fiyatın altına inince**) haber veriyor. Tamamen ücretsiz ve 7/24 çalışır.

```
/takip istanbul izmir 20.11 25.11        → fiyat her değiştiğinde bildir
/takip izmir istanbul 23.11 1400         → sadece 1.400 TL ve altına inince bildir
/liste   /sil 2   /kontrol   /yardim
```

## Nasıl çalışıyor?

```
 Telegram ──► Cloudflare Worker (ücretsiz)  ──tetikler──►  GitHub Actions (ücretsiz)
   ▲           • komutları anında cevaplar                  • gerçek Chrome açar
   │           • takipleri D1 veritabanında tutar           • Pegasus fiyatlarını çeker
   │           • 30 dk'da bir kontrolü başlatır              │
   └─bildirim─ • fiyatları karşılaştırır  ◄───fiyatlar───────┘
```

Pegasus'un sitesi bot korumalı (Akamai); düz istekler engelleniyor. Bu yüzden fiyatlar GitHub'ın sunucusunda sanal ekranda açılan gerçek bir Chrome ile çekiliyor.

**Arkadaşların için kurulum yok:** Botun kullanıcı adını ve erişim kodunu ver, Telegram'da bota `/kod KOD` yazsınlar, o kadar.

---

## Kurulum (bir kere, ~15 dakika)

Gerekenler: GitHub hesabı, Cloudflare hesabı (ücretsiz, kredi kartı istemez), Telegram, bilgisayarda [Node.js](https://nodejs.org) ve Git.

### 1. Telegram botu oluştur
1. Telegram'da **@BotFather**'a `/newbot` yaz.
2. Bir isim ve sonu `bot` ile biten kullanıcı adı seç.
3. Verdiği **token**'ı bir kenara not et (kimseyle paylaşma).

### 2. GitHub deposunu oluştur ve kodu yükle
1. github.com → **New repository** → ad: `pegasus-fiyat-takip`, **Public** seç (public depolarda Actions dakikaları sınırsız ve ücretsiz; depoda hiçbir gizli bilgi yok), README ekleme → **Create**.
2. Bu klasörde terminal aç:
   ```bash
   git remote add origin https://github.com/KULLANICI_ADIN/pegasus-fiyat-takip.git
   git push -u origin main
   ```

### 3. GitHub token oluştur (Worker'ın kontrolü başlatabilmesi için)
1. github.com → sağ üst profil → **Settings** → en altta **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Ad: `pegasus-takip`, süre: istediğin kadar (en fazla 1 yıl; bitince yenilemen gerekir).
3. **Repository access** → *Only select repositories* → `pegasus-fiyat-takip`.
4. **Permissions** → Repository permissions → **Actions: Read and write**.
5. **Generate token** → `github_pat_...` ile başlayan token'ı not et.

### 4. Cloudflare hesabı aç
[dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) — ücretsiz plan yeterli.

### 5. Kurulum betiğini çalıştır
Bu klasörde PowerShell aç:
```powershell
powershell -ExecutionPolicy Bypass -File kurulum.ps1
```
Betik sırasıyla: Cloudflare'e giriş yaptırır (tarayıcı açılır), veritabanını oluşturur, Worker'ı yayınlar, senden GitHub depo adını, Telegram token'ını ve GitHub token'ını ister, Telegram'ı bağlar. Sonunda ekrana **WORKER_URL**, **API_SECRET** ve arkadaşlar için **erişim kodu** yazar.

### 6. GitHub'a iki gizli değişken ekle
Depo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Ad | Değer |
|---|---|
| `WORKER_URL` | betiğin yazdığı adres (`https://pegasus-takip....workers.dev`) |
| `API_SECRET` | betiğin yazdığı şifre |

### 7. Dene
1. Telegram'da botuna **`/start`** yaz — bota ilk yazan kişi admin olur (hata uyarıları sana gelir).
2. `/takip istanbul izmir 20.11 25.11` yaz.
3. 1-2 dakika içinde ilk fiyat listesi gelmeli. Gelmezse GitHub'da **Actions** sekmesinden "Fiyat kontrol" çalışmasının loguna bak.

---

## Kullanım

| Komut | Ne yapar |
|---|---|
| `/takip istanbul izmir 20.11 25.11` | 20-25 Kasım arası her gün için en ucuz fiyatı takip eder, değişince bildirir |
| `/takip izmir istanbul 23.11` | Tek gün |
| `/takip istanbul izmir 20.11 25.11 1400` | Sadece fiyat **1.400 TL veya altına** inince bildirir |
| `/liste` | Takiplerin ve şu anki en ucuz fiyatlar |
| `/sil 2` / `/sil hepsi` | Takip siler |
| `/kontrol` | Beklemeden hemen kontrol et |

- **İstanbul** = Sabiha Gökçen + İstanbul Havalimanı (ikisinin en ucuzu). Sadece biri için `saw` ya da `ist` yaz.
- Diğer şehirler: ankara, antalya, trabzon, bodrum, dalaman... ya da havalimanı kodu (ESB, AYT, TZX...).
- Tarih biçimleri: `20.11`, `20.11.2026`, `2026-11-20`. Komutsuz `istanbul izmir 20.11 25.11` yazmak da olur.
- Kişi başı en fazla 10 takip, her takip en fazla 31 gün. Tarihi geçen takipler otomatik silinir.
- Fiyatlar 1 yetişkin, en ucuz paket (Eco) içindir.

## Sorun giderme

- **İlk fiyatlar gelmiyor:** GitHub → Actions → son "Fiyat kontrol" çalışmasına bak. `403` hataları Pegasus'un GitHub sunucularını engellediği anlamına gelir (aşağıya bak).
- **Bot cevap vermiyor:** Tarayıcıda `WORKER_URL/setup?key=API_SECRET` adresini aç; Telegram bağlantısını yeniler.
- **3 kontrol üst üste başarısız olursa** admin'e (sana) Telegram'dan uyarı gelir.
- **GitHub token'ının süresi dolunca** yeni token oluşturup `cd worker` → `npx wrangler secret put GH_TOKEN` ile güncelle.

### Pegasus GitHub'ı engellerse: kendi bilgisayarında çalıştır
Worker ve bot aynen çalışmaya devam eder; sadece fiyat çekme işini bilgisayarın yapar (bilgisayar açıkken):
```powershell
cd checker
pip install -r requirements.txt
$env:WORKER_URL="https://pegasus-takip....workers.dev"; $env:API_SECRET="..."
python check.py --loop 30
```

## Dosyalar

- `worker/src/index.js` — Telegram botu, veritabanı, bildirim mantığı (Cloudflare Worker)
- `worker/schema.sql` — veritabanı tabloları
- `checker/scraper.py` — Pegasus fiyatlarını gerçek Chrome ile çeker
- `checker/check.py` — bir kontrol turu (Worker'dan işi al → fiyatları çek → sonucu gönder)
- `.github/workflows/check.yml` — GitHub Actions görevi
- `kurulum.ps1` — Cloudflare kurulum betiği

> Kişisel kullanım içindir. Pegasus sitesini değiştirirse fiyat çekme kısmının güncellenmesi gerekebilir.
