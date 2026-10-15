# ✈️ Pegasus Fiyat Takip

Telegram botuna rota ve tarih aralığı yazıyorsun, bot ilk fiyatları **~1 dakikada** gönderiyor, sonra **30 dakikada bir** kontrol edip **fiyat değişince** (ya da belirlediğin **hedef fiyatın altına inince**) haber veriyor. Ücretsiz ve 7/24 çalışır.

```
/takip istanbul izmir 20.11 25.11        → fiyat her değiştiğinde bildir
/takip izmir istanbul 23.11 1400         → sadece 1.400 TL ve altına inince bildir
/takip istanbul izmir 20.11 saat 08-12   → sadece 08:00-12:00 arası kalkışlar
/liste   /iptal 2   /kontrol   /yardim
```

## Nasıl çalışıyor?

```
 Telegram ──► Cloudflare Worker (ücretsiz)        ◄──her dakika sorar──  Oracle sunucu (Always Free)
   ▲           • komutları anında cevaplar                                • obilet.com'dan Pegasus
   │           • takipleri D1 veritabanında tutar                           fiyatlarını çeker
   │           • "kontrol zamanı mı?" der (yeni takip / 30 dk)  ──işler──►  │
   └─bildirim─ • fiyatları karşılaştırır             ◄──fiyatlar──────────┘
```

**Fiyatlar neden obilet'ten?** Pegasus'un kendi sitesi Akamai bot korumasıyla bulut sunucularını (GitHub, Oracle...) tamamen engelliyor; sadece ev internetinden açılıyor. obilet ise Pegasus'tan canlı fiyat alıyor ve sunucudan erişilebiliyor. obilet her uçuş için **Pegasus'un kendi fiyatını** ayrıca veriyor (obilet hizmet bedeli hariç); test ettiğimizde Pegasus sitesindeki fiyatla birebir aynıydı. Bot da bu fiyatı gösterir.

**Arkadaşların için kurulum yok:** Botun kullanıcı adını ve erişim kodunu ver, Telegram'da bota `/kod KOD` yazsınlar, o kadar.

---

## Kurulum (bir kere)

Gerekenler: Cloudflare hesabı (ücretsiz), Oracle Cloud hesabı (Always Free; kart doğrulaması ister, ücret çekmez), Telegram, bilgisayarda [Node.js](https://nodejs.org), Git ve Git Bash.

### 1. Telegram botu oluştur
1. Telegram'da **@BotFather**'a `/newbot` yaz.
2. Bir isim ve sonu `bot` ile biten kullanıcı adı seç.
3. Verdiği **token**'ı kimseyle paylaşma; kurulum betiği Not Defteri açıp isteyecek.

### 2. Botu Cloudflare'e kur
Cloudflare hesabı aç ([dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)), sonra bu klasörde PowerShell'de:
```powershell
powershell -ExecutionPolicy Bypass -File kurulum.ps1
```
Betik Cloudflare'e giriş yaptırır, veritabanını oluşturur, botu yayınlar, Telegram token'ını Not Defteri ile ister ve Telegram'ı bağlar. Sonunda arkadaşlar için **erişim kodunu** yazar.

### 3. Fiyat çekici sunucuyu kur (Oracle Always Free)
1. Oracle Cloud'da bir sunucu aç: **Ubuntu 24.04**, şekil **VM.Standard.A1.Flex** (1 OCPU / 6 GB yeter), genel IP'li, SSH anahtarı olarak `~/.ssh/pegasus_oracle.pub` (yoksa `ssh-keygen -t ed25519 -f ~/.ssh/pegasus_oracle`).
   "Out of capacity" hatasında başka bir *Availability domain* dene. Genel IP verilmezse sunucu açılınca VNIC → *IP administration* → *Edit* → *Ephemeral public IP*.
2. Kodu sunucuya indir ve kur (Git Bash'te):
   ```bash
   ssh -i ~/.ssh/pegasus_oracle ubuntu@SUNUCU_IP "git clone https://github.com/KULLANICI_ADIN/pegasus-price-tracker.git pegasus-takip"
   bash sunucu/baglan.sh ubuntu@SUNUCU_IP
   ssh -i ~/.ssh/pegasus_oracle ubuntu@SUNUCU_IP "bash ~/pegasus-takip/sunucu/kur.sh"
   ```
   `baglan.sh` yeni bir ortak şifre üretip bota ve sunucuya yazar (ekrana basmaz). `kur.sh` her dakika çalışan zamanlayıcıyı kurar.

### 4. Dene
1. Telegram'da botuna **`/start`** yaz — bota ilk yazan kişi admin olur (hata uyarıları sana gelir).
2. `/takip istanbul izmir 20.11 25.11` yaz. ~1 dakika içinde ilk fiyat listesi gelir.
3. Sorun olursa bota **`/durum`** yaz (sadece admin): son kontrolün sonucunu ve hataları gösterir.

---

## Kullanım Kılavuzu

Aynı kılavuz botta da var: bota **`/yardim`** yaz.

### 1. Takip başlat
```
/takip istanbul izmir 20.11 25.11
```
20-25 Kasım arası her günün en ucuz uçuşunu takip eder. İlk fiyat listesi 1-2 dakikada gelir, sonra fiyat **her değiştiğinde** bildirim gelir.

Tek gün için tek tarih yaz: `/takip izmir istanbul 23.11`

### 2. Hedef fiyat
Sona bir sayı ekle:
```
/takip istanbul izmir 20.11 25.11 1400
```
Sadece fiyat **1.400 TL veya altına** inince bildirim gelir (altındayken daha da düşerse yine haber verir).

### 3. Saat aralığı
Sadece belli saatler arasında **kalkan** uçuşlara bakmak için. Saat aralığı girilince aralıktaki **her uçuş ayrı ayrı** takip edilir: ilk mesajda gün gün tüm uçuşlar listelenir, sonra herhangi bir uçuşun fiyatı değişince (ya da hedefin altına inince), yeni uçuş satışa açılınca veya bir uçuş satıştan kalkınca bildirim gelir. (Saat aralığı girilmezse her günün en ucuz uçuşu takip edilir.)
```
/takip istanbul izmir 20.11 25.11 saat 08-12
```

| Yazım | Anlamı |
|---|---|
| `saat 08-12` veya `08-12` | 08:00 - 12:00 arası kalkışlar |
| `08:30-11:00` | 08:30 - 11:00 arası |
| `saat 18 23` | 18:00 - 23:00 arası |
| `22-02` | gece yarısını aşan aralık: 22:00 - 02:00 |
| `sabah` | 06:00 - 12:00 |
| `öğle` | 12:00 - 17:00 |
| `akşam` | 17:00 - 24:00 |
| `gece` | 00:00 - 06:00 |

Hepsi bir arada: `/takip istanbul izmir 20.11 25.11 akşam 1500`

O gün seçilen saatlerde uçuş yoksa listede "bu saatlerde satışta uçuş yok" yazar.

### 4. Takiplerini gör
```
/liste
```
Aktif takiplerini numaralı olarak, şu anki en ucuz fiyatlarıyla gösterir. Her takibin altında **❌ iptal butonu** vardır.

### 5. Takip iptal et / çıkar

| Yazım | Ne yapar |
|---|---|
| `/iptal` | Takiplerini butonlarla listeler, ❌'ye basınca o takip çıkar |
| `/iptal 2` | 2 numaralı takibi çıkarır (numaralar `/liste`'de) |
| `/iptal 1 3` | Birden fazla takibi çıkarır |
| `/iptal hepsi` | Tüm takipleri çıkarır |
| `çıkar 2`, `sil 2`, `iptal 2` | Komutsuz yazım da olur |

Listede **🗑 Hepsini iptal et** butonu da var (yanlışlıkla basmaya karşı onay sorar).

### 6. Diğer komutlar

| Komut | Ne yapar |
|---|---|
| `/kontrol` | 30 dakikayı beklemeden şimdi kontrol et |
| `/yardim` | Kullanım kılavuzu |
| `/kod KOD` | Erişim kodu (arkadaşların ilk mesajda bunu yazar) |

### Bilmen gerekenler
- **İstanbul** = Sabiha Gökçen + İstanbul Havalimanı (ikisinin en ucuzu). Sadece biri için `saw` ya da `ist` yaz.
- Diğer şehirler: ankara, antalya, trabzon, bodrum, dalaman, kayseri... ya da havalimanı kodu (ESB, AYT, TZX...).
- Tarih biçimleri: `20.11`, `20.11.2026`, `2026-11-20`. Komutsuz `istanbul izmir 20.11 25.11` yazmak da olur.
- Kişi başı en fazla 10 takip, her takip en fazla 31 gün. Tarihi geçen takipler kendiliğinden biter (bildirim gelir).
- Fiyatlar 1 yetişkin, en ucuz paket (Eco) içindir.

## Sorun giderme

- **`/durum`** (sadece admin): son kontrol zamanı, sonucu ve varsa hatalar.
- **Sunucu logları:** `ssh -i ~/.ssh/pegasus_oracle ubuntu@SUNUCU_IP "journalctl -u pegasus-takip -n 50 -o cat"`
- **3 kontrol üst üste başarısız olursa** ya da **sunucu 15 dakika bota bağlanmazsa** admin'e Telegram'dan uyarı gelir.
- **Bot cevap vermiyor:** `bash sunucu/baglan.sh ubuntu@SUNUCU_IP` Telegram bağlantısını ve sunucu şifresini yeniler.
- **Kodu güncelledikten sonra:** `cd worker && npx wrangler deploy` (bot) ve sunucuda `git -C ~/pegasus-takip pull` (çekici).

### Pegasus'un kendi sitesinden çekmek (sadece ev internetinde)
`checker/scraper.py` Pegasus sitesini gerçek Chrome ile okur; ev internetinde çalışır, bulut sunucularda Akamai engeller. Kendi bilgisayarında denemek için:
```powershell
cd checker
pip install curl_cffi patchright
$env:SOURCE="pegasus"; $env:WORKER_URL="https://pegasus-takip....workers.dev"; $env:API_SECRET="..."
python check.py --loop 1
```

## Dosyalar

- `worker/src/index.js` — Telegram botu, veritabanı, bildirim mantığı (Cloudflare Worker)
- `worker/schema.sql`, `worker/migrations/` — veritabanı tabloları
- `checker/obilet.py` — Pegasus fiyatlarını obilet'ten çeker (varsayılan kaynak)
- `checker/scraper.py` — Pegasus sitesinden gerçek Chrome ile çeker (sadece ev internetinde)
- `checker/check.py` — bir kontrol turu (Worker'a sor → fiyatları çek → sonucu gönder)
- `sunucu/` — Oracle sunucu kurulumu: systemd servis + zamanlayıcı, `kur.sh`, `baglan.sh`
- `kurulum.ps1` — Cloudflare kurulum betiği

> Kişisel kullanım içindir. obilet ya da Pegasus sitelerini değiştirirse fiyat çekme kısmının güncellenmesi gerekebilir.
