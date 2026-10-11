# Pegasus Fiyat Takip - Cloudflare kurulumu
# Calistirmak icin: powershell -ExecutionPolicy Bypass -File kurulum.ps1

# wrangler bazen stderr'e uyarı yazar; PowerShell 5.1 bunu hata sanmasın diye "Continue"
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Join-Path $PSScriptRoot "worker")

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
Write-Host "Veritabanı: $($db.uuid)"
[System.IO.File]::WriteAllText((Join-Path (Get-Location) "wrangler.toml"), $toml, (New-Object System.Text.UTF8Encoding $false))
npx wrangler d1 execute pegasus-takip --remote --file schema.sql -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Tablolar oluşturulamadı" }

Adim "GitHub deposu"
$repo = Read-Host "GitHub deposu (ör. kullaniciadi/pegasus-price-tracker)"
$repo = $repo.Trim() -replace '^https://github.com/', '' -replace '\.git$', '' -replace '/$', ''
$toml = $toml -replace 'GH_REPO = "[^"]*"', ('GH_REPO = "' + $repo + '"')
[System.IO.File]::WriteAllText((Join-Path (Get-Location) "wrangler.toml"), $toml, (New-Object System.Text.UTF8Encoding $false))

Adim "Worker yayınlanıyor"
$deploy = (npx wrangler deploy 2>&1 | Out-String)
Write-Host $deploy
$url = [regex]::Match($deploy, 'https://[a-z0-9.-]+\.workers\.dev').Value
if (-not $url) { throw "Worker adresi bulunamadı (yukarıdaki çıktıya bakın)" }

Adim "Gizli bilgiler"
$tgToken = (Read-Host "Telegram bot token (BotFather'dan)").Trim()
$ghToken = (Read-Host "GitHub token (github_pat_...)").Trim()
$apiSecret = -join ((1..40) | ForEach-Object { "abcdefghijkmnpqrstuvwxyz23456789"[(Get-Random -Maximum 32)] })
$code = Read-Host "Arkadaşlarına vereceğin erişim kodu (boş bırakırsan rastgele üretilir)"
if (-not $code.Trim()) { $code = -join ((1..6) | ForEach-Object { "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[(Get-Random -Maximum 31)] }) }

$tmp = Join-Path $env:TEMP ("pegasus-takip-" + [guid]::NewGuid() + ".json")
try {
    @{ TELEGRAM_TOKEN = $tgToken; GH_TOKEN = $ghToken; API_SECRET = $apiSecret; ACCESS_CODE = $code.Trim() } |
        ConvertTo-Json | ForEach-Object { [System.IO.File]::WriteAllText($tmp, $_, (New-Object System.Text.UTF8Encoding $false)) }
    npx wrangler secret bulk $tmp | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Gizli bilgiler kaydedilemedi" }
} finally {
    Remove-Item $tmp -Force
}

Adim "Telegram bağlantısı"
Start-Sleep -Seconds 5
Write-Host (Invoke-RestMethod "$url/setup?key=$apiSecret")

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " Cloudflare tarafı hazır!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Şimdi GitHub'da depo > Settings > Secrets and variables > Actions >"
Write-Host "'New repository secret' ile şu ikisini ekle:"
Write-Host ""
Write-Host "  WORKER_URL  = $url" -ForegroundColor Yellow
Write-Host "  API_SECRET  = $apiSecret" -ForegroundColor Yellow
Write-Host ""
Write-Host "Arkadaşlarının bota ilk mesajda göndereceği kod:  /kod $code" -ForegroundColor Yellow
Write-Host ""
Write-Host "Sonra Telegram'da botuna /start yaz (ilk yazan sen ol, admin sen olursun)."
