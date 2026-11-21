'use strict';
/**
 * Brief — Linux x64 packager for GitHub Releases (.tar.gz, .deb, .AppImage).
 * Run on Linux (e.g. Ubuntu/Debian/GitHub Actions `ubuntu-latest`) where
 * `node_modules/electron/dist/electron` contains the Linux Electron runtime.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = String(PKG.version || '1.0.7').trim();
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

function stagePortableBundle(stageDir) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.cpSync(ELECTRON_DIST, stageDir, { recursive: true, force: true });

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
exec "$HERE/brief-bin" --no-sandbox "$@"
`;
  fs.writeFileSync(path.join(stageDir, 'brief'), launcher, 'utf8');
  fs.chmodSync(path.join(stageDir, 'brief'), 0o755);

  const installScript = `#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.local/opt/brief"
mkdir -p "$TARGET" "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/256x256/apps"
rm -rf "$TARGET"
cp -a "$HERE" "$TARGET"
ln -sf "$TARGET/brief" "$HOME/.local/bin/brief"
cp "$TARGET/resources/app/assets/icon.png" "$HOME/.local/share/icons/hicolor/256x256/apps/brief.png"
cat > "$HOME/.local/share/applications/brief.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Brief
Comment=Private Local Desktop AI Agent for Linux X11
Exec=/bin/bash -lc '"$HOME/.local/opt/brief/brief" %U'
Icon=brief
Terminal=false
Categories=Utility;Development;
StartupNotify=true
EOF
chmod +x "$HOME/.local/share/applications/brief.desktop"
echo "Installed Brief! Launch it from your app menu or run: brief"
`;
  fs.writeFileSync(path.join(stageDir, 'install.sh'), installScript, 'utf8');
  fs.chmodSync(path.join(stageDir, 'install.sh'), 0o755);
}

function buildTarGz(stageDir, outFile) {
  const parent = path.dirname(stageDir);
  const folder = path.basename(stageDir);
  execFileSync('tar', ['-czf', outFile, '-C', parent, folder], { stdio: 'inherit' });
}

function buildDebPackage(stageDir, outFile) {
  if (!hasCommand('dpkg-deb')) {
    console.log('SKIP: dpkg-deb not installed; skipping .deb build.');
    return false;
  }
  const debRoot = path.join(WORK_DIR, 'deb-root');
  fs.rmSync(debRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(debRoot, 'DEBIAN'), { recursive: true });
  fs.mkdirSync(path.join(debRoot, 'opt', 'brief'), { recursive: true });
  fs.mkdirSync(path.join(debRoot, 'usr', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(debRoot, 'usr', 'share', 'applications'), { recursive: true });
  fs.mkdirSync(path.join(debRoot, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps'), { recursive: true });

  fs.cpSync(stageDir, path.join(debRoot, 'opt', 'brief'), { recursive: true, force: true });
  fs.chmodSync(path.join(debRoot, 'opt', 'brief', 'brief-bin'), 0o755);
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
Comment=Private Desktop AI Agent with X11 Control and Custom Provider Cursors
Exec=/opt/brief/brief %U
Icon=brief
Terminal=false
Categories=Utility;Development;
StartupWMClass=LOCALLY
StartupNotify=true
`;
  fs.writeFileSync(path.join(debRoot, 'usr', 'share', 'applications', 'brief.desktop'), desktopEntry, 'utf8');

  const control = `Package: brief-desktop
Version: ${VERSION}
Section: utils
Priority: optional
Architecture: amd64
Maintainer: Brief Desktop <noreply@locally.app>
Depends: xdotool, xdg-utils, libgtk-3-0 | libgtk-3-0t64, libnss3, libxss1, libxtst6, libasound2 | libasound2t64
Description: Brief — Private Linux X11 Desktop AI Agent
 Controls your Linux X11 desktop cleanly with xdotool, screen capture,
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

function buildAppImage(stageDir, outFile) {
  const envTool = process.env.APPIMAGETOOL || '';
  const tool = (envTool && fs.existsSync(envTool) && fs.statSync(envTool).size > 0)
    ? envTool
    : (hasCommand('appimagetool') ? 'appimagetool' : '');
  if (!tool) {
    console.log('SKIP: appimagetool not found; skipping .AppImage build.');
    return false;
  }
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
Comment=Private Linux X11 Desktop AI Agent
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
  return true;
}

function main() {
  if (process.platform !== 'linux') {
    throw new Error('scripts/build-linux.js must be run on Linux (e.g. Ubuntu/GitHub Actions ubuntu-latest) where Linux Electron binaries are installed.');
  }
  if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron'))) {
    throw new Error('Linux Electron binary not found in node_modules/electron/dist/electron.');
  }

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  const stageDir = path.join(WORK_DIR, 'Brief-Linux-x64');
  stagePortableBundle(stageDir);

  const outputs = [];
  const tarOut = path.join(DOWNLOADS_DIR, 'Brief-Linux-x64.tar.gz');
  buildTarGz(stageDir, tarOut);
  outputs.push(tarOut);

  const debOut = path.join(DOWNLOADS_DIR, 'Brief-Linux-x64.deb');
  if (buildDebPackage(stageDir, debOut)) outputs.push(debOut);

  const appImgOut = path.join(DOWNLOADS_DIR, 'Brief-Linux-x64.AppImage');
  if (buildAppImage(stageDir, appImgOut)) outputs.push(appImgOut);

  console.log('SUCCESS: Built Brief Linux packages (v' + VERSION + '):');
  for (const f of outputs) {
    const st = fs.statSync(f);
    console.log('  ' + path.basename(f) + ' (' + (st.size / (1024 * 1024)).toFixed(1) + ' MB, sha256=' + sha256File(f).slice(0, 16) + '...)');
  }
}

main();
