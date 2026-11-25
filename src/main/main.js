'use strict';
/**
 * Locally — Electron main process.
 * Private local desktop AI agent. No telemetry, no cloud sync, no accounts.
 */
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) { /* ignore */ }
const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  globalShortcut,
  screen,
  shell,
  dialog,
  systemPreferences,
  Notification
} = require('electron');

const { JsonStore, DEFAULT_SETTINGS, DEFAULT_CHATS } = require('./store');
const { KeyStore } = require('./keystore');
const { stripModelPrefix } = require('./gemini');
const { ProviderRouter, detectKeyProvider, providerMeta, matchPresetsForProvider } = require('./providers');
const { ScreenService } = require('./screen');
const { createBackend, getOsPermissionsInfo } = require('./automation');
const { AgentRunner } = require('./agent');
const { McpManager } = require('./mcp');
const { TOOLS, resolvePath } = require('./tools');

const ROOT = path.resolve(__dirname, '..', '..');
const IS_SELFTEST = process.argv.includes('--selftest');
const IS_FUNCTEST = process.argv.includes('--test-functional');
let firstRunPending = process.argv.includes('--first-run');

app.setName('LOCALLY');
if (process.platform === 'linux') {
  try { app.commandLine.appendSwitch('enable-transparent-visuals'); } catch (_) { /* ignore */ }
}
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.locally.desktop'); } catch (_) { /* ignore */ }
}

let mainWindow = null;
let widgetWindow = null;
let cursorWindow = null;
let cursorDisplayBounds = null;
let nativeBlackCursorActive = false;
let blackCursorDesired = false;
let cursorFollowTimer = null;
let registeredHotkey = '';
let cachedModels = [];
let cachedMatch = null;
let currentStatus = { running: false, state: 'idle', mode: 'ask', permissionMode: 'ask', model: '', step: 0, maxSteps: 0, stepText: 'Ready', nativeCursor: false };
const actionLog = [];

function pushLog(entry) {
  actionLog.push(entry);
  if (actionLog.length > 600) actionLog.splice(0, actionLog.length - 600);
}

const gotLock = (IS_SELFTEST || IS_FUNCTEST) ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const userDataDir = app.getPath('userData');
const settingsStore = new JsonStore(path.join(userDataDir, 'settings.json'), DEFAULT_SETTINGS);
const chatsStore = new JsonStore(path.join(userDataDir, 'chats.json'), DEFAULT_CHATS);
const keyStore = new KeyStore(userDataDir);
const gemini = new ProviderRouter(() => keyStore.get(), () => settingsStore.get().provider || 'gemini');
const screenSvc = new ScreenService(() => settingsStore.get());
const automation = createBackend((m) => console.log('[automation]', m));
screenSvc.setAutomation(automation);
const mcpManager = new McpManager(() => settingsStore.get(), (patch) => settingsStore.set(patch));
mcpManager.on('updated', (servers) => broadcast('mcp:updated', servers));

function broadcast(channel, payload) {
  for (const win of [mainWindow, widgetWindow, cursorWindow]) {
    if (win && !win.isDestroyed() && win.webContents) {
      try { win.webContents.send(channel, payload); } catch (_) { /* ignore */ }
    }
  }
}

function showCursorOverlayAboveAll() {
  if (!cursorWindow || cursorWindow.isDestroyed()) return;
  if (!cursorWindow.isVisible()) cursorWindow.showInactive();
  try {
    cursorWindow.setAlwaysOnTop(true, 'screen-saver');
    cursorWindow.moveTop();
  } catch (_) { /* ignore */ }
}

function stopCursorFollow() {
  if (cursorFollowTimer) {
    clearInterval(cursorFollowTimer);
    cursorFollowTimer = null;
  }
}

function startCursorFollow() {
  if (cursorFollowTimer) return;
  cursorFollowTimer = setInterval(() => {
    const s = settingsStore.get();
    if (!currentStatus.running || currentStatus.mode !== 'work' || !s.showOverlay) {
      stopCursorFollow();
      return;
    }
    if (!cursorWindow || cursorWindow.isDestroyed() || !cursorWindow.isVisible()) return;
    try {
      const pt = screen.getCursorScreenPoint();
      const b = cursorDisplayBounds || (screenSvc.currentDisplay() && screenSvc.currentDisplay().bounds) || { x: 0, y: 0 };
      cursorWindow.webContents.send('cursor:event', {
        kind: 'layer-only',
        nativeCursor: nativeBlackCursorActive,
        provider: getConfirmedProvider(),
        x: pt.x - b.x,
        y: pt.y - b.y
      });
    } catch (_) { /* ignore */ }
  }, 16);
}

function getConfirmedProvider() {
  try {
    if (keyStore && keyStore.has()) return detectKeyProvider(keyStore.get()) || (settingsStore.get().provider || 'gemini');
  } catch (_) { /* ignore */ }
  return (settingsStore.get().provider || 'gemini');
}

let activeCursorStyle = '';
async function setNativeBlackCursor(enabled) {
  const want = !!enabled && process.platform === 'win32';
  const style = getConfirmedProvider();
  const logoPath = path.join(ROOT, 'assets', 'openai-logo.png');
  blackCursorDesired = !!enabled;
  if (!enabled) {
    nativeBlackCursorActive = false;
    activeCursorStyle = '';
    stopCursorFollow();
    currentStatus.nativeCursor = false;
    if (process.platform === 'win32') {
      await automation.setBlackCursor(false).catch(() => false);
    }
    return false;
  }
  if (process.platform === 'linux') {
    nativeBlackCursorActive = false;
    activeCursorStyle = style;
    currentStatus.nativeCursor = false;
    currentStatus.provider = style;
    startCursorFollow();
    return false;
  }
  if (!want) {
    nativeBlackCursorActive = false;
    activeCursorStyle = '';
    stopCursorFollow();
    currentStatus.nativeCursor = false;
    return false;
  }
  if (nativeBlackCursorActive && activeCursorStyle === style) return true;
  const ok = await automation.setBlackCursor(true, style, logoPath).catch(() => false);
  if (!blackCursorDesired) {
    await automation.setBlackCursor(false).catch(() => false);
    nativeBlackCursorActive = false;
    activeCursorStyle = '';
    return false;
  }
  nativeBlackCursorActive = !!ok;
  activeCursorStyle = ok ? style : '';
  currentStatus.nativeCursor = nativeBlackCursorActive;
  currentStatus.provider = style;
  if (nativeBlackCursorActive) {
    startCursorFollow();
    broadcast('agent:status', currentStatus);
  }
  return nativeBlackCursorActive;
}

function forwardCursorEvent(evt) {
  const s = settingsStore.get();
  const prov = getConfirmedProvider();
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    try { mainWindow.webContents.send('cursor:event', evt); } catch (_) { /* ignore */ }
  }
  if (!s.showOverlay && evt.kind !== 'hide') return;
  if (!cursorWindow || cursorWindow.isDestroyed()) return;
  if (evt.kind === 'hide') {
    cursorWindow.webContents.send('cursor:event', { kind: 'hide', nativeCursor: false, provider: prov });
    if (cursorWindow.isVisible()) cursorWindow.hide();
    return;
  }
  const enriched = Object.assign({}, evt, { nativeCursor: nativeBlackCursorActive, provider: prov });
  const hasXY = typeof enriched.x === 'number' && typeof enriched.y === 'number';
  if (hasXY) {
    const targetDisplay = screen.getDisplayNearestPoint({ x: Math.round(enriched.x), y: Math.round(enriched.y) });
    const b = targetDisplay.bounds;
    if (!cursorDisplayBounds || cursorDisplayBounds.x !== b.x || cursorDisplayBounds.y !== b.y || cursorDisplayBounds.width !== b.width || cursorDisplayBounds.height !== b.height) {
      cursorDisplayBounds = b;
      cursorWindow.setBounds(b);
    }
    showCursorOverlayAboveAll();
    cursorWindow.webContents.send('cursor:event', Object.assign({}, enriched, {
      x: enriched.x - b.x,
      y: enriched.y - b.y
    }));
  } else {
    showCursorOverlayAboveAll();
    cursorWindow.webContents.send('cursor:event', enriched);
  }
}

let startupModelsPromise = null;

const agent = new AgentRunner({
  gemini,
  screen: screenSvc,
  automation,
  mcpManager,
  getSettings: () => settingsStore.get(),
  getMatch: () => cachedMatch,
  getModels: () => cachedModels,
  cursorEmitter: forwardCursorEvent,
  onStatus: (patch) => {
    const s = settingsStore.get();
    const nextRunning = patch && patch.running !== undefined ? patch.running : currentStatus.running;
    const nextMode = patch && patch.mode !== undefined ? patch.mode : currentStatus.mode;
    const prov = getConfirmedProvider();
    const wantOverlay = !!(s.showOverlay !== false && nextRunning && nextMode === 'work');
    if (wantOverlay && (!blackCursorDesired || activeCursorStyle !== prov)) {
      setNativeBlackCursor(true).catch(() => {});
    } else if (!nextRunning && (blackCursorDesired || nativeBlackCursorActive)) {
      setNativeBlackCursor(false).catch(() => {});
    }
    currentStatus = Object.assign({}, currentStatus, patch, {
      permissionMode: s.permissionMode,
      nativeCursor: nativeBlackCursorActive,
      provider: prov
    });
    broadcast('agent:status', currentStatus);
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      if (s.showWidget && nextRunning && nextMode === 'work') {
        if (!widgetWindow.isVisible()) widgetWindow.showInactive();
      } else if (widgetWindow.isVisible()) {
        widgetWindow.hide();
      }
    }
    if (cursorWindow && !cursorWindow.isDestroyed()) {
      if (wantOverlay) {
        const pt = screen.getCursorScreenPoint();
        const d = screenSvc.currentDisplay() || screen.getDisplayNearestPoint(pt);
        if (d && (!cursorDisplayBounds || cursorDisplayBounds.x !== d.bounds.x || cursorDisplayBounds.y !== d.bounds.y || cursorDisplayBounds.width !== d.bounds.width || cursorDisplayBounds.height !== d.bounds.height)) {
          cursorDisplayBounds = d.bounds;
          cursorWindow.setBounds(d.bounds);
        }
        showCursorOverlayAboveAll();
        const b = cursorDisplayBounds || (d && d.bounds) || { x: 0, y: 0 };
        cursorWindow.webContents.send('cursor:event', {
          kind: 'layer-only',
          nativeCursor: nativeBlackCursorActive,
          provider: prov,
          x: pt.x - b.x,
          y: pt.y - b.y,
          label: currentStatus.stepText || 'Brief'
        });
      } else if (!currentStatus.running) {
        cursorWindow.webContents.send('cursor:event', { kind: 'hide', nativeCursor: false });
        if (cursorWindow.isVisible()) cursorWindow.hide();
      }
    }
  }
});

agent.on('log', (entry) => { pushLog(entry); broadcast('agent:log', entry); });
agent.on('chat-delta', (p) => broadcast('agent:chat-delta', p));
agent.on('work-plan', (p) => broadcast('agent:work-plan', p));
agent.on('work-thought', (p) => broadcast('agent:work-thought', p));
agent.on('work-note', (p) => broadcast('agent:work-note', p));
agent.on('work-step', (p) => broadcast('agent:work-step', p));
agent.on('command-output', (p) => broadcast('agent:command-output', p));
agent.on('prepare-desktop-eyes', () => {
  const s = settingsStore.get();
  if (s.minimizeDuringAgent !== false && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.minimize();
  }
});
agent.on('restore-after-eyes', () => {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) {
    mainWindow.restore();
    mainWindow.showInactive();
  }
});
agent.on('before-screen-action', () => {
  const s = settingsStore.get();
  if (s.minimizeDuringAgent !== false && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
    mainWindow.minimize();
  }
});
function focusMainWindowForUser() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

let winToastRegStarted = false;
function ensureWindowsToastRegistration() {
  if (winToastRegStarted || process.platform !== 'win32') return;
  winToastRegStarted = true;
  try {
    const { execFile } = require('child_process');
    const regKey = 'HKCU\\Software\\Classes\\AppUserModelId\\com.locally.desktop';
    const iconFile = path.join(ROOT, 'assets', 'icon.png');
    execFile('reg.exe', ['add', regKey, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'Brief', '/f'], { windowsHide: true }, () => {});
    if (fs.existsSync(iconFile)) {
      execFile('reg.exe', ['add', regKey, '/v', 'IconUri', '/t', 'REG_SZ', '/d', iconFile, '/f'], { windowsHide: true }, () => {});
    }
  } catch (_) { /* ignore */ }
}

if (process.platform === 'win32' && !IS_SELFTEST && !IS_FUNCTEST) {
  ensureWindowsToastRegistration();
}

function sendWindowsNotification({ title, body, urgency = 'normal', silent = false }) {
  try {
    ensureWindowsToastRegistration();
    if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return false;
    const iconFile = path.join(ROOT, 'assets', 'icon.png');
    const cleanTitle = String(title || 'Brief').replace(/\s+/g, ' ').trim().slice(0, 90);
    const cleanBody = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 220) || 'Open Brief for details.';
    const n = new Notification({
      title: cleanTitle,
      body: cleanBody,
      icon: fs.existsSync(iconFile) ? iconFile : undefined,
      urgency,
      silent
    });
    n.on('click', () => focusMainWindowForUser());
    n.show();
    return true;
  } catch (_) {
    return false;
  }
}

agent.on('approval-required', (req) => {
  focusMainWindowForUser();
  sendWindowsNotification({
    title: 'Brief needs your permission',
    body: (req && req.description) || 'Open Brief to Allow or Deny the pending action.',
    urgency: 'critical'
  });
  broadcast('agent:approval-required', req);
});
agent.on('approval-resolved', (p) => broadcast('agent:approval-resolved', p));
agent.on('set-watch-live', (watch) => {
  const next = settingsStore.set({ showOverlay: !!watch });
  if (!watch) {
    setNativeBlackCursor(false).catch(() => {});
    if (cursorWindow && !cursorWindow.isDestroyed()) {
      cursorWindow.webContents.send('cursor:event', { kind: 'hide', nativeCursor: false });
      if (cursorWindow.isVisible()) cursorWindow.hide();
    }
  } else if (currentStatus.running && currentStatus.mode === 'work') {
    setNativeBlackCursor(true).catch(() => {});
    showCursorOverlayAboveAll();
  }
  broadcast('settings:changed', next);
});
gemini.onUsage((u) => broadcast('usage:update', u));

let captureHookDepth = 0;
screenSvc.setCaptureHooks(
  async () => {
    captureHookDepth += 1;
    if (cursorWindow && !cursorWindow.isDestroyed() && cursorWindow.isVisible()) {
      cursorWindow.hide();
      await new Promise((r) => setTimeout(r, 35));
    }
    const s = settingsStore.get();
    if (currentStatus.running && currentStatus.mode === 'work' && !agent.pendingApproval && s.minimizeDuringAgent !== false && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.minimize();
      await new Promise((r) => setTimeout(r, 170));
    }
  },
  async () => {
    captureHookDepth = Math.max(0, captureHookDepth - 1);
    if (captureHookDepth === 0 && cursorWindow && !cursorWindow.isDestroyed() && currentStatus.running && currentStatus.mode === 'work' && settingsStore.get().showOverlay !== false) {
      showCursorOverlayAboveAll();
      cursorWindow.webContents.send('cursor:event', {
        kind: 'layer-only',
        nativeCursor: nativeBlackCursorActive,
        provider: getConfirmedProvider()
      });
    }
  }
);

function createMainWindow() {
  const iconPath = path.join(ROOT, 'assets', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 520,
    minHeight: 500,
    title: 'Brief',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#212121',
    show: !(IS_SELFTEST || IS_FUNCTEST),
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });

  mainWindow.loadFile(path.join(ROOT, 'app.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.close();
    if (cursorWindow && !cursorWindow.isDestroyed()) cursorWindow.close();
  });
}

function createWidgetWindow() {
  const s = settingsStore.get();
  const primary = screen.getPrimaryDisplay().workArea;
  const w = 340;
  const h = 166;
  widgetWindow = new BrowserWindow({
    width: w,
    height: h,
    x: primary.x + primary.width - w - 20,
    y: primary.y + primary.height - h - 20,
    frame: false,
    transparent: true,
    resizable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  widgetWindow.setAlwaysOnTop(true, 'screen-saver');
  widgetWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'overlay-widget.html'));
  widgetWindow.webContents.once('did-finish-load', () => {
    widgetWindow.webContents.send('agent:status', currentStatus);
  });
}

function createCursorWindow() {
  const primary = screen.getPrimaryDisplay().bounds;
  cursorDisplayBounds = primary;
  cursorWindow = new BrowserWindow({
    x: primary.x,
    y: primary.y,
    width: primary.width,
    height: primary.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  cursorWindow.setAlwaysOnTop(true, 'screen-saver');
  cursorWindow.setIgnoreMouseEvents(true, { forward: true });
  cursorWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'cursor-overlay.html'));
}

function registerStopHotkey(accelerator) {
  if (registeredHotkey) {
    try { globalShortcut.unregister(registeredHotkey); } catch (_) { /* ignore */ }
    registeredHotkey = '';
  }
  const accel = String(accelerator || 'CommandOrControl+Alt+Q').trim();
  if (!accel) return { ok: false, error: 'Hotkey cannot be empty.' };
  let ok = false;
  try {
    ok = globalShortcut.register(accel, () => {
      agent.stop('Global emergency stop hotkey (' + accel + ') pressed.');
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (ok) registeredHotkey = accel;
  return { ok, hotkey: accel, error: ok ? null : 'Could not register hotkey "' + accel + '" (it may already be in use by another app).' };
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: 'Locally', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.__locallyMenuAction && window.__locallyMenuAction("new-chat")').catch(() => {}) },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.__locallyMenuAction && window.__locallyMenuAction("settings")').catch(() => {}) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'OS Permissions Guide', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.__locallyMenuAction && window.__locallyMenuAction("permissions")').catch(() => {}) },
        { label: 'Emergency Stop Now', click: () => agent.stop('Stopped from Help menu.') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function chooseDefaultModelIfNeeded(match, models, provider) {
  const s = settingsStore.get();
  const prov = provider || (match && match.provider) || s.provider || 'gemini';
  const validIds = new Set((models || []).map((m) => m.id));
  const cleanPatch = {};
  if (s.customModel && !validIds.has(stripModelPrefix(s.customModel))) {
    cleanPatch.customModel = '';
  }
  if (s.roles && typeof s.roles === 'object') {
    const nextRoles = Object.assign({}, s.roles);
    let roleChanged = false;
    for (const rk of ['chat', 'agent', 'fast', 'planner']) {
      if (nextRoles[rk] && !validIds.has(stripModelPrefix(nextRoles[rk]))) {
        nextRoles[rk] = '';
        roleChanged = true;
      }
    }
    if (roleChanged) cleanPatch.roles = nextRoles;
  }
  if (Object.keys(cleanPatch).length) settingsStore.set(cleanPatch);

  if (s.activeModel && !/customtools/i.test(s.activeModel)) {
    const exists = validIds.has(stripModelPrefix(s.activeModel));
    if (exists) return;
  }
  const p = (match && match.presets) || {};
  let pick = '';
  if (prov === 'openai') {
    pick = (p.gpt61terra && p.gpt61terra.id) ||
      (p.gpt6luna && p.gpt6luna.id) ||
      (p.gpt6sol && p.gpt6sol.id) ||
      (p.gpt62astra && p.gpt62astra.id) ||
      (match && match.bestFlash) ||
      (match && match.fast) ||
      ((models[0] || {}).id || '');
  } else if (prov === 'anthropic') {
    pick = (p.claudesonnet55 && p.claudesonnet55.id) ||
      (p.claudehaiku55 && p.claudehaiku55.id) ||
      (p.claudeopus55 && p.claudeopus55.id) ||
      (p.claudefable52 && p.claudefable52.id) ||
      (match && match.bestFlash) ||
      (match && match.fast) ||
      ((models[0] || {}).id || '');
  } else if (prov === 'openrouter') {
    pick = (p.or_flash38 && p.or_flash38.id) ||
      (p.or_flashlite35 && p.or_flashlite35.id) ||
      (p.or_gpt61terra && p.or_gpt61terra.id) ||
      (p.or_sonnet55 && p.or_sonnet55.id) ||
      ((models[0] || {}).id || 'google/gemini-3.8-flash');
  } else {
    pick = (p.flash38 && p.flash38.id) ||
      (p.flashlite35 && p.flashlite35.id) ||
      (p.hydrogen && p.hydrogen.id) ||
      (p.neon && p.neon.id) ||
      (p.argon && p.argon.id) ||
      (match && match.bestFlash) ||
      (match && match.fast) ||
      (match && match.bestPro) ||
      ((models.find((m) => m.methods && m.methods.includes('generateContent')) || {}).id || '');
  }
  if (pick) settingsStore.set({ activeModel: pick, provider: prov });
}

/* ------------------------------------------------------------------ */
/* IPC handlers                                                       */
/* ------------------------------------------------------------------ */

function setupIpc() {
  ipcMain.handle('app:bootstrap', async () => {
    await keyStore.init();
    if (keyStore.has() && !cachedModels.length && startupModelsPromise) {
      await Promise.race([startupModelsPromise, new Promise((r) => setTimeout(r, 4500))]);
    }
    const s = settingsStore.get();
    const c = chatsStore.get();
    const diag = await getOsPermissionsInfo(automation, { systemPreferences });
    const activeProv = keyStore.has() ? detectKeyProvider(keyStore.get()) : (s.provider || 'gemini');
    const provInfo = providerMeta(activeProv);
    const firstRunRequested = !!firstRunPending;
    firstRunPending = false;
    return {
      version: app.getVersion(),
      userDataDir,
      firstRunRequested,
      os: { platform: process.platform, release: os.release(), type: os.type(), arch: os.arch(), backendName: automation.name },
      displays: screenSvc.displays(),
      diagnostics: diag,
      key: { has: keyStore.has(), masked: keyStore.masked(), backend: keyStore.backend(), available: await keyStore.available(), slots: keyStore.slots() },
      slots: keyStore.slots(),
      provider: activeProv,
      providerInfo: provInfo,
      settings: s,
      chatsData: c,
      models: cachedModels,
      match: cachedMatch,
      presets: provInfo.presets,
      usage: gemini.usage,
      status: currentStatus,
      hotkey: registeredHotkey || s.hotkey,
      log: actionLog,
      mcpServers: mcpManager.list(),
      mcpBridge: mcpManager.getBridgeInfo()
    };
  });

  ipcMain.handle('app:show-main', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    return true;
  });

  ipcMain.handle('app:open-external', async (_e, url) => {
    if (typeof url === 'string' && /^(https?:|x-apple\.systempreferences:|ms-settings:)/i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle('app:open-path', async (_e, p) => {
    const resolved = resolvePath(p);
    const err = await shell.openPath(resolved);
    if (err) throw new Error(err);
    return resolved;
  });

  async function readAttachmentFiles(filePaths) {
    const out = [];
    for (const filePath of (filePaths || []).slice(0, 6)) {
      const name = path.basename(filePath);
      const ext = path.extname(name).toLowerCase();
      const st = await fsp.stat(filePath).catch(() => null);
      if (!st) continue;
      if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
        if (st.size > 8 * 1024 * 1024) continue;
        const buf = await fsp.readFile(filePath);
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
        out.push({ name, path: filePath, kind: 'image', mime, base64: buf.toString('base64'), size: st.size });
      } else {
        let txt = '';
        if (st.size <= 1024 * 1024) {
          txt = await fsp.readFile(filePath, 'utf8').catch(() => '');
        }
        if (txt && !txt.includes('\u0000')) {
          out.push({ name, path: filePath, kind: 'text', textContent: txt, size: st.size });
        } else {
          out.push({
            name,
            path: filePath,
            kind: 'file',
            textContent: `Attached file on disk:\nPath: ${filePath}\nSize: ${st.size} bytes\nExtension: ${ext || '(none)'}\n(Inspect, open, or process this path using your file/terminal/desktop tools if needed.)`,
            size: st.size
          });
        }
      }
    }
    return out;
  }

  ipcMain.handle('app:pick-folder', async (_e, defaultPath) => {
    const opts = { properties: ['openDirectory'] };
    if (defaultPath && fs.existsSync(defaultPath)) opts.defaultPath = defaultPath;
    const res = await dialog.showOpenDialog(mainWindow, opts);
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('app:pick-files', async (_e, opts) => {
    const dlgOpts = { properties: ['openFile', 'multiSelections'] };
    if (opts && opts.defaultPath && fs.existsSync(String(opts.defaultPath))) {
      dlgOpts.defaultPath = String(opts.defaultPath);
    }
    const res = await dialog.showOpenDialog(mainWindow, dlgOpts);
    if (res.canceled || !res.filePaths.length) return [];
    return await readAttachmentFiles(res.filePaths);
  });

  ipcMain.handle('app:pick-folder-attachment', async (_e, opts) => {
    const dlgOpts = { properties: ['openDirectory'] };
    if (opts && opts.defaultPath && fs.existsSync(String(opts.defaultPath))) {
      dlgOpts.defaultPath = String(opts.defaultPath);
    }
    const res = await dialog.showOpenDialog(mainWindow, dlgOpts);
    if (res.canceled || !res.filePaths.length) return null;
    const folderPath = res.filePaths[0];
    const entries = await fsp.readdir(folderPath, { withFileTypes: true }).catch(() => []);
    const listed = entries.slice(0, 80).map((ent) => (ent.isDirectory() ? '[DIR]  ' : '[FILE] ') + ent.name);
    if (entries.length > 80) listed.push(`... and ${entries.length - 80} more item(s)`);
    return {
      name: 'Folder: ' + (path.basename(folderPath) || folderPath),
      path: folderPath,
      kind: 'folder',
      textContent: `Attached Folder Path: ${folderPath}\nItems (${entries.length}):\n${listed.join('\n') || '(empty folder)'}`,
      size: entries.length
    };
  });

  ipcMain.handle('app:capture-screenshot-attachment', async () => {
    const wasVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized();
    if (wasVisible) {
      mainWindow.minimize();
      await new Promise((r) => setTimeout(r, 180));
    }
    try {
      const shot = await screenSvc.capture({ format: 'png' });
      return {
        name: 'Screenshot-' + new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19) + '.png',
        path: '',
        kind: 'image',
        mime: 'image/png',
        base64: shot.base64,
        size: Buffer.byteLength(shot.base64, 'base64')
      };
    } finally {
      if (wasVisible && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  ipcMain.handle('app:list-drives', async () => {
    const places = [];
    const quick = [
      { id: 'desktop', label: 'Desktop', kind: 'folder', path: resolvePath('Desktop') },
      { id: 'documents', label: 'Documents', kind: 'folder', path: resolvePath('Documents') },
      { id: 'downloads', label: 'Downloads', kind: 'folder', path: resolvePath('Downloads') }
    ];
    const cloudCandidates = [
      { id: 'onedrive', label: 'OneDrive', path: process.env.OneDrive || process.env.OneDriveConsumer || '' },
      { id: 'onedrive-work', label: 'OneDrive Work', path: process.env.OneDriveCommercial || '' },
      { id: 'gdrive', label: 'Google Drive', path: path.join(os.homedir(), 'Google Drive') },
      { id: 'gdrive-my', label: 'Google Drive', path: path.join(os.homedir(), 'My Drive') },
      { id: 'dropbox', label: 'Dropbox', path: path.join(os.homedir(), 'Dropbox') }
    ];
    for (const q of quick) {
      if (q.path && fs.existsSync(q.path)) places.push(q);
    }
    for (const c of cloudCandidates) {
      if (c.path && fs.existsSync(c.path) && !places.some((p) => p.path === c.path)) {
        places.push({ id: c.id, label: c.label, kind: 'cloud', path: c.path });
      }
    }
    const drives = [];
    if (process.platform === 'win32') {
      const { execFile } = require('child_process');
      const psOut = await new Promise((resolve) => {
        execFile('powershell.exe', [
          '-NoProfile',
          '-Command',
          "[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady } | ForEach-Object { [pscustomobject]@{ path=$_.Name; label=$_.VolumeLabel; driveType=[string]$_.DriveType; freeGB=[math]::Round($_.AvailableFreeSpace/1GB,1); totalGB=[math]::Round($_.TotalSize/1GB,1) } } | ConvertTo-Json -Compress"
        ], { timeout: 3000 }, (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
      });
      if (psOut) {
        try {
          const parsed = JSON.parse(psOut);
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          for (const d of arr) {
            if (!d || !d.path) continue;
            const letter = String(d.path).replace(/\\+$/, '');
            const vol = d.label ? `${letter} (${d.label})` : `${letter} Drive`;
            drives.push({
              id: 'drive-' + letter[0].toLowerCase(),
              label: vol,
              sub: `${d.freeGB} GB free of ${d.totalGB} GB`,
              kind: 'drive',
              path: d.path
            });
          }
        } catch (_) { /* ignore */ }
      }
    }
    return { drives, places };
  });

  let lastValidatedCandidate = null;

  ipcMain.handle('key:status', async () => {
    await keyStore.init();
    return {
      has: keyStore.has(),
      masked: keyStore.masked(),
      backend: keyStore.backend(),
      available: await keyStore.available(),
      slots: keyStore.slots()
    };
  });

  ipcMain.handle('key:slots', async () => {
    await keyStore.init();
    return keyStore.slots();
  });

  ipcMain.handle('key:switch-slot', async (_e, { provider }) => {
    await keyStore.init();
    const p = String(provider || '').toLowerCase();
    const k = await keyStore.getAsync(p);
    if (!k) throw new Error('No key is saved in slot: ' + p);
    await keyStore.set(k, p);
    agent.clearModelCooldowns();
    const provInfo = providerMeta(p);
    const res = await gemini.validate(k, settingsStore.get().activeModel);
    cachedModels = res.models || [];
    cachedMatch = res.match || null;
    settingsStore.set({ provider: p });
    if (cachedMatch) chooseDefaultModelIfNeeded(cachedMatch, cachedModels, p);
    settingsStore.set({
      lastValidation: { status: res.status, icon: res.icon, title: res.title, message: res.message, testModel: res.testModel, provider: p, at: new Date().toISOString() }
    });
    const outBundle = {
      validation: res,
      provider: p,
      providerInfo: provInfo,
      presets: provInfo.presets,
      key: { has: keyStore.has(), masked: keyStore.masked(), backend: keyStore.backend(), slots: keyStore.slots() },
      slots: keyStore.slots(),
      models: cachedModels,
      match: cachedMatch,
      settings: settingsStore.get()
    };
    broadcast('models:updated', outBundle);
    return outBundle;
  });

  ipcMain.handle('key:peek', async () => {
    await keyStore.init();
    return (await keyStore.getAsync()) || '';
  });

  ipcMain.handle('key:test-only', async (_e, { key, testModel }) => {
    const trimmed = String(key || '').trim();
    const prov = detectKeyProvider(trimmed);
    const provInfo = providerMeta(prov);
    if (!trimmed) {
      return { validation: { status: 'nokey', icon: '❌', title: 'No key entered', message: 'Paste your Gemini, OpenAI, or Claude API key first.', steps: [], provider: prov }, provider: prov, providerInfo: provInfo, presets: provInfo.presets, models: [], match: null };
    }
    const res = await gemini.validate(trimmed, testModel || settingsStore.get().activeModel);
    if (res.status !== 'invalid' && res.status !== 'nokey') {
      lastValidatedCandidate = {
        key: trimmed,
        provider: prov,
        validation: res,
        models: res.models || [],
        match: res.match || null
      };
    }
    return { validation: res, provider: prov, providerInfo: provInfo, presets: provInfo.presets, models: res.models || [], match: res.match || null };
  });

  ipcMain.handle('key:save-only', async (_e, { key, testModel }) => {
    const trimmed = String(key || '').trim();
    if (!trimmed) throw new Error('Enter an API key before saving.');
    const prov = detectKeyProvider(trimmed);
    const provInfo = providerMeta(prov);
    let res;
    let models = [];
    let match = null;
    if (lastValidatedCandidate && lastValidatedCandidate.key === trimmed) {
      res = lastValidatedCandidate.validation;
      models = lastValidatedCandidate.models || [];
      match = lastValidatedCandidate.match || null;
    } else {
      res = await gemini.validate(trimmed, testModel || settingsStore.get().activeModel);
      models = res.models || [];
      match = res.match || null;
    }
    if (res.status === 'invalid' || res.status === 'nokey') {
      return {
        validation: res,
        provider: prov,
        providerInfo: provInfo,
        presets: provInfo.presets,
        key: { has: keyStore.has(), masked: keyStore.masked(), backend: keyStore.backend() },
        models: cachedModels,
        match: cachedMatch,
        settings: settingsStore.get()
      };
    }
    if (models.length) {
      cachedModels = models;
      cachedMatch = match;
    }
    await keyStore.set(trimmed);
    agent.clearModelCooldowns();
    settingsStore.set({ provider: prov });
    if (cachedMatch) chooseDefaultModelIfNeeded(cachedMatch, cachedModels, prov);
    settingsStore.set({
      lastValidation: { status: res.status, icon: res.icon, title: res.title, message: res.message, testModel: res.testModel, provider: prov, at: new Date().toISOString() }
    });
    const outBundle = {
      validation: res,
      provider: prov,
      providerInfo: provInfo,
      presets: provInfo.presets,
      key: { has: keyStore.has(), masked: keyStore.masked(), backend: keyStore.backend(), slots: keyStore.slots() },
      slots: keyStore.slots(),
      models: cachedModels,
      match: cachedMatch,
      settings: settingsStore.get()
    };
    broadcast('models:updated', outBundle);
    return outBundle;
  });

  ipcMain.handle('key:save-validate', async (_e, { key, testModel }) => {
    const trimmed = String(key || '').trim();
    const prov = detectKeyProvider(trimmed);
    const provInfo = providerMeta(prov);
    const res = await gemini.validate(trimmed, testModel || settingsStore.get().activeModel);
    if (res.models && res.models.length) {
      cachedModels = res.models;
      cachedMatch = res.match;
    }
    // Save encrypted locally whenever key itself isn't invalid (e.g. valid, rate-limited, or model noaccess)
    if (res.status !== 'invalid' && res.status !== 'nokey') {
      await keyStore.set(trimmed);
      agent.clearModelCooldowns();
      settingsStore.set({ provider: prov });
      if (cachedMatch) chooseDefaultModelIfNeeded(cachedMatch, cachedModels, prov);
    }
    settingsStore.set({
      lastValidation: { status: res.status, icon: res.icon, title: res.title, message: res.message, testModel: res.testModel, provider: prov, at: new Date().toISOString() }
    });
    const outBundle = {
      validation: res,
      provider: prov,
      providerInfo: provInfo,
      presets: provInfo.presets,
      key: { has: keyStore.has(), masked: keyStore.masked(), backend: keyStore.backend(), slots: keyStore.slots() },
      slots: keyStore.slots(),
      models: cachedModels,
      match: cachedMatch,
      settings: settingsStore.get()
    };
    broadcast('models:updated', outBundle);
    return outBundle;
  });

  ipcMain.handle('key:validate-current', async (_e, { testModel }) => {
    const k = await keyStore.getAsync();
    if (!k) return { validation: { status: 'nokey', icon: '❌', title: 'No key saved', message: 'Enter an API key first.', steps: [] } };
    const prov = detectKeyProvider(k);
    const provInfo = providerMeta(prov);
    const res = await gemini.validate(k, testModel || settingsStore.get().activeModel);
    if (res.models && res.models.length) {
      cachedModels = res.models;
      cachedMatch = res.match;
      settingsStore.set({ provider: prov });
      chooseDefaultModelIfNeeded(cachedMatch, cachedModels, prov);
    }
    settingsStore.set({
      lastValidation: { status: res.status, icon: res.icon, title: res.title, message: res.message, testModel: res.testModel, provider: prov, at: new Date().toISOString() }
    });
    return { validation: res, provider: prov, providerInfo: provInfo, presets: provInfo.presets, models: cachedModels, match: cachedMatch, settings: settingsStore.get(), slots: keyStore.slots() };
  });

  ipcMain.handle('key:remove', (_e, opts) => {
    lastValidatedCandidate = null;
    agent.clearModelCooldowns();
    const targetProv = opts && opts.provider ? String(opts.provider) : undefined;
    keyStore.remove(targetProv);
    if (!targetProv) {
      cachedModels = [];
      cachedMatch = null;
      settingsStore.set({ lastValidation: null });
    }
    return { has: keyStore.has(), masked: keyStore.masked(), slots: keyStore.slots() };
  });

  ipcMain.handle('models:refresh', async () => {
    const k = await keyStore.getAsync();
    if (!k) throw new Error('No API key is saved.');
    const prov = detectKeyProvider(k);
    const provInfo = providerMeta(prov);
    const models = await gemini.listModels(k);
    cachedModels = models;
    cachedMatch = matchPresetsForProvider(prov, models);
    settingsStore.set({ provider: prov });
    chooseDefaultModelIfNeeded(cachedMatch, cachedModels, prov);
    return { provider: prov, providerInfo: provInfo, presets: provInfo.presets, models: cachedModels, match: cachedMatch, settings: settingsStore.get() };
  });

  ipcMain.handle('models:test', async (_e, { modelId }) => {
    const k = await keyStore.getAsync();
    if (!k) throw new Error('No API key is saved.');
    return await gemini.validate(k, stripModelPrefix(modelId));
  });

  ipcMain.handle('usage:get', () => gemini.usage);
  ipcMain.handle('usage:reset', () => { gemini.resetUsage(); return gemini.usage; });

  ipcMain.handle('settings:update', (_e, patch) => {
    const clean = Object.assign({}, patch || {});
    delete clean.permissionMode; // permissionMode changes must go through permission:set
    const next = settingsStore.set(clean);
    if (clean.showWidget !== undefined && widgetWindow && !widgetWindow.isDestroyed()) {
      if (clean.showWidget && currentStatus.running && currentStatus.mode === 'work') widgetWindow.showInactive();
      else widgetWindow.hide();
    }
    broadcast('settings:changed', next);
    return next;
  });

  ipcMain.handle('permission:set', (_e, { mode }) => {
    if (!['ask', 'full', 'chat'].includes(mode)) throw new Error('Unknown permission mode.');
    const next = settingsStore.set({ permissionMode: mode });
    currentStatus = Object.assign({}, currentStatus, { permissionMode: mode });
    broadcast('agent:status', currentStatus);
    broadcast('settings:changed', next);
    return { ok: true, settings: next };
  });

  ipcMain.handle('hotkey:set', (_e, { accelerator }) => {
    const res = registerStopHotkey(accelerator);
    if (res.ok) settingsStore.set({ hotkey: res.hotkey });
    return res;
  });

  ipcMain.handle('chats:save', (_e, data) => {
    chatsStore.replace(data || { chats: [], projects: [] });
    return true;
  });

  ipcMain.handle('os:diagnostics', async () => ({
    displays: screenSvc.displays(),
    diagnostics: await getOsPermissionsInfo(automation, { systemPreferences })
  }));

  ipcMain.handle('os:test-automation', async () => {
    const results = [];
    try {
      const shot = await screenSvc.capture({ maxWidth: 480, format: 'jpeg' });
      results.push({ test: 'Screenshot capture', ok: true, detail: `Captured ${shot.width}×${shot.height} (physical ${shot.physical.width}×${shot.physical.height}) on display #${shot.index}` });
    } catch (e) {
      results.push({ test: 'Screenshot capture', ok: false, detail: e.message });
    }
    try {
      const pos = await automation.position();
      const moved = await automation.move(pos.x + 12, pos.y + 8, 120);
      await automation.move(pos.x, pos.y, 120);
      results.push({ test: 'Real cursor control', ok: true, detail: `Moved pointer from (${pos.x}, ${pos.y}) → (${moved.x}, ${moved.y}) and back.` });
    } catch (e) {
      results.push({ test: 'Real cursor control', ok: false, detail: e.message });
    }
    return { results, displays: screenSvc.displays() };
  });

  ipcMain.handle('os:test-overlay', async () => {
    const d = screenSvc.currentDisplay();
    const b = d.bounds;
    const cx = b.x + Math.round(b.width * 0.5);
    const cy = b.y + Math.round(b.height * 0.45);
    const prevPt = screen.getCursorScreenPoint();
    await setNativeBlackCursor(true);
    try {
      const p1 = screen.dipToScreenPoint({ x: cx - 160, y: cy - 60 });
      const p2 = screen.dipToScreenPoint({ x: cx + 160, y: cy + 60 });
      forwardCursorEvent({ kind: 'move', x: cx - 160, y: cy - 60, ms: 200 });
      await automation.move(p1.x, p1.y, 200).catch(() => {});
      await new Promise((r) => setTimeout(r, 90));
      forwardCursorEvent({ kind: 'move', x: cx + 160, y: cy + 60, ms: 220 });
      await automation.move(p2.x, p2.y, 220).catch(() => {});
      forwardCursorEvent({ kind: 'click', x: cx + 160, y: cy + 60, button: 'left', count: 1 });
      await new Promise((r) => setTimeout(r, 600));
      const pBack = screen.dipToScreenPoint({ x: prevPt.x, y: prevPt.y });
      await automation.move(pBack.x, pBack.y, 160).catch(() => {});
    } finally {
      if (!agent.isRunning()) {
        await setNativeBlackCursor(false);
        forwardCursorEvent({ kind: 'hide' });
      }
    }
    return { ok: true, nativeCursor: process.platform === 'win32' };
  });

  ipcMain.handle('widget:toggle', (_e, show) => {
    const val = show === undefined ? !settingsStore.get().showWidget : !!show;
    settingsStore.set({ showWidget: val });
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      if (val && currentStatus.running && currentStatus.mode === 'work') widgetWindow.showInactive();
      else widgetWindow.hide();
    }
    return val;
  });

  ipcMain.handle('cursor:toggle', (_e, show) => {
    const val = show === undefined ? !settingsStore.get().showOverlay : !!show;
    settingsStore.set({ showOverlay: val });
    if (!val && cursorWindow && !cursorWindow.isDestroyed()) cursorWindow.hide();
    return val;
  });

  ipcMain.handle('screenshare:list', async () => {
    return await screenSvc.listShareSources();
  });

  ipcMain.handle('screenshare:preview', async (_e, source) => {
    return await screenSvc.captureSharePreview(source);
  });

  ipcMain.handle('agent:chat', async (_e, payload) => {
    if (!settingsStore.get().activeModel && cachedModels.length === 0 && startupModelsPromise) {
      await Promise.race([startupModelsPromise.catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    }
    try {
      const res = await agent.runChat(payload);
      if (mainWindow && !mainWindow.isDestroyed() && (!mainWindow.isFocused() || mainWindow.isMinimized())) {
        sendWindowsNotification({
          title: 'Brief replied',
          body: (res && res.text) ? String(res.text).slice(0, 180) : 'New message ready in Brief.'
        });
      }
      return res;
    } catch (err) {
      sendWindowsNotification({
        title: 'Brief encountered an error',
        body: (err && err.message) || 'Chat request failed.',
        urgency: 'critical'
      });
      throw err;
    }
  });

  ipcMain.handle('agent:work', async (_e, payload) => {
    const s = settingsStore.get();
    if (s.permissionMode === 'chat') {
      throw new Error('Permission mode is set to "Chat only". Switch to "Ask for permission" or "Full access" (or the Work tab) to let Brief work on your computer.');
    }
    if (!settingsStore.get().activeModel && cachedModels.length === 0 && startupModelsPromise) {
      await Promise.race([startupModelsPromise.catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    }
    const isBgMode = String((payload && payload.workVisualMode) || s.briefWorkVisualMode || '').toLowerCase() === 'background';
    const shouldMin = !isBgMode && s.showOverlay !== false && s.minimizeDuringAgent !== false && mainWindow && !mainWindow.isDestroyed();
    if (shouldMin && s.permissionMode === 'full') mainWindow.minimize();
    try {
      const res = await agent.runWork(payload);
      const summary = (res && res.text) ? String(res.text).replace(/\s+/g, ' ').trim() : 'Desktop task finished.';
      const timePrefix = (res && res.elapsedLabel) ? ('Worked ' + res.elapsedLabel + ' · ') : '';
      sendWindowsNotification({
        title: res && res.stopped ? 'Brief stopped' : 'Brief finished working',
        body: (timePrefix + summary).slice(0, 200)
      });
      return res;
    } catch (err) {
      sendWindowsNotification({
        title: 'Brief encountered an error',
        body: (err && err.message) || 'Desktop task failed.',
        urgency: 'critical'
      });
      throw err;
    } finally {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) {
        mainWindow.restore();
        mainWindow.show();
      }
    }
  });

  ipcMain.handle('agent:stop', (_e, reason) => agent.stop(reason || 'Stopped by user.'));
  ipcMain.handle('agent:approval', (_e, decision) => agent.resolveApproval(decision));

  ipcMain.handle('mcp:list', () => mcpManager.list());
  ipcMain.handle('mcp:detect-apps', () => mcpManager.detectRunningApps());
  ipcMain.handle('mcp:scan-live', () => mcpManager.scanAndConnectLive());
  ipcMain.handle('mcp:bridge-info', () => mcpManager.getBridgeInfo());
  ipcMain.handle('mcp:save-server', (_e, cfg) => mcpManager.saveServer(cfg));
  ipcMain.handle('mcp:connect', (_e, { id, config }) => mcpManager.connectServer(id, config));
  ipcMain.handle('mcp:disconnect', (_e, id) => mcpManager.disconnectServer(id));
  ipcMain.handle('mcp:remove', (_e, id) => mcpManager.removeServer(id));
}

/* ------------------------------------------------------------------ */
/* Self-test mode (--selftest)                                        */
/* ------------------------------------------------------------------ */

async function runSelfTest() {
  const report = { ok: true, checks: [] };
  const record = (name, ok, detail) => {
    report.checks.push({ name, ok, detail });
    if (!ok) report.ok = false;
  };
  try {
    const diag = await getOsPermissionsInfo(automation, { systemPreferences });
    record('os-detect', true, `${diag.osLabel} · ${diag.backendName}`);
    record('keystore', await keyStore.available(), keyStore.backend());
    const displays = screenSvc.displays();
    record('displays', displays.length > 0, `${displays.length} display(s): ${displays.map((d) => `${d.physical.width}x${d.physical.height}@${Math.round(d.scaleFactor * 100)}%`).join(', ')}`);
    const mapped = screenSvc.mapPoint(500, 500);
    record('dpi-mapping', isFinite(mapped.native.x) && isFinite(mapped.native.y), `norm(500,500) -> dip(${mapped.dip.x},${mapped.dip.y}) -> native(${mapped.native.x},${mapped.native.y})`);
    try {
      const shot = await screenSvc.capture({ maxWidth: 640, format: 'jpeg' });
      record('screenshot', shot.base64.length > 1000, `${shot.width}x${shot.height} jpeg (${shot.base64.length} b64 chars)`);
    } catch (e) {
      record('screenshot', false, e.message);
    }
    record('tools', TOOLS.length >= 20, `${TOOLS.length} real desktop/file/code tools registered`);

    const errors = [];
    mainWindow.webContents.on('console-message', (e) => {
      if (e && (e.level === 'error' || Number(e.level) >= 3)) errors.push(e.message);
    });
    mainWindow.webContents.on('render-process-gone', (_e, d) => errors.push('render-process-gone: ' + d.reason));
    await new Promise((resolve) => {
      if (!mainWindow.webContents.isLoading()) resolve();
      else mainWindow.webContents.once('did-finish-load', resolve);
    });
    await new Promise((r) => setTimeout(r, 800));
    const uiStatus = await mainWindow.webContents.executeJavaScript('window.__locallySelfTest ? window.__locallySelfTest() : { ok: false, error: "missing __locallySelfTest" }');
    record('renderer-ui', !!uiStatus.ok && errors.length === 0, errors.length ? 'Console errors: ' + errors.join(' | ') : JSON.stringify(uiStatus));
    // Note: Windows headless/non-interactive runners return empty desktop capture; interactive desktop sessions pass screenshot natively.
    if (process.platform === 'win32' && !report.checks.find((c) => c.name === 'screenshot').ok) {
      const diagInfo = await getOsPermissionsInfo(automation, { systemPreferences });
      const winInput = diagInfo.checks.find((c) => c.id === 'win-input');
      if (winInput && winInput.status === 'error') {
        report.interactiveDesktop = false;
      }
    }
  } catch (e) {
    record('selftest-exception', false, e.message);
  }
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                      */
/* ------------------------------------------------------------------ */

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  // Enable full desktop access by default (upgrade previous 'ask'-reset installs once, preserve explicit user choices thereafter).
  const initialSettings = settingsStore.get();
  if (!initialSettings.uiCleanV5) {
    settingsStore.set({ showWidget: false, cursorSpeedMs: 220, screenshotMaxWidth: 3840, soundChime: false, uiCleanV4: true, uiCleanV5: true });
  }
  if (!initialSettings.uiCleanV6) {
    settingsStore.set({ permissionMode: initialSettings.permissionMode === 'chat' ? 'chat' : 'full', uiCleanV6: true });
  }
  if (!initialSettings.uiCleanV7) {
    settingsStore.set({
      maxSteps: Math.max(45, Number(initialSettings.maxSteps) || 45),
      cursorSpeedProfile: initialSettings.cursorSpeedProfile || 'adaptive',
      alignCursorBack: initialSettings.alignCursorBack !== false,
      usePlanner: true,
      thinkingLevel: (initialSettings.thinkingLevel === 'low' || !initialSettings.thinkingLevel) ? 'medium' : initialSettings.thinkingLevel,
      uiCleanV7: true
    });
  }
  if (!initialSettings.uiCleanV8) {
    settingsStore.set({
      maxSteps: Math.min(45, Math.max(12, Number(initialSettings.maxSteps) || 45)),
      deepWorkMinMinutes: 0,
      deepWorkMaxMinutes: Number(initialSettings.deepWorkMaxMinutes) > 0 ? Number(initialSettings.deepWorkMaxMinutes) : 25,
      multiAgentParallel: true,
      verifyTaskBeforeFinish: true,
      uiCleanV8: true
    });
  }
  if (!initialSettings.uiCleanV9) {
    settingsStore.set({
      soundChime: false,
      pasteLongText: false,
      typingDelayMs: 42,
      deepWorkMinMinutes: 0,
      maxSteps: Math.min(45, Math.max(12, Number(initialSettings.maxSteps) || 45)),
      uiCleanV9: true
    });
  }
  {
    const legacyRe = /3\.7|2\.[05]|1\.[05]|gpt-?(?:3|4)|claude-(?:2|3)|pro-?3\.1|3\.1-?flash-?lite|gemini-?4-?carbon/i;
    const fix = {};
    if (legacyRe.test(initialSettings.activeModel || '')) fix.activeModel = '';
    if (initialSettings.customModel) fix.customModel = '';
    if (/flash37|flashlite31|pro31|carbon|gpt62sol/i.test(initialSettings.activePreset || '')) fix.activePreset = '';
    if (initialSettings.roles && typeof initialSettings.roles === 'object') {
      const nextR = Object.assign({}, initialSettings.roles);
      let rMod = false;
      for (const rk of ['chat', 'agent', 'fast', 'planner', 'screen']) {
        if (legacyRe.test(nextR[rk] || '')) { nextR[rk] = rk === 'screen' ? 'auto' : ''; rMod = true; }
      }
      if (rMod) fix.roles = nextR;
    }
    if (Object.keys(fix).length) settingsStore.set(fix);
  }
  currentStatus.permissionMode = settingsStore.get().permissionMode;

  buildAppMenu();
  setupIpc();
  createMainWindow();
  createWidgetWindow();
  createCursorWindow();
  registerStopHotkey(settingsStore.get().hotkey);

  // If a key is already encrypted locally, silently refresh model list (only talks to Google Gemini endpoint).
  await keyStore.init();
  if (!IS_SELFTEST && !IS_FUNCTEST && keyStore.has()) {
    const kNow = keyStore.get();
    const prov = detectKeyProvider(kNow);
    const provInfo = providerMeta(prov);
    startupModelsPromise = gemini.listModels().then((models) => {
      cachedModels = models;
      cachedMatch = matchPresetsForProvider(prov, models);
      settingsStore.set({ provider: prov });
      chooseDefaultModelIfNeeded(cachedMatch, cachedModels, prov);
      broadcast('models:updated', { provider: prov, providerInfo: provInfo, presets: provInfo.presets, models: cachedModels, match: cachedMatch, settings: settingsStore.get() });
      broadcast('settings:changed', settingsStore.get());
    }).catch((err) => {
      console.log('[startup listModels]', err.message);
    });
  }

  if (!IS_SELFTEST && !IS_FUNCTEST) {
    automation.init().catch(() => {});
    mcpManager.startBridge(3847).then(() => broadcast('mcp:updated', mcpManager.list())).catch(() => {});
    mcpManager.connectEnabledOnStartup().catch(() => {});
    setTimeout(() => { mcpManager.scanAndConnectLive().catch(() => {}); }, 800);
  }

  if (IS_FUNCTEST) {
    const { runFunctionalTests } = require(path.join(ROOT, 'scripts', 'test-functional.js'));
    const funcReport = await runFunctionalTests(screenSvc, automation);
    console.log(JSON.stringify(funcReport, null, 2));
    app.exit(funcReport.ok ? 0 : 1);
    return;
  }

  if (IS_SELFTEST) {
    await runSelfTest();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopCursorFollow();
  agent.stop('Application exiting.');
  mcpManager.dispose();
  automation.dispose();
  settingsStore.saveNow();
  chatsStore.saveNow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
