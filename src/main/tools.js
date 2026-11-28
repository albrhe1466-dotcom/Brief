'use strict';
/**
 * Locally - the agent's real tools.
 *
 * Every tool here acts on the real machine: the mouse/keyboard tools drive the OS input backend,
 * the file tools use Node's fs on your real disk, and run_command spawns a real shell.
 * Nothing is simulated.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { app, shell, clipboard } = require('electron');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* Strictly wholesome watching + snack emojis for cursor waiting pill (zero inappropriate emojis). */
const WATCH_SNACK_EMOJIS = [
  '👀🍿',
  '👀🍕',
  '👀☕',
  '👀🍪',
  '👀🍩',
  '👀🍔',
  '👀🍟',
  '👀🧃',
  '👀🥨',
  '👀🍵'
];

function pickWatchEmoji(tick = 0) {
  const idx = Math.abs(Math.floor(Number(tick) || 0)) % WATCH_SNACK_EMOJIS.length;
  return WATCH_SNACK_EMOJIS[idx];
}

function formatWatchElapsed(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) return hrs + 'h ' + String(mins).padStart(2, '0') + 'm';
  if (mins > 0) return mins + 'm ' + String(secs).padStart(2, '0') + 's';
  return secs + 's';
}

const DEFAULT_LOADING_RE = /\b(loading|reading|thinking|thought\s+for|analyzing|searching|exploring|inspecting|planning|editing|flashing|validating|verifying|generating|rendering|downloading|uploading|installing|uninstalling|extracting|decompressing|compiling|building|bundling|packaging|writing|formatting|copying|transferring|syncing|initializing|starting|processing|working|waiting|please\s+wait|in\s+progress|almost\s+there|remaining|eta\b|queued|preparing|finishing|checking\s+updates|stop\s+generating|running\s+command)\b|\b(?:[1-9]?\d(?:\.\d+)?)\s*%/i;
const DEFAULT_PERMISSION_RE = /\b(allow\s+once|allow\s+always|allow\s+this|accept\s+all|approve|permission\s+required|wants?\s+to\s+(?:access|run|open|edit|read|write|execute|use)|do\s+you\s+want\s+to\s+allow|user\s+account\s+control|grant\s+(?:access|permission)|yes,\s*proceed|run\s+command\?|open\s+folder\?|trust\s+(?:this|the)\s+(?:folder|workspace|authors?)|\[y\/n\]|\(y\/n\)|press\s+any\s+key|click\s+allow|ask\s+for\s+permission)\b/i;
const DEFAULT_ERROR_RE = /\b(error:|failed|failure|denied|access\s+is\s+denied|permission\s+denied|rejected|unable\s+to|could\s+not|cannot|exception|crashed|fatal|abort(?:ed)?|checksum\s+mismatch|validation\s+failed|flash\s+failed|something\s+went\s+wrong|corrupt(?:ed)?|not\s+enough\s+space|device\s+not\s+found|timed?\s*out|try\s+again|retry)\b/i;
const DEFAULT_DONE_RE = /\b(flash\s+complete|completed?\s+successfully|finished\s+successfully|all\s+done|100%\s*(?:complete|done|finished)|successfully\s+(?:installed|flashed|generated|rendered|built|downloaded|completed|created|verified)|ready\s+to\s+download|video\s+ready|export\s+complete|build\s+succeeded|done!)\b/i;

function analyzeWatchText(rawText, doneKeywords, errorKeywords) {
  const txt = String(rawText || '').replace(/\s+/g, ' ').trim();
  const low = txt.toLowerCase();
  const findCustom = (list) => {
    if (!Array.isArray(list)) return '';
    for (const kw of list) {
      const k = String(kw || '').trim();
      if (k && low.includes(k.toLowerCase())) return k;
    }
    return '';
  };
  const permM = DEFAULT_PERMISSION_RE.exec(txt);
  const customErr = findCustom(errorKeywords);
  const errM = customErr ? [customErr] : DEFAULT_ERROR_RE.exec(txt);
  const customDone = findCustom(doneKeywords);
  const doneM = customDone ? [customDone] : DEFAULT_DONE_RE.exec(txt);

  // Detect active percentage strictly < 100% OR active loading/reading/thinking/flashing/validating/generating words
  let loadingHit = '';
  const pctRe = /\b(\d{1,3})(?:\.\d+)?\s*%/g;
  let pm;
  while ((pm = pctRe.exec(txt))) {
    const val = Number(pm[1]);
    if (val >= 0 && val < 100) { loadingHit = pm[0]; break; }
  }
  if (!loadingHit) {
    const lm = /\b(loading|reading|thinking|thought\s+for|analyzing|searching|exploring|inspecting|planning|editing|flashing|validating|verifying|generating|rendering|downloading|uploading|installing|extracting|decompressing|compiling|building|writing|formatting|copying|transferring|syncing|initializing|processing|please\s+wait|in\s+progress|remaining|eta\b|queued|preparing|stop\s+generating|running\s+command|working\.\.\.|thinking\.\.\.)\b/i.exec(txt);
    if (lm) loadingHit = lm[0];
  }

  // Critical: if screen says "Validating...", "Flashing 99%", "Reading...", "Thinking...", or "Rendering...", NEVER treat as done yet!
  const stillActivePhase = /\b(reading|thinking|analyzing|searching|flashing|validating|verifying|generating|rendering|downloading|installing|extracting|decompressing|compiling|building|writing|formatting|copying|please\s+wait|in\s+progress|loading|remaining|stop\s+generating)\b/i.test(txt);
  const isDone = !!doneM && (!stillActivePhase || (!!customDone && !/\b(validating|flashing|rendering|generating|reading|thinking)\b/i.test(loadingHit)));

  return {
    isLoading: !!loadingHit,
    loadingHit,
    hasPermissionPrompt: !!permM,
    permissionHit: permM ? String(permM[0]) : '',
    hasError: !!errM,
    errorHit: errM ? String(errM[0]) : '',
    isDone,
    doneHit: doneM ? String(doneM[0]) : ''
  };
}

function quickShotDiffPct(shotA, shotB) {
  try {
    if (!shotA || !shotB || !shotA.base64 || !shotB.base64) return null;
    if (shotA.base64 === shotB.base64) return 0;
    const { nativeImage } = require('electron');
    if (!nativeImage) return null;
    const a = nativeImage.createFromBuffer(Buffer.from(shotA.base64, 'base64')).resize({ width: 48, height: 27 }).toBitmap();
    const b = nativeImage.createFromBuffer(Buffer.from(shotB.base64, 'base64')).resize({ width: 48, height: 27 }).toBitmap();
    if (!a.length || a.length !== b.length) return null;
    let changed = 0;
    const px = Math.floor(a.length / 4);
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 26) changed++;
    }
    return px ? Number(((changed / px) * 100).toFixed(1)) : null;
  } catch (_) {
    return null;
  }
}

async function sampleForegroundTextForWatch(ctx) {
  const chunks = [];
  try {
    if (ctx && ctx.automation) {
      const disp = (ctx.screen && typeof ctx.screen.currentDisplay === 'function') ? ctx.screen.currentDisplay() : null;
      const b = (disp && disp.bounds) || { x: 0, y: 0, width: 1920, height: 1080 };
      const sf = (disp && disp.scaleFactor) || 1;
      const [fg, uiEls, ocr] = await Promise.all([
        typeof ctx.automation.foreground === 'function' ? Promise.race([ctx.automation.foreground().catch(() => null), sleep(450).then(() => null)]) : Promise.resolve(null),
        typeof ctx.automation.inspectUi === 'function' ? Promise.race([ctx.automation.inspectUi(95).catch(() => []), sleep(850).then(() => [])]) : Promise.resolve([]),
        typeof ctx.automation.ocrScreen === 'function' ? Promise.race([ctx.automation.ocrScreen(Math.round(b.x * sf), Math.round(b.y * sf), Math.round(b.width * sf), Math.round(b.height * sf)).catch(() => null), sleep(1400).then(() => null)]) : Promise.resolve(null)
      ]);
      if (fg && fg.title) chunks.push('WINDOW: ' + fg.title);
      if (Array.isArray(uiEls)) {
        for (const el of uiEls.slice(0, 80)) {
          const nm = String((el && (el.name || el.value)) || '').trim();
          if (nm.length >= 2) chunks.push(nm);
        }
      }
      if (ocr && Array.isArray(ocr.lines)) {
        for (const ln of ocr.lines.slice(0, 140)) {
          const t = String((ln && ln.text) || '').trim();
          if (t.length >= 2) chunks.push(t);
        }
      }
    }
  } catch (_) { /* ignore */ }
  return chunks.join(' | ').slice(0, 12000);
}

function getRunningTerminalSessions() {
  const out = [];
  for (const s of TERMINAL_SESSIONS.values()) {
    if (s && s.running) {
      out.push({
        id: s.id,
        shell: s.shell,
        command: s.lastCommand || '',
        interactive: !!s.interactive,
        startedAt: s.startedAt || 0,
        tail: String(s.output || '').slice(-1200)
      });
    }
  }
  return out;
}

function knownFolders() {
  const safe = (n) => { try { return app.getPath(n); } catch (_) { return null; } };
  return {
    home: os.homedir(),
    documents: safe('documents'),
    desktop: safe('desktop'),
    downloads: safe('downloads'),
    pictures: safe('pictures'),
    music: safe('music'),
    videos: safe('videos'),
    temp: os.tmpdir()
  };
}

const FOLDER_WORDS = {
  'home': 'home', '~': 'home', 'my home': 'home', 'user folder': 'home', 'profile': 'home',
  'documents': 'documents', 'my documents': 'documents', 'docs': 'documents', 'document': 'documents',
  'desktop': 'desktop', 'my desktop': 'desktop',
  'downloads': 'downloads', 'download': 'downloads', 'my downloads': 'downloads',
  'pictures': 'pictures', 'my pictures': 'pictures', 'photos': 'pictures', 'images': 'pictures',
  'music': 'music', 'my music': 'music', 'videos': 'videos', 'my videos': 'videos', 'movies': 'videos',
  'temp': 'temp', 'tmp': 'temp'
};

function expandEnv(p) {
  let s = p;
  s = s.replace(/%([^%]+)%/g, (m, name) => (process.env[name] !== undefined ? process.env[name] : m));
  s = s.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => (process.env[name] !== undefined ? process.env[name] : m));
  s = s.replace(/\$HOME\b/g, os.homedir());
  s = s.replace(/\$\{?USERPROFILE\}?/g, process.env.USERPROFILE || os.homedir());
  return s;
}

/** Resolves user-friendly paths ("Documents/invoices", "~/x", "%USERPROFILE%\\Desktop") to absolute paths. */
function resolvePath(input) {
  if (input === undefined || input === null || String(input).trim() === '') throw new Error('A path is required.');
  let p = String(input).trim().replace(/^["']|["']$/g, '');
  p = expandEnv(p);
  const kf = knownFolders();
  if (p === '~') return kf.home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.resolve(kf.home, p.slice(2));
  if (!path.isAbsolute(p)) {
    const norm = p.replace(/\\/g, '/');
    const first = norm.split('/')[0].toLowerCase();
    const whole = norm.toLowerCase().replace(/\/+$/, '');
    if (FOLDER_WORDS[whole] && kf[FOLDER_WORDS[whole]]) return kf[FOLDER_WORDS[whole]];
    if (FOLDER_WORDS[first] && kf[FOLDER_WORDS[first]]) return path.resolve(kf[FOLDER_WORDS[first]], norm.split('/').slice(1).join(path.sep));
    return path.resolve(kf.home, p);
  }
  return path.resolve(p);
}

function fmtSize(n) {
  if (n === undefined || n === null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
}

function truncateMiddle(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + '\n…[' + (s.length - max) + ' characters omitted]…\n' + s.slice(-half);
}

async function exists(p) { try { await fsp.access(p); return true; } catch (_) { return false; } }

async function uniquePath(target) {
  if (!(await exists(target))) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 10000; i++) {
    const c = path.join(dir, base + ' (' + i + ')' + ext);
    if (!(await exists(c))) return c;
  }
  throw new Error('Could not find a free name for ' + target);
}

async function movePath(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    if (e.code === 'EXDEV') {
      await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false });
      await fsp.rm(src, { recursive: true, force: true });
    } else throw e;
  }
}

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.bat', '.cmd', '.ps1', '.psm1', '.ini', '.cfg', '.conf', '.yaml', '.yml',
  '.toml', '.log', '.sql', '.lua', '.luau', '.kt', '.swift', '.vue', '.svelte', '.env', '.gitignore', '.rtf', '.tex', '.r', '.m', '.dart', '.scss', '.less']);

const CATEGORIES = {
  Images: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.tif', '.tiff', '.svg', '.ico', '.raw', '.psd'],
  Videos: ['.mp4', '.mkv', '.mov', '.avi', '.wmv', '.webm', '.flv', '.m4v'],
  Audio: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma'],
  Documents: ['.pdf', '.doc', '.docx', '.odt', '.rtf', '.txt', '.md', '.pages', '.tex'],
  Spreadsheets: ['.xls', '.xlsx', '.ods', '.csv', '.tsv', '.numbers'],
  Presentations: ['.ppt', '.pptx', '.odp', '.key'],
  Archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso'],
  Code: ['.js', '.ts', '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rs', '.rb', '.php', '.html', '.css', '.json', '.xml', '.sh', '.ps1', '.bat', '.lua', '.luau', '.sql', '.yml', '.yaml'],
  Installers: ['.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.appx', '.msix'],
  Fonts: ['.ttf', '.otf', '.woff', '.woff2'],
  Shortcuts: ['.lnk', '.url']
};

function categoryOf(file) {
  const ext = path.extname(file).toLowerCase();
  for (const [cat, list] of Object.entries(CATEGORIES)) if (list.includes(ext)) return cat;
  return 'Other';
}

const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', '.cache', '__pycache__', '.venv', 'venv', '.gradle', '.idea', '.vs', 'windowsapps']);

function makeMatcher(query) {
  const q = String(query || '').trim();
  if (!q) return () => true;
  const alts = q.split('|').map((s) => s.trim()).filter(Boolean);
  const tests = alts.map((a) => {
    if (/[*?]/.test(a)) {
      const re = new RegExp('^' + a.replace(/[.+^${}()[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      return (name) => re.test(name);
    }
    const lower = a.toLowerCase();
    return (name) => name.toLowerCase().includes(lower);
  });
  return (name) => tests.some((t) => t(name));
}

/* ------------------------------------------------------------------ */
/* dangerous-command detection                                          */
/* ------------------------------------------------------------------ */

const DELETE_PATTERNS = [
  /\bremove-item\b/i, /(^|[\s;&|(])ri\s/i, /(^|[\s;&|(])(rm|rmdir|rd|del|erase)(\s|$)/i, /\bclear-recyclebin\b/i,
  /\bformat-volume\b/i, /(^|\s)format\s+[a-z]:/i, /\bcipher\s+\/w/i, /\bdiskpart\b/i, /\bsdelete\b/i, /\bshred\b/i,
  /\bclear-content\b/i, /\[io\.file\]::delete/i, /\[system\.io\.directory\]::delete/i, /\bunlink\b/i, /\brimraf\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i, /\bgit\s+reset\s+--hard\b/i, /\breg\s+delete\b/i, /\bmkfs\b/i, /\bdd\s+if=/i
];

function isProtectedRootPath(p) {
  const norm = path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  const root = path.parse(path.resolve(p)).root.toLowerCase().replace(/[\\/]+$/, '');
  if (norm === root) return true;
  const kf = knownFolders();
  for (const val of Object.values(kf)) {
    if (val && path.resolve(val).toLowerCase().replace(/[\\/]+$/, '') === norm) return true;
  }
  if (IS_WIN && /^[a-z]:\\(windows|program files|program files \(x86\)|users|programdata)$/i.test(path.resolve(p))) {
    return true;
  }
  return false;
}

function isPermanentDeleteCommand(cmd) {
  return DELETE_PATTERNS.some((re) => re.test(String(cmd || '')));
}

/* ------------------------------------------------------------------ */
/* process helpers                                                      */
/* ------------------------------------------------------------------ */

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else process.kill(-child.pid, 'SIGKILL');
  } catch (_) {
    try { child.kill('SIGKILL'); } catch (__) { /* ignore */ }
  }
}

const TERMINAL_SESSIONS = new Map();
let nextTerminalSessionNum = 1;

function createTerminalSession({ exe, args, shell, command, cwd, interactive, emitStream }) {
  const id = 'term-' + (nextTerminalSessionNum++);
  const child = spawn(exe, args, {
    cwd,
    windowsHide: true,
    detached: !IS_WIN,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const sess = {
    id,
    shell,
    cwd,
    interactive: !!interactive,
    lastCommand: String(command || ''),
    child,
    running: true,
    exitCode: null,
    output: '',
    emitStream: typeof emitStream === 'function' ? emitStream : null
  };
  const append = (buf, streamName) => {
    const s = buf.toString('utf8');
    sess.output += s;
    if (sess.output.length > 250000) sess.output = sess.output.slice(-250000);
    if (sess.emitStream) {
      try { sess.emitStream(s, streamName, { sessionId: id, running: sess.running }); } catch (_) { /* ignore */ }
    }
  };
  if (child.stdout) child.stdout.on('data', (d) => append(d, 'stdout'));
  if (child.stderr) child.stderr.on('data', (d) => append(d, 'stderr'));
  child.on('close', (code) => {
    sess.running = false;
    sess.exitCode = code;
    if (sess.emitStream) {
      try { sess.emitStream('', 'meta', { sessionId: id, running: false, exitCode: code }); } catch (_) { /* ignore */ }
    }
  });
  child.on('error', (err) => {
    sess.running = false;
    sess.output += '\n[terminal error] ' + (err.message || String(err)) + '\n';
  });
  TERMINAL_SESSIONS.set(id, sess);
  return sess;
}

function stopAllTerminalSessions() {
  let count = 0;
  for (const [id, sess] of Array.from(TERMINAL_SESSIONS.entries())) {
    if (sess && sess.child && sess.running) {
      killTree(sess.child);
      sess.running = false;
      count += 1;
    }
    TERMINAL_SESSIONS.delete(id);
  }
  return count;
}

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function runPowerShell(script, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + script],
    { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(String(stdout || '').trim());
    });
  });
}

/* ------------------------------------------------------------------ */
/* screen action helpers                                                */
/* ------------------------------------------------------------------ */

async function computeAdaptiveMoveMs(ctx, targetNative, speedOverride = '', precision = false) {
  const s = ctx && typeof ctx.settings === 'function' ? ctx.settings() : {};
  const prof = String(speedOverride || s.cursorSpeedProfile || 'adaptive').toLowerCase();
  let dist = 300;
  if (ctx && ctx.automation && typeof ctx.automation.position === 'function' && targetNative) {
    try {
      const cur = await Promise.race([
        ctx.automation.position().catch(() => null),
        sleep(220).then(() => null)
      ]);
      if (cur && isFinite(cur.x) && isFinite(cur.y)) {
        dist = Math.hypot(targetNative.x - cur.x, targetNative.y - cur.y);
      }
    } catch (_) { /* ignore */ }
  }
  const baseRaw = Number(s.cursorSpeedMs !== undefined ? s.cursorSpeedMs : 200);
  if (baseRaw === 0) return 0;
  if (prof === 'slow') return Math.round(Math.max(320, Math.min(720, Math.max(360, dist * 0.65))));
  if (prof === 'fast') return Math.round(Math.max(75, Math.min(180, dist * 0.16 + 70)));
  if (prof === 'medium') return Math.round(Math.max(170, Math.min(340, dist * 0.25 + 150)));
  // 'adaptive' ("it depends"): fast over long empty jumps, medium in mid-range, slower steady landing on small targets/text/buttons
  if (precision || dist <= 190) return Math.round(Math.max(220, Math.min(380, 260 + (precision ? 40 : 0))));
  if (dist > 650) return Math.round(Math.max(130, Math.min(210, 120 + dist * 0.06)));
  return Math.round(Math.max(185, Math.min(265, 165 + dist * 0.14)));
}

async function pointer(ctx, nx, ny, scale = 1000, label = '', speedOverride = '', precision = false) {
  const m = ctx.screen.mapPoint(nx, ny, { scale });
  const ms = await computeAdaptiveMoveMs(ctx, m.native, speedOverride, precision);
  ctx.cursor({ x: m.dip.x, y: m.dip.y, ms, label: label || '', kind: 'move' });
  await ctx.automation.move(m.native.x, m.native.y, ms);
  return m;
}

function isCodeContent(text, filePath = '') {
  if (filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const codeExts = ['.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.php', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.swift', '.kt', '.lua', '.html', '.css', '.scss', '.sass', '.json', '.xml', '.yaml', '.yml', '.sql', '.sh', '.bash', '.ps1', '.bat'];
    if (codeExts.includes(ext)) return true;
  }
  const s = String(text || '');
  if (/^\s*(import |export |const |let |var |function |def |class |public |private |protected |return |if\s*\(|for\s*\(|while\s*\()/m.test(s)) return true;
  return false;
}

function isSelfOrDesktopForeground(fg) {
  if (!fg) return false;
  const proc = String(fg.process || '').trim().toLowerCase();
  const title = String(fg.title || '').trim().toLowerCase();
  if (/^(?:locally|brief|electron)$/i.test(proc)) return true;
  if (/^(?:brief|locally)$/i.test(title) || title.startsWith('brief desktop layer') || title.startsWith('brief status widget')) return true;
  if (title === 'program manager') return true;
  return false;
}

async function ensureTargetForeground(ctx, targetHint = '') {
  if (!ctx || !ctx.automation || typeof ctx.automation.foreground !== 'function') return null;
  let fg = await ctx.automation.foreground().catch(() => null);
  if (isSelfOrDesktopForeground(fg)) {
    if (typeof ctx.beforeScreenAction === 'function') {
      await ctx.beforeScreenAction().catch(() => {});
      await sleep(160);
    }
    if (targetHint && typeof ctx.automation.focusWindow === 'function') {
      await ctx.automation.focusWindow(targetHint).catch(() => {});
      await sleep(180);
    }
    fg = await ctx.automation.foreground().catch(() => null);
    if (isSelfOrDesktopForeground(fg) && typeof ctx.automation.listWindows === 'function' && typeof ctx.automation.focusWindow === 'function') {
      const wins = await ctx.automation.listWindows().catch(() => []);
      const cand = (Array.isArray(wins) ? wins : []).find((w) => {
        const wt = String((w && w.title) || '').trim().toLowerCase();
        const wp = String((w && w.process) || '').trim().toLowerCase();
        return wt && wt !== 'program manager' && !/^(?:locally|brief|electron)$/i.test(wp) && !/^(?:brief|locally)$/i.test(wt) && w.state !== 'minimized';
      });
      if (cand) {
        await ctx.automation.focusWindow(cand.title || cand.process).catch(() => {});
        await sleep(180);
        fg = await ctx.automation.foreground().catch(() => null);
      }
    }
    if (isSelfOrDesktopForeground(fg)) {
      const who = (fg && (fg.title || fg.process)) || 'Brief/Desktop';
      throw new Error('Cannot type: keyboard focus is still on "' + who + '" instead of the target app. Call focus_window or click the target input field first.');
    }
  }
  return fg;
}

function isCodeEditorProcess(fg) {
  if (!fg || typeof fg !== 'object') return false;
  const p = String(fg.process || '').toLowerCase();
  const t = String(fg.title || '').toLowerCase();
  if (/^(?:code|notepad|notepad\+\+|robloxstudiobeta|cursor|sublime_text|devenv|pycharm64|idea64|webstorm64|windsurf|zed|atom|powershell|pwsh|windowsterminal|cmd|wt)$/i.test(p)) {
    return true;
  }
  return /\b(visual studio code|vs code|notepad\+\+|notepad|roblox studio|cursor|sublime text|powershell|command prompt|terminal|script editor)\b/i.test(t);
}

async function typeText(ctx, text, options = {}) {
  const s = String(text || '').replace(/\r\n/g, '\n');
  if (!s) return 'typed';
  const fgTarget = await ensureTargetForeground(ctx, options.targetHint || '');
  const settingsPaste = !!(ctx.settings && ctx.settings().pasteLongText === true);
  // Type visibly character-by-character by default so the user sees the real typing animation.
  // Only paste via Ctrl+V when mode==='paste' / paste===true (or if pasteLongText is explicitly enabled for huge >1200-char blocks).
  const shouldPaste = options.mode === 'paste' || options.paste === true ||
    (options.mode !== 'type' && options.paste !== false && settingsPaste && s.length > 1200);
  if (shouldPaste && clipboard && typeof clipboard.writeText === 'function') {
    const prevText = clipboard.readText();
    const prevImage = clipboard.readImage();
    clipboard.writeText(s);
    if (ctx.cursor) {
      ctx.cursor({
        kind: 'type',
        text: '[Pasted block]',
        fullText: s,
        label: 'Paste: ' + s.replace(/\s+/g, ' ').slice(0, 32)
      });
    }
    await sleep(90);
    await ctx.automation.keys(IS_MAC ? 'cmd+v' : 'ctrl+v');
    await sleep(320);
    if (prevImage && !prevImage.isEmpty()) clipboard.writeImage(prevImage);
    else clipboard.writeText(prevText || '');
    return 'pasted';
  }
  // In code editors/IDEs/terminals use real Enter for \n; in chat/browser inputs use Shift+Enter so messages do not submit early.
  const softNewline = options.softNewline !== undefined
    ? !!options.softNewline
    : !isCodeEditorProcess(fgTarget);
  let curr = '';
  const rawDelay = ctx.settings ? ctx.settings().typingDelayMs : undefined;
  // Balanced, clearly visible character-by-character typing animation (not too fast, not too slow)
  const delayMs = rawDelay === 0 ? 0 : Math.max(28, Math.min(130, Number(rawDelay || 45)));
  for (let i = 0; i < s.length; i++) {
    if (ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
    if (i > 0 && i % 10 === 0 && ctx.automation && typeof ctx.automation.foreground === 'function') {
      const fg = await ctx.automation.foreground().catch(() => null);
      if (isSelfOrDesktopForeground(fg)) {
        throw new Error('Typing interrupted: focus shifted back to Brief/Desktop mid-typing. Re-focus the target app field.');
      }
    }
    curr += s[i];
    if (ctx.cursor) {
      ctx.cursor({
        kind: 'type',
        char: s[i],
        text: curr.slice(-35),
        fullText: curr,
        label: 'Typing: ' + curr.slice(-25)
      });
    }
    await ctx.automation.type(s[i], 0, { softNewline });
    if (delayMs > 0) await sleep(delayMs);
  }
  return 'typed';
}

async function sleepInterruptible(ms, ctx) {
  const total = Math.max(0, Math.min(30000, Number(ms) || 0));
  const end = Date.now() + total;
  while (Date.now() < end) {
    if (ctx && ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
    await sleep(Math.min(40, Math.max(10, end - Date.now())));
  }
}

function resolveHoldMs(a, defaultMs = 0) {
  if (!a || typeof a !== 'object') return defaultMs;
  const raw = a.hold_ms !== undefined ? a.hold_ms
    : (a.duration_ms !== undefined ? a.duration_ms
      : (a.duration !== undefined ? a.duration
        : (a.ms !== undefined ? a.ms
          : (a.seconds !== undefined ? Number(a.seconds) * 1000 : undefined))));
  if (raw !== undefined && isFinite(Number(raw)) && Number(raw) > 0) {
    return Math.max(100, Math.min(30000, Math.round(Number(raw))));
  }
  if (a.long_press === true || a.hold === true) return Math.max(100, defaultMs || 2000);
  return defaultMs;
}

async function performMouseHold(ctx, btn, holdMs, dip) {
  await ctx.automation.button(btn, true);
  try {
    const start = Date.now();
    const end = start + Math.max(100, Math.min(30000, holdMs));
    let nextHud = start;
    while (Date.now() < end) {
      if (ctx && ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
      if (dip && ctx.cursor && Date.now() >= nextHud) {
        const sec = ((Date.now() - start) / 1000).toFixed(1);
        ctx.cursor({ x: dip.x, y: dip.y, kind: 'click', button: btn, label: 'Holding ' + btn + ' (' + sec + 's)' });
        nextHud = Date.now() + 250;
      }
      await sleep(Math.min(40, Math.max(10, end - Date.now())));
    }
  } finally {
    await ctx.automation.button(btn, false).catch(() => {});
  }
}

async function performKeyHold(ctx, keyCombo, holdMs) {
  const dur = Math.max(100, Math.min(30000, holdMs));
  const isOnlyMod = /^(?:ctrl|shift|alt|win|cmd)(?:\+(?:ctrl|shift|alt|win|cmd))*$/i.test(String(keyCombo || '').trim());
  await ctx.automation.keyState(keyCombo, true);
  try {
    const start = Date.now();
    const end = start + dur;
    let nextRepeat = start + 260;
    while (Date.now() < end) {
      if (ctx && ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
      if (!isOnlyMod && Date.now() >= nextRepeat) {
        await ctx.automation.keyState(keyCombo, true).catch(() => {});
        nextRepeat = Date.now() + 55;
      }
      await sleep(Math.min(35, Math.max(10, end - Date.now())));
    }
  } finally {
    await ctx.automation.keyState(keyCombo, false).catch(() => {});
  }
}

function scrollNotches(direction, amount) {
  const n = Math.max(1, Math.min(100, Math.round(Number(amount) || 6)));
  switch (String(direction || 'down').toLowerCase()) {
    case 'up': return { dx: 0, dy: -n };
    case 'left': return { dx: -n, dy: 0 };
    case 'right': return { dx: n, dy: 0 };
    default: return { dx: 0, dy: n };
  }
}

async function launchApp(ctx, name) {
  const raw = String(name || '').trim();
  if (!raw) throw new Error('App name is required.');
  if (/^[a-z][a-z0-9+.-]*:(?!\\)/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) {
    await shell.openExternal(raw);
    return { opened: raw, method: 'protocol' };
  }
  if (/[\\/]/.test(raw)) {
    const p = resolvePath(raw);
    if (await exists(p)) {
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
      return { opened: p, method: 'path' };
    }
  }
  if (IS_MAC) {
    await new Promise((resolve, reject) => execFile('open', ['-a', raw], (e, so, se) => (e ? reject(new Error(String(se || e.message))) : resolve())));
    return { opened: raw, method: 'open -a' };
  }
  if (!IS_WIN) {
    const child = spawn(raw, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return { opened: raw, method: 'spawn' };
  }
  const lower = raw.toLowerCase();
  const ALIASES = {
    'file explorer': 'explorer.exe', 'explorer': 'explorer.exe', 'windows explorer': 'explorer.exe', 'files': 'explorer.exe',
    'notepad': 'notepad.exe', 'calculator': 'calc.exe', 'calc': 'calc.exe', 'paint': 'mspaint.exe', 'ms paint': 'mspaint.exe',
    'cmd': 'cmd.exe', 'command prompt': 'cmd.exe', 'powershell': 'powershell.exe', 'windows powershell': 'powershell.exe',
    'terminal': 'wt.exe', 'windows terminal': 'wt.exe', 'task manager': 'taskmgr.exe', 'control panel': 'control.exe',
    'settings': 'ms-settings:', 'windows settings': 'ms-settings:', 'snipping tool': 'snippingtool.exe', 'registry editor': 'regedit.exe',
    'word': 'winword.exe', 'microsoft word': 'winword.exe', 'excel': 'excel.exe', 'microsoft excel': 'excel.exe',
    'powerpoint': 'powerpnt.exe', 'microsoft powerpoint': 'powerpnt.exe', 'outlook': 'outlook.exe',
    'chrome': 'chrome.exe', 'google chrome': 'chrome.exe', 'edge': 'msedge.exe', 'microsoft edge': 'msedge.exe',
    'firefox': 'firefox.exe', 'mozilla firefox': 'firefox.exe', 'brave': 'brave.exe', 'opera': 'opera.exe',
    'vscode': 'code', 'vs code': 'code', 'visual studio code': 'code', 'code': 'code', 'spotify': 'spotify:',
    'store': 'ms-windows-store:', 'microsoft store': 'ms-windows-store:', 'mail': 'outlookmail:', 'camera': 'microsoft.windows.camera:',
    'photos': 'ms-photos:', 'clock': 'ms-clock:', 'maps': 'bingmaps:', 'wordpad': 'wordpad.exe'
  };
  const target = ALIASES[lower] || raw;
  if (/^[a-z-.]+:$/i.test(target)) {
    try { await shell.openExternal(target); return { opened: target, method: 'protocol' }; } catch (_) { /* fall through */ }
  }
  try {
    await runPowerShell('Start-Process -FilePath ' + psQuote(target), 20000);
    return { opened: target, method: 'Start-Process' };
  } catch (firstErr) {
    // Fall back to the Start menu (covers Store apps and shortcuts).
    let apps = [];
    try { apps = await ctx.automation.startApps(); } catch (_) { apps = []; }
    const exact = apps.find((a) => String(a.Name).toLowerCase() === lower);
    const partial = exact || apps.find((a) => String(a.Name).toLowerCase().includes(lower)) ||
      apps.find((a) => lower.includes(String(a.Name).toLowerCase()) && String(a.Name).length > 3);
    if (partial) {
      await new Promise((resolve, reject) => {
        execFile('explorer.exe', ['shell:AppsFolder\\' + partial.AppID], { windowsHide: true }, () => resolve());
        setTimeout(resolve, 1500);
        void reject;
      });
      return { opened: partial.Name, method: 'Start menu (shell:AppsFolder)', appId: partial.AppID };
    }
    throw new Error('Could not launch "' + raw + '": ' + firstErr.message.split('\n')[0] + ' — and no Start menu entry matched.');
  }
}

async function findAndClickUiElement(ctx, { query = '', typeFilter = 'any', nearNative = null, maxDistPx = 99999, skipClick = false } = {}) {
  if (!ctx || !ctx.automation || typeof ctx.automation.inspectUi !== 'function') return null;
  const els = await ctx.automation.inspectUi(60).catch(() => []);
  if (!Array.isArray(els) || !els.length) return null;
  const q = String(query || '').trim().toLowerCase();
  const tf = String(typeFilter || 'any').toLowerCase();
  let best = null;
  let bestScore = -1;
  for (const el of els) {
    if (!el || typeof el.x !== 'number' || typeof el.y !== 'number') continue;
    const dist = nearNative ? Math.hypot(el.x - nearNative.x, el.y - nearNative.y) : 0;
    if (dist > maxDistPx) continue;
    const nm = String(el.name || '').toLowerCase();
    const aid = String(el.autoId || '').toLowerCase();
    const tp = String(el.type || '').toLowerCase();
    const isInp = !!el.isInput || tp === 'edit' || tp === 'combobox';
    if (tf === 'input' && !isInp) continue;
    if (tf === 'button' && tp !== 'button' && tp !== 'menuitem') continue;
    if (tf === 'tab' && tp !== 'tabitem') continue;
    if (tf === 'link' && tp !== 'hyperlink') continue;
    let sc = 0;
    if (q) {
      if (nm === q || aid === q) sc += 100;
      else if (nm.includes(q) || aid.includes(q)) sc += 55;
      else if (tf !== 'input' && !isInp) continue;
      else continue;
    } else if (isInp) {
      sc += 20;
    } else {
      continue;
    }
    if (isInp && (/search|query|find|address|url|ask/i.test(nm) || /search|query|find/i.test(aid))) sc += 25;
    if (isInp && tf === 'input') sc += 20;
    if (nearNative) sc -= dist / 12;
    if (sc > bestScore) { bestScore = sc; best = el; }
  }
  if (!best) return null;
  const dip = ctx.screen.nativeToDip(best.x, best.y);
  const b = (ctx.screen && typeof ctx.screen.currentDisplay === 'function' && ctx.screen.currentDisplay() && ctx.screen.currentDisplay().bounds) || { x: 0, y: 0, width: 1920, height: 1080 };
  const normPt = {
    x: Math.max(0, Math.min(999, Math.round(((dip.x - b.x) / Math.max(1, b.width)) * 1000))),
    y: Math.max(0, Math.min(999, Math.round(((dip.y - b.y) / Math.max(1, b.height)) * 1000)))
  };
  const ms = await computeAdaptiveMoveMs(ctx, { x: best.x, y: best.y }, '', true);
  ctx.cursor({ x: dip.x, y: dip.y, ms, label: best.name ? ('Focus: ' + best.name.slice(0, 28)) : 'Focus control', kind: 'move' });
  await ctx.automation.move(best.x, best.y, ms);
  if (!skipClick) {
    ctx.cursor({ x: dip.x, y: dip.y, kind: 'click', button: 'left', count: 1 });
    await ctx.automation.click('left', 1);
    await sleep(140);
  }
  return { element: best, dip, norm: normPt, physical: { x: best.x, y: best.y } };
}

async function findOcrMatchesOnDisplay(ctx, query = '') {
  if (!ctx || !ctx.automation || typeof ctx.automation.ocrScreen !== 'function') return { text: '', matches: [] };
  const d = (ctx.screen && typeof ctx.screen.currentDisplay === 'function') ? ctx.screen.currentDisplay() : { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  const b = d.bounds || { x: 0, y: 0, width: 1920, height: 1080 };
  const sf = d.scaleFactor || 1;
  const { screen: elecScreen } = (process.versions && process.versions.electron) ? require('electron') : {};
  const physOrigin = (elecScreen && typeof elecScreen.dipToScreenPoint === 'function')
    ? elecScreen.dipToScreenPoint({ x: b.x, y: b.y })
    : { x: Math.round(b.x * sf), y: Math.round(b.y * sf) };
  const physW = Math.round(b.width * sf);
  const physH = Math.round(b.height * sf);
  const res = await ctx.automation.ocrScreen(physOrigin.x, physOrigin.y, physW, physH);
  const q = String(query || '').trim().toLowerCase();
  const normOf = (px, py) => {
    const dip = ctx.screen && typeof ctx.screen.nativeToDip === 'function' ? ctx.screen.nativeToDip(px, py) : { x: px, y: py };
    return {
      x: Math.max(0, Math.min(999, Math.round(((dip.x - b.x) / Math.max(1, b.width)) * 1000))),
      y: Math.max(0, Math.min(999, Math.round(((dip.y - b.y) / Math.max(1, b.height)) * 1000)))
    };
  };
  const all = [];
  for (const w of (Array.isArray(res.words) ? res.words : [])) {
    if (!w || !w.text) continue;
    all.push({ kind: 'word', text: w.text, px: w.x, py: w.y, rect: w.rect, norm: normOf(w.x, w.y) });
  }
  for (const ln of (Array.isArray(res.lines) ? res.lines : [])) {
    if (!ln || !ln.text) continue;
    all.push({ kind: 'line', text: ln.text, px: ln.x, py: ln.y, rect: ln.rect, norm: normOf(ln.x, ln.y) });
  }
  if (!q) {
    return { text: String(res.text || ''), matches: all.filter((m) => m.kind === 'line').slice(0, 90) };
  }
  const scored = [];
  for (const item of all) {
    const t = item.text.toLowerCase().trim();
    if (!t) continue;
    let score = 0;
    if (t === q) score = 100 + (item.kind === 'word' ? 10 : 0);
    else if (t.startsWith(q)) score = 80;
    else if (t.includes(q)) score = 60 - Math.min(25, Math.floor((t.length - q.length) / 3));
    if (score > 0) scored.push(Object.assign({}, item, { score }));
  }
  scored.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  return { text: String(res.text || ''), matches: scored.slice(0, 20) };
}

/* ------------------------------------------------------------------ */
/* tool definitions                                                     */
/* ------------------------------------------------------------------ */

/** Precision Glasses snap: if clicking within ~12 normalized units of a small UIA control center, snap dead-center so small buttons aren't missed on edges. */
async function resolveSmartClickPoint(ctx, nx, ny) {
  const m = ctx.screen.mapPoint(nx, ny, { scale: 1000 });
  if (!ctx || !ctx.automation || typeof ctx.automation.inspectUi !== 'function') {
    return { nx: m.normalized.x, ny: m.normalized.y, m, snapped: null };
  }
  try {
    const els = await Promise.race([
      ctx.automation.inspectUi(100).catch(() => []),
      sleep(320).then(() => [])
    ]);
    if (!Array.isArray(els) || !els.length) return { nx: m.normalized.x, ny: m.normalized.y, m, snapped: null };
    const disp = (ctx.screen && typeof ctx.screen.currentDisplay === 'function') ? ctx.screen.currentDisplay() : null;
    const sf = (disp && disp.scaleFactor) || 1;
    const maxSnapPx = Math.round(20 * sf);
    let best = null;
    let bestDist = maxSnapPx + 1;
    for (const el of els) {
      if (!el || typeof el.x !== 'number' || typeof el.y !== 'number') continue;
      if (!/^(Button|SplitButton|MenuItem|TabItem|CheckBox|RadioButton|Edit|Hyperlink)$/i.test(String(el.type || ''))) continue;
      if (el.rect) {
        const parts = String(el.rect).split(',').map(Number);
        if (parts.length === 4 && parts.every(isFinite)) {
          const w = parts[2] - parts[0];
          const h = parts[3] - parts[1];
          // Don't snap if the point is already comfortably inside a large region/box
          if (w > 220 * sf || h > 90 * sf) continue;
        }
      }
      const dist = Math.hypot(el.x - m.native.x, el.y - m.native.y);
      if (dist <= maxSnapPx && dist < bestDist) {
        bestDist = dist;
        best = el;
      }
    }
    if (best && bestDist >= 3) {
      const dip = ctx.screen.nativeToDip(best.x, best.y);
      const b = (disp && disp.bounds) || { x: 0, y: 0, width: 1920, height: 1080 };
      const snx = Math.max(0, Math.min(999, Math.round(((dip.x - b.x) / Math.max(1, b.width)) * 1000)));
      const sny = Math.max(0, Math.min(999, Math.round(((dip.y - b.y) / Math.max(1, b.height)) * 1000)));
      return {
        nx: snx,
        ny: sny,
        m: { dip, native: { x: best.x, y: best.y }, display: disp, normalized: { x: snx, y: sny, scale: 1000 } },
        snapped: best.name || best.type || 'UI Control'
      };
    }
  } catch (_) { /* ignore */ }
  return { nx: m.normalized.x, ny: m.normalized.y, m, snapped: null };
}

const XY = {
  x: { type: 'integer', description: 'Horizontal position on the current screenshot, 0 (left edge) to 1000 (right edge).' },
  y: { type: 'integer', description: 'Vertical position on the current screenshot, 0 (top edge) to 1000 (bottom edge).' }
};

const TOOLS = [
  /* ---------------- computer control ---------------- */
  {
    name: 'click', kind: 'screen', screen: true,
    description: 'Move the real mouse to a point on the current screenshot and click or long-press. Use button "right" for context menus, clicks=2 to double-click, or hold_ms (e.g. 1500-5000) / long_press=true to click and hold down.',
    parameters: { type: 'object', properties: Object.assign({}, XY, {
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
      clicks: { type: 'integer', description: '1 = single click, 2 = double click, 3 = triple click (default 1).' },
      hold_ms: { type: 'integer', description: 'Hold mouse button down for this many milliseconds (long press, e.g. 1500-30000) before releasing.' },
      long_press: { type: 'boolean', description: 'Set true to long-press (~2000ms) at (x, y) if hold_ms is omitted.' },
      speed: { type: 'string', enum: ['adaptive', 'slow', 'medium', 'fast'], description: 'Optional cursor speed ("slow" for tiny/precision buttons, "medium", "fast", or "adaptive").' },
      exact: { type: 'boolean', description: 'Set true to disable UIA button-center snap (for canvas/art coordinates).' }
    }), required: ['x', 'y'] },
    describe: (a) => {
      const h = resolveHoldMs(a, 0);
      return (h > 80 ? 'Long-press (' + h + 'ms)' : (a.clicks === 2 ? 'Double-click' : a.clicks === 3 ? 'Triple-click' : (a.button === 'right' ? 'Right-click' : a.button === 'middle' ? 'Middle-click' : 'Left-click'))) + ' at (' + a.x + ', ' + a.y + ') on the screen';
    },
    async run(a, ctx) {
      const btn = a.button || 'left';
      const holdMs = resolveHoldMs(a, 0);
      const snap = (!a.exact && holdMs <= 80 && btn === 'left') ? await resolveSmartClickPoint(ctx, a.x, a.y) : null;
      const tx = snap ? snap.nx : a.x;
      const ty = snap ? snap.ny : a.y;
      const m = await pointer(ctx, tx, ty, 1000, holdMs > 80 ? 'long-press' : (snap && snap.snapped ? ('Click ' + String(snap.snapped).slice(0, 22)) : 'click'), a.speed || '', true);
      if (holdMs > 80) {
        await performMouseHold(ctx, btn, holdMs, m.dip);
        return { clicked: true, long_press: true, hold_ms: holdMs, button: btn, norm: { x: tx, y: ty }, physical: m.native };
      }
      const count = Math.max(1, Math.min(3, Number(a.clicks) || 1));
      ctx.cursor({ x: m.dip.x, y: m.dip.y, kind: 'click', button: btn, count });
      await ctx.automation.click(btn, count);
      await sleep(110);
      return { clicked: true, button: btn, clicks: count, norm: { x: tx, y: ty }, snapped_control: (snap && snap.snapped) || undefined, physical: m.native };
    }
  },
  {
    name: 'mouse_button', kind: 'screen', screen: true,
    description: 'Press and hold, long-press, or release a mouse button ("left", "right", "middle"). Accepts (x, y) OR target UI element name. Use action="long_press" (default 2000ms, up to 30000ms), action="down" to keep holding while interacting, or "up" to release.',
    parameters: { type: 'object', properties: {
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
      action: { type: 'string', enum: ['down', 'up', 'long_press'], description: 'Whether to hold down, release up, or long-press and release.' },
      target: { type: 'string', description: 'Optional UI element name to locate dead-center before holding.' },
      x: { type: 'integer', description: 'Optional horizontal position (0-1000) to move to before pressing.' },
      y: { type: 'integer', description: 'Optional vertical position (0-1000) to move to before pressing.' },
      duration_ms: { type: 'integer', description: 'Duration in ms for long_press (default 2000, max 30000).' },
      hold_ms: { type: 'integer', description: 'Alias for duration_ms.' }
    }, required: ['action'] },
    describe: (a) => {
      const h = resolveHoldMs(a, 2000);
      return (a.action === 'down' ? 'Hold mouse ' + (a.button || 'left') + ' down' : a.action === 'up' ? 'Release mouse ' + (a.button || 'left') : 'Long-press mouse ' + (a.button || 'left') + ' (' + h + 'ms)') + (a.target ? ' on "' + a.target + '"' : (a.x !== undefined ? ' at (' + a.x + ', ' + a.y + ')' : ''));
    },
    async run(a, ctx) {
      const btn = a.button || 'left';
      const act = String(a.action || 'long_press').toLowerCase();
      let dip = null;
      if (a.target && act !== 'up' && ctx.automation && typeof ctx.automation.inspectUi === 'function') {
        const els = await ctx.automation.inspectUi(50).catch(() => []);
        const q = String(a.target).toLowerCase();
        const found = els.find((e) => String(e.name || '').toLowerCase().includes(q));
        if (found) {
          dip = ctx.screen.nativeToDip(found.x, found.y);
          ctx.cursor({ x: dip.x, y: dip.y, ms: 180, kind: 'move', label: 'Hold ' + a.target });
          await ctx.automation.move(found.x, found.y, 180);
        }
      }
      if (!dip && a.x !== undefined && a.y !== undefined) {
        const m = await pointer(ctx, a.x, a.y, 1000, 'hold');
        dip = m.dip;
      }
      if (act === 'down') {
        if (dip) ctx.cursor({ x: dip.x, y: dip.y, kind: 'click', button: btn, label: 'Holding ' + btn });
        await ctx.automation.button(btn, true);
        return { held: true, button: btn, state: 'down' };
      }
      if (act === 'up') {
        await ctx.automation.button(btn, false);
        return { released: true, button: btn, state: 'up' };
      }
      const dur = resolveHoldMs(a, 2000);
      await performMouseHold(ctx, btn, dur, dip);
      return { long_pressed: true, button: btn, duration_ms: dur };
    }
  },
  {
    name: 'click_element', kind: 'screen', screen: true,
    description: 'Locate an exact UI control (Search box, Address bar, Button, Tab, Link, Menu) on the active window by name using UI Automation and click or long-press dead-center on it.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Visible label/name of the element to click (e.g. "Search", "Address and search bar", "Submit", "Sign in").' },
        type_filter: { type: 'string', enum: ['any', 'input', 'button', 'tab', 'link'], description: 'Optional control kind filter (use "input" for Search/text boxes).' },
        hold_ms: { type: 'integer', description: 'Optional: hold mouse button down on this element for long-press (ms).' },
        long_press: { type: 'boolean', description: 'Set true to long-press (~2000ms) on this UI element.' }
      },
      required: ['query']
    },
    describe: (a) => (resolveHoldMs(a, 0) > 80 ? 'Long-press UI element "' : 'Click UI element "') + a.query + '"',
    async run(a, ctx) {
      const holdMs = resolveHoldMs(a, 0);
      const hit = await findAndClickUiElement(ctx, { query: a.query, typeFilter: a.type_filter || 'any', skipClick: holdMs > 80 });
      if (!hit) throw new Error('Could not find visible UI element matching "' + a.query + '". Use zoom_region / read_screen_text / click(x, y) instead.');
      if (holdMs > 80) {
        await performMouseHold(ctx, 'left', holdMs, hit.dip);
        return { clicked: true, long_press: true, hold_ms: holdMs, element: hit.element.name || a.query, type: hit.element.type, norm: hit.norm, physical: hit.physical };
      }
      return { clicked: true, element: hit.element.name || a.query, type: hit.element.type, norm: hit.norm, physical: hit.physical };
    }
  },
  {
    name: 'read_screen_text', kind: 'screen', screen: true,
    description: 'Use Windows native OCR to read ALL visible text, menus, buttons, timeline labels, Explorer items, or Output logs currently on screen and return their exact 0..1000 (x, y) coordinates. Works even in Qt/custom apps like CapCut & Roblox Studio.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional text to search for specifically (e.g. "Export", "Animation", "Command Bar", "Play"). Omit to read all visible screen lines.' }
      }
    },
    describe: (a) => a.query ? ('Read & find "' + a.query + '" on screen') : 'Read all visible text on screen (OCR)',
    async run(a, ctx) {
      const ocr = await findOcrMatchesOnDisplay(ctx, a.query || '');
      return {
        query: a.query || '',
        count: ocr.matches.length,
        matches: ocr.matches.map((m) => ({ text: m.text, kind: m.kind, x: m.norm.x, y: m.norm.y })),
        full_text_preview: ocr.text.slice(0, 2200)
      };
    }
  },
  {
    name: 'click_text', kind: 'screen', screen: true,
    description: 'Locate visible text/button/tab/menu anywhere on screen using native Windows OCR (and UI Automation fallback) and click, double-click, right-click, or long-press dead-center on it with adaptive cursor precision. Essential for CapCut, Roblox Studio, menus, and buttons.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Visible text label on screen (e.g. "Import", "Text", "Animation", "View", "Command Bar", "Explorer", "Run").' },
        occurrence: { type: 'integer', description: 'Which match to click (1 = best/first match, 2 = second, etc.).' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
        clicks: { type: 'integer', description: '1 = single, 2 = double click.' },
        hold_ms: { type: 'integer', description: 'Optional hold duration ms for long press.' },
        long_press: { type: 'boolean', description: 'Set true for long press (~2000ms).' },
        speed: { type: 'string', enum: ['adaptive', 'slow', 'medium', 'fast'], description: 'Cursor move speed (defaults to "slow" / adaptive precision landing).' },
        offset_x: { type: 'integer', description: 'Optional horizontal offset in 0..1000 units from matched text center.' },
        offset_y: { type: 'integer', description: 'Optional vertical offset in 0..1000 units from matched text center.' }
      },
      required: ['query']
    },
    describe: (a) => 'Find & click "' + a.query + '" cleanly on screen',
    async run(a, ctx) {
      const ocr = await findOcrMatchesOnDisplay(ctx, a.query);
      const idx = Math.max(0, (Number(a.occurrence) || 1) - 1);
      const hit = ocr.matches[idx] || ocr.matches[0];
      if (!hit) {
        const uiFallback = await findAndClickUiElement(ctx, { query: a.query, skipClick: resolveHoldMs(a, 0) > 80 });
        if (!uiFallback) {
          throw new Error('Could not find text "' + a.query + '" on screen via OCR or UIA. Use read_screen_text() or inspect the grid.');
        }
        const holdMs = resolveHoldMs(a, 0);
        if (holdMs > 80) await performMouseHold(ctx, a.button || 'left', holdMs, uiFallback.dip);
        return { clicked: true, via: 'uia', matched: uiFallback.element.name || a.query, norm: uiFallback.norm, physical: uiFallback.physical };
      }
      const tx = Math.max(2, Math.min(997, hit.norm.x + (Number(a.offset_x) || 0)));
      const ty = Math.max(2, Math.min(997, hit.norm.y + (Number(a.offset_y) || 0)));
      const btn = a.button || 'left';
      const holdMs = resolveHoldMs(a, 0);
      const m = await pointer(ctx, tx, ty, 1000, 'Text: ' + hit.text.slice(0, 26), a.speed || 'slow', true);
      if (holdMs > 80) {
        await performMouseHold(ctx, btn, holdMs, m.dip);
        return { clicked: true, via: 'ocr', matched: hit.text, long_press: true, hold_ms: holdMs, norm: { x: tx, y: ty }, physical: m.native };
      }
      const count = Math.max(1, Math.min(3, Number(a.clicks) || 1));
      ctx.cursor({ x: m.dip.x, y: m.dip.y, kind: 'click', button: btn, count, label: hit.text.slice(0, 26) });
      await ctx.automation.click(btn, count);
      await sleep(110);
      return { clicked: true, via: 'ocr', matched: hit.text, norm: { x: tx, y: ty }, physical: m.native };
    }
  },
  {
    name: 'zoom_region', kind: 'screen', screen: true,
    description: 'Macro Eyes: capture a sharp magnified close-up PNG photo of a rectangular region of the screen (0..1000 coords) so you can read tiny UI buttons, keyframes, Roblox Explorer/Output logs, or small text clearly before clicking.',
    parameters: {
      type: 'object',
      properties: {
        x1: { type: 'integer', description: 'Left edge (0-1000).' },
        y1: { type: 'integer', description: 'Top edge (0-1000).' },
        x2: { type: 'integer', description: 'Right edge (0-1000).' },
        y2: { type: 'integer', description: 'Bottom edge (0-1000).' }
      },
      required: ['x1', 'y1', 'x2', 'y2']
    },
    describe: (a) => `Zoom closer into screen region (${a.x1},${a.y1})-(${a.x2},${a.y2})`,
    async run(a, ctx) {
      if (!ctx.screen || typeof ctx.screen.captureRegion !== 'function') {
        throw new Error('Region zoom is not available.');
      }
      const crop = await ctx.screen.captureRegion({ x1: Number(a.x1), y1: Number(a.y1), x2: Number(a.x2), y2: Number(a.y2), grid: true });
      return {
        zoomed: true,
        width: crop.width,
        height: crop.height,
        regionNorm: crop.regionNorm,
        _visionImage: { mime: crop.mime || 'image/png', base64: crop.base64 }
      };
    }
  },
  {
    name: 'double_click', kind: 'screen', screen: true,
    description: 'Double-click with the left mouse button at a point (e.g. to open a file or folder in Explorer).',
    parameters: { type: 'object', properties: XY, required: ['x', 'y'] },
    describe: (a) => 'Double-click at (' + a.x + ', ' + a.y + ')',
    async run(a, ctx) {
      const snap = await resolveSmartClickPoint(ctx, a.x, a.y);
      const m = await pointer(ctx, snap.nx, snap.ny, 1000, snap.snapped ? ('Double-click ' + String(snap.snapped).slice(0, 18)) : 'double-click', '', true);
      ctx.cursor({ x: m.dip.x, y: m.dip.y, kind: 'click', count: 2 });
      await ctx.automation.click('left', 2);
      await sleep(110);
      return { clicked: true, clicks: 2, norm: { x: snap.nx, y: snap.ny }, snapped_control: snap.snapped || undefined, physical: m.native };
    }
  },
  {
    name: 'move_mouse', kind: 'screen', screen: true,
    description: 'Move the real mouse pointer to a point without clicking (hover).',
    parameters: { type: 'object', properties: XY, required: ['x', 'y'] },
    describe: (a) => 'Move the mouse to (' + a.x + ', ' + a.y + ')',
    async run(a, ctx) { const m = await pointer(ctx, a.x, a.y, 1000, 'hover'); return { moved: true, physical: m.native }; }
  },
  {
    name: 'drag', kind: 'screen', screen: true,
    description: 'Press the left mouse button at a start point, drag smoothly to an end point and release (move files, select text, resize, draw a straight stroke).',
    parameters: { type: 'object', properties: {
      start_x: { type: 'integer', description: 'Start x (0-1000).' }, start_y: { type: 'integer', description: 'Start y (0-1000).' },
      end_x: { type: 'integer', description: 'End x (0-1000).' }, end_y: { type: 'integer', description: 'End y (0-1000).' },
      duration_ms: { type: 'integer', description: 'Optional drag duration ms (default 300).' }
    }, required: ['start_x', 'start_y', 'end_x', 'end_y'] },
    describe: (a) => 'Drag from (' + a.start_x + ', ' + a.start_y + ') to (' + a.end_x + ', ' + a.end_y + ')',
    async run(a, ctx) {
      const s = ctx.screen.mapPoint(a.start_x, a.start_y);
      const e = ctx.screen.mapPoint(a.end_x, a.end_y);
      const dur = Math.max(180, Math.min(3000, Number(a.duration_ms) || 300));
      ctx.cursor({ x: s.dip.x, y: s.dip.y, ms: 100, kind: 'move', label: 'Drag start' });
      ctx.cursor({ x: e.dip.x, y: e.dip.y, ms: dur, kind: 'drag', label: 'Dragging' });
      await ctx.automation.drag(s.native.x, s.native.y, e.native.x, e.native.y, dur);
      return { dragged: true, from: s.native, to: e.native };
    }
  },
  {
    name: 'draw_art', kind: 'screen', screen: true,
    description: 'Draw smooth, well-proportioned illustrations on MS Paint or any drawing canvas using continuous mouse strokes with automatic screen aspect-ratio correction (so circles/suns/heads/hands are truly round, never ovals!). Accepts high-level geometric shapes ("sun", "house", "tree", "cloud", "person", "flower", "heart", "mountains", "car", "circle", "arc", "star", "polygon") AND/OR custom freehand polyline/smooth-curve strokes.',
    parameters: {
      type: 'object',
      properties: {
        shapes: {
          type: 'array',
          description: 'Array of shape objects in 0..1000 screen coordinates (keep y between 240..880 in MS Paint so shapes stay below the top toolbar ribbon): e.g. {kind:"sun", cx:780, cy:290, r:45, rays:12}, {kind:"house", x:370, y:500, w:240, h:190}, {kind:"tree", cx:200, bottom_y:700, h:210}, {kind:"cloud", cx:260, cy:300, w:120}, {kind:"person", cx:520, bottom_y:760, h:210, wave:true}, {kind:"flower", cx:310, bottom_y:760, h:120}, {kind:"heart", cx:500, cy:460, size:70}, {kind:"mountains", x:180, y:480, w:640, h:180}, {kind:"car", x:350, y:620, w:220, h:95}, {kind:"circle", cx:500, cy:500, r:60}, {kind:"arc", cx:500, cy:500, r:50, start_deg:20, end_deg:160}, {kind:"polygon", vertices:[[x,y],...]}, {kind:"star", cx:500, cy:350, r:40}.',
          items: { type: 'object' }
        },
        strokes: {
          type: 'array',
          description: 'Optional custom multi-point continuous strokes in 0..1000 coords, each as { label?: string, smooth?: boolean, points: [[x,y], ...] }.',
          items: { type: 'object' }
        },
        ms_per_segment: { type: 'integer', description: 'Speed per stroke segment in ms (default 22).' }
      }
    },
    describe: (a) => {
      const nSh = Array.isArray(a.shapes) ? a.shapes.length : 0;
      const nSt = Array.isArray(a.strokes) ? a.strokes.length : 0;
      const names = (Array.isArray(a.shapes) ? a.shapes.map((s) => s.kind || s.type).filter(Boolean) : []).slice(0, 4).join(', ');
      return 'Draw artwork on canvas (' + (names || (nSt + ' strokes')) + (nSh && nSt ? ' + ' + nSt + ' strokes' : '') + ')';
    },
    async run(a, ctx) {
      if (!ctx.automation || typeof ctx.automation.drawPath !== 'function') {
        throw new Error('Continuous path drawing is not supported on this backend.');
      }
      const disp = (ctx.screen && typeof ctx.screen.currentDisplay === 'function') ? ctx.screen.currentDisplay() : null;
      const dispW = (disp && disp.bounds && disp.bounds.width) || 1920;
      const dispH = (disp && disp.bounds && disp.bounds.height) || 1080;
      const aspect = dispW / Math.max(1, dispH); // dy per dx for circular equivalence in 0..1000 units

      const allStrokes = [];
      const normPair = (p) => Array.isArray(p) ? [Number(p[0]), Number(p[1])] : (p && typeof p === 'object' ? [Number(p.x), Number(p.y)] : null);
      const catmullRom = (pts, subdivs = 4) => {
        if (!Array.isArray(pts) || pts.length < 3 || subdivs < 2) return pts;
        const out = [];
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[Math.max(0, i - 1)];
          const p1 = pts[i];
          const p2 = pts[i + 1];
          const p3 = pts[Math.min(pts.length - 1, i + 2)];
          for (let s = 0; s < subdivs; s++) {
            const t = s / subdivs;
            const t2 = t * t;
            const t3 = t2 * t;
            const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
            const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
            out.push([x, y]);
          }
        }
        out.push(pts[pts.length - 1]);
        return out;
      };
      const addPoly = (pts, smooth = false) => {
        if (!Array.isArray(pts) || pts.length < 2) return;
        const clean = pts.map(normPair).filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (clean.length < 2) return;
        const finalPts = smooth && clean.length >= 3 ? catmullRom(clean, 4) : clean;
        allStrokes.push(finalPts.map(([x, y]) => [Math.max(5, Math.min(994, x)), Math.max(5, Math.min(994, y))]));
      };
      const circlePts = (cx, cy, r, steps = 32, startDeg = 0, endDeg = 360) => {
        const pts = [];
        for (let i = 0; i <= steps; i++) {
          const rad = ((startDeg + ((endDeg - startDeg) * i) / steps) * Math.PI) / 180;
          pts.push([cx + Math.cos(rad) * r, cy + Math.sin(rad) * r * aspect]);
        }
        return pts;
      };

      for (const sh of (Array.isArray(a.shapes) ? a.shapes : [])) {
        const kRaw = sh && (sh.kind || sh.type);
        if (!kRaw) continue;
        const k = String(kRaw).toLowerCase();
        const scx = Number(sh.cx !== undefined ? sh.cx : sh.x);
        const scy = Number(sh.cy !== undefined ? sh.cy : sh.y);
        const sr = Number(sh.r !== undefined ? sh.r : (sh.rx !== undefined ? sh.rx : sh.radius));
        if (k === 'circle') {
          addPoly(circlePts(Number.isFinite(scx) ? scx : 500, Number.isFinite(scy) ? scy : 500, Number.isFinite(sr) ? sr : 50, 32, 0, 360));
        } else if (k === 'arc') {
          addPoly(circlePts(Number.isFinite(scx) ? scx : 500, Number.isFinite(scy) ? scy : 500, Number.isFinite(sr) ? sr : 50, 20, Number(sh.start_deg) || 0, Number(sh.end_deg) || 180));
        } else if (k === 'ellipse') {
          const rx = Number(sh.rx) || 60;
          const ry = Number(sh.ry) || 40;
          const cx0 = Number.isFinite(scx) ? scx : 500;
          const cy0 = Number.isFinite(scy) ? scy : 500;
          const pts = [];
          for (let i = 0; i <= 32; i++) {
            const rad = (i * 2 * Math.PI) / 32;
            pts.push([cx0 + Math.cos(rad) * rx, cy0 + Math.sin(rad) * ry]);
          }
          addPoly(pts);
        } else if (k === 'sun') {
          const cx = Number.isFinite(scx) ? scx : 780;
          const cy = Number.isFinite(scy) ? scy : 290;
          const r = Number.isFinite(sr) ? sr : 42;
          const rays = Math.max(6, Math.min(16, Number(sh.rays) || 10));
          addPoly(circlePts(cx, cy, r, 30, 0, 360));
          for (let i = 0; i < rays; i++) {
            const rad = (i * 2 * Math.PI) / rays;
            const r1 = r * 1.28;
            const r2 = (i % 2 === 0 ? r * 1.95 : r * 1.6);
            addPoly([
              [cx + Math.cos(rad) * r1, cy + Math.sin(rad) * r1 * aspect],
              [cx + Math.cos(rad) * r2, cy + Math.sin(rad) * r2 * aspect]
            ]);
          }
        } else if (k === 'house') {
          const x = Number(sh.x) || 370;
          const y = Number(sh.y) || 490;
          const w = Number(sh.w) || 240;
          const h = Number(sh.h) || 200;
          const roofH = Math.round(h * 0.55);
          addPoly([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]);
          addPoly([[x - w * 0.08, y + h * 0.02], [x + w * 0.5, y - roofH], [x + w * 1.08, y + h * 0.02]]);
          const chX1 = x + w * 0.72;
          const chX2 = x + w * 0.84;
          const chYBase = y - roofH * 0.55;
          const chYTop = y - roofH * 0.96;
          addPoly([[chX1, chYBase], [chX1, chYTop], [chX2, chYTop], [chX2, chYBase + roofH * 0.22]]);
          addPoly([[chX1 - w * 0.02, chYTop], [chX2 + w * 0.02, chYTop]]);
          const dW = w * 0.22;
          const dH = h * 0.44;
          const dX = x + (w - dW) * 0.5;
          const dY = y + h - dH;
          addPoly([[dX, y + h], [dX, dY], [dX + dW, dY], [dX + dW, y + h]]);
          addPoly(circlePts(dX + dW * 0.78, dY + dH * 0.55, Math.max(3, w * 0.015), 10, 0, 360));
          const winW = w * 0.18;
          const winH = h * 0.24;
          const winY = y + h * 0.2;
          for (const wx of [x + w * 0.12, x + w * 0.7]) {
            addPoly([[wx, winY], [wx + winW, winY], [wx + winW, winY + winH], [wx, winY + winH], [wx, winY]]);
            addPoly([[wx + winW * 0.5, winY], [wx + winW * 0.5, winY + winH]]);
            addPoly([[wx, winY + winH * 0.5], [wx + winW, winY + winH * 0.5]]);
          }
          addPoly([[x - w * 0.45, y + h], [x + w * 1.45, y + h]]);
        } else if (k === 'tree') {
          const cx = Number(sh.cx) || 190;
          const by = Number(sh.bottom_y) || 690;
          const h = Number(sh.h) || 210;
          const trW = h * 0.11;
          const trTop = by - h * 0.48;
          addPoly([[cx - trW * 0.65, by], [cx - trW * 0.4, trTop], [cx + trW * 0.4, trTop], [cx + trW * 0.65, by]]);
          addPoly(circlePts(cx, trTop - h * 0.2, h * 0.19, 24, 0, 360));
          addPoly(circlePts(cx - h * 0.13, trTop - h * 0.08, h * 0.13, 20, 40, 290));
          addPoly(circlePts(cx + h * 0.13, trTop - h * 0.08, h * 0.13, 20, -110, 140));
        } else if (k === 'cloud') {
          const cx = Number(sh.cx) || 260;
          const cy = Number(sh.cy) || 300;
          const r = (Number(sh.w) || 120) * 0.25;
          addPoly(circlePts(cx - r * 0.9, cy + r * 0.15, r * 0.75, 16, 100, 320));
          addPoly(circlePts(cx, cy - r * 0.25, r, 18, 170, 370));
          addPoly(circlePts(cx + r * 0.95, cy + r * 0.15, r * 0.75, 16, 220, 430));
          addPoly([[cx - r * 1.4, cy + r * 0.75 * aspect], [cx + r * 1.45, cy + r * 0.75 * aspect]]);
        } else if (k === 'person') {
          const cx = Number.isFinite(scx) ? scx : 500;
          const by = Number(sh.bottom_y) || 760;
          const h = Number(sh.h) || 220;
          const wave = sh.wave !== false;
          const headR = h * 0.075;
          const headY = by - h + headR * aspect * 1.1;
          addPoly(circlePts(cx, headY, headR, 24, 0, 360));
          // Eyes & smile
          const eyeDx = headR * 0.36;
          const eyeY = headY - headR * aspect * 0.18;
          addPoly(circlePts(cx - eyeDx, eyeY, Math.max(1.8, headR * 0.1), 8, 0, 360));
          addPoly(circlePts(cx + eyeDx, eyeY, Math.max(1.8, headR * 0.1), 8, 0, 360));
          addPoly(circlePts(cx, headY + headR * aspect * 0.08, headR * 0.48, 12, 25, 155));
          // Neck & curved torso/shirt
          const shY = headY + headR * aspect * 1.35;
          const hipY = by - h * 0.38;
          const shW = headR * 1.55;
          const wW = headR * 1.1;
          addPoly([[cx, headY + headR * aspect], [cx, shY]]);
          addPoly([[cx - shW, shY], [cx + shW, shY], [cx + wW, hipY], [cx - wW, hipY], [cx - shW, shY]]);
          // Left relaxed curved arm + proportional hand palm with thumb & fingers
          const lElbX = cx - shW * 1.55;
          const lElbY = shY + h * 0.13;
          const lHandX = cx - shW * 1.35;
          const lHandY = hipY + h * 0.04;
          addPoly([[cx - shW, shY], [lElbX, lElbY], [lHandX, lHandY]], true);
          addPoly(circlePts(lHandX, lHandY, headR * 0.28, 12, 0, 360));
          for (let f = -1; f <= 2; f++) {
            addPoly([[lHandX, lHandY], [lHandX + f * headR * 0.14, lHandY + headR * 0.42]]);
          }
          // Right arm (waving up or resting) + proportional hand with 4 fingers + thumb
          const rElbX = cx + shW * 1.55;
          const rElbY = wave ? (shY + h * 0.02) : (shY + h * 0.13);
          const rHandX = wave ? (cx + shW * 1.95) : (cx + shW * 1.35);
          const rHandY = wave ? (headY + h * 0.02) : (hipY + h * 0.04);
          addPoly([[cx + shW, shY], [rElbX, rElbY], [rHandX, rHandY]], true);
          addPoly(circlePts(rHandX, rHandY, headR * 0.28, 12, 0, 360));
          for (let f = -2; f <= 1; f++) {
            addPoly([[rHandX, rHandY], [rHandX + f * headR * 0.15, wave ? (rHandY - headR * 0.45) : (rHandY + headR * 0.42)]]);
          }
          // Legs & shoes
          const footLX = cx - wW * 0.65;
          const footRX = cx + wW * 0.65;
          addPoly([[cx - wW * 0.55, hipY], [footLX, by]]);
          addPoly([[cx + wW * 0.55, hipY], [footRX, by]]);
          addPoly([[footLX - headR * 0.55, by], [footLX + headR * 0.35, by]]);
          addPoly([[footRX - headR * 0.35, by], [footRX + headR * 0.55, by]]);
        } else if (k === 'flower') {
          const cx = Number.isFinite(scx) ? scx : 310;
          const by = Number(sh.bottom_y) || 740;
          const h = Number(sh.h) || 120;
          const headY = by - h * 0.78;
          const pr = h * 0.075;
          addPoly([[cx, by], [cx - h * 0.03, by - h * 0.4], [cx, headY]], true);
          addPoly([[cx, by - h * 0.35], [cx + h * 0.14, by - h * 0.48], [cx, by - h * 0.28]], true);
          addPoly(circlePts(cx, headY, pr, 16, 0, 360));
          for (let i = 0; i < 6; i++) {
            const rad = (i * Math.PI) / 3;
            addPoly(circlePts(cx + Math.cos(rad) * pr * 1.9, headY + Math.sin(rad) * pr * 1.9 * aspect, pr * 0.85, 14, 0, 360));
          }
        } else if (k === 'heart') {
          const cx = Number.isFinite(scx) ? scx : 500;
          const cy = Number.isFinite(scy) ? scy : 460;
          const sz = Number(sh.size) || 65;
          const pts = [];
          for (let i = 0; i <= 36; i++) {
            const t = (i * 2 * Math.PI) / 36;
            const hx = 16 * Math.pow(Math.sin(t), 3);
            const hy = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
            pts.push([cx + (hx / 16) * (sz * 0.55), cy + (hy / 16) * (sz * 0.55) * aspect]);
          }
          addPoly(pts);
        } else if (k === 'mountains') {
          const x = Number(sh.x) || 160;
          const y = Number(sh.y) || 490;
          const w = Number(sh.w) || 680;
          const h = Number(sh.h) || 180;
          addPoly([[x, y + h], [x + w * 0.22, y + h * 0.22], [x + w * 0.42, y + h]]);
          addPoly([[x + w * 0.3, y + h * 0.65], [x + w * 0.52, y], [x + w * 0.74, y + h]]);
          addPoly([[x + w * 0.62, y + h * 0.6], [x + w * 0.84, y + h * 0.18], [x + w, y + h]]);
        } else if (k === 'car') {
          const x = Number(sh.x) || 350;
          const y = Number(sh.y) || 620;
          const w = Number(sh.w) || 220;
          const h = Number(sh.h) || 95;
          addPoly([[x, y + h * 0.68], [x + w * 0.04, y + h * 0.35], [x + w * 0.24, y + h * 0.32], [x + w * 0.36, y], [x + w * 0.68, y], [x + w * 0.82, y + h * 0.32], [x + w * 0.98, y + h * 0.38], [x + w, y + h * 0.68], [x, y + h * 0.68]]);
          addPoly([[x + w * 0.38, y + h * 0.08], [x + w * 0.65, y + h * 0.08], [x + w * 0.75, y + h * 0.32], [x + w * 0.29, y + h * 0.32], [x + w * 0.38, y + h * 0.08]]);
          const wr = w * 0.085;
          addPoly(circlePts(x + w * 0.22, y + h * 0.72, wr, 20, 0, 360));
          addPoly(circlePts(x + w * 0.78, y + h * 0.72, wr, 20, 0, 360));
        } else if (k === 'star') {
          const cx = Number.isFinite(scx) ? scx : 500;
          const cy = Number.isFinite(scy) ? scy : 350;
          const rOut = Number.isFinite(sr) ? sr : 40;
          const rIn = rOut * 0.42;
          const n = Math.max(4, Math.min(12, Number(sh.points) || 5));
          const pts = [];
          for (let i = 0; i <= n * 2; i++) {
            const rad = ((i * Math.PI) / n) - Math.PI / 2;
            const r = i % 2 === 0 ? rOut : rIn;
            pts.push([cx + Math.cos(rad) * r, cy + Math.sin(rad) * r * aspect]);
          }
          addPoly(pts);
        } else if (k === 'polygon' && Array.isArray(sh.vertices) && sh.vertices.length >= 2) {
          addPoly(sh.vertices, !!sh.smooth);
        }
      }

      for (const st of (Array.isArray(a.strokes) ? a.strokes : [])) {
        if (st && Array.isArray(st.points)) addPoly(st.points, !!st.smooth);
        else if (Array.isArray(st)) addPoly(st, false);
      }
      if (!allStrokes.length) throw new Error('Provide at least one shape or stroke to draw.');

      const msPerSeg = Math.max(14, Math.min(80, Number(a.ms_per_segment) || 22));
      let completed = 0;
      for (const stroke of allStrokes) {
        if (ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
        const nativePts = stroke.map(([nx, ny]) => ctx.screen.mapPoint(nx, ny, { scale: 1000 }));
        const firstDip = nativePts[0].dip;
        const midDip = nativePts[Math.floor(nativePts.length / 2)].dip;
        const lastDip = nativePts[nativePts.length - 1].dip;
        ctx.cursor({ x: firstDip.x, y: firstDip.y, ms: 85, kind: 'move', label: 'Drawing stroke ' + (completed + 1) + '/' + allStrokes.length });
        const pathPromise = ctx.automation.drawPath(nativePts.map((p) => p.native), msPerSeg);
        ctx.cursor({ x: midDip.x, y: midDip.y, ms: Math.max(60, Math.round((nativePts.length * msPerSeg) / 2)), kind: 'drag', label: 'Drawing stroke ' + (completed + 1) + '/' + allStrokes.length });
        await pathPromise;
        ctx.cursor({ x: lastDip.x, y: lastDip.y, ms: 40, kind: 'move', label: 'Stroke ' + (completed + 1) + '/' + allStrokes.length });
        completed += 1;
        await sleep(35);
      }
      return { drawn: true, strokes: completed };
    }
  },
  {
    name: 'scroll', kind: 'screen', screen: true,
    description: 'Scroll the mouse wheel up, down, left, or right anywhere while looking/reading on screen (or over an optional x, y point). amount is wheel notches (1-100, default 6).',
    parameters: { type: 'object', properties: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Direction to scroll ("down" to look lower on the page, "up" to go back up).' },
      amount: { type: 'integer', description: 'Wheel notches, 1-100 (default 6; use 12-25 for big scrolls).' },
      x: { type: 'integer', description: 'Optional horizontal position (0-1000) to hover before scrolling.' },
      y: { type: 'integer', description: 'Optional vertical position (0-1000) to hover before scrolling.' }
    }, required: ['direction'] },
    describe: (a) => 'Scroll ' + a.direction + ' (' + (a.amount || 6) + ' notches)' + (a.x !== undefined ? ' at (' + a.x + ', ' + a.y + ')' : ''),
    async run(a, ctx) {
      let curDip = null;
      if (a.x !== undefined && a.y !== undefined) {
        const m = await pointer(ctx, a.x, a.y, 1000, 'scroll');
        curDip = m.dip;
      } else {
        let fgBox = null;
        if (ctx.automation && typeof ctx.automation.foreground === 'function') {
          const fg = await ctx.automation.foreground().catch(() => null);
          const isBrief = fg && (/^(?:locally|brief|electron)$/i.test(String(fg.process || '').trim()) || /^(?:brief|locally)$/i.test(String(fg.title || '').trim()));
          if (fg && !isBrief && fg.rect) {
            const nums = typeof fg.rect === 'string' ? fg.rect.split(',').map((n) => Number(n.trim())) : [];
            if (nums.length === 4 && nums.every(isFinite) && (nums[2] - nums[0]) > 80) {
              fgBox = { x: Math.round((nums[0] + nums[2]) / 2), y: Math.round((nums[1] + nums[3]) / 2) };
            }
          }
        }
        if (fgBox) {
          const dip = ctx.screen.nativeToDip(fgBox.x, fgBox.y);
          ctx.cursor({ x: dip.x, y: dip.y, ms: 160, kind: 'move', label: 'Scroll ' + a.direction });
          await ctx.automation.move(fgBox.x, fgBox.y, 160).catch(() => {});
          curDip = dip;
        } else {
          const m = await pointer(ctx, 500, 500, 1000, 'scroll');
          curDip = m.dip;
        }
      }
      ctx.cursor({ x: curDip.x, y: curDip.y, kind: 'scroll', direction: a.direction });
      const { dx, dy } = scrollNotches(a.direction, a.amount || 6);
      const vSign = Math.sign(dy);
      const hSign = Math.sign(dx);
      let remV = Math.abs(dy);
      let remH = Math.abs(dx);
      while (remV > 0 || remH > 0) {
        if (ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
        const chunkV = Math.min(12, remV) * vSign;
        const chunkH = Math.min(12, remH) * hSign;
        await ctx.automation.scroll(chunkH, chunkV);
        remV -= Math.abs(chunkV);
        remH -= Math.abs(chunkH);
        if (remV > 0 || remH > 0) await sleep(60);
      }
      return { scrolled: a.direction, notches: Math.abs(dx || dy) };
    }
  },
  {
    name: 'type_text', kind: 'screen', screen: true,
    description: 'Type text visibly character-by-character into any editor, code file, search box, or input field so the user can clearly watch the typing animation. Uses real Enter in code editors/IDEs and Shift+Enter in chat inputs. Pass clear_first=true to Ctrl+A + Delete old text first, or mode="paste" ONLY when explicitly asked to paste via Ctrl+V.',
    parameters: { type: 'object', properties: {
      text: { type: 'string', description: 'Exact text or code to type visibly.' },
      target: { type: 'string', description: 'Name/label of the editor, search box, or text field to focus & click first (e.g. "Editor", "Search", "Address and search bar").' },
      x: { type: 'integer', description: 'Optional: click here first (0-1000).' },
      y: { type: 'integer', description: 'Optional: click here first (0-1000).' },
      mode: { type: 'string', enum: ['type', 'auto', 'paste'], description: 'type / auto (default: visible character-by-character typing animation), or paste (Ctrl+V only when explicitly requested).' },
      soft_newline: { type: 'boolean', description: 'Optional override: true = Shift+Enter for \\n (chat apps), false = real Enter for \\n (code editors). Auto-detected if omitted.' },
      clear_first: { type: 'boolean', description: 'Click, Ctrl+A, and Delete existing code/text before typing.' },
      press_enter: { type: 'boolean', description: 'Press Enter ONCE at the very end after the full text is typed.' }
    }, required: ['text'] },
    describe: (a) => (a.mode === 'paste' ? 'Paste "' : 'Type "') + truncateMiddle(a.text, 120) + '"' + (a.target ? ' into "' + a.target + '"' : (a.x !== undefined ? ' at (' + a.x + ', ' + a.y + ')' : ' into the focused field')) + (a.press_enter ? ' and press Enter' : ''),
    async run(a, ctx) {
      if (ctx.beforeScreenAction) await ctx.beforeScreenAction().catch(() => {});
      let targetHit = null;
      if (a.target) {
        targetHit = await findAndClickUiElement(ctx, { query: a.target, typeFilter: 'input' }) ||
          await findAndClickUiElement(ctx, { query: a.target, typeFilter: 'any' });
      }
      if (!targetHit && a.x !== undefined && a.y !== undefined) {
        const m = await pointer(ctx, a.x, a.y, 1000, 'click');
        ctx.cursor({ x: m.dip.x, y: m.dip.y, kind: 'click' });
        await ctx.automation.click('left', 1);
        await sleep(180);
      } else if (!targetHit && a.x === undefined && ctx.automation && typeof ctx.automation.foreground === 'function') {
        const fgNow = await ctx.automation.foreground().catch(() => null);
        if (isSelfOrDesktopForeground(fgNow)) {
          targetHit = await findAndClickUiElement(ctx, { query: 'search', typeFilter: 'input' }) ||
            await findAndClickUiElement(ctx, { typeFilter: 'input' });
        }
      }
      const fgBefore = await ensureTargetForeground(ctx, a.target || '');
      if (a.clear_first) { await ctx.automation.keys(IS_MAC ? 'cmd+a' : 'ctrl+a'); await sleep(90); await ctx.automation.keys('delete'); await sleep(90); }
      const willPaste = a.mode === 'paste';
      ctx.cursor({ kind: 'type', label: willPaste ? 'Pasting' : 'Typing' });
      const typeOpts = { mode: a.mode || 'type', targetHint: a.target || '' };
      if (typeof a.soft_newline === 'boolean') typeOpts.softNewline = a.soft_newline;
      const how = await typeText(ctx, a.text || '', typeOpts);
      if (a.press_enter) { await sleep(80); await ctx.automation.keys('enter'); }
      const finalFocus = (ctx.automation && typeof ctx.automation.focusedElement === 'function')
        ? await ctx.automation.focusedElement().catch(() => null)
        : null;
      return {
        typed_chars: String(a.text || '').length,
        method: how,
        pressed_enter: !!a.press_enter,
        foreground_window: fgBefore ? fgBefore.title : undefined,
        foreground_process: fgBefore ? fgBefore.process : undefined,
        clicked_element: targetHit && targetHit.element ? targetHit.element.name || targetHit.element.type : undefined,
        focused: finalFocus ? { type: finalFocus.type, name: finalFocus.name, canType: finalFocus.canType } : undefined
      };
    }
  },
  {
    name: 'press_keys', kind: 'screen', screen: true,
    description: 'Full real keyboard control: click into a target (optional x, y or target) and execute any single key, shortcut, or multi-step keyboard sequence — e.g. "ctrl+c" (copy), "ctrl+v" (paste), "ctrl+a" (select all), "delete" / "backspace" (remove selected code/snippet), "ctrl+f" (find), "ctrl+h" (find & replace), "ctrl+s" (save), "ctrl+z" (undo), "ctrl+x" (cut), "shift+enter" (soft newline), "pagedown", "pageup", "home", "end", "ctrl+home", "ctrl+end", "f5", "f8", arrows, or chained combos like sequence: ["ctrl+a", "delete"] or keys: "ctrl+a -> delete".',
    parameters: { type: 'object', properties: {
      keys: { type: 'string', description: 'Single key/combo joined with + (e.g. "ctrl+c", "ctrl+v", "ctrl+a", "ctrl+f", "ctrl+s", "delete", "backspace", "pagedown", "shift+enter") OR "->" chained combos like "ctrl+a -> delete" or "ctrl+a -> ctrl+c".' },
      sequence: { type: 'array', items: { type: 'string' }, description: 'Optional ordered list of key combos to execute step-by-step, e.g. ["ctrl+a", "delete"], ["ctrl+a", "ctrl+c"], ["ctrl+v", "ctrl+s"].' },
      target: { type: 'string', description: 'Optional: UI element/editor name to click & focus before pressing the keys.' },
      x: { type: 'integer', description: 'Optional: click here (0-1000) before pressing the keys (e.g. click code editor -> Ctrl+A -> Delete).' },
      y: { type: 'integer', description: 'Optional: click here (0-1000) before pressing the keys.' },
      repeat: { type: 'integer', description: 'How many times to repeat the key or sequence (default 1, max 30).' },
      delay_ms: { type: 'integer', description: 'Delay between keys in a sequence in ms (default 120ms).' },
      hold_ms: { type: 'integer', description: 'Optional: hold the key(s) down for this many milliseconds (up to 30000ms) for long press.' },
      long_press: { type: 'boolean', description: 'Set true to long-press the key (~2000ms).' }
    } },
    describe: (a) => {
      const h = resolveHoldMs(a, 0);
      const seqLabel = Array.isArray(a.sequence) && a.sequence.length ? a.sequence.join(' -> ') : (a.keys || '');
      const loc = a.target ? (' in "' + a.target + '"') : (a.x !== undefined && a.y !== undefined ? (' at (' + a.x + ', ' + a.y + ')') : '');
      return (h > 100 ? 'Long-press ' + seqLabel + ' (' + h + 'ms)' : ('Press ' + seqLabel + (a.repeat > 1 ? ' ×' + a.repeat : ''))) + loc;
    },
    dangerous: (a) => {
      const all = [];
      if (a && a.keys) all.push(String(a.keys));
      if (a && Array.isArray(a.sequence)) for (const k of a.sequence) all.push(String(k || ''));
      return all.some((s) => /shift\s*\+\s*(delete|del)\b|(delete|del)\s*\+\s*shift/i.test(s))
        ? 'Shift+Delete permanently deletes the selected item(s) in Explorer.'
        : null;
    },
    async run(a, ctx) {
      if (ctx.beforeScreenAction) await ctx.beforeScreenAction().catch(() => {});
      let clicked = null;
      if (a.target) {
        clicked = await findAndClickUiElement(ctx, { query: a.target, typeFilter: 'any' });
      }
      if (!clicked && a.x !== undefined && a.y !== undefined) {
        const m = await pointer(ctx, a.x, a.y, 1000, 'click');
        ctx.cursor({ x: m.dip.x, y: m.dip.y, kind: 'click', label: 'Focus for keys' });
        await ctx.automation.click('left', 1);
        await sleep(140);
      }
      const seq = [];
      if (Array.isArray(a.sequence) && a.sequence.length) {
        for (const item of a.sequence) {
          const clean = String(item || '').trim();
          if (clean) seq.push(clean);
        }
      } else if (a.keys) {
        const parts = String(a.keys).split(/\s*->\s*/).map((s) => s.trim()).filter(Boolean);
        for (const p of parts) seq.push(p);
      }
      if (!seq.length) throw new Error('press_keys requires either "keys" or a non-empty "sequence" array.');
      const holdMs = resolveHoldMs(a, 0);
      if (seq.length === 1 && holdMs > 100 && typeof ctx.automation.keyState === 'function') {
        ctx.cursor({ kind: 'type', label: 'Hold ' + seq[0] + ' ' + holdMs + 'ms' });
        await performKeyHold(ctx, seq[0], holdMs);
        return { held: seq[0], hold_ms: holdMs };
      }
      const n = Math.max(1, Math.min(30, Number(a.repeat) || 1));
      const stepDelay = Math.max(40, Math.min(1000, Number(a.delay_ms) || 120));
      const executed = [];
      for (let r = 0; r < n; r++) {
        for (let i = 0; i < seq.length; i++) {
          if (ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
          const combo = seq[i];
          ctx.cursor({ kind: 'type', label: combo });
          await ctx.automation.keys(combo, holdMs || 45);
          executed.push(combo);
          if (i < seq.length - 1 || r < n - 1) await sleep(stepDelay);
        }
      }
      return { pressed: seq.length === 1 ? seq[0] : seq, sequence: executed, times: n };
    }
  },
  {
    name: 'hold_key', kind: 'screen', screen: true,
    description: 'Hold down, long-press, or release any keyboard key or modifier combo ("w", "a", "s", "d", "space", "shift", "ctrl", "up", "down", "left", "right"). Use action="down" to keep holding while doing mouse/other actions, "up" to release, or "long_press" with duration_ms (default 2000ms, up to 30000ms).',
    parameters: { type: 'object', properties: {
      key: { type: 'string', description: 'Key name or combo to hold (e.g. "w", "space", "shift", "ctrl", "down", "e").' },
      action: { type: 'string', enum: ['down', 'up', 'long_press'], description: 'Keep holding ("down"), release ("up"), or hold for duration_ms and release ("long_press").' },
      duration_ms: { type: 'integer', description: 'Duration in milliseconds when action="long_press" (100-30000ms, default 2000).' },
      hold_ms: { type: 'integer', description: 'Alias for duration_ms.' }
    }, required: ['key', 'action'] },
    describe: (a) => (a.action === 'down' ? 'Hold key "' + a.key + '" down' : a.action === 'up' ? 'Release key "' + a.key + '"' : 'Long-press key "' + a.key + '" (' + resolveHoldMs(a, 2000) + 'ms)'),
    async run(a, ctx) {
      if (typeof ctx.automation.keyState !== 'function') throw new Error('Key hold is not supported by this automation backend.');
      const act = String(a.action || 'long_press').toLowerCase();
      ctx.cursor({ kind: 'type', label: (act === 'up' ? 'Release ' : 'Hold ') + a.key });
      if (act === 'down') {
        await ctx.automation.keyState(a.key, true);
        return { key: a.key, state: 'down' };
      }
      if (act === 'up') {
        await ctx.automation.keyState(a.key, false);
        return { key: a.key, state: 'up' };
      }
      const dur = resolveHoldMs(a, 2000);
      await performKeyHold(ctx, a.key, dur);
      return { key: a.key, long_pressed: true, duration_ms: dur };
    }
  },
  {
    name: 'open_app', kind: 'app',
    description: 'Launch an application by name (e.g. "File Explorer", "Notepad", "Chrome", "Word", "Visual Studio Code", "Settings") or by full path.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'App name or path.' } }, required: ['name'] },
    describe: (a) => 'Open the app "' + a.name + '"',
    async run(a, ctx) { const r = await launchApp(ctx, a.name); await sleep(800); return r; }
  },
  {
    name: 'focus_window', kind: 'app',
    description: 'Bring an already-open window to the front by part of its title or process name (e.g. "Notepad", "Chrome", "Documents", "Roblox Studio").',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    describe: (a) => 'Bring the "' + a.title + '" window to the front',
    async run(a, ctx) {
      const r = await ctx.automation.focusWindow(a.title);
      try {
        if (ctx.cursor && ctx.automation && typeof ctx.automation.foreground === 'function') {
          const fg = await ctx.automation.foreground().catch(() => null);
          if (fg && fg.rect) {
            const rp = String(fg.rect).split(',').map(Number);
            if (rp.length === 4 && rp.every(isFinite)) {
              const cx = Math.round((rp[0] + rp[2]) / 2);
              const cy = Math.round((rp[1] + rp[3]) / 2);
              const dip = (ctx.screen && typeof ctx.screen.nativeToDip === 'function') ? ctx.screen.nativeToDip(cx, cy) : { x: cx, y: cy };
              ctx.cursor({ kind: 'move', x: dip.x, y: dip.y, ms: 280, label: 'Focused ' + (fg.title || a.title) });
            }
          }
        }
      } catch (_) { /* ignore cursor error */ }
      await sleep(400);
      return r;
    }
  },
  {
    name: 'window_control', kind: 'app',
    description: 'Minimize (shrink), maximize, restore, or close an open application window by title or process name (e.g. Chrome, Visual Studio Code, Notepad). Protected: will never close Brief itself.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Window title substring or process name (e.g. "Chrome", "Code", "Notepad").' },
        action: { type: 'string', enum: ['minimize', 'maximize', 'restore', 'close'], description: 'Window operation to perform.' }
      },
      required: ['title', 'action']
    },
    describe: (a) => (a.action === 'minimize' ? 'Minimize' : a.action === 'maximize' ? 'Maximize' : a.action === 'close' ? 'Close' : 'Restore') + ' the "' + a.title + '" window',
    async run(a, ctx) { const r = await ctx.automation.controlWindow(a.title, a.action); await sleep(280); return r; }
  },
  {
    name: 'close_other_windows', kind: 'app',
    description: 'Minimize or close all other open desktop windows/apps EXCEPT the target window you want to focus on (and never closes Brief). Useful when cleaning distracting windows or going straight to a specific app.',
    parameters: {
      type: 'object',
      properties: {
        keep_title: { type: 'string', description: 'Window title or process name to KEEP open (e.g. "Chrome", "Roblox Studio", "YouTube"). Leave empty to minimize/close all non-Brief windows.' },
        action: { type: 'string', enum: ['minimize', 'close'], description: 'Whether to minimize (default) or close the other windows.' }
      },
      required: ['keep_title']
    },
    describe: (a) => ((a.action || 'minimize') === 'close' ? 'Close' : 'Minimize') + ' other windows except "' + (a.keep_title || 'desktop') + '"',
    async run(a, ctx) {
      const r = await ctx.automation.controlOtherWindows(a.keep_title || '', a.action || 'minimize');
      if (a.keep_title) await ctx.automation.focusWindow(a.keep_title).catch(() => {});
      await sleep(250);
      return r;
    }
  },
  {
    name: 'browser_tab', kind: 'app',
    description: 'Inspect, switch to, open, navigate, or close browser tabs (Chrome, Edge, Brave, Firefox, Opera). Use action="list" to see all open tab titles, "switch" to click into a specific tab by title, "close" to close a tab, "close_others" to close all other tabs except query, or "new"/"navigate" to open/load a URL in the browser.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'switch', 'close', 'close_others', 'new', 'navigate'], description: 'Tab operation to perform.' },
        query: { type: 'string', description: 'Tab title/keyword to match (for switch, close, or the tab to KEEP in close_others).' },
        url: { type: 'string', description: 'URL to open when action is "new" or "navigate".' },
        browser: { type: 'string', description: 'Optional browser process filter (e.g. "chrome", "msedge", "firefox", "brave").' }
      },
      required: ['action']
    },
    describe: (a) => {
      if (a.action === 'list') return 'List open browser tabs';
      if (a.action === 'switch') return 'Switch to browser tab "' + (a.query || '') + '"';
      if (a.action === 'close') return 'Close browser tab "' + (a.query || 'current') + '"';
      if (a.action === 'close_others') return 'Close other browser tabs except "' + (a.query || 'current') + '"';
      if (a.action === 'new') return 'Open a new browser tab' + (a.url ? ' (' + a.url + ')' : '');
      return 'Open ' + (a.url || '') + ' in the browser';
    },
    async run(a, ctx) {
      const act = String(a.action || 'list').toLowerCase();
      const q = String(a.query || '').trim().toLowerCase();
      const browserFilter = String(a.browser || '').trim().toLowerCase();
      const clickTabRect = async (tab) => {
        if (!tab || !tab.rect) return false;
        const parts = String(tab.rect).split(',').map((n) => Number(n.trim()));
        if (parts.length !== 4 || !parts.every(isFinite)) return false;
        const nx = Math.round((parts[0] + parts[2]) / 2);
        const ny = Math.round((parts[1] + parts[3]) / 2);
        const dip = ctx.screen.nativeToDip(nx, ny);
        const ms = Number(ctx.settings().cursorSpeedMs !== undefined ? ctx.settings().cursorSpeedMs : 200);
        ctx.cursor({ kind: 'move', x: dip.x, y: dip.y, ms, label: 'Tab: ' + String(tab.title || '').slice(0, 32) });
        await ctx.automation.move(nx, ny, ms);
        ctx.cursor({ kind: 'click', x: dip.x, y: dip.y, button: 'left', count: 1, label: 'Click tab' });
        await ctx.automation.click('left', 1);
        await sleep(220);
        return true;
      };
      const focusAnyBrowser = async () => {
        const wins = await ctx.automation.listWindows().catch(() => []);
        const bWin = wins.find((w) => {
          const p = String(w.process || '').toLowerCase();
          const t = String(w.title || '').toLowerCase();
          if (browserFilter && !(p.includes(browserFilter) || t.includes(browserFilter))) return false;
          return /chrome|msedge|brave|opera|firefox|vivaldi|arc/.test(p);
        });
        if (!bWin) return null;
        await ctx.automation.focusWindow(bWin.title || bWin.process);
        await sleep(220);
        return bWin;
      };

      if (act === 'list') {
        const tabs = await ctx.automation.listBrowserTabs(browserFilter);
        return { count: tabs.length, tabs: tabs.map((t) => ({ process: t.process, windowTitle: t.windowTitle, title: t.title, active: !!t.active })) };
      }
      if (act === 'new' || act === 'navigate') {
        const bWin = await focusAnyBrowser();
        let u = String(a.url || '').trim();
        if (!bWin) {
          if (!u) throw new Error('No open browser window found and no URL was provided.');
          if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
          await shell.openExternal(u);
          await sleep(1400);
          return { opened: u, mode: 'external' };
        }
        await ctx.automation.keys(IS_MAC ? (act === 'new' ? 'cmd+t' : 'cmd+l') : (act === 'new' ? 'ctrl+t' : 'ctrl+l'));
        await sleep(200);
        if (u) {
          if (!/^[a-z][a-z0-9+.-]*:/i.test(u) && /\./.test(u)) u = 'https://' + u;
          await typeText(ctx, u, { isCode: false });
          await sleep(100);
          await ctx.automation.keys('enter');
          await sleep(1000);
        }
        const fg = await ctx.automation.foreground().catch(() => ({}));
        return { ok: true, action: act, url: u, foreground: fg.title || bWin.title };
      }

      await focusAnyBrowser();
      if (act === 'switch') {
        if (!q) throw new Error('Specify query (tab title or keyword) to switch to.');
        const tabs = await ctx.automation.listBrowserTabs(browserFilter);
        const match = tabs.find((t) => String(t.title || '').toLowerCase().includes(q));
        if (match) {
          await ctx.automation.focusWindow(match.windowTitle || match.process).catch(() => {});
          await sleep(180);
          const clicked = await clickTabRect(match);
          if (clicked) {
            const fg = await ctx.automation.foreground().catch(() => ({}));
            return { switched: true, tab: match.title, method: 'click', foreground: fg.title || '' };
          }
        }
        // Fallback: Chrome/Edge Ctrl+Shift+A tab search
        await ctx.automation.keys(IS_MAC ? 'cmd+shift+a' : 'ctrl+shift+a');
        await sleep(260);
        await typeText(ctx, a.query, { isCode: false });
        await sleep(220);
        await ctx.automation.keys('enter');
        await sleep(350);
        const fg = await ctx.automation.foreground().catch(() => ({}));
        return { switched: fg.title ? fg.title.toLowerCase().includes(q) : true, tab: fg.title || a.query, method: 'tab_search' };
      }

      if (act === 'close') {
        const tabs = await ctx.automation.listBrowserTabs(browserFilter);
        if (q) {
          const match = tabs.find((t) => String(t.title || '').toLowerCase().includes(q));
          if (match) {
            await ctx.automation.focusWindow(match.windowTitle || match.process).catch(() => {});
            await sleep(150);
            await clickTabRect(match);
          }
        }
        await ctx.automation.keys(IS_MAC ? 'cmd+w' : 'ctrl+w');
        await sleep(240);
        const fg = await ctx.automation.foreground().catch(() => ({}));
        return { closed: q || 'active_tab', foreground: fg.title || '' };
      }

      if (act === 'close_others') {
        const closed = [];
        for (let iter = 0; iter < 25; iter++) {
          if (ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
          const tabs = await ctx.automation.listBrowserTabs(browserFilter);
          if (tabs.length <= 1) break;
          const keepMatch = q ? tabs.find((t) => String(t.title || '').toLowerCase().includes(q)) : (tabs.find((t) => t.active) || tabs[0]);
          const keepTitle = keepMatch ? keepMatch.title : '';
          const victim = tabs.find((t) => keepMatch ? (t.title !== keepTitle || t.rect !== keepMatch.rect) : !t.active);
          if (!victim) break;
          await ctx.automation.focusWindow(victim.windowTitle || victim.process).catch(() => {});
          await sleep(120);
          const didClick = await clickTabRect(victim);
          if (!didClick) break;
          await ctx.automation.keys(IS_MAC ? 'cmd+w' : 'ctrl+w');
          closed.push(victim.title);
          await sleep(200);
        }
        if (q) {
          const rem = await ctx.automation.listBrowserTabs(browserFilter);
          const keep = rem.find((t) => String(t.title || '').toLowerCase().includes(q));
          if (keep) await clickTabRect(keep);
        }
        const fg = await ctx.automation.foreground().catch(() => ({}));
        return { closedCount: closed.length, closedTabs: closed, activeForeground: fg.title || '' };
      }
      throw new Error('Unknown browser_tab action: ' + a.action);
    }
  },
  {
    name: 'list_windows', kind: 'info', observe: true,
    description: 'List the visible top-level windows (title, process, state). Useful to find what is open.',
    parameters: { type: 'object', properties: {} },
    describe: () => 'List open windows',
    async run(a, ctx) { const w = await ctx.automation.listWindows(); return { count: w.length, windows: w.slice(0, 60) }; }
  },
  {
    name: 'switch_display', kind: 'info', observe: true,
    description: 'Switch which monitor the screenshots and coordinates refer to (multi-monitor setups). Index from get_system_info.',
    parameters: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] },
    describe: (a) => 'Switch to display #' + a.index,
    async run(a, ctx) { const d = ctx.screen.setCurrentDisplayByIndex(Number(a.index)); return { display: Number(a.index), bounds: d.bounds, scaleFactor: d.scaleFactor }; }
  },
  {
    name: 'take_screenshot', kind: 'info', observe: true,
    description: 'Capture a fresh screenshot of the current display (one is attached automatically after every action).',
    parameters: { type: 'object', properties: {} },
    describe: () => 'Take a screenshot',
    async run() { return { note: 'A fresh screenshot is attached.' }; }
  },
  {
    name: 'wait', kind: 'info', observe: true,
    description: 'Wait briefly (0.5 to 300 seconds) while displaying live watching cursor status, then get a fresh screenshot. For terminals, flashing, rendering, video generation, downloads, installs, or waiting on another AI agent, prefer watch_and_wait instead so Brief watches actively for completion or errors.',
    parameters: { type: 'object', properties: {
      seconds: { type: 'number', description: '0.5 to 300 seconds (up to 5 minutes).' },
      reason: { type: 'string', description: 'Short label of what you are waiting for (shown next to cursor).' }
    }, required: ['seconds'] },
    describe: (a) => 'Wait ' + a.seconds + 's' + (a.reason ? ' (' + a.reason + ')' : ''),
    async run(a, ctx) {
      const ms = Math.max(500, Math.min(300000, Number(a.seconds || 1) * 1000));
      const reason = String(a.reason || 'loading').trim().slice(0, 34);
      const start = Date.now();
      const end = start + ms;
      let tick = 0;
      let lastEmit = 0;
      while (Date.now() < end) {
        if (ctx.isStopped()) throw new Error('Stopped by user.');
        const now = Date.now();
        if (now - lastEmit >= 2000) {
          lastEmit = now;
          const emoji = pickWatchEmoji(Math.floor((now - start) / 10000) + tick);
          const lbl = `${emoji} Waiting (${reason})… ${formatWatchElapsed(now - start)}`;
          if (ctx.cursor && !ctx.isBackground) ctx.cursor({ kind: 'watch', label: lbl });
          if (ctx.setStatus) ctx.setStatus({ state: 'watching', stepText: lbl });
          tick++;
        }
        await sleep(250);
      }
      return { waited_ms: ms, reason };
    }
  },
  {
    name: 'watch_and_wait', kind: 'info', observe: true,
    description: 'Stay PATIENTLY and quietly watch ANY running process (Claude AI reading/thinking, ChatGPT, any other AI agent, terminal command, BalenaEtcher, Rufus, OS flasher/validator, AI video generator, installer, download, or build) until the REAL final result, a permission prompt (supports granting 3–16 permissions in a row!), or an error appears. Supports up to 240 minutes (4 hours!) with zero extra LLM calls and zero "I am still waiting" chat spam, showing wholesome watching+snack cursor emojis (👀🍿 / 👀🍕 / 👀☕). Works in BOTH Background and Live Visible modes!',
    parameters: { type: 'object', properties: {
      reason: { type: 'string', description: 'What Brief is watching (e.g. "Claude AI working", "terminal build", "BalenaEtcher/Rufus flashing & validating", "AI video generation").' },
      session_id: { type: 'string', description: 'Optional terminal session_id from terminal_open or run_command(background=true) to monitor directly.' },
      max_wait_minutes: { type: 'number', description: 'Max minutes to stay and watch patiently (default 30, min 1, max 240 = 4 hours). Stays silently up to 30m per cycle so it never interrupts prematurely!' },
      check_interval_sec: { type: 'number', description: 'Seconds between screen/terminal checks (default 8, min 3, max 45).' },
      done_keywords: { type: 'array', items: { type: 'string' }, description: 'Optional words/phrases indicating true final completion (e.g. ["Flash Complete", "READY", "Finished", "Video ready"]).' },
      error_keywords: { type: 'array', items: { type: 'string' }, description: 'Optional words/phrases indicating an error, denial, or crash needing immediate intervention.' },
      watch_mode: { type: 'string', enum: ['auto', 'screen', 'terminal', 'both'], description: 'What to watch: "auto" (terminal+screen if session_id given, else screen), "terminal", "screen", or "both".' }
    }, required: ['reason'] },
    describe: (a) => '👀🍿 Stay & watch patiently: ' + String(a.reason || 'running process').slice(0, 64),
    async run(a, ctx) {
      const reason = String(a.reason || 'process').trim().slice(0, 44);
      const sessionId = String(a.session_id || '').trim();
      const reqMaxMin = Math.max(1, Math.min(240, Number(a.max_wait_minutes) || 30));
      // Stay quietly up to 30 full minutes per cycle (so 16–30 min jobs finish smoothly with ZERO impatient wake-ups; multi-hour jobs up to 4h checkpoint cleanly every 30m!)
      const cycleBudgetMs = Math.min(reqMaxMin * 60 * 1000, 30 * 60 * 1000);
      const baseIntervalMs = Math.max(3, Math.min(45, Number(a.check_interval_sec) || 8)) * 1000;
      const doneKws = Array.isArray(a.done_keywords) ? a.done_keywords : [];
      const errorKws = Array.isArray(a.error_keywords) ? a.error_keywords : [];
      const rawMode = String(a.watch_mode || 'auto').toLowerCase();
      const watchTerminal = !!sessionId && (rawMode === 'auto' || rawMode === 'terminal' || rawMode === 'both');
      const watchScreen = !watchTerminal || rawMode === 'both' || rawMode === 'screen';

      const started = Date.now();
      const deadline = started + cycleBudgetMs;
      let prevShot = (watchScreen && ctx.screen) ? await ctx.screen.capture({ format: 'jpeg' }).catch(() => null) : null;
      let sess = sessionId ? TERMINAL_SESSIONS.get(sessionId) : null;
      let lastTermLen = sess ? String(sess.output || '').length : 0;
      let sawActivity = false;
      let settledSince = 0;
      let checks = 0;
      let emojiIdx = Math.floor(Math.random() * WATCH_SNACK_EMOJIS.length);
      let lastEmojiSwap = started;
      let lastTextSnippet = '';
      let lastLoadingSignal = '';

      const emitWatchBanner = (extraNote) => {
        const now = Date.now();
        if (now - lastEmojiSwap >= 14000) {
          emojiIdx = (emojiIdx + 1) % WATCH_SNACK_EMOJIS.length;
          lastEmojiSwap = now;
        }
        const emoji = pickWatchEmoji(emojiIdx);
        const elap = formatWatchElapsed(now - started);
        const label = `${emoji} Watching ${reason}${extraNote ? ' · ' + extraNote : ''} (${elap})`;
        if (ctx.cursor && !ctx.isBackground) {
          ctx.cursor({ kind: 'watch', label: label.slice(0, 62) });
        }
        if (ctx.setStatus) {
          ctx.setStatus({ state: 'watching', stepText: label });
        }
      };

      emitWatchBanner('patiently');

      while (Date.now() < deadline) {
        if (ctx.isStopped()) throw new Error('Stopped by user.');
        // Adaptive sleep: responsive 250ms stop checks while waiting baseIntervalMs
        const elapsedNow = Date.now() - started;
        const intervalMs = elapsedNow > 240000 ? Math.min(22000, Math.round(baseIntervalMs * 1.5)) : baseIntervalMs;
        const nextCheckAt = Math.min(deadline, Date.now() + intervalMs);
        while (Date.now() < nextCheckAt) {
          if (ctx.isStopped()) throw new Error('Stopped by user.');
          emitWatchBanner(lastLoadingSignal || '');
          await sleep(Math.min(1000, Math.max(200, nextCheckAt - Date.now())));
        }
        if (ctx.isStopped()) throw new Error('Stopped by user.');
        checks++;

        // 1) Monitor background/interactive terminal session if provided
        if (watchTerminal) {
          sess = TERMINAL_SESSIONS.get(sessionId);
          if (!sess) {
            return {
              ok: true,
              outcome: 'terminal_closed',
              reason,
              watched_duration: formatWatchElapsed(Date.now() - started),
              checks,
              note: 'Terminal session ' + sessionId + ' is no longer active. Verify and test the real final result now.'
            };
          }
          const fullOut = String(sess.output || '');
          const delta = fullOut.slice(lastTermLen);
          if (delta.trim().length > 0) {
            sawActivity = true;
            settledSince = 0;
            lastTermLen = fullOut.length;
          }
          const termSig = analyzeWatchText(delta || fullOut.slice(-2500), doneKws, errorKws);
          if (!sess.running) {
            const okExit = sess.exitCode === 0;
            return {
              ok: okExit,
              outcome: okExit ? 'process_exited_ok' : 'process_exited_error',
              reason,
              session_id: sessionId,
              exit_code: sess.exitCode,
              watched_duration: formatWatchElapsed(Date.now() - started),
              checks,
              output_tail: truncateMiddle(fullOut.slice(-10000), 10000),
              note: okExit
                ? 'Terminal command finished with exit code 0! Now TEST and verify the real final outcome before declaring done.'
                : 'Terminal command exited with error code ' + sess.exitCode + '! Inspect stderr/output, diagnose what went wrong, fix or honestly tell the user.'
            };
          }
          if (termSig.hasPermissionPrompt) {
            return {
              ok: true,
              outcome: 'permission_prompt',
              source: 'terminal',
              matched: termSig.permissionHit,
              reason,
              session_id: sessionId,
              running: true,
              watched_duration: formatWatchElapsed(Date.now() - started),
              checks,
              output_tail: truncateMiddle(fullOut.slice(-6000), 6000),
              note: 'Terminal is asking for permission/confirmation ("' + termSig.permissionHit + '")! Respond with terminal_send (e.g. y / Enter) and IMMEDIATELY call watch_and_wait again — do NOT stop after granting 1 permission (supports up to 16 permission grants)!'
            };
          }
          if (termSig.hasError) {
            return {
              ok: false,
              outcome: 'alert_detected',
              source: 'terminal',
              matched: termSig.errorHit,
              reason,
              session_id: sessionId,
              running: true,
              watched_duration: formatWatchElapsed(Date.now() - started),
              checks,
              output_tail: truncateMiddle(fullOut.slice(-8000), 8000),
              note: 'Detected error/failure ("' + termSig.errorHit + '") in terminal output while watching! Inspect and fix or report honestly.'
            };
          }
          if (termSig.isDone && !termSig.isLoading) {
            return {
              ok: true,
              outcome: 'completed',
              source: 'terminal',
              matched: termSig.doneHit,
              reason,
              session_id: sessionId,
              running: sess.running,
              watched_duration: formatWatchElapsed(Date.now() - started),
              checks,
              output_tail: truncateMiddle(fullOut.slice(-8000), 8000),
              note: 'Detected completion signal "' + termSig.doneHit + '" in terminal! Now TEST and verify the actual final result.'
            };
          }
          if (termSig.loadingHit) lastLoadingSignal = termSig.loadingHit.slice(0, 18);
        }

        // 2) Monitor live screen visuals + OCR + UIA (Claude AI, ChatGPT, other AI agents, terminals, BalenaEtcher, Rufus, video generators, installers)
        if (watchScreen && ctx.screen) {
          const curShot = await ctx.screen.capture({ format: 'jpeg' }).catch(() => null);
          const diffPct = quickShotDiffPct(prevShot, curShot);
          prevShot = curShot || prevShot;
          const screenText = await sampleForegroundTextForWatch(ctx);
          lastTextSnippet = screenText.slice(0, 1800);
          const sig = analyzeWatchText(screenText, doneKws, errorKws);

          if (diffPct !== null && diffPct >= 0.25) {
            sawActivity = true;
            settledSince = 0;
          }
          if (sig.isLoading) {
            sawActivity = true;
            settledSince = 0;
            lastLoadingSignal = sig.loadingHit.slice(0, 18);
          } else {
            lastLoadingSignal = '';
          }

          // Immediate wake on permission / approval prompt (so Brief keeps granting permissions 1..16 and immediately resumes watching!)
          if (sig.hasPermissionPrompt && !sig.isDone) {
            return {
              ok: true,
              outcome: 'permission_prompt',
              source: 'screen',
              matched: sig.permissionHit,
              reason,
              watched_duration: formatWatchElapsed(Date.now() - started),
              checks,
              visual_diff_pct: diffPct,
              screen_text_excerpt: lastTextSnippet,
              note: 'Permission / approval prompt detected ("' + sig.permissionHit + '")! Grant it (click Allow / Approve / Accept / Proceed / Yes / Open Folder) and IMMEDIATELY call watch_and_wait again — NEVER stop after granting 1 permission (apps & AI agents commonly ask 3–16 times)!'
            };
          }

          // Immediate wake on real error / failure / denial / crash!
          if (sig.hasError && !sig.isDone) {
            return {
              ok: false,
              outcome: 'alert_detected',
              source: 'screen',
              matched: sig.errorHit,
              reason,
              watched_duration: formatWatchElapsed(Date.now() - started),
              checks,
              visual_diff_pct: diffPct,
              screen_text_excerpt: lastTextSnippet,
              note: 'Error / Failure detected on screen ("' + sig.errorHit + '") while watching! Inspect the attached fresh screenshot carefully to diagnose, fix/retry, or honestly report it.'
            };
          }

          // Wake on confirmed completion ONLY when active loading/reading/thinking/flashing/validating is completely finished!
          if (sig.isDone && !sig.isLoading && (Date.now() - started) >= 5000) {
            return {
              ok: true,
              outcome: 'completed',
              source: 'screen',
              matched: sig.doneHit,
              reason,
              watched_duration: formatWatchElapsed(Date.now() - started),
              checks,
              visual_diff_pct: diffPct,
              screen_text_excerpt: lastTextSnippet,
              note: 'Completion signal "' + sig.doneHit + '" detected on screen and loading stopped! Now TEST & VERIFY the actual final output/drive/files/app before saying done (do NOT just assume it worked!).'
            };
          }

          // Be TRULY PATIENT: only wake on stillness after 3–4 FULL MINUTES (180s–240s) of ZERO pixel change AND ZERO loading/reading/thinking/progress signals!
          if (!sig.isLoading && (diffPct === null || diffPct < 0.2)) {
            if (!settledSince) settledSince = Date.now();
            const stillMs = Date.now() - settledSince;
            const settleThresholdMs = sawActivity ? 180000 : 240000;
            if (stillMs >= settleThresholdMs) {
              return {
                ok: true,
                outcome: 'settled_verify',
                source: 'screen',
                reason,
                watched_duration: formatWatchElapsed(Date.now() - started),
                checks,
                visual_diff_pct: diffPct,
                screen_text_excerpt: lastTextSnippet,
                note: 'Screen stayed completely unchanged with no loading/progress indicators for ' + formatWatchElapsed(stillMs) + '. Inspect the fresh screenshot closely: if the final result arrived, TEST & verify it; if a permission button or next step is waiting, click it; if still slowly running, call watch_and_wait again WITHOUT telling the user "I am still waiting"!'
              };
            }
          }
        }
      }

      // Clean 30-min checkpoint for multi-hour jobs (up to 4 hours total) — stay quiet, NEVER print "I am still waiting"!
      return {
        ok: true,
        outcome: 'checkpoint',
        reason,
        watched_duration: formatWatchElapsed(Date.now() - started),
        checks,
        still_loading_hint: lastLoadingSignal || 'check attached screenshot',
        screen_text_excerpt: lastTextSnippet,
        note: 'Silent 30m watch checkpoint reached (' + formatWatchElapsed(Date.now() - started) + '). DO NOT output a chat reply saying "I am still waiting"! Look at the fresh screenshot: if STILL loading/flashing/validating/reading/generating, immediately call watch_and_wait again (up to 4 hours total). If finished, TEST & verify the final result!'
      };
    }
  },

  /* ---------------- information ---------------- */
  {
    name: 'get_system_info', kind: 'info', observe: true,
    description: 'Get OS, user name, real paths of Home/Documents/Desktop/Downloads, and the connected displays.',
    parameters: { type: 'object', properties: {} },
    describe: () => 'Read system information',
    async run(a, ctx) {
      return {
        os: os.type() + ' ' + os.release() + ' (' + process.platform + ' ' + os.arch() + ')',
        user: os.userInfo().username,
        computer: os.hostname(),
        folders: knownFolders(),
        displays: ctx.screen.displays().map((d) => ({ index: d.index, primary: d.primary, physical: d.physical, scale: d.scaleFactor })),
        current_display: ctx.screen.displayIndex(ctx.screen.currentDisplay())
      };
    }
  },

  /* ---------------- files ---------------- */
  {
    name: 'list_directory', kind: 'file', readOnly: true,
    description: 'List the files and folders inside a folder. Accepts absolute paths or names like "Documents", "Desktop/Projects", "~/Downloads".',
    parameters: { type: 'object', properties: {
      path: { type: 'string' },
      show_hidden: { type: 'boolean' }
    }, required: ['path'] },
    describe: (a) => 'List the contents of ' + a.path,
    async run(a, ctx) {
      if (a.path && ctx && ctx.cursor) {
        const pStr = String(a.path);
        const fastTest = ctx.settings && ctx.settings().typingDelayMs === 0;
        let curr = '';
        for (let i = 0; i < pStr.length; i++) {
          if (ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
          curr += pStr[i];
          ctx.cursor({
            kind: 'type',
            char: pStr[i],
            text: curr.slice(-35),
            fullText: curr,
            label: 'Folder: ' + curr.slice(-25)
          });
          if (!fastTest) await sleep(Math.min(28, Math.max(12, Math.floor(380 / pStr.length))));
        }
      }
      const dir = resolvePath(a.path);
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const items = [];
      for (const e of entries) {
        if (!a.show_hidden && e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        let st = null;
        try { st = await fsp.stat(full); } catch (_) { /* broken link / permission */ }
        items.push({ name: e.name, type: e.isDirectory() ? 'folder' : 'file', size: st && !e.isDirectory() ? fmtSize(st.size) : '', modified: st ? st.mtime.toISOString().slice(0, 16).replace('T', ' ') : '' });
      }
      items.sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name) : x.type === 'folder' ? -1 : 1));
      return { path: dir, count: items.length, items: items.slice(0, 500), truncated: items.length > 500 };
    }
  },
  {
    name: 'search_files', kind: 'file', readOnly: true,
    description: 'Search the real disk for files/folders whose NAME contains the query (case-insensitive; supports * and ? wildcards and "a|b" alternatives). Optionally also search inside text files. Much faster and more reliable than clicking through Explorer.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Text to find in the name, e.g. "invoice", "*.pdf", "report|summary".' },
      root: { type: 'string', description: 'Folder to search (default: your home folder). E.g. "Documents".' },
      extensions: { type: 'array', items: { type: 'string' }, description: 'Optional extension filter, e.g. [".pdf", ".docx"].' },
      search_content: { type: 'boolean', description: 'Also look for the query inside text files (slower).' },
      include_folders: { type: 'boolean', description: 'Include matching folders (default true).' },
      max_results: { type: 'integer', description: 'Default 200.' },
      max_depth: { type: 'integer', description: 'How deep to recurse (default 15).' }
    }, required: ['query'] },
    describe: (a) => 'Search ' + (a.root || 'your home folder') + ' for "' + a.query + '"' + (a.search_content ? ' (names and contents)' : ''),
    async run(a, ctx) {
      if (a.query && ctx && ctx.cursor) {
        const qStr = String(a.query);
        const fastTest = ctx.settings && ctx.settings().typingDelayMs === 0;
        let curr = '';
        for (let i = 0; i < qStr.length; i++) {
          if (ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
          curr += qStr[i];
          ctx.cursor({
            kind: 'type',
            char: qStr[i],
            text: curr.slice(-35),
            fullText: curr,
            label: 'Search: ' + curr.slice(-25)
          });
          if (!fastTest) await sleep(Math.min(30, Math.max(12, Math.floor(400 / qStr.length))));
        }
      }
      const root = resolvePath(a.root || '~');
      const match = makeMatcher(a.query);
      const exts = (a.extensions || []).map((e) => (String(e).startsWith('.') ? String(e) : '.' + e).toLowerCase());
      const max = Math.max(1, Math.min(2000, Number(a.max_results) || 200));
      const maxDepth = Math.max(0, Math.min(40, a.max_depth === undefined ? 15 : Number(a.max_depth)));
      const includeFolders = a.include_folders !== false;
      const contentNeedle = a.search_content ? String(a.query).toLowerCase().replace(/[*?]/g, '') : '';
      const started = Date.now();
      const deadline = started + 30000;
      const results = [];
      let scanned = 0;
      let skipped = 0;
      let timedOut = false;
      const queue = [{ dir: root, depth: 0 }];
      const rootLower = root.toLowerCase();
      while (queue.length && results.length < max) {
        if (ctx.isStopped()) throw new Error('Stopped by user.');
        if (Date.now() > deadline) { timedOut = true; break; }
        const { dir, depth } = queue.shift();
        let handle;
        try { handle = await fsp.opendir(dir); } catch (_) { skipped++; continue; }
        try {
          for await (const ent of handle) {
            scanned++;
            const full = path.join(dir, ent.name);
            const lowerName = ent.name.toLowerCase();
            if (ent.isDirectory()) {
              if (SKIP_DIRS.has(lowerName)) continue;
              if (lowerName === 'appdata' && !rootLower.includes('appdata')) continue;
              if (includeFolders && !exts.length && match(ent.name)) results.push({ path: full, name: ent.name, type: 'folder' });
              if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
            } else if (ent.isFile() || ent.isSymbolicLink()) {
              const ext = path.extname(ent.name).toLowerCase();
              if (exts.length && !exts.includes(ext)) continue;
              let hit = match(ent.name);
              let where = 'name';
              if (!hit && contentNeedle && TEXT_EXT.has(ext)) {
                try {
                  const st = await fsp.stat(full);
                  if (st.size < 2 * 1024 * 1024) {
                    const txt = (await fsp.readFile(full, 'utf8')).toLowerCase();
                    if (txt.includes(contentNeedle)) { hit = true; where = 'content'; }
                  }
                } catch (_) { /* unreadable */ }
              }
              if (hit) {
                let st = null;
                try { st = await fsp.stat(full); } catch (_) { /* ignore */ }
                results.push({ path: full, name: ent.name, type: 'file', size: st ? fmtSize(st.size) : '', modified: st ? st.mtime.toISOString().slice(0, 10) : '', matched_in: where });
              }
            }
            if (results.length >= max) break;
          }
        } catch (_) { skipped++; }
      }
      return { root, query: a.query, count: results.length, results, scanned_entries: scanned, unreadable_folders: skipped, timed_out: timedOut, limit_reached: results.length >= max, seconds: ((Date.now() - started) / 1000).toFixed(1) };
    }
  },
  {
    name: 'project_tree', kind: 'file', readOnly: true,
    description: 'Inspect a project or folder structure cleanly as an indented tree (skipping node_modules and .git). Ideal before editing code.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Folder path, e.g. "Desktop/my-app".' },
      max_depth: { type: 'integer', description: 'Depth limit (default 3, max 6).' }
    }, required: ['path'] },
    describe: (a) => 'Inspect folder tree of ' + a.path,
    async run(a) {
      const root = resolvePath(a.path);
      const maxDepth = Math.max(1, Math.min(6, Number(a.max_depth) || 3));
      const lines = [];
      let count = 0;
      async function walk(dir, prefix, depth) {
        if (count >= 400 || depth > maxDepth) return;
        let ents;
        try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
        ents = ents.filter((e) => !SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')).sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name) : x.isDirectory() ? -1 : 1));
        for (const e of ents) {
          if (count >= 400) break;
          count++;
          lines.push(prefix + (e.isDirectory() ? '📁 ' : '📄 ') + e.name);
          if (e.isDirectory() && depth < maxDepth) {
            await walk(path.join(dir, e.name), prefix + '  ', depth + 1);
          }
        }
      }
      await walk(root, '', 1);
      return { root, entries: count, truncated: count >= 400, tree: lines.join('\n') };
    }
  },
  {
    name: 'grep_files', kind: 'file', readOnly: true,
    description: 'Search inside code and text files in a folder for an exact substring or regex, returning file paths, line numbers, and matching lines.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Text or regex pattern to find.' },
      root: { type: 'string', description: 'Folder to search.' },
      regex: { type: 'boolean', description: 'Treat query as regular expression (default false).' },
      max_matches: { type: 'integer', description: 'Default 80.' }
    }, required: ['query', 'root'] },
    describe: (a) => 'Search code/text inside ' + a.root + ' for "' + a.query + '"',
    async run(a, ctx) {
      const root = resolvePath(a.root);
      const max = Math.max(1, Math.min(300, Number(a.max_matches) || 80));
      const re = a.regex ? new RegExp(a.query, 'i') : null;
      const needle = a.regex ? '' : String(a.query || '').toLowerCase();
      const matches = [];
      const queue = [root];
      while (queue.length && matches.length < max) {
        if (ctx.isStopped()) throw new Error('Stopped by user.');
        const dir = queue.shift();
        let ents;
        try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
        for (const e of ents) {
          if (SKIP_DIRS.has(e.name.toLowerCase()) || e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { queue.push(full); continue; }
          if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
          try {
            const st = await fsp.stat(full);
            if (st.size > 1024 * 1024) continue;
            const lines = (await fsp.readFile(full, 'utf8')).split('\n');
            for (let i = 0; i < lines.length; i++) {
              const hit = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needle);
              if (hit) {
                matches.push({ file: path.relative(root, full), path: full, line: i + 1, text: lines[i].trim().slice(0, 220) });
                if (matches.length >= max) break;
              }
            }
          } catch (_) { /* ignore unreadable */ }
        }
      }
      return { root, query: a.query, count: matches.length, matches };
    }
  },
  {
    name: 'read_file', kind: 'file', readOnly: true,
    description: 'Read a text file from disk (code, notes, CSV, JSON, logs...). Returns up to max_chars characters starting at offset.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' }, offset: { type: 'integer' }, max_chars: { type: 'integer', description: 'Default 20000, max 100000.' }
    }, required: ['path'] },
    describe: (a) => 'Read the file ' + a.path,
    async run(a) {
      const p = resolvePath(a.path);
      const st = await fsp.stat(p);
      if (st.isDirectory()) throw new Error(p + ' is a folder. Use list_directory.');
      const fd = await fsp.open(p, 'r');
      try {
        const probe = Buffer.alloc(Math.min(8192, st.size));
        await fd.read(probe, 0, probe.length, 0);
        if (probe.includes(0)) return { path: p, size: fmtSize(st.size), binary: true, note: 'Binary file (' + path.extname(p) + '); open it with open_path to view it in its app.' };
      } finally { await fd.close(); }
      const text = await fsp.readFile(p, 'utf8');
      const off = Math.max(0, Number(a.offset) || 0);
      const max = Math.max(100, Math.min(100000, Number(a.max_chars) || 20000));
      return { path: p, size: fmtSize(st.size), total_chars: text.length, offset: off, content: text.slice(off, off + max), truncated: off + max < text.length };
    }
  },
  {
    name: 'write_file', kind: 'file',
    description: 'Create a file (documents, notes, code, HTML, CSV...) with the given text content. Parent folders are created. Set overwrite=true to replace an existing file.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' }, content: { type: 'string' }, overwrite: { type: 'boolean' }
    }, required: ['path', 'content'] },
    describe: (a) => (a.overwrite ? 'Write (overwrite) ' : 'Create ') + a.path + ' (' + String(a.content || '').length + ' characters)',
    async run(a, ctx) {
      const p = resolvePath(a.path);
      if (!a.overwrite && (await exists(p))) throw new Error(p + ' already exists. Pass overwrite=true to replace it, or choose another name.');
      await fsp.mkdir(path.dirname(p), { recursive: true });
      const contentStr = String(a.content || '');
      const isCode = isCodeContent(contentStr, p);
      if (ctx && ctx.cursor) {
        const fastTest = ctx.settings && ctx.settings().typingDelayMs === 0;
        if (isCode) {
          // Code exception: when writing or editing code, pasting is fine. Keep the visible mouse movement and clicks there.
          ctx.cursor({ kind: 'type', text: '[Code pasted]', fullText: contentStr, label: 'Paste: ' + path.basename(p) });
          if (!fastTest) await sleep(150);
        } else {
          const sliceLen = Math.min(contentStr.length, 100);
          let curr = '';
          for (let i = 0; i < sliceLen; i++) {
            if (ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
            curr += contentStr[i];
            ctx.cursor({ kind: 'type', char: contentStr[i], text: curr.slice(-35), fullText: curr, label: 'Typing: ' + curr.slice(-25) });
            if (!fastTest) await sleep(18);
          }
        }
      }
      await fsp.writeFile(p, contentStr, 'utf8');
      const st = await fsp.stat(p);
      const fastTest = ctx && ctx.settings && ctx.settings().typingDelayMs === 0;
      if (!fastTest && /\.(?:txt|md|html?|csv)$/i.test(p)) {
        try { await shell.openPath(p); } catch (_) { /* ignore */ }
      }
      return { written: p, size: fmtSize(st.size) };
    }
  },
  {
    name: 'edit_file', kind: 'file',
    description: 'Edit a text file by replacing an exact snippet with new text.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' }, find: { type: 'string', description: 'Exact existing text.' }, replace: { type: 'string' },
      replace_all: { type: 'boolean' }
    }, required: ['path', 'find', 'replace'] },
    describe: (a) => 'Edit ' + a.path + ': replace "' + truncateMiddle(a.find, 60) + '"',
    async run(a, ctx) {
      const p = resolvePath(a.path);
      const text = await fsp.readFile(p, 'utf8');
      const count = text.split(a.find).length - 1;
      if (count === 0) throw new Error('The text to replace was not found in ' + p + '. Read the file first and copy the snippet exactly.');
      const out = a.replace_all ? text.split(a.find).join(a.replace) : text.replace(a.find, () => a.replace);
      const isCode = isCodeContent(a.replace, p);
      if (ctx && ctx.cursor) {
        const fastTest = ctx.settings && ctx.settings().typingDelayMs === 0;
        if (isCode) {
          // Code exception: when writing or editing code, pasting is fine. Keep the visible mouse movement and clicks there.
          ctx.cursor({ kind: 'type', text: '[Code snippet pasted]', fullText: String(a.replace || ''), label: 'Paste edit: ' + path.basename(p) });
          if (!fastTest) await sleep(150);
        } else {
          const sliceLen = Math.min(String(a.replace || '').length, 100);
          let curr = '';
          for (let i = 0; i < sliceLen; i++) {
            if (ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
            curr += a.replace[i];
            ctx.cursor({ kind: 'type', char: a.replace[i], text: curr.slice(-35), fullText: curr, label: 'Typing: ' + curr.slice(-25) });
            if (!fastTest) await sleep(18);
          }
        }
      }
      await fsp.writeFile(p, out, 'utf8');
      return { edited: p, occurrences_found: count, replaced: a.replace_all ? count : 1 };
    }
  },
  {
    name: 'append_file', kind: 'file',
    description: 'Append text to the end of a file (creates it if missing).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    describe: (a) => 'Append ' + String(a.content || '').length + ' characters to ' + a.path,
    async run(a, ctx) {
      const p = resolvePath(a.path);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      const contentStr = String(a.content || '');
      const isCode = isCodeContent(contentStr, p);
      if (ctx && ctx.cursor) {
        const fastTest = ctx.settings && ctx.settings().typingDelayMs === 0;
        if (isCode) {
          ctx.cursor({ kind: 'type', text: '[Code appended]', fullText: contentStr, label: 'Append: ' + path.basename(p) });
          if (!fastTest) await sleep(150);
        } else {
          const sliceLen = Math.min(contentStr.length, 100);
          let curr = '';
          for (let i = 0; i < sliceLen; i++) {
            if (ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
            curr += contentStr[i];
            ctx.cursor({ kind: 'type', char: contentStr[i], text: curr.slice(-35), fullText: curr, label: 'Typing: ' + curr.slice(-25) });
            if (!fastTest) await sleep(18);
          }
        }
      }
      await fsp.appendFile(p, contentStr, 'utf8');
      return { appended: p };
    }
  },
  {
    name: 'create_folder', kind: 'file',
    description: 'Create a folder (and any missing parent folders).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    describe: (a) => 'Create the folder ' + a.path,
    async run(a) { const p = resolvePath(a.path); await fsp.mkdir(p, { recursive: true }); return { created: p }; }
  },
  {
    name: 'move_path', kind: 'file',
    description: 'Move a file or folder. If destination is an existing folder, the item is moved into it. Never overwrites: a free name like "file (1).txt" is chosen.',
    parameters: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' } }, required: ['source', 'destination'] },
    describe: (a) => 'Move ' + a.source + ' → ' + a.destination,
    async run(a) {
      const src = resolvePath(a.source);
      let dest = resolvePath(a.destination);
      try { if ((await fsp.stat(dest)).isDirectory()) dest = path.join(dest, path.basename(src)); } catch (_) { /* dest does not exist */ }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      dest = await uniquePath(dest);
      await movePath(src, dest);
      return { moved: src, to: dest };
    }
  },
  {
    name: 'rename_path', kind: 'file',
    description: 'Rename a file or folder in place.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, new_name: { type: 'string' } }, required: ['path', 'new_name'] },
    describe: (a) => 'Rename ' + a.path + ' to "' + a.new_name + '"',
    async run(a) {
      const src = resolvePath(a.path);
      if (/[\\/]/.test(a.new_name)) throw new Error('new_name must be a name, not a path. Use move_path to move.');
      const dest = path.join(path.dirname(src), a.new_name);
      if (await exists(dest)) throw new Error('"' + a.new_name + '" already exists in that folder.');
      await fsp.rename(src, dest);
      return { renamed: src, to: dest };
    }
  },
  {
    name: 'copy_path', kind: 'file',
    description: 'Copy a file or folder (recursively). If destination is an existing folder, copies into it.',
    parameters: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' }, overwrite: { type: 'boolean' } }, required: ['source', 'destination'] },
    describe: (a) => 'Copy ' + a.source + ' → ' + a.destination,
    async run(a) {
      const src = resolvePath(a.source);
      let dest = resolvePath(a.destination);
      try { if ((await fsp.stat(dest)).isDirectory()) dest = path.join(dest, path.basename(src)); } catch (_) { /* new path */ }
      if (!a.overwrite) dest = await uniquePath(dest);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.cp(src, dest, { recursive: true, force: !!a.overwrite, errorOnExist: !a.overwrite });
      return { copied: src, to: dest };
    }
  },
  {
    name: 'delete_path', kind: 'file',
    description: 'Delete a single file or folder. By default it goes to the Recycle Bin / Trash (recoverable). Never delete user root folders or unrelated files. permanent=true or deleting a whole folder ALWAYS requires explicit user confirmation.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, permanent: { type: 'boolean' } }, required: ['path'] },
    describe: (a) => (a.permanent ? 'PERMANENTLY delete ' : 'Move to the Recycle Bin: ') + a.path,
    dangerous: (a) => {
      if (a.permanent) return 'This permanently deletes the item. It will NOT go to the Recycle Bin and cannot be undone.';
      try {
        const p = resolvePath(a.path);
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return 'Deleting an entire folder requires explicit confirmation.';
      } catch (_) { /* ignore */ }
      return null;
    },
    async run(a) {
      const p = resolvePath(a.path);
      if (isProtectedRootPath(p)) throw new Error('Safety block: refusing to delete a drive root, system folder, or user library folder (' + p + ').');
      if (!(await exists(p))) throw new Error(p + ' does not exist.');
      if (a.permanent) { await fsp.rm(p, { recursive: true, force: false }); return { deleted_permanently: p }; }
      await shell.trashItem(p);
      return { moved_to_recycle_bin: p };
    }
  },
  {
    name: 'open_path', kind: 'app',
    description: 'Open a file with its default app, or open a folder in File Explorer / Finder, on the real desktop. E.g. "Documents".',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    describe: (a) => 'Open ' + a.path + ' on the desktop',
    async run(a) {
      const p = resolvePath(a.path);
      if (!(await exists(p))) throw new Error(p + ' does not exist.');
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
      await sleep(1200);
      return { opened: p };
    }
  },
  {
    name: 'reveal_in_folder', kind: 'app',
    description: 'Open the containing folder in Explorer/Finder with the item selected.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    describe: (a) => 'Show ' + a.path + ' in its folder',
    async run(a) { const p = resolvePath(a.path); shell.showItemInFolder(p); await sleep(1000); return { revealed: p }; }
  },
  {
    name: 'path_info', kind: 'file', readOnly: true,
    description: 'Get details about a file or folder (size, dates, type, item count).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    describe: (a) => 'Inspect ' + a.path,
    async run(a) {
      const p = resolvePath(a.path);
      const st = await fsp.stat(p);
      const out = { path: p, type: st.isDirectory() ? 'folder' : 'file', size: fmtSize(st.size), created: st.birthtime.toISOString(), modified: st.mtime.toISOString() };
      if (st.isDirectory()) { try { out.items = (await fsp.readdir(p)).length; } catch (_) { /* ignore */ } }
      else out.category = categoryOf(p);
      return out;
    }
  },
  {
    name: 'organize_folder', kind: 'file',
    description: 'Tidy a messy folder by moving its top-level files into subfolders by type (Images, Documents, Videos, Archives...), by extension, or by year-month of modification. Use dry_run=true first to preview the plan.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' },
      strategy: { type: 'string', enum: ['type', 'extension', 'date'] },
      dry_run: { type: 'boolean' }
    }, required: ['path'] },
    describe: (a) => (a.dry_run ? 'Preview organizing ' : 'Organize ') + a.path + ' by ' + (a.strategy || 'type'),
    async run(a, ctx) {
      const dir = resolvePath(a.path);
      const strategy = a.strategy || 'type';
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const plan = [];
      for (const e of entries) {
        if (!e.isFile() || e.name.startsWith('.') || /^desktop\.ini$/i.test(e.name)) continue;
        const full = path.join(dir, e.name);
        let folder;
        if (strategy === 'extension') folder = (path.extname(e.name).slice(1) || 'no-extension').toUpperCase();
        else if (strategy === 'date') { const st = await fsp.stat(full); folder = st.mtime.toISOString().slice(0, 7); }
        else folder = categoryOf(e.name);
        plan.push({ file: e.name, to: folder });
      }
      if (a.dry_run) {
        const summary = {};
        plan.forEach((p) => { summary[p.to] = (summary[p.to] || 0) + 1; });
        return { folder: dir, dry_run: true, files: plan.length, summary, plan: plan.slice(0, 300) };
      }
      const done = [];
      for (const item of plan) {
        if (ctx.isStopped()) break;
        const destDir = path.join(dir, item.to);
        await fsp.mkdir(destDir, { recursive: true });
        const dest = await uniquePath(path.join(destDir, item.file));
        await movePath(path.join(dir, item.file), dest);
        done.push({ file: item.file, to: path.relative(dir, dest) });
      }
      return { folder: dir, moved: done.length, of: plan.length, moves: done.slice(0, 300) };
    }
  },

  /* ---------------- code & full terminal / command prompt control ---------------- */
  {
    name: 'run_command', kind: 'command',
    description: 'Run a real Windows Command Prompt (shell="cmd") or PowerShell (shell="powershell") command with live streaming output. Supports one-shot commands, background dev servers/watchers (background=true returning a session_id for terminal_read/terminal_send/terminal_stop), or opening a visible Command Prompt window on desktop (open_window=true).',
    parameters: { type: 'object', properties: {
      command: { type: 'string', description: 'Exact command to run in Command Prompt or PowerShell.' },
      cwd: { type: 'string', description: 'Working folder (supports Desktop, Documents, Downloads, or full path; default: home).' },
      shell: { type: 'string', enum: ['cmd', 'powershell', 'bash'], description: 'Use "cmd" for Windows Command Prompt (cmd.exe) or "powershell" for PowerShell (default on Windows: powershell).' },
      background: { type: 'boolean', description: 'Set true for long-running servers/watchers/tasks to keep running in the background and return session_id.' },
      open_window: { type: 'boolean', description: 'Set true to launch a real visible Command Prompt / PowerShell window on the desktop.' },
      timeout_sec: { type: 'integer', description: 'Timeout in seconds for foreground commands (default 300 = 5 min, max 14400 = 4 hours).' }
    }, required: ['command'] },
    describe: (a) => 'Run in ' + (a.shell === 'cmd' ? 'Command Prompt' : (a.shell || (IS_WIN ? 'PowerShell' : 'bash'))) + (a.cwd ? ' (in ' + a.cwd + ')' : '') + ': ' + a.command,
    dangerous: (a) => (isPermanentDeleteCommand(a.command) ? 'This command looks like it permanently deletes files (deletions from the terminal skip the Recycle Bin).' : null),
    async run(a, ctx) {
      if (a.command && ctx && ctx.cursor) {
        const cmdStr = String(a.command);
        const fastTest = ctx.settings && ctx.settings().typingDelayMs === 0;
        let curr = '';
        for (let i = 0; i < cmdStr.length; i++) {
          if (ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
          curr += cmdStr[i];
          ctx.cursor({
            kind: 'type',
            char: cmdStr[i],
            text: curr.slice(-40),
            fullText: curr,
            label: 'Terminal: ' + curr.slice(-30)
          });
          if (!fastTest) await sleep(Math.min(24, Math.max(8, Math.floor(420 / Math.max(1, cmdStr.length)))));
        }
      }
      const cwd = a.cwd ? resolvePath(a.cwd) : os.homedir();
      const which = a.shell || (IS_WIN ? 'powershell' : 'bash');
      const shellLabel = which === 'cmd' ? 'CMD' : (which === 'bash' ? 'Bash' : 'PowerShell');

      if (IS_WIN && a.open_window) {
        const winArgs = which === 'cmd'
          ? ['/c', 'start', '"Brief Command Prompt"', '/D', cwd, 'cmd.exe', '/k', String(a.command || '')]
          : ['/c', 'start', '"Brief PowerShell"', '/D', cwd, 'powershell.exe', '-NoExit', '-Command', String(a.command || '')];
        spawn('cmd.exe', winArgs, { cwd, detached: true, windowsHide: false, stdio: 'ignore' }).unref();
        await sleep(900);
        return {
          ok: true,
          opened_window: true,
          still_running: true,
          shell: shellLabel,
          cwd,
          command: a.command,
          still_running_notice: 'IMPORTANT: The visible terminal window was just launched and is STILL LOADING/RUNNING! Do NOT declare finished yet — call watch_and_wait to stay and watch the terminal window until it clearly succeeds or errors, then verify the final output!'
        };
      }

      const emitStream = (chunk, streamName, extra) => {
        if (ctx && typeof ctx.onCommandOutput === 'function') {
          ctx.onCommandOutput(Object.assign({
            shell: shellLabel,
            command: String(a.command || ''),
            cwd,
            chunk: String(chunk || ''),
            stream: streamName || 'stdout',
            running: true
          }, extra || {}));
        } else if (ctx && typeof ctx.progress === 'function' && chunk) {
          ctx.progress(String(chunk));
        }
      };

      let exe;
      let args;
      if (IS_WIN && which === 'cmd') { exe = 'cmd.exe'; args = ['/d', '/s', '/c', a.command]; }
      else if (IS_WIN) { exe = 'powershell.exe'; args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference=\'SilentlyContinue\'; ' + a.command]; }
      else { exe = '/bin/bash'; args = ['-lc', a.command]; }

      if (a.background) {
        const sess = createTerminalSession({ exe, args, shell: shellLabel, command: String(a.command || ''), cwd, interactive: false, emitStream });
        if (ctx && ctx.registerProcess) ctx.registerProcess(sess.child);
        await sleep(Math.min(1800, Math.max(250, Number(a.wait_ms) || 700)));
        return {
          ok: true,
          background: true,
          session_id: sess.id,
          pid: sess.child.pid,
          shell: sess.shell,
          cwd: sess.cwd,
          running: sess.running,
          exit_code: sess.exitCode,
          output: truncateMiddle(sess.output, 12000),
          still_running_notice: sess.running ? 'This command is still running in background (session_id=' + sess.id + '). Call watch_and_wait({ reason, session_id: "' + sess.id + '" }) to stay and watch until it completes or errors!' : ''
        };
      }

      const limit = Math.max(5, Math.min(14400, Number(a.timeout_sec) || Number(ctx.settings().commandTimeoutSec) || 1080)) * 1000;
      const started = Date.now();
      emitStream('', 'meta', { running: true });
      let cmdWatchTick = 0;
      const cmdWatchIv = setInterval(() => {
        if (ctx.isStopped && ctx.isStopped()) return;
        const elapMs = Date.now() - started;
        if (elapMs < 2200) return;
        const emoji = pickWatchEmoji(Math.floor(elapMs / 12000) + cmdWatchTick);
        const lbl = `${emoji} Watching ${shellLabel}… (${formatWatchElapsed(elapMs)})`;
        if (ctx.cursor && !ctx.isBackground) ctx.cursor({ kind: 'watch', label: lbl });
        if (ctx.setStatus) ctx.setStatus({ state: 'watching', stepText: lbl });
        cmdWatchTick++;
      }, 2500);
      return await new Promise((resolve, reject) => {
        let out = '';
        let err = '';
        let timedOut = false;
        let child;
        try {
          child = spawn(exe, args, { cwd, windowsHide: true, detached: !IS_WIN, env: process.env });
        } catch (e) { clearInterval(cmdWatchIv); reject(e); return; }
        ctx.registerProcess(child);
        const timer = setTimeout(() => { timedOut = true; killTree(child); }, limit);
        child.stdout.on('data', (d) => {
          const s = d.toString('utf8');
          out += s;
          if (out.length > 400000) out = out.slice(-400000);
          emitStream(s, 'stdout', { running: true });
        });
        child.stderr.on('data', (d) => {
          const s = d.toString('utf8');
          err += s;
          if (err.length > 200000) err = err.slice(-200000);
          emitStream(s, 'stderr', { running: true });
        });
        child.on('error', (e) => { clearInterval(cmdWatchIv); clearTimeout(timer); ctx.unregisterProcess(child); reject(e); });
        child.on('close', (code) => {
          clearInterval(cmdWatchIv);
          clearTimeout(timer);
          ctx.unregisterProcess(child);
          emitStream('', 'meta', { running: false, exitCode: code });
          if (ctx.isStopped()) { reject(new Error('Stopped by user (process killed).')); return; }
          resolve({
            shell: shellLabel,
            command: a.command,
            exit_code: code,
            ok: code === 0 && !timedOut,
            timed_out: timedOut,
            cwd,
            duration_sec: ((Date.now() - started) / 1000).toFixed(1),
            stdout: truncateMiddle(out, 24000),
            stderr: truncateMiddle(err, 8000)
          });
        });
      });
    }
  },
  {
    name: 'terminal_open', kind: 'command',
    description: 'Open a persistent interactive Command Prompt (cmd.exe) or PowerShell terminal session that remembers its working directory, environment variables, and running state across multiple terminal_send commands.',
    parameters: { type: 'object', properties: {
      shell: { type: 'string', enum: ['cmd', 'powershell', 'bash'], description: 'Shell to open (default on Windows: cmd).' },
      cwd: { type: 'string', description: 'Starting working directory (default: home).' },
      initial_command: { type: 'string', description: 'Optional first command to run right after opening the terminal.' }
    } },
    describe: (a) => 'Open interactive ' + (a.shell === 'powershell' ? 'PowerShell' : 'Command Prompt') + (a.cwd ? ' in ' + a.cwd : ''),
    dangerous: (a) => (a.initial_command && isPermanentDeleteCommand(a.initial_command) ? 'The initial terminal command may permanently delete files.' : null),
    async run(a, ctx) {
      const cwd = a.cwd ? resolvePath(a.cwd) : os.homedir();
      const which = a.shell || (IS_WIN ? 'cmd' : 'bash');
      const shellLabel = which === 'powershell' ? 'PowerShell' : (which === 'bash' ? 'Bash' : 'CMD');
      const exe = IS_WIN ? (which === 'powershell' ? 'powershell.exe' : 'cmd.exe') : '/bin/bash';
      const args = IS_WIN
        ? (which === 'powershell' ? ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass'] : ['/Q', '/K'])
        : [];
      const emitStream = (chunk, streamName, extra) => {
        if (ctx && typeof ctx.onCommandOutput === 'function') {
          ctx.onCommandOutput(Object.assign({
            shell: shellLabel,
            command: a.initial_command || ('open ' + shellLabel),
            cwd,
            chunk: String(chunk || ''),
            stream: streamName || 'stdout',
            running: true
          }, extra || {}));
        }
      };
      const sess = createTerminalSession({ exe, args, shell: shellLabel, command: a.initial_command || shellLabel, cwd, interactive: true, emitStream });
      if (ctx && ctx.registerProcess) ctx.registerProcess(sess.child);
      if (a.initial_command) {
        await sleep(160);
        sess.child.stdin.write(String(a.initial_command) + '\r\n');
      }
      await sleep(550);
      return {
        ok: true,
        session_id: sess.id,
        pid: sess.child.pid,
        shell: sess.shell,
        cwd: sess.cwd,
        running: sess.running,
        output: truncateMiddle(sess.output, 12000)
      };
    }
  },
  {
    name: 'terminal_send', kind: 'command',
    description: 'Send a command or input line into an active Command Prompt / PowerShell terminal session opened with terminal_open or run_command(background=true), and read the live response.',
    parameters: { type: 'object', properties: {
      session_id: { type: 'string', description: 'The session_id returned by terminal_open or run_command(background=true).' },
      input: { type: 'string', description: 'Command or text to write into the terminal.' },
      press_enter: { type: 'boolean', description: 'Append newline to execute the command (default true).' },
      wait_ms: { type: 'integer', description: 'Milliseconds to wait for output after sending (default 700, max 15000).' }
    }, required: ['session_id', 'input'] },
    describe: (a) => 'Send to terminal ' + a.session_id + ': ' + truncateMiddle(a.input, 90),
    dangerous: (a) => (isPermanentDeleteCommand(a.input) ? 'This terminal command may permanently delete files.' : null),
    async run(a, ctx) {
      const sess = TERMINAL_SESSIONS.get(String(a.session_id || ''));
      if (!sess) throw new Error('Terminal session not found: ' + a.session_id + '. Call terminal_open or list_terminals first.');
      if (!sess.running || !sess.child || !sess.child.stdin || sess.child.stdin.destroyed) {
        throw new Error('Terminal session ' + sess.id + ' is no longer running (exit_code=' + sess.exitCode + ').');
      }
      const beforeLen = sess.output.length;
      const text = String(a.input || '') + (a.press_enter === false ? '' : '\r\n');
      sess.lastCommand = String(a.input || '');
      if (ctx && typeof ctx.onCommandOutput === 'function') {
        sess.emitStream = (chunk, streamName, extra) => ctx.onCommandOutput(Object.assign({
          sessionId: sess.id,
          shell: sess.shell,
          command: sess.lastCommand,
          cwd: sess.cwd,
          chunk: String(chunk || ''),
          stream: streamName || 'stdout',
          running: sess.running
        }, extra || {}));
      }
      sess.child.stdin.write(text);
      const wait = Math.max(120, Math.min(15000, Number(a.wait_ms) || 700));
      await sleepInterruptible(wait, ctx);
      const delta = sess.output.slice(beforeLen);
      return {
        ok: true,
        session_id: sess.id,
        shell: sess.shell,
        running: sess.running,
        exit_code: sess.exitCode,
        new_output: truncateMiddle(delta, 16000),
        output_tail: truncateMiddle(sess.output.slice(-6000), 6000)
      };
    }
  },
  {
    name: 'terminal_read', kind: 'command', readOnly: true,
    description: 'Read live output and running status from a background or interactive Command Prompt / PowerShell terminal session.',
    parameters: { type: 'object', properties: {
      session_id: { type: 'string', description: 'The session_id to inspect.' },
      wait_ms: { type: 'integer', description: 'Optional milliseconds to wait before reading (default 250, max 10000).' }
    }, required: ['session_id'] },
    describe: (a) => 'Read output from terminal ' + a.session_id,
    async run(a, ctx) {
      const sess = TERMINAL_SESSIONS.get(String(a.session_id || ''));
      if (!sess) throw new Error('Terminal session not found: ' + a.session_id);
      const wait = Math.max(0, Math.min(10000, Number(a.wait_ms) || 250));
      if (wait > 0 && sess.running) await sleepInterruptible(wait, ctx);
      return {
        ok: true,
        session_id: sess.id,
        shell: sess.shell,
        cwd: sess.cwd,
        pid: sess.child ? sess.child.pid : null,
        running: sess.running,
        exit_code: sess.exitCode,
        output: truncateMiddle(sess.output, 20000)
      };
    }
  },
  {
    name: 'terminal_stop', kind: 'command',
    description: 'Stop and close an active Command Prompt / PowerShell terminal session (or pass session_id="all" to close all active sessions).',
    parameters: { type: 'object', properties: {
      session_id: { type: 'string', description: 'Session ID to stop, or "all".' }
    }, required: ['session_id'] },
    describe: (a) => 'Stop terminal session ' + a.session_id,
    async run(a) {
      const id = String(a.session_id || '');
      if (id === 'all') {
        const count = stopAllTerminalSessions();
        return { ok: true, stopped_count: count };
      }
      const sess = TERMINAL_SESSIONS.get(id);
      if (!sess) return { ok: true, stopped: false, note: 'Session already closed.' };
      if (sess.child && sess.running) killTree(sess.child);
      sess.running = false;
      TERMINAL_SESSIONS.delete(id);
      return { ok: true, stopped: true, session_id: id };
    }
  },
  {
    name: 'list_terminals', kind: 'command', readOnly: true,
    description: 'List all active Command Prompt / PowerShell terminal sessions managed by Brief.',
    parameters: { type: 'object', properties: {} },
    describe: () => 'List active terminal sessions',
    async run() {
      const list = [];
      for (const s of TERMINAL_SESSIONS.values()) {
        list.push({
          session_id: s.id,
          shell: s.shell,
          cwd: s.cwd,
          pid: s.child ? s.child.pid : null,
          running: s.running,
          exit_code: s.exitCode,
          last_command: s.lastCommand
        });
      }
      return { count: list.length, sessions: list };
    }
  },
  {
    name: 'open_url', kind: 'app',
    description: 'Open a web page in the default browser on the desktop.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    describe: (a) => 'Open ' + a.url + ' in the browser',
    async run(a, ctx) {
      let u = String(a.url || '').trim();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
      if (!/^(https?|mailto):/i.test(u)) throw new Error('Only http, https and mailto links can be opened.');
      await shell.openExternal(u);
      await sleep(1500);
      const fg = ctx && ctx.automation && ctx.automation.foreground ? await ctx.automation.foreground().catch(() => ({})) : {};
      return { opened: u, url: u, domain: extractDomainFromUrl(u), visited: true, foreground: fg.title || '' };
    }
  },
  {
    name: 'web_search', kind: 'info', readOnly: true,
    description: 'Search the live web for factual information, current events, documentation, or answers. Always use this when the user asks about real-world facts, topics (such as water pollution, science, news, or documentation), or enables Search mode.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Search query to look up on the web.' },
      max_results: { type: 'integer', description: 'Number of results to return (default 6, max 10).' }
    }, required: ['query'] },
    describe: (a) => 'Search the web for "' + a.query + '"',
    async run(a, ctx) {
      const qStr = String(a.query || '').trim();
      if (!qStr) throw new Error('Search query is required.');
      if (ctx && ctx.cursor) {
        const fastTest = ctx.settings && ctx.settings().typingDelayMs === 0;
        let curr = '';
        for (let i = 0; i < qStr.length; i++) {
          if (ctx.isStopped && ctx.isStopped()) throw new Error('Stopped by user.');
          curr += qStr[i];
          ctx.cursor({
            kind: 'type',
            char: qStr[i],
            text: curr.slice(-35),
            fullText: curr,
            label: 'Web Search: ' + curr.slice(-25)
          });
          if (!fastTest) await sleep(Math.min(26, Math.max(10, Math.floor(360 / qStr.length))));
        }
      }
      const results = await runLiveWebSearch(qStr, Math.max(1, Math.min(10, Number(a.max_results) || 6)));
      const engines = [...new Set(results.map((r) => r && r.engine).filter(Boolean))];
      return { query: qStr, engine: engines[0] || 'duckduckgo.com', engines, count: results.length, results };
    }
  },
  {
    name: 'fetch_url', kind: 'info', readOnly: true,
    description: 'Fetch a web page URL and extract its readable text content so you can read articles, documentation, or search result pages.',
    parameters: { type: 'object', properties: {
      url: { type: 'string', description: 'Full http:// or https:// URL to read.' },
      max_chars: { type: 'integer', description: 'Maximum characters to return (default 12000).' }
    }, required: ['url'] },
    describe: (a) => 'Read web page ' + a.url,
    async run(a) {
      return await fetchWebPageText(a.url, Math.max(500, Math.min(40000, Number(a.max_chars) || 12000)));
    }
  }
];

function extractDomainFromUrl(rawUrl) {
  try {
    const h = new URL(String(rawUrl || '')).hostname.toLowerCase().replace(/^www\./, '');
    return h || '';
  } catch (_) {
    return '';
  }
}

async function runLiveWebSearch(query, maxResults = 6) {
  const q = String(query || '').trim();
  if (!q) return [];
  const out = [];
  // 1. DuckDuckGo HTML search
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (res.ok) {
      const html = await res.text();
      const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)/gi;
      let m;
      while ((m = blockRe.exec(html)) !== null && out.length < maxResults) {
        let href = m[1] || '';
        const uddg = /[?&]uddg=([^&]+)/.exec(href);
        if (uddg) {
          try { href = decodeURIComponent(uddg[1]); } catch (_) {}
        }
        const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
        const title = strip(m[2]);
        const snippet = strip(m[3] || m[4] || '');
        if (title && /^https?:/i.test(href)) {
          out.push({ title, url: href, snippet, domain: extractDomainFromUrl(href), engine: 'duckduckgo.com' });
        }
      }
    }
  } catch (_) { /* fall through to Wikipedia */ }

  // 2. Wikipedia OpenSearch / Query API supplement for factual accuracy
  if (out.length < maxResults) {
    try {
      const wRes = await fetch('https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(q) + '&utf8=&format=json&srlimit=' + Math.max(3, maxResults - out.length));
      if (wRes.ok) {
        const wJson = await wRes.json();
        const list = (wJson && wJson.query && wJson.query.search) || [];
        for (const item of list) {
          if (out.length >= maxResults) break;
          const snippet = String(item.snippet || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
          const wikiUrl = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(item.title || '').replace(/ /g, '_'));
          out.push({
            title: item.title + ' (Wikipedia)',
            url: wikiUrl,
            snippet,
            domain: 'en.wikipedia.org',
            engine: 'wikipedia.org'
          });
        }
      }
    } catch (_) { /* ignore */ }
  }
  return out;
}

async function fetchWebPageText(rawUrl, maxChars = 12000) {
  let u = String(rawUrl || '').trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  const res = await fetch(u, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  });
  const html = await res.text();
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : u;
  const clean = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return { url: u, domain: extractDomainFromUrl(u), visited: true, title, length: clean.length, content: clean.slice(0, maxChars), truncated: clean.length > maxChars };
}

/* ------------------------------------------------------------------ */
/* Gemini Computer Use predefined actions -> desktop implementation     */
/* ------------------------------------------------------------------ */

const CU_ACTIONS = {
  open_web_browser: {
    describe: () => 'Open the default web browser',
    async run(a, ctx) { await shell.openExternal('https://www.google.com'); await sleep(2000); return {}; }
  },
  wait_5_seconds: {
    describe: () => 'Wait 5 seconds', observe: true,
    async run(a, ctx) { for (let i = 0; i < 25; i++) { if (ctx.isStopped()) throw new Error('Stopped by user.'); await sleep(200); } return {}; }
  },
  go_back: { describe: () => 'Go back (Alt+Left)', async run(a, ctx) { await ctx.automation.keys(IS_MAC ? 'cmd+[' : 'alt+left'); await sleep(800); return {}; } },
  go_forward: { describe: () => 'Go forward (Alt+Right)', async run(a, ctx) { await ctx.automation.keys(IS_MAC ? 'cmd+]' : 'alt+right'); await sleep(800); return {}; } },
  search: { describe: () => 'Open a web search page', async run() { await shell.openExternal('https://www.google.com'); await sleep(2000); return {}; } },
  navigate: {
    describe: (a) => 'Open ' + a.url + ' in the browser',
    async run(a) {
      let u = String(a.url || '').trim();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
      await shell.openExternal(u);
      await sleep(2000);
      return {};
    }
  },
  click_at: {
    describe: (a) => 'Click at (' + a.x + ', ' + a.y + ')',
    async run(a, ctx) { const m = await pointer(ctx, a.x, a.y, 1000, 'click'); ctx.cursor({ x: m.dip.x, y: m.dip.y, kind: 'click' }); await ctx.automation.click('left', 1); await sleep(300); return {}; }
  },
  hover_at: {
    describe: (a) => 'Hover at (' + a.x + ', ' + a.y + ')',
    async run(a, ctx) { await pointer(ctx, a.x, a.y, 1000, 'hover'); await sleep(300); return {}; }
  },
  type_text_at: {
    describe: (a) => 'Type "' + truncateMiddle(a.text, 100) + '" at (' + a.x + ', ' + a.y + ')' + (a.press_enter === false ? '' : ' + Enter'),
    async run(a, ctx) {
      const m = await pointer(ctx, a.x, a.y, 1000, 'click');
      ctx.cursor({ x: m.dip.x, y: m.dip.y, kind: 'click' });
      await ctx.automation.click('left', 1);
      await sleep(150);
      if (a.clear_before_typing !== false) { await ctx.automation.keys(IS_MAC ? 'cmd+a' : 'ctrl+a'); await ctx.automation.keys('backspace'); }
      ctx.cursor({ kind: 'type', label: 'typing' });
      await typeText(ctx, a.text || '');
      if (a.press_enter !== false) await ctx.automation.keys('enter');
      await sleep(400);
      return {};
    }
  },
  key_combination: {
    describe: (a) => 'Press ' + a.keys,
    dangerous: (a) => (/shift\s*\+\s*(delete|del)\b/i.test(a.keys || '') ? 'Shift+Delete permanently deletes the selected item(s).' : null),
    async run(a, ctx) { ctx.cursor({ kind: 'type', label: a.keys }); await ctx.automation.keys(a.keys); await sleep(300); return {}; }
  },
  scroll_document: {
    describe: (a) => 'Scroll the page ' + a.direction,
    async run(a, ctx) {
      const m = await pointer(ctx, 500, 500, 1000, 'scroll');
      ctx.cursor({ x: m.dip.x, y: m.dip.y, kind: 'scroll', direction: a.direction });
      const { dx, dy } = scrollNotches(a.direction, 10);
      await ctx.automation.scroll(dx, dy);
      await sleep(300);
      return {};
    }
  },
  scroll_at: {
    describe: (a) => 'Scroll ' + a.direction + ' at (' + a.x + ', ' + a.y + ')',
    async run(a, ctx) {
      const m = await pointer(ctx, a.x, a.y, 1000, 'scroll');
      ctx.cursor({ x: m.dip.x, y: m.dip.y, kind: 'scroll', direction: a.direction });
      const notches = Math.max(1, Math.round((Number(a.magnitude) || 800) / 100));
      const { dx, dy } = scrollNotches(a.direction, notches);
      await ctx.automation.scroll(dx, dy);
      await sleep(300);
      return {};
    }
  },
  drag_and_drop: {
    describe: (a) => 'Drag from (' + a.x + ', ' + a.y + ') to (' + a.destination_x + ', ' + a.destination_y + ')',
    async run(a, ctx) {
      const s = ctx.screen.mapPoint(a.x, a.y);
      const e = ctx.screen.mapPoint(a.destination_x, a.destination_y);
      ctx.cursor({ x: s.dip.x, y: s.dip.y, ms: 100, kind: 'move', label: 'drag' });
      setTimeout(() => ctx.cursor({ x: e.dip.x, y: e.dip.y, ms: 260, kind: 'drag', label: 'drag' }), 120);
      await ctx.automation.drag(s.native.x, s.native.y, e.native.x, e.native.y, 260);
      await sleep(300);
      return {};
    }
  }
};

/** Points the model referenced (for the approval preview marker). */
function pointsOf(name, a) {
  const pts = [];
  const push = (x, y) => { if (x !== undefined && y !== undefined) pts.push({ x: Number(x), y: Number(y) }); };
  if (name === 'drag') { push(a.start_x, a.start_y); push(a.end_x, a.end_y); }
  else if (name === 'drag_and_drop') { push(a.x, a.y); push(a.destination_x, a.destination_y); }
  else push(a.x, a.y);
  return pts;
}

function declarations({ includeScreen = true, cuMode = false } = {}) {
  return TOOLS.filter((t) => {
    if (!includeScreen && (t.screen || ['switch_display', 'take_screenshot', 'list_windows', 'focus_window', 'window_control', 'close_other_windows', 'browser_tab', 'click_element', 'click_text', 'read_screen_text', 'zoom_region', 'mouse_button', 'hold_key', 'draw_art'].includes(t.name))) return false;
    if (cuMode && ['move_mouse', 'scroll', 'type_text', 'press_keys', 'drag', 'wait', 'take_screenshot'].includes(t.name)) return false;
    return true;
  }).map((t) => {
    const d = { name: t.name, description: t.description };
    // Gemini rejects OBJECT schemas with no properties, so parameterless tools omit the field.
    if (t.parameters && t.parameters.properties && Object.keys(t.parameters.properties).length) d.parameters = t.parameters;
    return d;
  });
}

function getTool(name) { return TOOLS.find((t) => t.name === name) || null; }

module.exports = { TOOLS, CU_ACTIONS, declarations, getTool, resolvePath, knownFolders, killTree, stopAllTerminalSessions, isPermanentDeleteCommand, pointsOf, launchApp, makeMatcher, categoryOf, runLiveWebSearch, fetchWebPageText, isSelfOrDesktopForeground, ensureTargetForeground, typeText, WATCH_SNACK_EMOJIS, pickWatchEmoji, formatWatchElapsed, analyzeWatchText, getRunningTerminalSessions };
