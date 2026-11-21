'use strict';
/**
 * Locally - real OS automation backends.
 *
 *  - Windows : persistent PowerShell host using user32 SendInput / SetCursorPos (native/winput.ps1).
 *              Per-monitor DPI aware, so coordinates are physical screen pixels.
 *  - macOS   : CoreGraphics events through JavaScript for Automation (osascript -l JavaScript)
 *              and System Events for keystrokes. Needs Accessibility + Screen Recording permission.
 *  - Linux   : xdotool (X11 sessions only - Wayland blocks synthetic input by design).
 *
 * Every backend exposes the same async interface used by the agent:
 *   init, move, click, button, drag, scroll, type, keys, release, foreground, listWindows,
 *   focusWindow, startApps, position
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

/* ------------------------------------------------------------------ */
/* Key name normalisation                                             */
/* ------------------------------------------------------------------ */

const KEY_ALIASES = {
  control: 'ctrl', ctl: 'ctrl', ctrl: 'ctrl', lctrl: 'ctrl', rctrl: 'ctrl',
  shift: 'shift', lshift: 'lshift', rshift: 'rshift', rightshift: 'rshift', leftshift: 'lshift',
  alt: 'alt', option: 'alt', opt: 'alt', menu: 'alt', lalt: 'alt', ralt: 'alt', altgr: 'alt',
  win: 'win', windows: 'win', meta: 'win', super: 'win', cmd: 'win', command: 'win', os: 'win', start: 'win',
  enter: 'enter', return: 'enter', ret: 'enter',
  tab: 'tab', esc: 'esc', escape: 'esc', space: 'space', spacebar: 'space', ' ': 'space',
  backspace: 'backspace', back: 'backspace', bksp: 'backspace',
  delete: 'delete', del: 'delete', forwarddelete: 'delete',
  insert: 'insert', ins: 'insert', home: 'home', end: 'end',
  pageup: 'pageup', pgup: 'pageup', page_up: 'pageup', prior: 'pageup',
  pagedown: 'pagedown', pgdn: 'pagedown', page_down: 'pagedown', next: 'pagedown',
  up: 'up', arrowup: 'up', uparrow: 'up', down: 'down', arrowdown: 'down', downarrow: 'down',
  left: 'left', arrowleft: 'left', leftarrow: 'left', right: 'right', arrowright: 'right', rightarrow: 'right',
  capslock: 'capslock', caps: 'capslock', printscreen: 'printscreen', prtsc: 'printscreen', print: 'printscreen',
  contextmenu: 'apps', apps: 'apps', application: 'apps',
  numlock: 'numlock', scrolllock: 'scrolllock', pause: 'pause',
  volumeup: 'volumeup', volumedown: 'volumedown', volumemute: 'volumemute', mute: 'volumemute',
  medianext: 'medianext', mediaprev: 'mediaprev', mediaplaypause: 'mediaplaypause', playpause: 'mediaplaypause',
  plus: '=', minus: '-', equal: '=', equals: '=', comma: ',', period: '.', dot: '.', slash: '/',
  backslash: '\\', semicolon: ';', quote: "'", apostrophe: "'", backquote: '`', grave: '`', tilde: '`',
  bracketleft: '[', bracketright: ']', leftbracket: '[', rightbracket: ']'
};

function normaliseKey(raw) {
  if (raw === undefined || raw === null) return null;
  let k = String(raw).trim();
  if (k.length === 1) return k.toLowerCase();
  k = k.toLowerCase().replace(/\s+/g, '');
  if (KEY_ALIASES[k]) return KEY_ALIASES[k];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(k)) return k;
  if (/^(numpad|num)[0-9]$/.test(k)) return 'numpad' + k.slice(-1);
  if (/^key[a-z]$/.test(k)) return k.slice(3);
  if (/^digit[0-9]$/.test(k)) return k.slice(5);
  return k;
}

/** Parses "ctrl+shift+s", "Control+A", ["ctrl","c"] or "Ctrl++" into canonical key names. */
function parseCombo(input) {
  let parts = [];
  if (Array.isArray(input)) {
    parts = input.map(String);
  } else {
    let s = String(input || '').trim();
    if (!s) return [];
    const low = s.toLowerCase().replace(/[\s-]+/g, '_');
    if (low === 'shift_enter' || low === 'continue_line' || low === 'soft_enter' || low === 'newline') {
      return ['shift', 'enter'];
    }
    if (low === 'rshift_enter' || low === 'right_shift_enter') {
      return ['rshift', 'enter'];
    }
    let plusKey = false;
    if (s.endsWith('++')) { plusKey = true; s = s.slice(0, -2); }
    else if (s === '+') { return ['=']; }
    parts = s.split(/\s*\+\s*/).filter(Boolean);
    if (plusKey) parts.push('=');
  }
  const out = [];
  for (const p of parts) {
    const n = normaliseKey(p);
    if (!n) continue;
    if (n === 'plus' || p === '+') out.push('=');
    else out.push(n);
  }
  return out;
}

const WIN_VK = {
  ctrl: 0x11, shift: 0x10, lshift: 0xA0, rshift: 0xA1, alt: 0x12, win: 0x5B, apps: 0x5D,
  enter: 0x0D, tab: 0x09, esc: 0x1B, space: 0x20, backspace: 0x08, delete: 0x2E, insert: 0x2D,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  capslock: 0x14, printscreen: 0x2C, numlock: 0x90, scrolllock: 0x91, pause: 0x13,
  volumeup: 0xAF, volumedown: 0xAE, volumemute: 0xAD, medianext: 0xB0, mediaprev: 0xB1, mediaplaypause: 0xB3,
  ';': 0xBA, '=': 0xBB, ',': 0xBC, '-': 0xBD, '.': 0xBE, '/': 0xBF, '`': 0xC0,
  '[': 0xDB, '\\': 0xDC, ']': 0xDD, "'": 0xDE
};

function windowsVk(name) {
  if (WIN_VK[name] !== undefined) return WIN_VK[name];
  if (/^[a-z]$/.test(name)) return name.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(name)) return name.charCodeAt(0);
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(name)) return 0x70 + parseInt(name.slice(1), 10) - 1;
  if (/^numpad[0-9]$/.test(name)) return 0x60 + parseInt(name.slice(-1), 10);
  // Shifted punctuation -> base key + shift is handled by caller via SHIFTED map.
  return null;
}

const SHIFTED = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`'
};

/* ------------------------------------------------------------------ */
/* Windows backend                                                    */
/* ------------------------------------------------------------------ */

class WindowsBackend {
  constructor(log) {
    this.name = 'Windows · user32 SendInput (PowerShell host)';
    this.log = log || (() => {});
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.readyPromise = null;
    this.dpi = 'unknown';
  }

  scriptPath() {
    // When packaged inside an asar archive PowerShell cannot read the file, so copy it out.
    let p = path.join(__dirname, 'native', 'winput.ps1');
    if (p.includes('app.asar')) {
      const target = path.join(os.tmpdir(), 'locally-winput.ps1');
      fs.writeFileSync(target, fs.readFileSync(p));
      p = target;
    }
    return p;
  }

  init() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const exe = fs.existsSync(ps) ? ps : 'powershell.exe';
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('The Windows input host did not start within 30 seconds.')); }
      }, 30000);
      try {
        this.proc = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath()], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (e) {
        clearTimeout(timer);
        settled = true;
        reject(e);
        return;
      }
      this.proc.stdout.setEncoding('utf8');
      this.proc.stderr.setEncoding('utf8');
      this.proc.stdout.on('data', (chunk) => {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line.replace(/^\uFEFF/, '')); } catch (_) { this.log('input-host: ' + line); continue; }
          if (msg.ready) {
            this.dpi = msg.dpi;
            if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: true, dpi: msg.dpi, pid: msg.pid }); }
            continue;
          }
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.ok) p.resolve(msg.result || {});
            else p.reject(new Error(msg.error || 'Input host error'));
          }
        }
      });
      this.proc.stderr.on('data', (d) => {
        const text = String(d).trim();
        if (text) this.log('input-host stderr: ' + text);
        if (!settled && /error|exception/i.test(text)) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Input host failed to start: ' + text.slice(0, 400)));
        }
      });
      this.proc.on('exit', (code) => {
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Input host exited (code ' + code + ').')); }
        this.pending.clear();
        this.proc = null;
        this.readyPromise = null;
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Input host exited during start (code ' + code + ').')); }
      });
      this.proc.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
      });
    });
    return this.readyPromise;
  }

  async call(cmd, args = {}, timeoutMs = 60000) {
    await this.init();
    if (!this.proc) throw new Error('Input host is not running.');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Input host timed out on "' + cmd + '".'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify(Object.assign({ id, cmd }, args)) + '\n');
    });
  }

  position() { return this.call('pos'); }
  move(x, y, ms = 0) { return this.call('move', { x: Math.round(x), y: Math.round(y), ms: Math.round(ms) }); }
  click(button = 'left', count = 1) { return this.call('click', { button, count }); }
  button(button = 'left', down = true) { return this.call('button', { button, down }); }
  drag(x1, y1, x2, y2, ms = 600) { return this.call('drag', { x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2), ms }); }
  drawPath(points, msPerSeg = 28) {
    const pts = Array.isArray(points) ? points.filter((p) => p && isFinite(p.x) && isFinite(p.y)) : [];
    if (pts.length < 2) return Promise.resolve({ drawn: false });
    const xs = pts.map((p) => Math.round(p.x));
    const ys = pts.map((p) => Math.round(p.y));
    const estMs = Math.max(15000, xs.length * Math.max(20, msPerSeg) + 5000);
    return this.call('drawpath', { xs, ys, msPerSeg: Math.round(msPerSeg) }, estMs);
  }
  scroll(dx, dy) { return this.call('scroll', { dx: Math.round(dx), dy: Math.round(dy) }); }
  type(text, delay = 6, opts = {}) {
    const softNewline = opts && opts.softNewline !== undefined ? !!opts.softNewline : true;
    return this.call('type', { text: String(text), delay, softNewline }, 120000);
  }

  comboToVks(combo) {
    const names = parseCombo(combo);
    if (!names.length) throw new Error('No keys given.');
    const vks = [];
    for (const n of names) {
      if (SHIFTED[n]) { vks.push(WIN_VK.shift); vks.push(windowsVk(SHIFTED[n])); continue; }
      const vk = windowsVk(n);
      if (vk === null) throw new Error('Unknown key "' + n + '".');
      vks.push(vk);
    }
    const set = new Set(names);
    if (set.has('ctrl') && set.has('alt') && set.has('delete')) {
      throw new Error('Ctrl+Alt+Delete is a Secure Attention Sequence; Windows does not allow any app to synthesize it.');
    }
    return vks;
  }

  keys(combo, holdMs = 40) {
    let vks;
    try { vks = this.comboToVks(combo); } catch (e) { return Promise.reject(e); }
    const hold = Math.max(40, Math.min(2500, Number(holdMs) || 40));
    return this.call('keys', { vks, hold }, Math.max(10000, hold + 8000));
  }

  async keyState(combo, down) {
    const vks = this.comboToVks(combo);
    const seq = down ? vks : vks.slice().reverse();
    for (const vk of seq) {
      await this.call('keystate', { vk, down: !!down });
    }
    return { vks, down: !!down };
  }

  release() { return this.call('release', {}, 10000).catch(() => ({})); }
  setBlackCursor(enabled, style = 'gemini', logoPath = '') {
    return this.call('setcursor', { black: !!enabled, style: String(style || 'gemini'), logoPath: String(logoPath || '') }, 8000).then((r) => !!(r && r.active)).catch(() => false);
  }
  foreground() { return this.call('foreground'); }
  async listWindows() { const r = await this.call('windows'); return r.windows || []; }
  focusWindow(query) { return this.call('focus', { query: String(query) }); }
  controlWindow(query, action) { return this.call('wincontrol', { query: String(query), action: String(action) }); }
  controlOtherWindows(keepQuery, action = 'minimize') { return this.call('wincontrolother', { keep: String(keepQuery || ''), action: String(action) }); }
  async listBrowserTabs(browserQuery = '') { const r = await this.call('browsertabs', { browser: String(browserQuery || '') }); return (r && r.tabs) || []; }
  async inspectUi(max = 100) { const r = await this.call('inspectui', { max }); return (r && r.elements) || []; }
  focusedElement() { return this.call('focused').catch(() => ({ type: '', name: '', canType: false })); }
  async captureNative(x, y, width, height, opts = {}) {
    try {
      const r = await this.call('capture', {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.max(16, Math.round(width)),
        height: Math.max(16, Math.round(height)),
        png: !!opts.png,
        grid: !!opts.grid
      }, 15000);
      return (r && r.base64) ? r : null;
    } catch (_) {
      return null;
    }
  }
  async ocrScreen(x, y, width, height) {
    try {
      const r = await this.call('ocr', {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.max(16, Math.round(width)),
        height: Math.max(16, Math.round(height))
      }, 15000);
      return (r && Array.isArray(r.lines)) ? r : { text: '', lines: [], words: [] };
    } catch (_) {
      return { text: '', lines: [], words: [] };
    }
  }
  async drawVisionGrid(base64) {
    try {
      const r = await this.call('drawgrid', { base64 }, 15000);
      return (r && r.base64) || base64;
    } catch (_) {
      return base64;
    }
  }
  async startApps() { const r = await this.call('startapps', {}, 30000); return r.apps || []; }

  dispose() {
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try {
        if (p.stdin && !p.stdin.destroyed) {
          p.stdin.write(JSON.stringify({ id: 999999, cmd: 'setcursor', black: false }) + '\n');
          p.stdin.end();
        }
      } catch (_) { /* ignore */ }
      setTimeout(() => { try { p.kill(); } catch (_) { /* ignore */ } }, 350);
    }
  }
}

/* ------------------------------------------------------------------ */
/* macOS backend (CoreGraphics via JXA)                                */
/* ------------------------------------------------------------------ */

function runFile(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error((stderr || err.message || '').toString().trim())); return; }
      resolve(String(stdout || '').trim());
    });
  });
}

const MAC_KEYCODES = {
  enter: 36, tab: 48, space: 49, backspace: 51, esc: 53, delete: 117, home: 115, end: 119,
  pageup: 116, pagedown: 121, left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111
};

class MacBackend {
  constructor(log) { this.name = 'macOS · CoreGraphics events (JXA) + System Events'; this.log = log || (() => {}); this.dpi = 'points'; }
  jxa(code) { return runFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', code]); }
  apple(code) { return runFile('/usr/bin/osascript', ['-e', code]); }
  async init() {
    await this.jxa('ObjC.import("CoreGraphics"); "ok"');
    return { ok: true, dpi: 'points' };
  }
  mouseScript(body) {
    return 'ObjC.import("CoreGraphics");' +
      'function P(x,y){return $.CGPointMake(x,y);}' +
      'function post(t,x,y,b,n){var e=$.CGEventCreateMouseEvent(null,t,P(x,y),b);if(n){$.CGEventSetIntegerValueField(e,$.kCGMouseEventClickState,n);}$.CGEventPost($.kCGHIDEventTap,e);}' +
      'function cur(){var e=$.CGEventCreate(null);return $.CGEventGetLocation(e);}' +
      'function sleep(ms){delay(ms/1000);}' + body;
  }
  async position() { const out = await this.jxa(this.mouseScript('var p=cur(); JSON.stringify({x:p.x,y:p.y})')); return JSON.parse(out); }
  async move(x, y, ms = 0) {
    const steps = Math.max(1, Math.min(60, Math.round(ms / 10)));
    await this.jxa(this.mouseScript(
      'var s=cur(),tx=' + Number(x) + ',ty=' + Number(y) + ',n=' + steps + ';' +
      'for(var i=1;i<=n;i++){var t=i/n;var e=t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;post(5,s.x+(tx-s.x)*e,s.y+(ty-s.y)*e,0);if(n>1)sleep(8);} "ok"'));
    return { x, y };
  }
  async click(button = 'left', count = 1) {
    const map = { left: [1, 2, 0], right: [3, 4, 1], middle: [25, 26, 2] };
    const m = map[button] || map.left;
    await this.jxa(this.mouseScript('var p=cur();for(var c=1;c<=' + Math.max(1, count) + ';c++){post(' + m[0] + ',p.x,p.y,' + m[2] + ',c);post(' + m[1] + ',p.x,p.y,' + m[2] + ',c);sleep(40);} "ok"'));
  }
  async button(button = 'left', down = true) {
    const map = { left: [1, 2, 0], right: [3, 4, 1], middle: [25, 26, 2] };
    const m = map[button] || map.left;
    await this.jxa(this.mouseScript('var p=cur();post(' + (down ? m[0] : m[1]) + ',p.x,p.y,' + m[2] + ',1); "ok"'));
  }
  async drag(x1, y1, x2, y2) {
    await this.move(x1, y1, 150);
    await this.jxa(this.mouseScript(
      'post(1,' + x1 + ',' + y1 + ',0,1);sleep(120);var n=40;for(var i=1;i<=n;i++){var t=i/n;post(6,' + x1 + '+(' + (x2 - x1) + ')*t,' + y1 + '+(' + (y2 - y1) + ')*t,0);sleep(10);}post(2,' + x2 + ',' + y2 + ',0,1); "ok"'));
  }
  async drawPath(points) {
    if (!Array.isArray(points) || points.length < 2) return { drawn: false };
    await this.move(points[0].x, points[0].y, 120);
    await this.jxa(this.mouseScript('post(1,' + points[0].x + ',' + points[0].y + ',0,1); "ok"'));
    try {
      for (let i = 1; i < points.length; i++) {
        await this.jxa(this.mouseScript('post(6,' + points[i].x + ',' + points[i].y + ',0,1); "ok"'));
      }
    } finally {
      const last = points[points.length - 1];
      await this.jxa(this.mouseScript('post(2,' + last.x + ',' + last.y + ',0,1); "ok"')).catch(() => {});
    }
    return { drawn: true };
  }
  async scroll(dx, dy) {
    await this.jxa('ObjC.import("CoreGraphics");var e=$.CGEventCreateScrollWheelEvent(null,1,2,' + (-Math.round(dy) * 3) + ',' + (-Math.round(dx) * 3) + ');$.CGEventPost($.kCGHIDEventTap,e); "ok"');
  }
  async type(text, _delay, opts = {}) {
    const safe = String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const lines = safe.split('\n');
    const softNewline = !opts || opts.softNewline !== false;
    let script = 'tell application "System Events"\n';
    lines.forEach((l, i) => {
      if (l) script += 'keystroke "' + l.replace(/\r/g, '') + '"\n';
      if (i < lines.length - 1) script += softNewline ? 'key code 36 using {shift down}\n' : 'key code 36\n';
    });
    script += 'end tell';
    await this.apple(script);
  }
  async keys(combo) {
    const names = parseCombo(combo);
    const mods = [];
    let main = null;
    for (const n of names) {
      if (n === 'ctrl') mods.push('control down');
      else if (n === 'shift' || n === 'lshift' || n === 'rshift') mods.push('shift down');
      else if (n === 'alt') mods.push('option down');
      else if (n === 'win') mods.push('command down');
      else main = n;
    }
    if (!main) throw new Error('A key combination needs a non-modifier key on macOS.');
    const using = mods.length ? ' using {' + mods.join(', ') + '}' : '';
    const code = MAC_KEYCODES[main];
    const cmd = code !== undefined ? 'key code ' + code + using : 'keystroke "' + main.replace(/"/g, '\\"') + '"' + using;
    await this.apple('tell application "System Events" to ' + cmd);
  }
  async keyState(combo, down) {
    const names = parseCombo(combo);
    const mods = new Set(['ctrl', 'shift', 'alt', 'cmd']);
    const hold = names.filter((n) => mods.has(n));
    const main = names.find((n) => !mods.has(n)) || names[names.length - 1];
    if (main && MAC_KEYCODES[main] !== undefined) {
      await this.apple('tell application "System Events" to ' + (down ? 'key down' : 'key up') + ' {key code ' + MAC_KEYCODES[main] + '}');
    } else if (hold.length) {
      for (const m of hold) await this.apple('tell application "System Events" to ' + (down ? 'key down ' : 'key up ') + (m === 'cmd' ? 'command' : (m === 'ctrl' ? 'control' : (m === 'alt' ? 'option' : 'shift')))).catch(() => {});
    }
    return { down: !!down };
  }
  async release() { return {}; }
  async setBlackCursor() { return false; }
  async foreground() {
    const out = await this.apple('tell application "System Events" to set p to first application process whose frontmost is true\ntell application "System Events" to set n to name of p\ntry\ntell application "System Events" to set t to name of front window of p\non error\nset t to ""\nend try\nreturn n & "|" & t');
    const [proc, title] = out.split('|');
    return { title: title || proc, process: proc };
  }
  async listWindows() {
    const out = await this.apple('set res to ""\ntell application "System Events"\nrepeat with p in (application processes whose visible is true)\ntry\nrepeat with w in windows of p\nset res to res & (name of p) & "|" & (name of w) & linefeed\nend repeat\nend try\nend repeat\nend tell\nreturn res');
    return out.split('\n').filter(Boolean).map((l) => { const [p, t] = l.split('|'); return { process: p, title: t, state: 'normal' }; });
  }
  async focusWindow(query) {
    await this.apple('tell application "' + String(query).replace(/"/g, '') + '" to activate');
    return { title: query };
  }
  async controlWindow(query, action) {
    const q = String(query).replace(/"/g, '');
    if (q.toLowerCase() === 'locally' || q.toLowerCase() === 'brief') throw new Error('Cannot close Brief via window_control.');
    if (action === 'close') await this.apple('tell application "' + q + '" to quit');
    else if (action === 'minimize') await this.apple('tell application "System Events" to set value of attribute "AXMinimized" of windows of process "' + q + '" to true');
    return { title: q, action };
  }
  async controlOtherWindows() { return { count: 0, windows: [], note: 'Not supported on macOS via this backend.' }; }
  async listBrowserTabs() { return []; }
  async inspectUi() { return []; }
  async focusedElement() { return { type: '', name: '', canType: false }; }
  async captureNative() { return null; }
  async ocrScreen() { return { text: '', lines: [], words: [] }; }
  async drawVisionGrid(base64) { return base64; }
  async startApps() {
    const dirs = ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')];
    const apps = [];
    for (const d of dirs) {
      try { for (const f of fs.readdirSync(d)) if (f.endsWith('.app')) apps.push({ Name: f.replace(/\.app$/, ''), AppID: path.join(d, f) }); } catch (_) { /* ignore */ }
    }
    return apps;
  }
  dispose() {}
}

/* ------------------------------------------------------------------ */
/* Linux backend (xdotool, X11)                                        */
/* ------------------------------------------------------------------ */

const XDO_KEYS = {
  ctrl: 'ctrl', shift: 'shift', alt: 'alt', win: 'super', enter: 'Return', tab: 'Tab', esc: 'Escape', space: 'space',
  backspace: 'BackSpace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', capslock: 'Caps_Lock', printscreen: 'Print', apps: 'Menu',
  ';': 'semicolon', '=': 'equal', ',': 'comma', '-': 'minus', '.': 'period', '/': 'slash', '`': 'grave',
  '[': 'bracketleft', '\\': 'backslash', ']': 'bracketright', "'": 'apostrophe',
  volumeup: 'XF86AudioRaiseVolume', volumedown: 'XF86AudioLowerVolume', volumemute: 'XF86AudioMute'
};

class LinuxBackend {
  constructor(log) { this.name = 'Linux · xdotool (X11 / XWayland · All Distros & ARM64/x64)'; this.log = log || (() => {}); this.dpi = 'pixels'; }
  x(args, t) { return runFile('xdotool', args, t); }
  detectDistroInstallCmd() {
    try {
      const osRel = fs.existsSync('/etc/os-release') ? fs.readFileSync('/etc/os-release', 'utf8').toLowerCase() : '';
      if (/kali|raspbian|debian|ubuntu|mint|parrot|pop/.test(osRel)) return 'sudo apt update && sudo apt install -y xdotool';
      if (/arch|manjaro|endeavouros/.test(osRel)) return 'sudo pacman -S --noconfirm xdotool';
      if (/fedora|rhel|centos|rocky|alma/.test(osRel)) return 'sudo dnf install -y xdotool';
      if (/suse/.test(osRel)) return 'sudo zypper install -y xdotool';
      if (/alpine/.test(osRel)) return 'sudo apk add xdotool';
    } catch (_) { /* ignore */ }
    return 'sudo apt install -y xdotool';
  }
  async init() {
    const installCmd = this.detectDistroInstallCmd();
    await this.x(['version']).catch(() => {
      throw new Error('xdotool is not installed. Install it on your Linux distro (Kali, Raspberry Pi OS, Ubuntu, Debian, Arch, Fedora) with: ' + installCmd);
    });
    const isWayland = (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland';
    if (isWayland && !process.env.DISPLAY) {
      throw new Error('Pure Wayland session without XWayland DISPLAY detected. Switch to an "X11 / Xorg" session (or enable XWayland) on your login screen to allow global mouse/keyboard control.');
    }
    return { ok: true, dpi: 'pixels' };
  }
  async position() {
    const out = await this.x(['getmouselocation', '--shell']);
    const m = {};
    out.split('\n').forEach((l) => { const [k, v] = l.split('='); m[k] = Number(v); });
    return { x: m.X, y: m.Y };
  }
  async move(x, y, ms = 0) {
    if (ms > 0) {
      const s = await this.position();
      const n = Math.max(2, Math.min(30, Math.round(ms / 15)));
      for (let i = 1; i < n; i++) {
        const t = i / n;
        await this.x(['mousemove', String(Math.round(s.x + (x - s.x) * t)), String(Math.round(s.y + (y - s.y) * t))]);
      }
    }
    await this.x(['mousemove', String(Math.round(x)), String(Math.round(y))]);
    return { x, y };
  }
  click(button = 'left', count = 1) { const b = { left: '1', middle: '2', right: '3' }[button] || '1'; return this.x(['click', '--repeat', String(Math.max(1, count)), '--delay', '80', b]); }
  button(button = 'left', down = true) { const b = { left: '1', middle: '2', right: '3' }[button] || '1'; return this.x([down ? 'mousedown' : 'mouseup', b]); }
  async drag(x1, y1, x2, y2) {
    await this.move(x1, y1, 150);
    await this.x(['mousedown', '1']);
    await this.move(x2, y2, 500);
    await this.x(['mouseup', '1']);
  }
  async drawPath(points) {
    if (!Array.isArray(points) || points.length < 2) return { drawn: false };
    await this.move(points[0].x, points[0].y, 120);
    await this.x(['mousedown', '1']);
    try {
      for (let i = 1; i < points.length; i++) await this.x(['mousemove', String(Math.round(points[i].x)), String(Math.round(points[i].y))]);
    } finally {
      await this.x(['mouseup', '1']).catch(() => {});
    }
    return { drawn: true };
  }
  async scroll(dx, dy) {
    if (dy) await this.x(['click', '--repeat', String(Math.abs(Math.round(dy))), '--delay', '20', dy > 0 ? '5' : '4']);
    if (dx) await this.x(['click', '--repeat', String(Math.abs(Math.round(dx))), '--delay', '20', dx > 0 ? '7' : '6']);
  }
  async type(text) {
    const raw = String(text || '');
    if (!raw) return;
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) {
        await this.x(['type', '--clearmodifiers', '--delay', '8', '--', lines[i]], 120000);
      }
      if (i < lines.length - 1) {
        await this.x(['key', '--clearmodifiers', 'Return']);
      }
    }
  }
  keys(combo) {
    const names = parseCombo(combo).map((n) => XDO_KEYS[n] || (/^f\d+$/.test(n) ? n.toUpperCase() : n));
    return this.x(['key', '--clearmodifiers', names.join('+')]);
  }
  keyState(combo, down) {
    const names = parseCombo(combo).map((n) => XDO_KEYS[n] || (/^f\d+$/.test(n) ? n.toUpperCase() : n));
    return this.x([down ? 'keydown' : 'keyup', names.join('+')]);
  }
  async release() { await this.x(['keyup', 'ctrl', 'shift', 'alt', 'super']).catch(() => {}); return {}; }
  async setBlackCursor() { return false; }
  async foreground() { const title = await this.x(['getactivewindow', 'getwindowname']).catch(() => ''); return { title, process: '' }; }
  async listWindows() {
    const ids = (await this.x(['search', '--onlyvisible', '--name', '.']).catch(() => '')).split('\n').filter(Boolean).slice(0, 60);
    const out = [];
    for (const id of ids) { const t = await this.x(['getwindowname', id]).catch(() => ''); if (t) out.push({ title: t, process: '', state: 'normal', hwnd: id }); }
    return out;
  }
  async focusWindow(query) {
    const ids = (await this.x(['search', '--onlyvisible', '--name', String(query)])).split('\n').filter(Boolean);
    if (!ids.length) throw new Error('No visible window matches "' + query + '".');
    await this.x(['windowactivate', ids[0]]);
    return { title: query };
  }
  async controlWindow(query, action) {
    const ql = String(query).toLowerCase();
    if (ql === 'locally' || ql === 'brief') throw new Error('Cannot close Brief via window_control.');
    const ids = (await this.x(['search', '--onlyvisible', '--name', String(query)])).split('\n').filter(Boolean);
    if (!ids.length) throw new Error('No visible window matches "' + query + '".');
    if (action === 'minimize') await this.x(['windowminimize', ids[0]]);
    else if (action === 'close') await this.x(['windowclose', ids[0]]);
    else await this.x(['windowactivate', ids[0]]);
    return { title: query, action };
  }
  async controlOtherWindows() { return { count: 0, windows: [], note: 'Use window_control on Linux.' }; }
  async listBrowserTabs() { return []; }
  async inspectUi() { return []; }
  async focusedElement() { return { type: '', name: '', canType: false }; }
  async captureNative() { return null; }
  async ocrScreen() { return { text: '', lines: [], words: [] }; }
  async drawVisionGrid(base64) { return base64; }
  async startApps() {
    const dirs = ['/usr/share/applications', path.join(os.homedir(), '.local/share/applications')];
    const apps = [];
    for (const d of dirs) {
      try { for (const f of fs.readdirSync(d)) if (f.endsWith('.desktop')) apps.push({ Name: f.replace(/\.desktop$/, ''), AppID: path.join(d, f) }); } catch (_) { /* ignore */ }
    }
    return apps;
  }
  dispose() {}
}

function createBackend(log) {
  if (process.platform === 'win32') return new WindowsBackend(log);
  if (process.platform === 'darwin') return new MacBackend(log);
  return new LinuxBackend(log);
}

/**
 * Checks OS permissions and desktop automation capabilities without moving the mouse.
 */
async function getOsPermissionsInfo(backend, electronModule) {
  const platform = process.platform;
  const info = {
    platform,
    osLabel: os.type() + ' ' + os.release() + ' (' + os.arch() + ')',
    backendName: backend.name,
    dpiMode: backend.dpi || 'unknown',
    checks: [],
    limitations: [],
    guides: []
  };

  if (platform === 'win32') {
    let hostOk = false;
    let hostDetail = '';
    try {
      const init = await backend.init();
      const can = await backend.call('caninput');
      const fg = await backend.foreground();
      const pos = await backend.position();
      if (can && can.allowed) {
        hostOk = true;
        hostDetail = `DPI: ${init.dpi}, cursor at (${pos.x}, ${pos.y}), foreground: ${fg.process || 'desktop'}`;
      } else {
        hostDetail = 'SetCursorPos was denied by Windows (PC locked, UAC prompt open, or launched from a non-interactive background session).';
      }
    } catch (e) {
      hostDetail = e.message;
    }
    info.checks.push({
      id: 'win-input',
      name: 'Desktop Mouse & Keyboard Input (user32 SendInput)',
      status: hostOk ? 'granted' : 'error',
      detail: hostDetail
    });
    info.checks.push({
      id: 'win-screen',
      name: 'Screen Capture (Desktop Duplication / GDI)',
      status: 'granted',
      detail: 'Windows allows desktop apps in your interactive session to capture screens without a separate permission toggle.'
    });
    info.limitations.push(
      'Windows UIPI (User Interface Privilege Isolation): if you open an Administrator window (for example Task Manager or an elevated terminal), standard non-elevated SendInput cannot click or type into it. Run Locally as Administrator only if you need it to control elevated windows.',
      'Windows Secure Desktop (UAC prompts and the Lock Screen) and Ctrl+Alt+Delete cannot be read or controlled by any desktop app.'
    );
    info.guides.push(
      { title: 'Interactive Desktop Session', steps: ['Launch Locally from your normal Windows user session (Start Menu, Explorer, or VS Code terminal).', 'Do not lock the screen while Work mode is running.'] },
      { title: 'Optional: Controlling Elevated Apps', steps: ['Only if needed: right-click your terminal or Locally shortcut → Run as administrator.', 'Keep Ask for permission enabled when running elevated.'] }
    );
  } else if (platform === 'darwin') {
    const sysPref = electronModule && electronModule.systemPreferences;
    let acc = false;
    let scr = 'unknown';
    try { acc = sysPref ? sysPref.isTrustedAccessibilityClient(false) : false; } catch (_) { acc = false; }
    try { scr = sysPref ? sysPref.getMediaAccessStatus('screen') : 'unknown'; } catch (_) { scr = 'unknown'; }
    info.checks.push({
      id: 'mac-accessibility',
      name: 'Accessibility (Mouse & Keyboard Control)',
      status: acc ? 'granted' : 'required',
      detail: acc ? 'Trusted for Accessibility events.' : 'Not granted yet — macOS blocks CoreGraphics clicks and System Events typing until enabled.',
      deepLink: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    });
    info.checks.push({
      id: 'mac-screen',
      name: 'Screen Recording',
      status: scr === 'granted' ? 'granted' : 'required',
      detail: scr === 'granted' ? 'Screen Recording permission granted.' : `Status: ${scr}. Without this, screenshots show only the desktop wallpaper.`,
      deepLink: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    });
    info.limitations.push(
      'macOS protects Secure Input password fields (such as Terminal Secure Keyboard Entry and FileVault/Keychain prompts), where synthetic typing is blocked by macOS.'
    );
    info.guides.push(
      { title: 'Enable Accessibility', steps: ['Open System Settings → Privacy & Security → Accessibility.', 'Enable Locally (or Electron / Terminal if launching from terminal).'] },
      { title: 'Enable Screen Recording', steps: ['Open System Settings → Privacy & Security → Screen Recording.', 'Enable Locally / Electron and restart Locally so macOS applies it.'] }
    );
  } else {
    const session = (process.env.XDG_SESSION_TYPE || 'unknown').toLowerCase();
    let xdoOk = false;
    let xdoDetail = '';
    try {
      await backend.init();
      xdoOk = true;
      xdoDetail = 'xdotool ready in X11 session.';
    } catch (e) {
      xdoDetail = e.message;
    }
    info.checks.push({
      id: 'linux-session',
      name: 'Display Server Session',
      status: session === 'wayland' ? 'blocked' : 'granted',
      detail: `Session type: ${session}`
    });
    info.checks.push({
      id: 'linux-xdotool',
      name: 'Input Automation (xdotool)',
      status: xdoOk ? 'granted' : 'error',
      detail: xdoDetail
    });
    info.limitations.push(
      'Wayland blocks global synthetic mouse/keyboard injection and background screenshot capture by security design. Log in using an X11 / Xorg session for full desktop control.'
    );
    info.guides.push(
      { title: 'Install xdotool & Use X11', steps: ['Install xdotool: sudo apt install xdotool (or your distro equivalent).', 'On the login screen gear menu, choose "Ubuntu on Xorg" / X11 instead of Wayland.'] }
    );
  }

  return info;
}

module.exports = { createBackend, getOsPermissionsInfo, parseCombo, normaliseKey, windowsVk, WindowsBackend, MacBackend, LinuxBackend };
