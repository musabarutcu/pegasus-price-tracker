# Pegasus Fiyat Takip - token'ları Worker'a kaydeder (Worker yayınlandıktan sonra)
# Çalıştırmak için: powershell -ExecutionPolicy Bypass -File tokenlar.ps1

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Join-Path $PSScriptRoot "worker")

$url = "https://pegasus-takip.pegasus-takip-worker.workers.dev"

# Token'lar Not Defteri ile alınır (terminale yapıştırmak zor olabiliyor); dosya hemen silinir.
$form = Join-Path $env:TEMP "pegasus-tokenlar.txt"
$utf8 = New-Object System.Text.UTF8Encoding $false
$tgToken = ""; $ghToken = ""; $hata = ""

while ($true) {
    $sablon = @(
        $hata
        "1) TELEGRAM= satirinin sonuna BotFather'in verdigi token'in TAMAMINI yapistir (Ctrl+V)."
        "   Rakamlarla baslar ve icinde : vardir. Ornek bicim:  1234567890:AAH...uzun-yazi"
        "2) GITHUB= satirinin sonuna github_pat_ ile baslayan token'i yapistir (Ctrl+V)."
        "3) Ctrl+S ile KAYDET, sonra bu pencereyi X ile kapat."
        ""
        "TELEGRAM=$tgToken"
        "GITHUB=$ghToken"
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($form, $sablon.TrimStart(), $utf8)

    Write-Host ""
    Write-Host "Not Defteri açıldı: token'ları yapıştır, Ctrl+S ile kaydet, pencereyi kapat." -ForegroundColor Cyan
    Start-Process notepad.exe -ArgumentList ('"' + $form + '"') -Wait

    $icerik = [System.IO.File]::ReadAllText($form)
    $tgToken = [regex]::Match($icerik, '(?m)^\s*TELEGRAM\s*=[ \t]*([^\s]*)').Groups[1].Value
    $ghToken = [regex]::Match($icerik, '(?m)^\s*GITHUB\s*=[ \t]*([^\s]*)').Groups[1].Value

    $tgOk = $tgToken -match '^\d{5,}:[\w-]{30,}$'
    $ghOk = $ghToken -match '^(github_pat_|ghp_)\w{20,}$'
    if ($tgOk -and $ghOk) { break }

    $sorunlar = @()
    if (-not $tgToken) { $sorunlar += "Telegram token'i bos (yapistirdiktan sonra Ctrl+S ile kaydetmeyi unutma)." }
    elseif (-not $tgOk) { $sorunlar += "Telegram token'i eksik: basinda rakamlar ve : olmali (BotFather mesajindaki satirin tamami)." }
    if (-not $ghToken) { $sorunlar += "GitHub token'i bos." }
    elseif (-not $ghOk) { $sorunlar += "GitHub token'i github_pat_ ile baslamali." }
    $hata = "!!! DUZELTMEN GEREKEN: " + ($sorunlar -join " ") + "`r`n"
    Write-Host ($sorunlar -join "`n") -ForegroundColor Red
}
[System.IO.File]::Delete($form)

$apiSecret = -join ((1..40) | ForEach-Object { "abcdefghijkmnpqrstuvwxyz23456789"[(Get-Random -Maximum 32)] })
$code = -join ((1..6) | ForEach-Object { "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[(Get-Random -Maximum 31)] })

$tmp = Join-Path $env:TEMP ("pegasus-takip-" + [guid]::NewGuid() + ".json")
try {
    $json = @{ TELEGRAM_TOKEN = $tgToken; GH_TOKEN = $ghToken; API_SECRET = $apiSecret; ACCESS_CODE = $code } | ConvertTo-Json
    [System.IO.File]::WriteAllText($tmp, $json, $utf8)
    Write-Host ""
    Write-Host "Kaydediliyor..."
    npx wrangler secret bulk $tmp | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Token'lar kaydedilemedi" }
} finally {
    if (Test-Path $tmp) { [System.IO.File]::Delete($tmp) }
}

Start-Sleep -Seconds 5
Write-Host (Invoke-RestMethod "$url/setup?key=$apiSecret")

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " Hazır! GitHub'a eklenecek iki değer:" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  WORKER_URL  =  $url" -ForegroundColor Yellow
Write-Host "  API_SECRET  =  $apiSecret" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Arkadaşların için erişim kodu:  /kod $code" -ForegroundColor Yellow
Write-Host ""
