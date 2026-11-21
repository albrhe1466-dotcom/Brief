'use strict';
/**
 * Brief — Universal Linux Packager for GitHub Releases:
 *  1) Brief-Linux-x64.deb         (Ubuntu, Debian, Kali Linux x64, Linux Mint, Parrot OS, Pop!_OS)
 *  2) Brief-Linux-arm64.deb       (Raspberry Pi OS 64-bit, Kali Linux ARM64 / Raspberry Pi, Ubuntu/Debian ARM64)
 *  3) Brief-Linux-x64.AppImage    (Universal single-file executable for any x64 Linux distro: Arch, Fedora, Kali, Ubuntu, openSUSE)
 *  4) Brief-Linux-x64.tar.gz      (Universal x64 portable bundle + auto-distro install.sh)
 *  5) Brief-Linux-arm64.tar.gz    (Universal ARM64 / Raspberry Pi portable bundle + auto-distro install.sh)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = String(PKG.version || '2.0.0').trim();
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const DOWNLOADS_DIR = process.env.BRIEF_DOWNLOADS_DIR
  ? path.resolve(process.env.BRIEF_DOWNLOADS_DIR)
  : path.join(ROOT, 'download-site', 'public', 'downloads');
const WORK_DIR = path.join(os.tmpdir(), 'brief-linux-build');

function hasCommand(cmd) {
  const res = spawnSync('which', [cmd], { stdio: 'ignore' });
  return res.status === 0;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(65536);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function copyAppPayload(appDir) {
  fs.mkdirSync(appDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(appDir, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'app.html'), path.join(appDir, 'app.html'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(appDir, 'src'), { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'assets'), path.join(appDir, 'assets'), { recursive: true, force: true });
}

function writeUniversalInstallScript(stageDir) {
  const installScript = `#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.local/opt/brief"
mkdir -p "$TARGET" "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/256x256/apps"

if ! command -v xdotool >/dev/null 2>&1; then
  echo "Installing xdotool for desktop control..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y xdotool || true
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm xdotool || true
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y xdotool || true
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper install -y xdotool || true
  elif command -v apk >/dev/null 2>&1; then
    sudo apk add xdotool || true
  fi
fi

rm -rf "$TARGET"
cp -a "$HERE" "$TARGET"
ln -sf "$TARGET/brief" "$HOME/.local/bin/brief"
cp "$TARGET/resources/app/assets/icon.png" "$HOME/.local/share/icons/hicolor/256x256/apps/brief.png"
cat > "$HOME/.local/share/applications/brief.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Brief
Comment=Private Local Desktop AI Agent for Linux (Kali, Raspberry Pi, Ubuntu, Debian, Arch)
Exec=/bin/bash -lc '"$HOME/.local/opt/brief/brief" %U'
Icon=brief
Terminal=false
Categories=Utility;Development;
StartupNotify=true
EOF
chmod +x "$HOME/.local/share/applications/brief.desktop"
echo "Installed Brief v${VERSION}! Launch it from your app menu or run: brief"
`;
  fs.writeFileSync(path.join(stageDir, 'install.sh'), installScript, 'utf8');
  fs.chmodSync(path.join(stageDir, 'install.sh'), 0o755);
}

function stagePortableBundle(stageDir, electronDir) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.cpSync(electronDir, stageDir, { recursive: true, force: true });

  const oldBin = path.join(stageDir, 'electron');
  const briefBin = path.join(stageDir, 'brief-bin');
  if (fs.existsSync(oldBin)) {
    fs.renameSync(oldBin, briefBin);
    fs.chmodSync(briefBin, 0o755);
  }

  copyAppPayload(path.join(stageDir, 'resources', 'app'));

  const launcher = `#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
export ELECTRON_DISABLE_SANDBOX=1
exec "$HERE/brief-bin" --no-sandbox --enable-transparent-visuals "$@"
`;
  fs.writeFileSync(path.join(stageDir, 'brief'), launcher, 'utf8');
  fs.chmodSync(path.join(stageDir, 'brief'), 0o755);
  writeUniversalInstallScript(stageDir);
}

function stageArm64PortableBundle(stageDir) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stageDir, 'resources'), { recursive: true });
  copyAppPayload(path.join(stageDir, 'resources', 'app'));

  const launcher = `#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
export ELECTRON_DISABLE_SANDBOX=1
if [ -x "$HERE/brief-bin" ]; then
  exec "$HERE/brief-bin" --no-sandbox --enable-transparent-visuals "$@"
elif command -v electron >/dev/null 2>&1; then
  exec electron --no-sandbox --enable-transparent-visuals "$HERE/resources/app" "$@"
elif [ -x "$HOME/.local/opt/brief-electron-arm64/electron" ]; then
  exec "$HOME/.local/opt/brief-electron-arm64/electron" --no-sandbox --enable-transparent-visuals "$HERE/resources/app" "$@"
else
  echo "Downloading Electron ARM64 runtime for Raspberry Pi / Kali ARM64..."
  mkdir -p "$HOME/.local/opt/brief-electron-arm64"
  EV="v33.2.1"
  curl -fsSL "https://github.com/electron/electron/releases/download/$EV/electron-$EV-linux-arm64.zip" -o /tmp/brief-el-arm64.zip
  unzip -q -o /tmp/brief-el-arm64.zip -d "$HOME/.local/opt/brief-electron-arm64"
  rm -f /tmp/brief-el-arm64.zip
  chmod +x "$HOME/.local/opt/brief-electron-arm64/electron"
  exec "$HOME/.local/opt/brief-electron-arm64/electron" --no-sandbox --enable-transparent-visuals "$HERE/resources/app" "$@"
fi
`;
  fs.writeFileSync(path.join(stageDir, 'brief'), launcher, 'utf8');
  fs.chmodSync(path.join(stageDir, 'brief'), 0o755);
  writeUniversalInstallScript(stageDir);
}

function buildTarGz(stageDir, outFile) {
  const parent = path.dirname(stageDir);
  const folder = path.basename(stageDir);
  execFileSync('tar', ['-czf', outFile, '-C', parent, folder], { stdio: 'inherit' });
}

function buildDebPackage(stageDir, outFile, debArch) {
  if (!hasCommand('dpkg-deb')) {
    console.log('SKIP: dpkg-deb not installed; skipping .deb build.');
    return false;
  }
  const debRoot = path.join(WORK_DIR, 'deb-root-' + debArch);
  fs.rmSync(debRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(debRoot, 'DEBIAN'), { recursive: true });
  fs.mkdirSync(path.join(debRoot, 'opt', 'brief'), { recursive: true });
  fs.mkdirSync(path.join(debRoot, 'usr', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(debRoot, 'usr', 'share', 'applications'), { recursive: true });
  fs.mkdirSync(path.join(debRoot, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps'), { recursive: true });

  fs.cpSync(stageDir, path.join(debRoot, 'opt', 'brief'), { recursive: true, force: true });
  if (fs.existsSync(path.join(debRoot, 'opt', 'brief', 'brief-bin'))) {
    fs.chmodSync(path.join(debRoot, 'opt', 'brief', 'brief-bin'), 0o755);
  }
  fs.chmodSync(path.join(debRoot, 'opt', 'brief', 'brief'), 0o755);

  const usrBin = `#!/usr/bin/env bash
exec /opt/brief/brief "$@"
`;
  fs.writeFileSync(path.join(debRoot, 'usr', 'bin', 'brief'), usrBin, 'utf8');
  fs.chmodSync(path.join(debRoot, 'usr', 'bin', 'brief'), 0o755);

  fs.copyFileSync(
    path.join(ROOT, 'assets', 'icon.png'),
    path.join(debRoot, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps', 'brief.png')
  );

  const desktopEntry = `[Desktop Entry]
Type=Application
Name=Brief
GenericName=Desktop AI Agent
Comment=Private Desktop AI Agent for Linux (Ubuntu, Debian, Kali Linux, Raspberry Pi OS)
Exec=/opt/brief/brief %U
Icon=brief
Terminal=false
Categories=Utility;Development;
StartupWMClass=LOCALLY
StartupNotify=true
`;
  fs.writeFileSync(path.join(debRoot, 'usr', 'share', 'applications', 'brief.desktop'), desktopEntry, 'utf8');

  const extraDeps = debArch === 'arm64' ? ', curl, unzip' : '';
  const control = `Package: brief-desktop
Version: ${VERSION}
Section: utils
Priority: optional
Architecture: ${debArch}
Maintainer: Brief Desktop <noreply@locally.app>
Depends: xdotool, xdg-utils, libgtk-3-0 | libgtk-3-0t64, libnss3, libxss1, libxtst6, libasound2 | libasound2t64${extraDeps}
Description: Brief — Private Linux Desktop AI Agent (Ubuntu, Kali, Debian, Raspberry Pi)
 Controls your Linux desktop cleanly with xdotool, screen capture,
 and Gemini, OpenAI, Claude, and OpenRouter AI models. Zero telemetry.
`;
  fs.writeFileSync(path.join(debRoot, 'DEBIAN', 'control'), control, 'utf8');

  const postinst = `#!/bin/sh
set -e
if [ -f /opt/brief/chrome-sandbox ]; then
  chown root:root /opt/brief/chrome-sandbox || true
  chmod 4755 /opt/brief/chrome-sandbox || true
fi
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
`;
  fs.writeFileSync(path.join(debRoot, 'DEBIAN', 'postinst'), postinst, 'utf8');
  fs.chmodSync(path.join(debRoot, 'DEBIAN', 'postinst'), 0o755);

  execFileSync('dpkg-deb', ['--root-owner-group', '--build', debRoot, outFile], { stdio: 'inherit' });
  return true;
}

function buildAppImageOrSelfExtracting(stageDir, tarFile, outFile) {
  const envTool = process.env.APPIMAGETOOL || '';
  const tool = (envTool && fs.existsSync(envTool) && fs.statSync(envTool).size > 0)
    ? envTool
    : (hasCommand('appimagetool') ? 'appimagetool' : '');

  if (tool) {
    try {
      const appDir = path.join(WORK_DIR, 'Brief.AppDir');
      fs.rmSync(appDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(appDir, 'usr', 'lib', 'brief'), { recursive: true });
      fs.cpSync(stageDir, path.join(appDir, 'usr', 'lib', 'brief'), { recursive: true, force: true });

      const appRun = `#!/usr/bin/env bash
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/usr/lib/brief/brief" "$@"
`;
      fs.writeFileSync(path.join(appDir, 'AppRun'), appRun, 'utf8');
      fs.chmodSync(path.join(appDir, 'AppRun'), 0o755);

      fs.copyFileSync(path.join(ROOT, 'assets', 'icon.png'), path.join(appDir, 'brief.png'));
      fs.copyFileSync(path.join(ROOT, 'assets', 'icon.png'), path.join(appDir, '.DirIcon'));

      const desktop = `[Desktop Entry]
Type=Application
Name=Brief
Comment=Private Linux Desktop AI Agent
Exec=AppRun
Icon=brief
Terminal=false
Categories=Utility;Development;
`;
      fs.writeFileSync(path.join(appDir, 'brief.desktop'), desktop, 'utf8');

      execFileSync(tool, ['--appimage-extract-and-run', appDir, outFile], {
        stdio: 'inherit',
        env: Object.assign({}, process.env, { ARCH: 'x86_64', APPIMAGE_EXTRACT_AND_RUN: '1' })
      });
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1024) {
        fs.chmodSync(outFile, 0o755);
        return true;
      }
    } catch (e) {
      console.warn('WARN: appimagetool failed (' + e.message + '), building FUSE-free self-extracting AppImage executable...');
    }
  }

  // Bulletproof FUSE-free self-extracting executable .AppImage (works on all Linux distros without libfuse2)
  const header = Buffer.from(`#!/usr/bin/env bash
set -euo pipefail
CACHE_DIR="\${XDG_CACHE_HOME:-$HOME/.cache}/brief-appimage-v${VERSION}"
if [ ! -x "$CACHE_DIR/Brief-Linux-x64/brief" ]; then
  mkdir -p "$CACHE_DIR"
  ARCHIVE_LINE=\$(awk '/^__BRIEF_TAR_PAYLOAD_BELOW__$/ {print NR + 1; exit 0; }' "\$0")
  tail -n +\$ARCHIVE_LINE "\$0" | tar -xz -C "$CACHE_DIR"
fi
exec "$CACHE_DIR/Brief-Linux-x64/brief" "\$@"
__BRIEF_TAR_PAYLOAD_BELOW__
`, 'utf8');
  const payload = fs.readFileSync(tarFile);
  fs.writeFileSync(outFile, Buffer.concat([header, payload]));
  fs.chmodSync(outFile, 0o755);
  return true;
}

function main() {
  if (process.platform !== 'linux') {
    throw new Error('scripts/build-linux.js must be run on Linux (e.g. GitHub Actions ubuntu-latest).');
  }
  if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron'))) {
    throw new Error('Linux Electron binary not found in node_modules/electron/dist/electron.');
  }

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  fs.rmSync(WORK_DIR, { recursive: true, force: true });

  const outputs = [];

  // 1. x64 Linux packages (Ubuntu, Debian, Kali x64, Arch, Fedora, Mint)
  const stageX64 = path.join(WORK_DIR, 'Brief-Linux-x64');
  stagePortableBundle(stageX64, ELECTRON_DIST);

  const tarX64 = path.join(DOWNLOADS_DIR, 'Brief-Linux-x64.tar.gz');
  buildTarGz(stageX64, tarX64);
  outputs.push(tarX64);

  const debX64 = path.join(DOWNLOADS_DIR, 'Brief-Linux-x64.deb');
  if (buildDebPackage(stageX64, debX64, 'amd64')) outputs.push(debX64);

  const appImgX64 = path.join(DOWNLOADS_DIR, 'Brief-Linux-x64.AppImage');
  if (buildAppImageOrSelfExtracting(stageX64, tarX64, appImgX64)) outputs.push(appImgX64);

  // 2. ARM64 Linux packages (Raspberry Pi OS 64-bit, Kali Linux ARM64 / Raspberry Pi, Ubuntu/Debian ARM64)
  const stageArm64 = path.join(WORK_DIR, 'Brief-Linux-arm64');
  stageArm64PortableBundle(stageArm64);

  const tarArm64 = path.join(DOWNLOADS_DIR, 'Brief-Linux-arm64.tar.gz');
  buildTarGz(stageArm64, tarArm64);
  outputs.push(tarArm64);

  const debArm64 = path.join(DOWNLOADS_DIR, 'Brief-Linux-arm64.deb');
  if (buildDebPackage(stageArm64, debArm64, 'arm64')) outputs.push(debArm64);

  console.log('SUCCESS: Built Brief Linux packages (v' + VERSION + '):');
  for (const f of outputs) {
    const st = fs.statSync(f);
    console.log('  ' + path.basename(f) + ' (' + (st.size / (1024 * 1024)).toFixed(2) + ' MB, sha256=' + sha256File(f).slice(0, 16) + '...)');
  }
}

main();
