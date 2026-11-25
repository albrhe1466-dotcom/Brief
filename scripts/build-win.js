'use strict';
/**
 * Locally — Packages a standalone Windows 11 desktop application (`LOCALLY.exe`)
 * into %LOCALAPPDATA%\Programs\LOCALLY, embeds the icon + Windows metadata with rcedit,
 * and creates Start Menu + Desktop shortcuts so typing `LOCALLY` in Windows Search opens it directly.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { rcedit } = require('rcedit');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const LOCAL_PROGRAMS = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs');
const STAGE_DIR = path.join(LOCAL_PROGRAMS, '_LOCALLY_STAGE');
const TARGET_DIR = path.join(LOCAL_PROGRAMS, 'LOCALLY');

async function main() {
  if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron.exe'))) {
    throw new Error('Electron dist binary not found. Run: node node_modules/electron/install.js');
  }

  // If Brief / LOCALLY is already installed, update its resources/app + Brief launcher & shortcuts in-place
  const existingAppDir = path.join(TARGET_DIR, 'resources', 'app');
  const existingExe = path.join(TARGET_DIR, 'LOCALLY.exe');
  const briefExe = path.join(TARGET_DIR, 'Brief.exe');
  if (fs.existsSync(existingAppDir) && (fs.existsSync(existingExe) || fs.existsSync(briefExe))) {
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(existingAppDir, 'package.json'));
    fs.copyFileSync(path.join(ROOT, 'app.html'), path.join(existingAppDir, 'app.html'));
    fs.cpSync(path.join(ROOT, 'src'), path.join(existingAppDir, 'src'), { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, 'assets'), path.join(existingAppDir, 'assets'), { recursive: true, force: true });
    const installedIco = path.join(TARGET_DIR, 'resources', 'app', 'assets', 'icon.ico');
    // Ensure a Brief.exe copy exists with Brief product metadata (skip cleanly if locked by a running instance)
    let launchExe = fs.existsSync(briefExe) ? briefExe : existingExe;
    if (!fs.existsSync(briefExe) && fs.existsSync(existingExe)) {
      try {
        fs.copyFileSync(existingExe, briefExe);
        launchExe = briefExe;
      } catch (_) { /* ignore */ }
    }
    try {
      await rcedit(launchExe, {
        icon: installedIco,
        'file-version': '2.0.4.0',
        'product-version': '2.0.4.0',
        'version-string': {
          ProductName: 'Brief',
          FileDescription: 'Brief — Private Windows Desktop AI Assistant',
          InternalName: 'Brief',
          OriginalFilename: 'Brief.exe',
          CompanyName: 'Brief Desktop',
          LegalCopyright: 'Copyright (c) 2026 Brief Desktop'
        }
      });
    } catch (_) { /* running exe locked — icon/metadata updated on next closed rebuild */ }
    const startDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const deskDir = path.join(os.homedir(), 'Desktop');
    const startMenuBrief = path.join(startDir, 'Brief.lnk');
    const desktopBrief = path.join(deskDir, 'Brief.lnk');
    for (const stale of [
      path.join(startDir, 'LOCALLY.lnk'),
      path.join(startDir, 'BRIEF.lnk'),
      path.join(deskDir, 'LOCALLY.lnk'),
      path.join(deskDir, 'BRIEF.lnk')
    ]) {
      try { if (fs.existsSync(stale)) fs.rmSync(stale, { force: true }); } catch (_) { /* ignore */ }
    }
    try {
      const ps = [
        '$sh = New-Object -ComObject WScript.Shell',
        `foreach ($lnk in @('${startMenuBrief.replace(/'/g, "''")}', '${desktopBrief.replace(/'/g, "''")}')) {`,
        '  $sc = $sh.CreateShortcut($lnk)',
        `  $sc.TargetPath = '${launchExe.replace(/'/g, "''")}'`,
        `  $sc.WorkingDirectory = '${TARGET_DIR.replace(/'/g, "''")}'`,
        `  $sc.IconLocation = '${installedIco.replace(/'/g, "''")},0'`,
        "  $sc.Description = 'Brief — Private Desktop AI Agent'",
        '  $sc.Save()',
        '}'
      ].join('\n');
      execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
    } catch (_) { /* ignore shortcut errors */ }
    console.log('SUCCESS: Updated installed Brief app bundle in-place at:', existingAppDir);
    return;
  }

  console.log('Building standalone Brief.exe...');
  fs.mkdirSync(LOCAL_PROGRAMS, { recursive: true });
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });

  // 1. Copy Electron runtime
  fs.cpSync(ELECTRON_DIST, STAGE_DIR, { recursive: true });

  // 2. Replace default_app.asar with Brief's app files
  const resourcesDir = path.join(STAGE_DIR, 'resources');
  const defaultAsar = path.join(resourcesDir, 'default_app.asar');
  if (fs.existsSync(defaultAsar)) fs.rmSync(defaultAsar, { force: true });

  const appDir = path.join(resourcesDir, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(appDir, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'app.html'), path.join(appDir, 'app.html'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(appDir, 'src'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'assets'), path.join(appDir, 'assets'), { recursive: true });

  // 3. Rename electron.exe -> Brief.exe and embed Windows icon + ProductName metadata
  const rawExe = path.join(STAGE_DIR, 'electron.exe');
  const finalStageExe = path.join(STAGE_DIR, 'Brief.exe');
  fs.renameSync(rawExe, finalStageExe);

  const icoPath = path.join(ROOT, 'assets', 'icon.ico');
  await rcedit(finalStageExe, {
    icon: icoPath,
    'version-string': {
      ProductName: 'Brief',
      FileDescription: 'Brief — Private Desktop AI Agent',
      InternalName: 'Brief',
      OriginalFilename: 'Brief.exe',
      CompanyName: 'Local Machine'
    }
  });

  // 4. Move staged build into final %LOCALAPPDATA%\Programs\LOCALLY folder
  fs.rmSync(TARGET_DIR, { recursive: true, force: true });
  fs.renameSync(STAGE_DIR, TARGET_DIR);

  const exePath = path.join(TARGET_DIR, 'Brief.exe');
  const installedIco = path.join(TARGET_DIR, 'resources', 'app', 'assets', 'icon.ico');
  if (!fs.existsSync(exePath)) {
    throw new Error('Expected executable missing: ' + exePath);
  }

  // 5. Create Windows 11 Start Menu & Desktop shortcuts so `Brief` appears in Windows Search
  const startMenuLink = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Brief.lnk'
  );
  const desktopLink = path.join(os.homedir(), 'Desktop', 'Brief.lnk');

  const psScript = [
    '$sh = New-Object -ComObject WScript.Shell',
    `foreach ($lnk in @('${startMenuLink.replace(/'/g, "''")}', '${desktopLink.replace(/'/g, "''")}')) {`,
    '  $dir = Split-Path -Parent $lnk',
    '  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }',
    '  $sc = $sh.CreateShortcut($lnk)',
    `  $sc.TargetPath = '${exePath.replace(/'/g, "''")}'`,
    `  $sc.WorkingDirectory = '${TARGET_DIR.replace(/'/g, "''")}'`,
    `  $sc.IconLocation = '${installedIco.replace(/'/g, "''")},0'`,
    "  $sc.Description = 'Brief — Private Desktop AI Agent'",
    '  $sc.Save()',
    '}'
  ].join('\n');

  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
    stdio: 'inherit',
    windowsHide: true
  });

  console.log('SUCCESS: Standalone Windows 11 app installed!');
  console.log('Executable:', exePath);
  console.log('Start Menu Shortcut:', startMenuLink);
  console.log('Desktop Shortcut:', desktopLink);
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
