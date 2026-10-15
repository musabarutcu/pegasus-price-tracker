# Pegasus Fiyat Takip - Cloudflare kurulumu (Telegram botu + veritabanı)
# Çalıştırmak için: powershell -ExecutionPolicy Bypass -File kurulum.ps1
# Sonrasında fiyat çekici sunucuyu bağlamak için: bash sunucu/baglan.sh ubuntu@SUNUCU_IP

# wrangler bazen stderr'e uyarı yazar; PowerShell 5.1 bunu hata sanmasın diye "Continue"
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Join-Path $PSScriptRoot "worker")
$utf8 = New-Object System.Text.UTF8Encoding $false

function Adim($t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Cyan }

Adim "Bağımlılıklar kuruluyor"
npm install --silent
if ($LASTEXITCODE -ne 0) { throw "npm install başarısız" }

Adim "Cloudflare hesabı"
$who = (npx wrangler whoami 2>&1 | Out-String)
if ($who -match "not authenticated|You are not") {
    Write-Host "Tarayıcıda Cloudflare giriş sayfası açılacak, onaylayın."
    npx wrangler login
    if ($LASTEXITCODE -ne 0) { throw "Cloudflare girişi başarısız" }
} else {
    Write-Host "Giriş yapılmış."
}

Adim "Veritabanı (D1)"
$toml = Get-Content wrangler.toml -Raw -Encoding UTF8
$dbs = (npx wrangler d1 list --json 2>$null | Out-String) | ConvertFrom-Json
$db = $dbs | Where-Object { $_.name -eq "pegasus-takip" } | Select-Object -First 1
if (-not $db) {
    "n" | npx wrangler d1 create pegasus-takip --location eeur | Out-Host
    $dbs = (npx wrangler d1 list --json 2>$null | Out-String) | ConvertFrom-Json
    $db = $dbs | Where-Object { $_.name -eq "pegasus-takip" } | Select-Object -First 1
}
if (-not $db) { throw "D1 veritabanı oluşturulamadı" }
$toml = $toml -replace 'database_id = "[^"]*"', ('database_id = "' + $db.uuid + '"')
[System.IO.File]::WriteAllText((Join-Path (Get-Location) "wrangler.toml"), $toml, $utf8)
Write-Host "Veritabanı: $($db.uuid)"
npx wrangler d1 execute pegasus-takip --remote --file schema.sql -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Tablolar oluşturulamadı" }

Adim "Worker yayınlanıyor"
$deploy = (npx wrangler deploy 2>&1 | Out-String)
$url = [regex]::Match($deploy, 'https://[a-z0-9.-]+\.workers\.dev').Value
if (-not $url) { Write-Host $deploy; throw "Worker adresi bulunamadı (yukarıdaki çıktıya bakın)" }
Write-Host "Adres: $url"

Adim "Telegram bot token'ı"
# Token Not Defteri ile alınır (terminale yapıştırmak zor olabiliyor); dosya hemen silinir.
$form = Join-Path $env:TEMP "pegasus-tokenlar.txt"
$tgToken = ""; $hata = ""
while ($true) {
    $sablon = @(
        $hata
        "TELEGRAM= satirinin sonuna BotFather'in verdigi token'in TAMAMINI yapistir (Ctrl+V)."
        "Rakamlarla baslar ve icinde : vardir. Ornek bicim:  1234567890:AAH...uzun-yazi"
        "Sonra Ctrl+S ile KAYDET ve bu pencereyi X ile kapat."
        ""
        "TELEGRAM=$tgToken"
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($form, $sablon.TrimStart(), $utf8)
    Write-Host "Not Defteri açıldı: token'ı yapıştır, Ctrl+S ile kaydet, pencereyi kapat." -ForegroundColor Cyan
    Start-Process notepad.exe -ArgumentList ('"' + $form + '"') -Wait
    $tgToken = [regex]::Match([System.IO.File]::ReadAllText($form), '(?m)^\s*TELEGRAM\s*=[ \t]*([^\s]*)').Groups[1].Value
    if ($tgToken -match '^\d{5,}:[\w-]{30,}$') { break }
    $hata = "!!! DUZELTMEN GEREKEN: Telegram token'i bos ya da eksik (basinda rakamlar ve : olmali; Ctrl+S ile kaydetmeyi unutma).`r`n"
    Write-Host "Telegram token'ı hatalı görünüyor, tekrar dene." -ForegroundColor Red
}
[System.IO.File]::Delete($form)

$code = -join ((1..6) | ForEach-Object { "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[(Get-Random -Maximum 31)] })
$apiSecret = -join ((1..48) | ForEach-Object { "abcdef0123456789"[(Get-Random -Maximum 16)] })

$tmp = Join-Path $env:TEMP ("pegasus-takip-" + [guid]::NewGuid() + ".json")
try {
    $json = @{ TELEGRAM_TOKEN = $tgToken; ACCESS_CODE = $code; API_SECRET = $apiSecret } | ConvertTo-Json
    [System.IO.File]::WriteAllText($tmp, $json, $utf8)
    npx wrangler secret bulk $tmp | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Gizli bilgiler kaydedilemedi" }
} finally {
    if (Test-Path $tmp) { [System.IO.File]::Delete($tmp) }
}

Adim "Telegram bağlantısı"
Start-Sleep -Seconds 5
Write-Host (Invoke-RestMethod -Method Post -Uri "$url/setup" -Headers @{ Authorization = "Bearer $apiSecret" })

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " Bot hazır!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Arkadaşların için erişim kodu:  /kod $code" -ForegroundColor Yellow
Write-Host ""
Write-Host "Sıradaki adım: fiyat çekici sunucuyu bağla (README > Kurulum > 3. adım):"
Write-Host "  bash sunucu/baglan.sh ubuntu@SUNUCU_IP" -ForegroundColor Yellow
