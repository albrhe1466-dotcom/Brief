'use strict';
/**
 * Locally - local JSON persistence (settings, chats, projects, action log).
 * Everything is stored in Electron's userData folder on this machine only.
 * Writes are atomic (write temp file, then rename) so a crash never corrupts data.
 */
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = null;
    this.timer = null;
  }

  load() {
    if (this.data) return this.data;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = deepMerge(clone(this.defaults), parsed);
    } catch (_) {
      this.data = clone(this.defaults);
    }
    return this.data;
  }

  get() { return this.load(); }

  set(patch) {
    this.load();
    this.data = deepMerge(this.data, patch || {});
    this.saveSoon();
    return this.data;
  }

  replace(data) {
    this.data = data;
    this.saveSoon();
    return this.data;
  }

  saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 150);
  }

  saveNow() {
    clearTimeout(this.timer);
    if (!this.data) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] failed to save', this.file, e.message);
    }
  }
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function isPlain(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function deepMerge(target, src) {
  if (!isPlain(src)) return target;
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (isPlain(v) && isPlain(target[k])) target[k] = deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

const DEFAULT_SETTINGS = {
  version: 1,
  permissionMode: 'full',         // Full access by default so Brief can execute desktop/app/hold actions immediately (permanent deletion still requires confirmation).
  activeModel: '',                // model id chosen in the chat bar
  activePreset: '',               // preset key chosen in the chat bar ('' = custom/explicit)
  customModel: '',
  thinkingLevel: 'medium',        // 'low' | 'medium' | 'high' (real Gemini thinkingConfig)
  roles: {
    chat: '',                     // '' = use active model
    agent: '',                    // '' = use active model (reasoning + tool calls)
    screen: 'auto',               // 'auto' = computer-use model when available on the key
    fast: '',                     // '' = auto-pick a Flash/Flash-Lite model
    planner: ''                   // '' = no separate planning call
  },
  usePlanner: true,
  hotkey: 'CommandOrControl+Alt+Q',
  minimizeDuringAgent: true,
  showOverlay: true,
  showWidget: false,
  maxSteps: 140,
  deepWorkMinMinutes: 10,
  deepWorkMaxMinutes: 25,
  multiAgentParallel: true,
  verifyTaskBeforeFinish: true,
  screenshotMaxWidth: 3840,
  displayTarget: 'primary',       // 'primary' | 'cursor' | display id
  typingDelayMs: 6,
  cursorSpeedMs: 200,
  cursorSpeedProfile: 'adaptive', // 'adaptive' | 'slow' | 'medium' | 'fast'
  alignCursorBack: true,          // Re-align mouse smoothly to target on drift and back to user origin after finishing
  commandTimeoutSec: 120,
  pasteLongText: true,
  sidebarCollapsed: false,
  logPanelOpen: false,
  sendWithEnter: true,
  soundChime: true,
  provider: 'gemini',
  userName: '',
  onboardingCompleted: false,
  seenNewsVersion: '',
  lastValidation: null,
  mcpServers: []
};

const DEFAULT_CHATS = { chats: [], projects: [] };

module.exports = { JsonStore, DEFAULT_SETTINGS, DEFAULT_CHATS, deepMerge };
