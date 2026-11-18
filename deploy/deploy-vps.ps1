param(
    [Parameter(Mandatory = $true)]
    [string]$Domain,

    [Parameter(Mandatory = $true)]
    [string]$ServerIp,

    [string]$SshUser = "root",

    [string]$Email = ""
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Stage = Join-Path $env:TEMP ("brief-vps-deploy-" + [guid]::NewGuid().ToString("N"))

try {
    $StageDownloads = Join-Path $Stage "download-site\public\downloads"
    New-Item -ItemType Directory -Force -Path $StageDownloads | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Stage "assets") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Stage "dns") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Stage "nginx") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Stage "systemd") | Out-Null

    Write-Host "1/4 Building Brief-Setup.exe for https://$Domain/download/brief-package.zip ..."
    $env:BRIEF_DOWNLOAD_URL = "https://$Domain/download/brief-package.zip"
    $env:BRIEF_FALLBACK_DOWNLOAD_URL = "http://$Domain/download/brief-package.zip"
    $env:BRIEF_DOWNLOADS_DIR = $StageDownloads
    Push-Location $Root
    try {
        node scripts/build-installer.js
        if ($LASTEXITCODE -ne 0) { throw "build-installer.js failed" }
    }
    finally {
        Remove-Item Env:BRIEF_DOWNLOAD_URL -ErrorAction SilentlyContinue
        Remove-Item Env:BRIEF_FALLBACK_DOWNLOAD_URL -ErrorAction SilentlyContinue
        Remove-Item Env:BRIEF_DOWNLOADS_DIR -ErrorAction SilentlyContinue
        Pop-Location
    }

    Write-Host "2/4 Preparing standalone VPS bundle (direct SCP, no GitHub required)..."
    Copy-Item -Force (Join-Path $Root "download-site\server.js") (Join-Path $Stage "download-site\server.js")
    Copy-Item -Force (Join-Path $Root "download-site\public\index.html") (Join-Path $Stage "download-site\public\index.html")
    Copy-Item -Recurse -Force (Join-Path $Root "assets\*") (Join-Path $Stage "assets")

    $zoneText = (Get-Content (Join-Path $PSScriptRoot "db.brief-domain.zone") -Raw).
        Replace("<DOMAIN>", $Domain).
        Replace("<SERVER_IP>", $ServerIp).
        Replace("`r`n", "`n")
    [System.IO.File]::WriteAllText((Join-Path $Stage "dns\db.$Domain.zone"), $zoneText, (New-Object System.Text.UTF8Encoding($false)))

    $namedConfText = (Get-Content (Join-Path $PSScriptRoot "named.conf.brief") -Raw).
        Replace("<DOMAIN>", $Domain).
        Replace("`r`n", "`n")
    [System.IO.File]::WriteAllText((Join-Path $Stage "dns\named.conf.brief"), $namedConfText, (New-Object System.Text.UTF8Encoding($false)))

    $nginxText = (Get-Content (Join-Path $PSScriptRoot "nginx-brief.conf") -Raw).
        Replace("<DOMAIN>", $Domain).
        Replace("`r`n", "`n")
    [System.IO.File]::WriteAllText((Join-Path $Stage "nginx\brief.conf"), $nginxText, (New-Object System.Text.UTF8Encoding($false)))

    $svcText = (Get-Content (Join-Path $PSScriptRoot "brief-download.service") -Raw).Replace("`r`n", "`n")
    [System.IO.File]::WriteAllText((Join-Path $Stage "systemd\brief-download.service"), $svcText, (New-Object System.Text.UTF8Encoding($false)))

    $target = "$SshUser@$ServerIp"
    Write-Host "3/4 Uploading bundle directly to $target via SCP..."
    ssh $target "mkdir -p /opt/brief-download /etc/bind/zones /etc/nginx/sites-available /etc/nginx/sites-enabled"
    scp -r (Join-Path $Stage "download-site") (Join-Path $Stage "assets") "${target}:/opt/brief-download/"
    scp (Join-Path $Stage "dns\db.$Domain.zone") "${target}:/etc/bind/zones/db.$Domain.zone"
    scp (Join-Path $Stage "dns\named.conf.brief") "${target}:/etc/bind/named.conf.brief"
    scp (Join-Path $Stage "nginx\brief.conf") "${target}:/etc/nginx/sites-available/brief.conf"
    scp (Join-Path $Stage "systemd\brief-download.service") "${target}:/etc/systemd/system/brief-download.service"

    Write-Host "4/4 Configuring Node.js, BIND9 authoritative DNS, Nginx, and firewall..."
    $certEmailArg = if ($Email) { "--email `"$Email`"" } else { "--register-unsafely-without-email" }
    $remoteSetup = @"
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nodejs bind9 bind9utils nginx certbot python3-certbot-nginx
if ! grep -q "named.conf.brief" /etc/bind/named.conf.local; then
  echo 'include "/etc/bind/named.conf.brief";' >> /etc/bind/named.conf.local
fi
cat <<'BINDOPT' >/etc/bind/named.conf.options
options {
    directory "/var/cache/bind";
    recursion no;
    allow-query { any; };
    listen-on { any; };
    listen-on-v6 { any; };
    dnssec-validation auto;
};
BINDOPT
named-checkconf
named-checkzone "$Domain" "/etc/bind/zones/db.$Domain.zone"
ln -sf /etc/nginx/sites-available/brief.conf /etc/nginx/sites-enabled/brief.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp || true
  ufw allow 53/tcp || true
  ufw allow 53/udp || true
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
fi
systemctl daemon-reload
systemctl enable --now brief-download.service
systemctl restart bind9
systemctl restart nginx
echo "--- Server HTTP & DNS ready ---"
echo "If DNS already points to this server, issuing TLS certificate now..."
certbot --nginx --non-interactive --agree-tos $certEmailArg -d "$Domain" -d "www.$Domain" || echo "NOTE: Run certbot after registrar NS/glue propagation completes: certbot --nginx -d $Domain -d www.$Domain"
"@
    $remoteSetupUnix = $remoteSetup.Replace("`r`n", "`n")
    $remoteSetupUnix | ssh $target "bash -s"

    Write-Host ""
    Write-Host "DEPLOYED TO $Domain ($ServerIp)."
    Write-Host "Registrar DNS steps (one-time):"
    Write-Host "  1) Add Host / Glue records:  ns1.$Domain -> $ServerIp  and  ns2.$Domain -> $ServerIp"
    Write-Host "  2) Set custom Nameservers:   ns1.$Domain  and  ns2.$Domain"
    Write-Host "Then run on VPS if TLS wasn't issued yet:  certbot --nginx -d $Domain -d www.$Domain"
}
finally {
    if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue }
}
