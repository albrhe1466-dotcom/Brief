'use strict';
/**
 * Locally - local JSON persistence (settings, chats, projects, action log).
 * Everything is stored in Electron's userData folder on this machine only.
 * Writes are atomic (write temp file, then rename) so a crash never corrupts data.
 */
const fs = require('fs');
const path = require('path');

const LEGACY_MODEL_RE = /(?:^|\/)(?:gemini-(?:1|2)(?:\.|_|-|$)|gpt-(?:3|4)(?:\.|o|_|-|$)|o1(?:-|$)|o4-mini|claude-(?:2|instant|3)(?:\.|_|-|$)|claude-sonnet-4-2025|claude-opus-4-2025)/i;

function sanitizeModelIdValue(val) {
  const s = String(val || '').trim();
  if (!s) return '';
  if (LEGACY_MODEL_RE.test(s)) return '';
  if (/gemini-?4-?argon/i.test(s)) return s.replace(/gemini-?4-?argon/i, 'gemini-4-carbon');
  if (/gpt-?6\.2-?sol/i.test(s)) return s.replace(/gpt-?6\.2-?sol/i, 'gpt-6-sol');
  if (/(?:^|\/)gpt-?6-?astra$/i.test(s)) return s.replace(/gpt-?6-?astra$/i, 'gpt-6.2-astra');
  return s;
}

function sanitizeSettingsData(data) {
  if (!data || typeof data !== 'object') return data;
  let dirty = false;
  if (data.customModel) {
    data.customModel = '';
    dirty = true;
  }
  const nextActive = sanitizeModelIdValue(data.activeModel);
  if (nextActive !== (data.activeModel || '')) {
    data.activeModel = nextActive;
    dirty = true;
  }
  const ap = String(data.activePreset || '');
  if (ap === 'argon') {
    data.activePreset = 'carbon';
    dirty = true;
  } else if (ap === 'or_argon') {
    data.activePreset = 'or_carbon';
    dirty = true;
  } else if (/gpt62sol/i.test(ap)) {
    data.activePreset = ap.replace(/gpt62sol/i, 'gpt6sol');
    dirty = true;
  } else if (/^gpt6astra$/i.test(ap)) {
    data.activePreset = 'gpt62astra';
    dirty = true;
  } else if (/^or_gpt6astra$/i.test(ap)) {
    data.activePreset = 'or_gpt62astra';
    dirty = true;
  }
  if (data.roles && typeof data.roles === 'object') {
    for (const rk of ['chat', 'agent', 'fast', 'planner', 'screen']) {
      if (data.roles[rk] && data.roles[rk] !== 'auto') {
        const cleaned = sanitizeModelIdValue(data.roles[rk]);
        if (cleaned !== data.roles[rk]) {
          data.roles[rk] = rk === 'screen' ? 'auto' : cleaned;
          dirty = true;
        }
      }
    }
  }
  if (data.deepWorkMinMinutes === 10) {
    data.deepWorkMinMinutes = 0;
    dirty = true;
  }
  if (data.maxSteps === 140) {
    data.maxSteps = 45;
    dirty = true;
  }
  if (data.typingDelayMs === 6) {
    data.typingDelayMs = 42;
    dirty = true;
  }
  data._sanitizedDirty = dirty;
  return data;
}

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
      this.data = sanitizeSettingsData(deepMerge(clone(this.defaults), parsed));
      if (this.data._sanitizedDirty) {
        delete this.data._sanitizedDirty;
        this.saveSoon();
      } else {
        delete this.data._sanitizedDirty;
      }
    } catch (_) {
      this.data = clone(this.defaults);
    }
    return this.data;
  }

  get() { return this.load(); }

  set(patch) {
    this.load();
    this.data = sanitizeSettingsData(deepMerge(this.data, patch || {}));
    delete this.data._sanitizedDirty;
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
  maxSteps: 45,
  deepWorkMinMinutes: 0,
  deepWorkMaxMinutes: 25,
  multiAgentParallel: true,
  verifyTaskBeforeFinish: true,
  screenshotMaxWidth: 3840,
  displayTarget: 'primary',       // 'primary' | 'cursor' | display id
  typingDelayMs: 42,
  cursorSpeedMs: 200,
  cursorSpeedProfile: 'adaptive', // 'adaptive' | 'slow' | 'medium' | 'fast'
  alignCursorBack: true,          // Re-align mouse smoothly to target on drift and back to user origin after finishing
  commandTimeoutSec: 120,
  pasteLongText: false,
  sidebarCollapsed: false,
  sidebarWidth: 260,
  usageMeters: {},
  logPanelOpen: false,
  sendWithEnter: true,
  soundChime: false,
  selectedMicDeviceId: '',
  selectedMicLabel: '',
  provider: 'gemini',
  userName: '',
  onboardingCompleted: false,
  seenNewsVersion: '',
  lastValidation: null,
  mcpServers: []
};

const DEFAULT_CHATS = { chats: [], projects: [] };

module.exports = { JsonStore, DEFAULT_SETTINGS, DEFAULT_CHATS, deepMerge, sanitizeModelIdValue, sanitizeSettingsData };
