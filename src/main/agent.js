'use strict';
/**
 * Locally — Real Desktop Agent & Chat Runner.
 *
 * Orchestrates:
 *  - Chat-only streaming turns (never calls computer/file/code tools)
 *  - Autonomous Work loop:
 *      Observe (real screenshot + OS context)
 *      -> Think (selected Gemini model / Fast / Pro / Computer-Use model)
 *      -> Permission check (Ask before every action, or Full access with permanent-delete confirmation)
 *      -> Act (real OS automation / files / terminal)
 *      -> Capture fresh screenshot & verify -> retry on failure with a different approach -> repeat until done or Stop
 */

const { EventEmitter } = require('events');
const { stripModelPrefix, buildThinkingConfig, abortError, sleep } = require('./gemini');
const { TOOLS, CU_ACTIONS, declarations, getTool, pointsOf, isPermanentDeleteCommand, runLiveWebSearch } = require('./tools');
const { buildChatSystemPrompt, buildWorkSystemPrompt } = require('./systemPrompt');

/** Plain-English 1-sentence explanation of what Brief just did for the step photo caption. */
function summarizeStepForUser(name, args, ok, res) {
  if (!ok) {
    const err = (res && res.error) ? String(res.error).slice(0, 120) : 'action failed';
    return 'Tried ' + name + ', hit an issue (' + err + ') — adjusting next.';
  }
  const a = args || {};
  switch (name) {
    case 'browser_tab':
      if (a.action === 'switch') return 'Switched directly to the "' + (res && res.tab ? res.tab : (a.query || 'target')) + '" browser tab and captured the updated view.';
      if (a.action === 'close_others') return 'Closed ' + ((res && res.closedCount) || 0) + ' other browser tab(s) and focused on "' + (a.query || (res && res.activeForeground) || 'target tab') + '".';
      if (a.action === 'close') return 'Closed the "' + (a.query || 'active') + '" browser tab.';
      if (a.action === 'new' || a.action === 'navigate') return 'Opened "' + (a.url || 'new tab') + '" inside the browser.';
      return 'Checked ' + ((res && res.count) || 0) + ' open browser tab(s).';
    case 'close_other_windows':
      return ((a.action || 'minimize') === 'close' ? 'Closed ' : 'Minimized ') + ((res && res.count) || 0) + ' distracting window(s) to focus cleanly on "' + (a.keep_title || 'target') + '".';
    case 'focus_window': return 'Brought "' + ((res && res.title) || a.title || 'target window') + '" to the front.';
    case 'window_control': return (a.action || 'updated') + ' the "' + ((res && res.title) || a.title) + '" window.';
    case 'open_app': return 'Opened "' + (a.name || 'application') + '" and brought it to the front.';
    case 'open_url': return 'Opened ' + (a.url || 'link') + ' in the browser' + (res && res.foreground ? ' (' + res.foreground + ')' : '') + '.';
    case 'click':
    case 'double_click':
    case 'right_click': return a.hold_ms > 80 ? ('Long-pressed ' + (a.button || 'left') + ' mouse button for ' + a.hold_ms + 'ms at (' + a.x + ', ' + a.y + ').') : ('Clicked on screen at (' + a.x + ', ' + a.y + ') and captured the result.');
    case 'mouse_button': return a.action === 'down' ? ('Held ' + (a.button || 'left') + ' mouse button down.') : a.action === 'up' ? ('Released ' + (a.button || 'left') + ' mouse button.') : ('Long-pressed ' + (a.button || 'left') + ' mouse button for ' + (a.duration_ms || 800) + 'ms.');
    case 'scroll': return 'Scrolled ' + (a.direction || 'down') + ' (' + (a.amount || 6) + ' notches) and captured what came into view.';
    case 'hold_key': return a.action === 'down' ? ('Held key "' + a.key + '" down.') : a.action === 'up' ? ('Released key "' + a.key + '".') : ('Long-pressed key "' + a.key + '" for ' + (a.duration_ms || 1000) + 'ms.');
    case 'click_element': return 'Focused & clicked "' + ((res && res.element) || a.query || 'control') + '" cleanly.';
    case 'click_text': return 'Found "' + ((res && res.matched) || a.query || 'label') + '" via Screen Text OCR and clicked it cleanly.';
    case 'read_screen_text': return 'Scanned all visible text & coordinates on screen (' + ((res && res.count) || 0) + ' items).';
    case 'zoom_region': return 'Zoomed in for a closer sharp look at (' + a.x1 + ',' + a.y1 + ')-(' + a.x2 + ',' + a.y2 + ').';
    case 'draw_art': return 'Drew artistic strokes smoothly onto the canvas (' + ((res && res.strokes) || 'artwork') + ' strokes) and took a photo to check the look.';
    case 'drag': return 'Dragged smoothly from (' + a.start_x + ', ' + a.start_y + ') to (' + a.end_x + ', ' + a.end_y + ').';
    case 'type_text': return 'Typed "' + String(a.text || '').slice(0, 40) + '" visibly.';
    case 'press_keys': return a.hold_ms > 100 ? ('Long-pressed "' + (a.keys || '') + '" for ' + a.hold_ms + 'ms.') : ('Pressed shortcut ' + (a.keys || '') + '.');
    case 'write_file': return 'Wrote ' + (a.path || 'file') + ' and opened it.';
    case 'edit_file': return 'Updated ' + (a.path || 'file') + ' cleanly.';
    case 'web_search': return 'Searched the live web for "' + (a.query || '') + '" (' + ((res && res.count) || 0) + ' results).';
    default: return (res && res.note) ? String(res.note).slice(0, 140) : 'Completed "' + name + '" and took a fresh screen photo.';
  }
}

/** Small JPEG thumbnail (data URL) of a captured screenshot, shown as "photos" in the step cards. */
function thumbOf(shot) {
  try {
    if (!shot || !shot.base64) return null;
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBuffer(Buffer.from(shot.base64, 'base64'));
    if (img.isEmpty()) return 'data:' + (shot.mime || 'image/jpeg') + ';base64,' + shot.base64;
    const sz = img.getSize();
    const w = Math.min(720, sz.width);
    const small = sz.width > w ? img.resize({ width: w, quality: 'good' }) : img;
    return 'data:image/jpeg;base64,' + small.toJPEG(68).toString('base64');
  } catch (_) {
    return null;
  }
}

/** Overlay a clean 0..1000 cyan ruler grid on a copy of the screenshot for AI vision accuracy (never alters user photo thumbnails). */
async function shotForVision(shot, automation) {
  if (!shot || !shot.base64) return shot;
  if (!automation || typeof automation.drawVisionGrid !== 'function') return shot;
  try {
    const gB64 = await automation.drawVisionGrid(shot.base64);
    if (gB64 && gB64.length > 200) return { mime: 'image/jpeg', base64: gB64 };
  } catch (_) { /* ignore */ }
  return shot;
}

/** Scout / Eyes Agent helper: fetches BOTH UIA controls AND Windows WinRT OCR text coordinates on active display. */
async function describeForegroundElements(screen, automation) {
  if (!automation) return '';
  try {
    const disp = (screen && typeof screen.currentDisplay === 'function') ? screen.currentDisplay() : null;
    const b = (disp && disp.bounds) || { x: 0, y: 0, width: 1920, height: 1080 };
    const sf = (disp && disp.scaleFactor) || 1;
    const { screen: elecScreen } = (process.versions && process.versions.electron) ? require('electron') : {};
    const physOrigin = (elecScreen && typeof elecScreen.dipToScreenPoint === 'function')
      ? elecScreen.dipToScreenPoint({ x: b.x, y: b.y })
      : { x: Math.round(b.x * sf), y: Math.round(b.y * sf) };
    const physW = Math.round(b.width * sf);
    const physH = Math.round(b.height * sf);

    const [els, focused, ocr] = await Promise.all([
      typeof automation.inspectUi === 'function' ? automation.inspectUi(100).catch(() => []) : Promise.resolve([]),
      typeof automation.focusedElement === 'function' ? automation.focusedElement().catch(() => null) : Promise.resolve(null),
      typeof automation.ocrScreen === 'function' ? automation.ocrScreen(physOrigin.x, physOrigin.y, physW, physH).catch(() => null) : Promise.resolve(null)
    ]);

    const normCoord = (px, py) => {
      const dip = (screen && typeof screen.nativeToDip === 'function') ? screen.nativeToDip(px, py) : { x: px, y: py };
      return {
        nx: Math.max(0, Math.min(999, Math.round(((dip.x - b.x) / Math.max(1, b.width)) * 1000))),
        ny: Math.max(0, Math.min(999, Math.round(((dip.y - b.y) / Math.max(1, b.height)) * 1000)))
      };
    };

    const lines = [];
    if (focused && (focused.type || focused.name)) {
      lines.push(`Focused control: ${focused.type || 'Control'} "${focused.name || ''}" (${focused.canType ? 'READY FOR TYPING' : 'not a text box — click Search/input first!'})`);
    }
    if (Array.isArray(els) && els.length) {
      const inputs = els.filter((e) => e.isInput || /^(Edit|ComboBox|Document)$/i.test(e.type || ''));
      const others = els.filter((e) => !inputs.includes(e));
      for (const el of [...inputs.slice(0, 14), ...others.slice(0, 26)]) {
        const { nx, ny } = normCoord(el.x, el.y);
        const tag = (el.isInput || /^(Edit|ComboBox|Document)$/i.test(el.type || '')) ? '[INPUT] ' : '';
        const lbl = el.name || el.autoId || el.type;
        lines.push(`- UIA ${tag}${el.type || 'Control'} "${lbl}" at (${nx}, ${ny})`);
      }
    }
    if (ocr && Array.isArray(ocr.lines) && ocr.lines.length) {
      const seen = new Set();
      let ocrAdded = 0;
      for (const ln of ocr.lines) {
        if (!ln || !ln.text) continue;
        const txt = String(ln.text).replace(/\s+/g, ' ').trim();
        if (!txt || txt.length < 2) continue;
        const { nx, ny } = normCoord(ln.x, ln.y);
        const sigKey = txt.toLowerCase() + '@' + Math.round(nx / 20) + ',' + Math.round(ny / 20);
        if (seen.has(sigKey)) continue;
        seen.add(sigKey);
        lines.push(`- OCR "${txt.slice(0, 48)}" at (${nx}, ${ny})`);
        if (++ocrAdded >= 48) break;
      }
    }
    return lines.length ? ('\n[Scout Eyes — Visible UI Controls & Windows OCR Text (exact 0..1000 coordinates — prefer click_text/click_element or exact x,y):\n' + lines.join('\n') + '\n]') : '';
  } catch (_) {
    return '';
  }
}

/** Tools that only observe or inspect without changing any app/file/timeline state. */
const PASSIVE_OBSERVE_TOOLS = new Set([
  'take_screenshot', 'read_screen_text', 'zoom_region', 'wait', 'list_windows',
  'list_directory', 'search_files', 'project_tree', 'grep_files', 'read_file',
  'path_info', 'get_system_info', 'web_search', 'fetch_url'
]);

/** Navigation/window focus tools (necessary first steps, but NOT finished creation work). */
const APP_NAV_TOOLS = new Set([
  'open_app', 'focus_window', 'window_control', 'close_other_windows',
  'browser_tab', 'open_url', 'switch_display'
]);

function formatWorkedTime(ms) {
  const totalSec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (totalSec < 60) return totalSec + 's';
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins + 'm ' + String(secs).padStart(2, '0') + 's';
}

function isMutatingWorkStep(item) {
  if (!item || !item.ok) return false;
  const t = String(item.tool || '');
  return !PASSIVE_OBSERVE_TOOLS.has(t) && !APP_NAV_TOOLS.has(t);
}

function isTestEvidenceStep(item) {
  if (!item || !item.ok) return false;
  const t = String(item.tool || '');
  const a = item.args || {};
  if (t === 'run_command') return true;
  if (/execute_luau|start_stop_play|test|verify|render|preview|play/i.test(t)) return true;
  if (t === 'press_keys') {
    const ks = String(a.keys || '');
    if (/\b(?:f5|f8|space)\b/i.test(ks)) return true;
  }
  if (t === 'click_text' || t === 'click_element') {
    const q = String(a.query || '');
    if (/\b(play|run|test|preview|render|export|output|console|timeline)\b/i.test(q)) return true;
  }
  return false;
}

function detectDeepTaskProfile(task, openWindows, settings, overrides) {
  const text = String(task || '');
  const winNames = Array.isArray(openWindows) ? openWindows.map((w) => String(w.title || '')).join(' ') : '';
  const combined = text + ' ' + winNames;
  const isRoblox = /\b(roblox|studio|obby|elevator|luau|workspace|startergui|proximityprompt|clickdetector)\b/i.test(combined);
  const isAnimationOrCreative = /\b(capcut|blender|higgsfield|after\s*effects|premiere|photoshop|illustrator|adobe|animat(?:e|ion|ing)|keyframe|rig|timeline|3d|shader|unreal|unity|davinci)\b/i.test(combined);
  const isQuickCheckOnly = /^\s*(?:what is on my screen|read (?:this|screen)|open [a-z0-9 ]{1,24}|search (?:google|youtube|web) for .{1,50}|take a screenshot|list windows)\s*[.!?]?\s*$/i.test(text);
  const requiresAppTest = !isQuickCheckOnly && (isRoblox || isAnimationOrCreative || /\b(create|build|make|fix|debug|code|script|app|website|game|elevator|obby|ui|button|animat)\b/i.test(text));
  const isDeepBuildTask = !isQuickCheckOnly && (isRoblox || isAnimationOrCreative || /\b(full|complete|entire|thorough|complex|multi-step|3d|game|elevator|obby|studio)\b/i.test(text));

  const minMins = (overrides && typeof overrides.minWorkMs === 'number')
    ? null
    : Math.max(0, Number((settings && settings.deepWorkMinMinutes !== undefined) ? settings.deepWorkMinMinutes : 10));
  const maxMins = (overrides && typeof overrides.maxWorkMs === 'number')
    ? null
    : Math.max(5, Number((settings && settings.deepWorkMaxMinutes !== undefined) ? settings.deepWorkMaxMinutes : 25));

  const minWorkMs = (overrides && typeof overrides.minWorkMs === 'number')
    ? overrides.minWorkMs
    : (isDeepBuildTask ? minMins * 60 * 1000 : 0);
  const maxWorkMs = (overrides && typeof overrides.maxWorkMs === 'number')
    ? overrides.maxWorkMs
    : (maxMins * 60 * 1000);

  return {
    isRoblox,
    isAnimationOrCreative,
    requiresAppTest,
    isDeepBuildTask,
    minWorkMs,
    maxWorkMs
  };
}

/** Fast visual change percentage (0..100) comparing two screenshots via small raw RGBA sample. */
function computeVisualDiffPct(shotA, shotB) {
  try {
    if (!shotA || !shotB || !shotA.base64 || !shotB.base64) return null;
    if (shotA.base64 === shotB.base64) return 0;
    const { nativeImage } = require('electron');
    if (!nativeImage) return null;
    const imgA = nativeImage.createFromBuffer(Buffer.from(shotA.base64, 'base64')).resize({ width: 48, height: 27 });
    const imgB = nativeImage.createFromBuffer(Buffer.from(shotB.base64, 'base64')).resize({ width: 48, height: 27 });
    const bufA = imgA.toBitmap();
    const bufB = imgB.toBitmap();
    if (!bufA.length || bufA.length !== bufB.length) return null;
    let changed = 0;
    const pixels = Math.floor(bufA.length / 4);
    for (let i = 0; i < bufA.length; i += 4) {
      const dr = Math.abs(bufA[i] - bufB[i]);
      const dg = Math.abs(bufA[i + 1] - bufB[i + 1]);
      const db = Math.abs(bufA[i + 2] - bufB[i + 2]);
      if (dr + dg + db > 28) changed += 1;
    }
    return pixels ? Number(((changed / pixels) * 100).toFixed(1)) : null;
  } catch (_) {
    return null;
  }
}

/** Tools that would pull ready-made assets from a store instead of building things by hand. */
const BLOCKED_STORE_TOOL_RE = /(insert_asset|search_asset|insert_model|toolbox|marketplace|manage_assets|manage_open_cloud_assets|generate_scene|generate_procedural_model|generate_mesh|generate_avatar)/i;

function summarizeToolResult(result) {
  try {
    const json = JSON.stringify(result);
    if (json.length <= 16000) return result;
    return { truncated: true, preview: json.slice(0, 16000) + '... [truncated]' };
  } catch (_) {
    return { result: String(result) };
  }
}

/**
 * Strips inlineData screenshots from older turns in Gemini contents history so token usage
 * stays reasonable over long 20–40 step tasks, retaining the most recent `keepCount` images.
 */
function pruneHistoryScreenshots(contents, keepCount = 3) {
  const imageSlots = [];
  for (let i = 0; i < contents.length; i++) {
    const parts = contents[i].parts || [];
    for (let j = 0; j < parts.length; j++) {
      const p = parts[j];
      if (p.inlineData) imageSlots.push({ type: 'part', i, j });
      if (p.functionResponse && Array.isArray(p.functionResponse.parts)) {
        for (let k = 0; k < p.functionResponse.parts.length; k++) {
          if (p.functionResponse.parts[k].inlineData) imageSlots.push({ type: 'fr', i, j, k });
        }
      }
    }
  }
  const removeCount = Math.max(0, imageSlots.length - keepCount);
  if (removeCount === 0) return contents;
  const toRemove = imageSlots.slice(0, removeCount);
  const clone = JSON.parse(JSON.stringify(contents));
  for (const slot of toRemove) {
    if (slot.type === 'part') {
      clone[slot.i].parts[slot.j] = { text: '[Earlier screenshot omitted to save context]' };
    } else if (slot.type === 'fr') {
      clone[slot.i].parts[slot.j].functionResponse.parts.splice(slot.k, 1);
      if (clone[slot.i].parts[slot.j].functionResponse.parts.length === 0) {
        delete clone[slot.i].parts[slot.j].functionResponse.parts;
      }
    }
  }
  return clone;
}

class AgentRunner extends EventEmitter {
  constructor({ gemini, screen, automation, mcpManager, getSettings, getMatch, getModels, cursorEmitter, onStatus }) {
    super();
    this.gemini = gemini;
    this.screen = screen;
    this.automation = automation;
    this.mcpManager = mcpManager || null;
    this.getSettings = getSettings;
    this.getMatch = getMatch;
    this.getModels = getModels || (() => []);
    this.cursorEmitter = cursorEmitter || (() => {});
    this.onStatus = onStatus || (() => {});
    this.running = false;
    this.stopped = false;
    this.abortController = null;
    this.activeProcesses = new Set();
    this.conversationAutoApproveChats = new Set();
    this.pendingApproval = null;
    this.runId = 0;
  }

  isRunning() { return this.running; }
  isStopped() { return this.stopped; }

  emitLog(entry) {
    const payload = Object.assign({
      id: 'log-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      ts: new Date().toISOString(),
      time: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }, entry);
    this.emit('log', payload);
    return payload;
  }

  setStatus(patch) {
    this.onStatus(patch);
    this.emit('status', patch);
  }

  /**
   * Immediately halts any running chat stream, agent loop, OS keys, child commands, or approval prompt.
   */
  stop(reason = 'Stopped by user.') {
    if (!this.running && !this.pendingApproval) return false;
    this.stopped = true;
    if (this.abortController) {
      try { this.abortController.abort(); } catch (_) { /* ignore */ }
    }
    if (this.pendingApproval) {
      const p = this.pendingApproval;
      this.pendingApproval = null;
      p.resolve({ allowed: false, note: reason, aborted: true });
    }
    for (const child of Array.from(this.activeProcesses)) {
      const { killTree } = require('./tools');
      killTree(child);
      this.activeProcesses.delete(child);
    }
    this.automation.release().catch(() => {});
    if (typeof this.automation.setBlackCursor === 'function') this.automation.setBlackCursor(false).catch(() => {});
    this.cursorEmitter({ kind: 'hide' });
    this.emitLog({ kind: 'stop', status: 'stopped', tool: 'emergency_stop', detail: reason });
    this.setStatus({ state: 'stopped', stepText: reason, running: false });
    return true;
  }

  resolveApproval(decision) {
    if (!this.pendingApproval) return false;
    const p = this.pendingApproval;
    this.pendingApproval = null;
    p.resolve(decision);
    return true;
  }

  /** Resolves which real Gemini model ID to use for a job ('chat' | 'agent' | 'fast' | 'screen' | 'planner'). */
  resolveModelForJob(job) {
    const s = this.getSettings();
    const m = this.getMatch() || { presets: {} };
    const active = stripModelPrefix(s.activeModel || s.customModel || '');
    const roleVal = stripModelPrefix((s.roles && s.roles[job]) || '');
    if (job === 'screen') {
      if (roleVal === 'auto' || !roleVal) {
        if (m.computerUse) return { id: m.computerUse, isComputerUse: true };
        return { id: active || m.bestFlash || m.bestPro || '', isComputerUse: false };
      }
      return { id: roleVal, isComputerUse: /computer-use/i.test(roleVal) };
    }
    if (roleVal && roleVal !== 'auto') {
      return { id: roleVal, isComputerUse: /computer-use/i.test(roleVal) };
    }
    if (job === 'fast') {
      return { id: m.fast || active || m.bestFlash || '', isComputerUse: false };
    }
    if (job === 'planner') {
      const pId = active || m.bestPro || m.bestFlash || m.fast || '';
      return { id: /computer-use/i.test(pId) ? (m.bestPro || m.bestFlash || m.fast || '') : pId, isComputerUse: false };
    }
    return { id: active || m.bestPro || m.bestFlash || m.fast || '', isComputerUse: /computer-use/i.test(active) };
  }

  /**
   * Builds a multi-agent model roster from the healthy models available on the user's API key
   * so Executor, Scout, Code/Animation Specialist, and QA Tester do not leave models sitting idle.
   */
  resolveTeamRoster() {
    const s = this.getSettings() || {};
    const m = this.getMatch() || { presets: {} };
    const executor = this.resolveModelForJob('agent').id;
    const candidates = this.getFallbackModels(new Set());
    const fastRole = stripModelPrefix((s.roles && s.roles.fast) || '');
    const planRole = stripModelPrefix((s.roles && s.roles.planner) || '');

    const pickDistinct = (preferredIds, fallbackId) => {
      for (const raw of preferredIds) {
        const clean = stripModelPrefix(raw || '');
        if (!clean || /computer-use/i.test(clean)) continue;
        if (candidates.includes(clean) && clean !== executor) return clean;
      }
      for (const id of candidates) {
        if (id !== executor) return id;
      }
      return fallbackId || executor;
    };

    const scout = (fastRole && fastRole !== 'auto')
      ? fastRole
      : pickDistinct([
          m.presets && m.presets.flashlite35 && m.presets.flashlite35.id,
          m.presets && m.presets.gpt6luna && m.presets.gpt6luna.id,
          m.presets && m.presets.claudehaiku55 && m.presets.claudehaiku55.id,
          m.fast,
          m.bestFlash
        ], executor);

    const specialist = (planRole && planRole !== 'auto')
      ? planRole
      : pickDistinct([
          m.presets && m.presets.hydrogen && m.presets.hydrogen.id,
          m.presets && m.presets.flash38 && m.presets.flash38.id,
          m.presets && m.presets.gpt61terra && m.presets.gpt61terra.id,
          m.presets && m.presets.claudesonnet55 && m.presets.claudesonnet55.id,
          m.bestFlash
        ].filter((id) => id !== scout), scout);

    const qaTester = pickDistinct([
      m.presets && m.presets.argon && m.presets.argon.id,
      m.presets && m.presets.gpt61sol && m.presets.gpt61sol.id,
      m.presets && m.presets.claudeopus55 && m.presets.claudeopus55.id,
      m.bestPro,
      planRole
    ], specialist || executor);

    const distinctCount = new Set([executor, scout, specialist, qaTester].filter(Boolean)).size;
    return { executor, scout, specialist, qaTester, distinctCount };
  }

  /** Ordered list of healthy general Gemini fallback model IDs from the user's account, excluding failedModels. */
  getFallbackModels(failedModels) {
    const m = this.getMatch() || {};
    const all = Array.isArray(this.getModels()) ? this.getModels() : [];
    const bad = failedModels || new Set();
    const out = [];
    const seen = new Set();
    const push = (id) => {
      const clean = stripModelPrefix(id || '');
      if (!clean || bad.has(clean) || seen.has(clean)) return;
      if (/(image|tts|audio|live|embedding|aqa|imagen|veo|native-audio|robotics|computer-use|customtools)/i.test(clean)) return;
      seen.add(clean);
      out.push(clean);
    };
    if (m.presets) {
      push(m.presets.flash38 && m.presets.flash38.id);
      push(m.presets.hydrogen && m.presets.hydrogen.id);
      push(m.presets.flashlite35 && m.presets.flashlite35.id);
      push(m.presets.argon && m.presets.argon.id);
    }
    const availableIds = new Set(all.filter((x) => Array.isArray(x.methods) && x.methods.includes('generateContent')).map((x) => x.id));
    for (const stableFreeId of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite']) {
      if (availableIds.has(stableFreeId)) push(stableFreeId);
    }
    push(m.bestFlash);
    push(m.fast);
    const general = all
      .filter((x) => Array.isArray(x.methods) && x.methods.includes('generateContent'))
      .map((x) => x.id)
      .filter((id) => !/(image|tts|audio|live|embedding|aqa|imagen|veo|native-audio|robotics|computer-use|customtools)/i.test(id));
    general.sort((a, b) => {
      const aHeavy = /\bpro\b|argon|\bopus\b/i.test(a) ? 1 : 0;
      const bHeavy = /\bpro\b|argon|\bopus\b/i.test(b) ? 1 : 0;
      if (aHeavy !== bHeavy) return aHeavy - bHeavy;
      const va = parseFloat((/(?:gemini-|gpt-|claude-[^-]*-)(\d+(?:\.\d+)?)/.exec(a) || [])[1] || '0');
      const vb = parseFloat((/(?:gemini-|gpt-|claude-[^-]*-)(\d+(?:\.\d+)?)/.exec(b) || [])[1] || '0');
      if (vb !== va) return vb - va;
      return b.localeCompare(a);
    });
    for (const id of general) {
      if (!/\bpro\b|argon|\bopus\b/i.test(id)) push(id);
    }
    if (m.presets) {
      push(m.presets.argon && m.presets.argon.id);
      push(m.presets.pro31 && m.presets.pro31.id);
    }
    push(m.bestPro);
    for (const id of general) push(id);
    return out;
  }

  /**
   * Asks the user for permission before executing an action when:
   * - permissionMode === 'ask', OR
   * - the action is permanent deletion / dangerous (ALWAYS requires confirmation even in Full access), OR
   * - Gemini Computer Use emitted safety_decision === 'require_confirmation'.
   */
  async requestPermission({ chatId, step, toolName, args, description, dangerReason, cuSafety, screenshotPreview, isControlStep }) {
    const s = this.getSettings();
    const forceConfirm = !!dangerReason || (cuSafety && cuSafety.decision === 'require_confirmation');
    const mode = s.permissionMode || 'full';
    if (!forceConfirm && mode === 'full') {
      return { allowed: true, autoApproved: true };
    }
    if (!forceConfirm && chatId && this.conversationAutoApproveChats.has(chatId)) {
      return { allowed: true, autoApproved: true, scope: 'conversation' };
    }
    const id = 'perm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const points = pointsOf(toolName, args || {});
    this.setStatus({ state: 'approval', stepText: 'Waiting for your confirmation: ' + description });
    this.emitLog({ kind: 'approval', status: 'pending', tool: toolName, detail: description, danger: !!forceConfirm });
    const req = {
      id,
      chatId: chatId || null,
      step,
      toolName,
      args,
      description,
      dangerReason: dangerReason || (cuSafety ? cuSafety.explanation : null),
      permanent: !!dangerReason,
      isControlStep: !!isControlStep,
      watchLiveCurrent: s.showOverlay !== false,
      points,
      screenshot: screenshotPreview || null
    };
    this.emit('approval-required', req);
    const decision = await new Promise((resolve) => {
      this.pendingApproval = { id, resolve };
    });
    if (decision && decision.allowed && !forceConfirm && decision.scope === 'conversation' && chatId) {
      this.conversationAutoApproveChats.add(chatId);
    }
    if (decision && decision.allowed && decision.watchLive !== undefined) {
      this.emit('set-watch-live', !!decision.watchLive);
    }
    this.emit('approval-resolved', { id, decision });
    return decision;
  }

  /** Runs a Chat-Only streaming request (with live web search & optional Third Eye Screen Share). */
  async runChat({ chatId, messages, attachments, webSearch, screenShare }) {
    if (this.running) throw new Error('An operation is already running. Press Stop first.');
    this.running = true;
    this.stopped = false;
    this.abortController = new AbortController();
    const runId = ++this.runId;
    const modelInfo = this.resolveModelForJob('chat');
    if (!modelInfo.id) {
      this.running = false;
      throw new Error('No AI model is selected or available on this API key. Check Settings → API Key & Models.');
    }
    this.setStatus({ running: true, state: 'thinking', mode: 'chat', model: modelInfo.id, stepText: 'Chatting...' });
    this.emitLog({ kind: 'chat', status: 'started', model: modelInfo.id, tool: 'chat_stream', detail: 'Streaming reply using ' + modelInfo.id });

    try {
      const s = this.getSettings();
      const useSearch = webSearch !== undefined ? !!webSearch : (settings.webSearchEnabled !== false);
      const lastMsg = messages[messages.length - 1] || {};
      let shareShot = null;
      if (screenShare && screenShare.enabled && this.screen && typeof this.screen.capture === 'function') {
        try {
          shareShot = await this.screen.capture({
            sourceId: screenShare.id,
            sourceName: screenShare.name,
            kind: screenShare.kind,
            format: 'jpeg',
            maxWidth: 1600
          });
        } catch (_) { shareShot = null; }
      }
      let searchContextText = '';
      if (useSearch && lastMsg.text && String(lastMsg.text).trim().length > 2) {
        this.setStatus({ running: true, state: 'thinking', mode: 'chat', model: modelInfo.id, stepText: 'Searching the web...' });
        const hits = await Promise.race([
          runLiveWebSearch(String(lastMsg.text).trim().slice(0, 160), 5),
          sleep(2600).then(() => [])
        ]).catch(() => []);
        if (Array.isArray(hits) && hits.length) {
          searchContextText = '\n\n[Live Web Search Results — use these facts accurately and stay strictly on the user\'s exact topic]:\n' +
            hits.map((h, idx) => `${idx + 1}. ${h.title} (${h.url})\n   ${h.snippet}`).join('\n');
        }
      }

      const contents = [];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const parts = [];
        if (msg.text) {
          const txt = (i === messages.length - 1 && searchContextText) ? (msg.text + searchContextText) : msg.text;
          parts.push({ text: txt });
        }
        if (i === messages.length - 1 && shareShot && shareShot.base64) {
          parts.push({ text: `[Third Eye Live Screen Share (${screenShare.name || 'Screen'}) attached below.]` });
          parts.push({ inlineData: { mimeType: shareShot.mime || 'image/jpeg', data: shareShot.base64 } });
        }
        if (i === messages.length - 1 && Array.isArray(attachments)) {
          for (const att of attachments) {
            if (att.kind === 'image' && att.base64) {
              parts.push({ inlineData: { mimeType: att.mime || 'image/png', data: att.base64 } });
            } else if (att.textContent !== undefined) {
              parts.push({ text: `\n[Attached file: ${att.name}]\n\`\`\`\n${att.textContent.slice(0, 40000)}\n\`\`\`` });
            }
          }
        }
        if (parts.length) contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
      }

      let fullText = '';
      let thoughtText = '';
      const failedModels = new Set();
      let activeChatModel = modelInfo.id;
      let res = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        const tCfg = buildThinkingConfig(activeChatModel, s.thinkingLevel === 'high' ? 'medium' : s.thinkingLevel, this.getModels());
        const chatPayload = {
          systemInstruction: { parts: [{ text: buildChatSystemPrompt({ screenShare }) }] },
          contents
        };
        if (tCfg) chatPayload.generationConfig = { thinkingConfig: tCfg };
        try {
          res = await this.gemini.stream(activeChatModel, chatPayload, {
            retries: 1,
            signal: this.abortController.signal,
            onThought: (delta) => {
              thoughtText += delta;
              this.emit('chat-delta', { runId, chatId, thoughtDelta: delta });
            },
            onText: (delta, full) => {
              fullText = full;
              this.emit('chat-delta', { runId, chatId, delta, full });
            }
          });
          break;
        } catch (chatErr) {
          if (this.stopped || chatErr.kind === 'aborted' || chatErr.name === 'AbortError') throw chatErr;
          if (chatErr.kind === 'invalid' || chatErr.kind === 'nokey' || chatErr.kind === 'disabled' || fullText) throw chatErr;
          failedModels.add(activeChatModel);
          const next = this.getFallbackModels(failedModels)[0];
          const switchable = ['server', 'rate', 'quota', 'noaccess', 'timeout'].includes(chatErr.kind) || /high demand|overloaded|unavailable|capacity|try again|timed out|quota|limit:\s*0/i.test(chatErr.message);
          if (!switchable || !next) throw chatErr;
          this.emitLog({ kind: 'retry', status: 'warn', model: activeChatModel, tool: 'model_fallback', detail: `${activeChatModel} unavailable (${chatErr.message}); switching to ${next}` });
          this.setStatus({ running: true, state: 'thinking', mode: 'chat', model: next, stepText: `${activeChatModel} busy — switching to ${next}...` });
          activeChatModel = next;
        }
      }
      this.emitLog({
        kind: 'chat',
        status: 'ok',
        model: activeChatModel,
        tool: 'chat_stream',
        detail: 'Completed (' + ((res.usage && res.usage.totalTokenCount) || 0) + ' tokens)'
      });
      this.setStatus({ running: false, state: 'idle', stepText: 'Ready' });
      return { text: fullText || res.text, thought: thoughtText, model: activeChatModel, usage: res.usage };
    } catch (e) {
      if (this.stopped || e.kind === 'aborted' || e.name === 'AbortError') {
        this.emitLog({ kind: 'chat', status: 'stopped', model: modelInfo.id, tool: 'chat_stream', detail: 'Cancelled by user.' });
        this.setStatus({ running: false, state: 'stopped', stepText: 'Stopped' });
        throw abortError();
      }
      this.emitLog({ kind: 'chat', status: 'error', model: modelInfo.id, tool: 'chat_stream', detail: e.message });
      this.setStatus({ running: false, state: 'error', stepText: e.message });
      throw e;
    } finally {
      this.running = false;
      this.abortController = null;
    }
  }

  /**
   * Runs a focused screen-control sub-loop using Google's Computer Use model (when available on the key).
   */
  async executeComputerUseSubtask({ goal, cuModelId, chatId, startStep, maxSubSteps = 8, onStepEmit }) {
    const cuHistory = [];
    let shot = await this.screen.capture({ format: 'jpeg' });
    cuHistory.push({
      role: 'user',
      parts: [
        { text: 'Perform this GUI task on the visible screen: ' + goal + '\nUse predefined actions carefully and stop as soon as the goal is visible on screen.' },
        { inlineData: { mimeType: shot.mime, data: shot.base64 } }
      ]
    });

    const actionsTaken = [];
    for (let sub = 0; sub < maxSubSteps; sub++) {
      if (this.stopped) throw abortError();
      const stepNum = startStep + sub;
      this.setStatus({ running: true, state: 'thinking', model: cuModelId, step: stepNum, stepText: 'Computer-Use screen control: ' + goal });
      const body = {
        contents: pruneHistoryScreenshots(cuHistory, 3),
        tools: [{ computerUse: { environment: 'ENVIRONMENT_BROWSER' } }]
      };
      const json = await this.gemini.generate(cuModelId, body, {
        signal: this.abortController.signal,
        onRetry: (r) => this.emitLog({ kind: 'retry', status: 'warn', model: cuModelId, tool: 'computer_use', detail: 'Retrying (' + r.error + ') in ' + Math.round(r.wait / 1000) + 's' })
      });
      const cand = (json.candidates || [])[0];
      if (!cand || !cand.content || !Array.isArray(cand.content.parts)) {
        return { ok: false, error: 'Computer Use model returned no content.', actionsTaken, lastShot: shot };
      }
      cuHistory.push(cand.content);
      const calls = cand.content.parts.filter((p) => p.functionCall);
      const texts = cand.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('\n');
      if (!calls.length) {
        return { ok: true, summary: texts || 'Completed screen step.', actionsTaken, lastShot: shot };
      }

      const responseParts = [];
      for (const part of calls) {
        if (this.stopped) throw abortError();
        const fc = part.functionCall;
        const name = fc.name;
        const args = fc.args || {};
        const handler = CU_ACTIONS[name];
        const safety = args.safety_decision || null;
        if (safety && safety.decision === 'blocked') {
          this.emitLog({ kind: 'safety', status: 'error', model: cuModelId, tool: name, detail: 'Blocked by Gemini Computer Use safety policy: ' + (safety.explanation || '') });
          return { ok: false, blocked: true, error: 'Blocked by safety policy: ' + (safety.explanation || ''), actionsTaken, lastShot: shot };
        }
        const desc = handler ? handler.describe(args) : (name + '(' + JSON.stringify(args) + ')');
        const dangerReason = handler && handler.dangerous ? handler.dangerous(args) : null;
        const preview = await this.screen.preview(540).catch(() => null);
        const perm = await this.requestPermission({
          step: stepNum,
          toolName: name,
          args,
          description: desc,
          dangerReason,
          cuSafety: safety,
          screenshotPreview: preview ? preview.dataUrl : null
        });
        if (this.stopped || perm.aborted) throw abortError();

        let fnResult = {};
        let stepOk = false;
        const t0 = Date.now();
        if (!perm.allowed) {
          fnResult = { error: 'User denied this action.' + (perm.note ? ' Reason: ' + perm.note : ''), url: 'desktop://screen' };
          this.emitLog({ kind: 'action', status: 'denied', model: cuModelId, tool: name, detail: desc + (perm.note ? ' — ' + perm.note : '') });
        } else if (!handler) {
          fnResult = { error: 'Unsupported Computer Use action: ' + name, url: 'desktop://screen' };
        } else {
          try {
            this.setStatus({ running: true, state: 'acting', model: cuModelId, step: stepNum, stepText: desc });
            const out = await handler.run(args, this.makeToolContext());
            stepOk = true;
            fnResult = Object.assign({ ok: true, url: 'desktop://screen' }, out || {});
            if (safety && safety.decision === 'require_confirmation') {
              fnResult.safety_acknowledgement = 'true';
            }
            this.emitLog({ kind: 'action', status: 'ok', model: cuModelId, tool: name, detail: desc, ms: Date.now() - t0 });
          } catch (err) {
            fnResult = { error: err.message, url: 'desktop://screen' };
            this.emitLog({ kind: 'action', status: 'error', model: cuModelId, tool: name, detail: desc + ' → ' + err.message, ms: Date.now() - t0 });
          }
        }
        actionsTaken.push({ tool: name, description: desc, ok: stepOk, result: fnResult });
        await sleep(250);
        shot = await this.screen.capture({ format: 'jpeg' });
        if (onStepEmit) {
          onStepEmit({
            step: stepNum,
            model: cuModelId,
            tool: name,
            description: desc,
            args,
            ok: stepOk,
            denied: !perm.allowed,
            result: fnResult,
            ms: Date.now() - t0
          });
        }
        responseParts.push({
          functionResponse: {
            name,
            response: fnResult,
            parts: [{ inlineData: { mimeType: shot.mime, data: shot.base64 } }]
          }
        });
      }
      cuHistory.push({ role: 'user', parts: responseParts });
    }
    return { ok: true, summary: 'Reached max screen sub-steps.', actionsTaken, lastShot: shot };
  }

  makeToolContext() {
    return {
      screen: this.screen,
      automation: this.automation,
      settings: () => this.getSettings(),
      isStopped: () => this.stopped,
      cursor: (evt) => this.cursorEmitter(evt),
      registerProcess: (p) => this.activeProcesses.add(p),
      unregisterProcess: (p) => this.activeProcesses.delete(p),
      progress: (txt) => this.emit('command-output', txt)
    };
  }

  /**
   * Independent QA Verifier Agent: compares BEFORE vs AFTER screenshots, OCR state, mutating work actions,
   * and live test evidence before allowing Brief to declare completion. Fail-closed on incomplete/untested work.
   */
  async runTaskVerifierAgent({
    task,
    taskProfile,
    planText,
    stepLog,
    mutatingCount,
    testCount,
    elapsedMs,
    minWorkMs,
    qaPasses,
    initShot,
    currentShot,
    candidateAnswer,
    modelId,
    deepPolishAudit
  }) {
    if (!this.gemini || typeof this.gemini.generate !== 'function') return { verified: true };
    if (mutatingCount === 0) {
      return {
        verified: false,
        reason: 'Only screenshots or passive reads ran — zero edits, clicks, keyframes, objects, or commands were executed.',
        next_fix: 'Stop taking passive photos. Click, type, build scripts/objects/keyframes, and test the result cleanly right now.'
      };
    }
    try {
      const [beforeVisionShot, afterVisionShot, uiMap] = await Promise.all([
        initShot ? shotForVision(initShot, this.automation) : Promise.resolve(null),
        shotForVision(currentShot, this.automation),
        describeForegroundElements(this.screen, this.automation)
      ]);
      const visualDiffPct = computeVisualDiffPct(initShot, currentShot);
      const mutSteps = (Array.isArray(stepLog) ? stepLog : []).filter(isMutatingWorkStep);
      const tstSteps = (Array.isArray(stepLog) ? stepLog : []).filter(isTestEvidenceStep);
      const traceLines = (Array.isArray(stepLog) ? stepLog : []).slice(-26).map((s) => {
        const tag = isTestEvidenceStep(s) ? 'TEST' : (isMutatingWorkStep(s) ? 'EDIT' : 'VIEW');
        return `Step ${s.step} [${s.tool}/${tag}] (${s.ok ? 'OK' : 'FAILED'}): ${s.description}${s.result && s.result.error ? ' · ERR: ' + String(s.result.error).slice(0, 120) : ''}`;
      }).join('\n');

      const depthNote = (taskProfile && taskProfile.isDeepBuildTask && minWorkMs > 0 && elapsedMs < minWorkMs && qaPasses < 2)
        ? `\nDEEP QUALITY CHECK (${formatWorkedTime(elapsedMs)} worked so far; target thorough build+test window is ${Math.round(minWorkMs / 60000)}–25m): Hunt carefully for ANYTHING missing, ugly, untested, static, or broken (missing UI buttons, un-animated frames, missing easing/lighting, Play-mode errors, collision/UX issues). If anything can be tested deeper or improved cleanly, return verified=false with exact next_fix!`
        : '';

      const prompt = [
        'You are Brief\'s Independent QA Tester & Reviewer Agent. Compare the BEFORE vs AFTER desktop images, executed steps, and live OCR UI state strictly.',
        'STRICT REJECTION RULES (return verified=false whenever ANY fails):',
        '1. Screenshots, OCR reads, or focusing windows without actually building/editing what the user asked -> verified=false.',
        '2. Writing or copying code/prompts into a file/message WITHOUT running, applying, or testing it live inside the real app -> verified=false.',
        '3. Roblox Studio (elevator/obby/GUI/script): Parts, buttons, and scripts MUST visibly exist in Studio AND Play/Run (F5/F8) + Output MUST have been tested with zero errors -> otherwise verified=false.',
        '4. Blender / CapCut / Higgsfield / Adobe (animation/3D/video): Objects/clips AND real multi-frame animation keyframes/effects MUST be applied AND timeline playback/scrubbing must have been visually tested across frames -> otherwise verified=false.',
        '5. If UI/scene appears missing requested buttons, broken, clipped, static, or visually unchanged -> verified=false.',
        depthNote,
        'Reply ONLY with strict JSON: {"verified":true,"reason":"specific tested proof","next_fix":""} or {"verified":false,"reason":"specific missing or broken item","next_fix":"exact next actions & test to run now"}.',
        '',
        'USER REQUEST: ' + task,
        `METRICS: elapsed=${formatWorkedTime(elapsedMs)}, mutatingEdits=${mutSteps.length}, testRuns=${tstSteps.length}, visualScreenDiff=${visualDiffPct !== null ? (visualDiffPct + '%') : 'unknown'}, qaPass=${qaPasses}, auditMode=${deepPolishAudit ? 'deep_polish' : 'completion_check'}`,
        planText ? ('SPECIALIST / SCOUT BRIEF:\n' + planText.slice(0, 1400)) : '',
        'EXECUTED STEPS:\n' + (traceLines || '(none)'),
        'EXECUTOR SUMMARY: ' + (candidateAnswer || '(none)'),
        uiMap
      ].filter(Boolean).join('\n');

      const vParts = [{ text: prompt }];
      if (beforeVisionShot && beforeVisionShot.base64) {
        vParts.push({ text: '[BEFORE screenshot at task start:]' });
        vParts.push({ inlineData: { mimeType: beforeVisionShot.mime, data: beforeVisionShot.base64 } });
      }
      if (afterVisionShot && afterVisionShot.base64) {
        vParts.push({ text: '[AFTER screenshot RIGHT NOW:]' });
        vParts.push({ inlineData: { mimeType: afterVisionShot.mime, data: afterVisionShot.base64 } });
      }

      const vPayload = {
        contents: [{ role: 'user', parts: vParts }],
        generationConfig: { maxOutputTokens: 380, temperature: 0.1 }
      };
      const res = await this.gemini.generate(modelId, vPayload, { signal: this.abortController ? this.abortController.signal : undefined, retries: 1 });
      const cand = (res && res.candidates || [])[0];
      const txt = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || '').join('').trim();
      const jsonMatch = /\{[\s\S]*\}/.exec(txt);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (typeof parsed.verified === 'boolean') {
            return {
              verified: parsed.verified,
              reason: String(parsed.reason || '').trim(),
              next_fix: String(parsed.next_fix || '').trim()
            };
          }
        } catch (_) { /* fall through to text pattern */ }
      }
      if (/\b(?:VERIFIED\s*:\s*NO|NOT\s+VERIFIED|verified["']?\s*:\s*false)\b/i.test(txt)) {
        return { verified: false, reason: txt.slice(0, 180), next_fix: 'Inspect UI, complete unfinished parts, run live Play/Playback test, and re-verify.' };
      }
      if (/\bverified["']?\s*:\s*true\b/i.test(txt)) {
        return { verified: true, reason: txt.slice(0, 180), next_fix: '' };
      }
      // Fail-closed when response was ambiguous and no in-app test ran yet
      if (testCount === 0 && taskProfile && taskProfile.requiresAppTest) {
        return {
          verified: false,
          reason: 'QA Verifier could not confirm live app test evidence yet.',
          next_fix: 'Run an explicit live test (Play/Run in Roblox, Space/Play/timeline scrub in Blender/CapCut/Adobe, or test command) and inspect the resulting screen.'
        };
      }
      return { verified: true, reason: txt.slice(0, 160), next_fix: '' };
    } catch (err) {
      // Fail-closed unless mutating & tested work has already been proven cleanly
      if (mutatingCount === 0 || (taskProfile && taskProfile.requiresAppTest && testCount === 0)) {
        return {
          verified: false,
          reason: 'QA verification could not verify live tested results (' + (err && err.message ? err.message : 'check error') + ').',
          next_fix: 'Execute concrete build & live test checks in the target app and re-capture evidence.'
        };
      }
      return { verified: false, reason: 'QA check interrupted (' + (err && err.message ? err.message : 'retry') + ') — re-verify current state before finishing.', next_fix: 'Take one quick inspection check and verify everything requested is present and working.' };
    }
  }

  /**
   * Runs the full real multi-agent desktop pipeline (Strategist + Scout + Specialist + Precision Executor + QA Verifier).
   */
  async runWork({ chatId, messages, task, attachments, webSearch, screenShare, _testMinWorkMs, _testMaxWorkMs }) {
    if (this.running) throw new Error('An agent task is already running. Press Stop first.');
    this.running = true;
    this.stopped = false;
    this.abortController = new AbortController();
    this.screen.resetSession();

    const runId = ++this.runId;
    const workStartMs = Date.now();
    const settings = this.getSettings();
    const configuredMax = Math.max(1, Math.min(200, Number(settings.maxSteps) || 140));
    const agentModel = this.resolveModelForJob('agent');
    const fastModel = this.resolveModelForJob('fast');
    const screenModel = this.resolveModelForJob('screen');
    const plannerModel = this.resolveModelForJob('planner');

    if (!agentModel.id) {
      this.running = false;
      throw new Error('No AI model is selected or available on this API key. Open Settings → API Key & Models.');
    }

    const roster = this.resolveTeamRoster();
    const userOriginPos = (this.automation && typeof this.automation.position === 'function')
      ? await this.automation.position().catch(() => null)
      : null;
    let anyPointerMoved = false;

    const cuAvailable = screenModel.isComputerUse && screenModel.id !== agentModel.id;
    let usingDirectCu = agentModel.isComputerUse;
    const stepLog = [];
    let finalAnswer = '';
    let errorNote = null;
    let maxSteps = configuredMax;

    const elapsedNowLabel = () => formatWorkedTime(Date.now() - workStartMs);

    this.setStatus({
      running: true,
      state: 'observing',
      mode: 'work',
      model: agentModel.id,
      crew: [roster.executor, roster.scout, roster.specialist, roster.qaTester],
      elapsedMs: 0,
      elapsedLabel: '0s',
      step: 0,
      maxSteps,
      stepText: `Multi-Agent Crew (${roster.distinctCount} model${roster.distinctCount === 1 ? '' : 's'}) opening workspace...`
    });
    this.emitLog({
      kind: 'task',
      status: 'started',
      model: agentModel.id,
      tool: 'work_start',
      detail: `${task} [Crew: Exec=${roster.executor}, Scout=${roster.scout}, Specialist=${roster.specialist}, QA=${roster.qaTester}]`
    });

    try {
      // Honor Third Eye shared window/display and tuck Brief away so the very first screenshot shows the real target app/tab, never Brief itself.
      if (screenShare && screenShare.enabled) {
        if (screenShare.displayId && typeof this.screen.displays === 'function') {
          const dispList = this.screen.displays();
          const dispIdx = dispList.findIndex((d) => String(d.id) === String(screenShare.displayId));
          if (dispIdx >= 0) this.screen.setCurrentDisplayByIndex(dispIdx);
        }
        if (screenShare.kind === 'window' && screenShare.name && this.automation && typeof this.automation.focusWindow === 'function') {
          await this.automation.focusWindow(screenShare.name).catch(() => {});
          await sleep(180);
        }
      }
      if (settings.minimizeDuringAgent !== false) {
        this.emit('prepare-desktop-eyes');
        await sleep(200);
      }

      const [currentShotInit, rawWindows, rawTabs] = await Promise.all([
        this.screen.capture({ format: 'jpeg' }),
        (this.automation && typeof this.automation.listWindows === 'function') ? this.automation.listWindows().catch(() => []) : Promise.resolve([]),
        (this.automation && typeof this.automation.listBrowserTabs === 'function') ? this.automation.listBrowserTabs().catch(() => []) : Promise.resolve([])
      ]);
      const openWindows = (Array.isArray(rawWindows) ? rawWindows : []).filter((w) => !/^(?:brief(?:\s|$)|locally(?:\s|$))/i.test(String(w.title || '')) && !/^(?:locally|brief)$/i.test(String(w.process || '')));
      const openTabs = Array.isArray(rawTabs) ? rawTabs : [];

      const taskProfile = detectDeepTaskProfile(task, openWindows, settings, { minWorkMs: _testMinWorkMs, maxWorkMs: _testMaxWorkMs });
      if (taskProfile.isDeepBuildTask) {
        maxSteps = Math.max(configuredMax, 140);
      }

      const obsShotThumb = thumbOf(currentShotInit);
      this.emit('work-step', {
        runId,
        chatId,
        item: {
          step: 0,
          toolCallId: 'observe-init',
          running: true,
          model: roster.scout || agentModel.id,
          agentRole: 'Scout Eyes',
          tool: 'observe_screen',
          description: screenShare && screenShare.enabled
            ? ('Third Eye looking at "' + (screenShare.name || 'screen') + '"…')
            : `Crew (${roster.distinctCount} models) scanning desktop & launching Step 1 immediately…`,
          seenShot: obsShotThumb
        }
      });
      const useSearch = webSearch !== undefined ? !!webSearch : (settings.webSearchEnabled !== false);
      const needsPreSearch = useSearch && task && /\b(search|look up|what is|who is|why|how does|news|weather|price|cause|causes|effects|facts|information|research|find out|essay|report|summary|pollution|how to)\b/i.test(String(task));
      const initialWebHits = needsPreSearch
        ? await Promise.race([runLiveWebSearch(String(task).trim().slice(0, 160), 5), sleep(900).then(() => [])]).catch(() => [])
        : [];
      let currentShot = currentShotInit;
      if (this.getSettings().showOverlay !== false) {
        try {
          const startMap = this.screen.mapPoint(520, 420, { scale: 1000 });
          this.cursorEmitter({ kind: 'move', x: startMap.dip.x, y: startMap.dip.y, ms: 200, label: 'Crew starting…' });
          this.automation.move(startMap.native.x, startMap.native.y, 200).catch(() => {});
        } catch (_) { /* ignore */ }
      }

      // Build conversation history cleanly
      const contents = [];
      const prior = (Array.isArray(messages) ? messages : []).slice(0, -1).slice(-8);
      for (const m of prior) {
        if (!m.text) continue;
        contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] });
      }

      const [initVisionShot, initUiMap] = await Promise.all([
        shotForVision(currentShot, this.automation),
        describeForegroundElements(this.screen, this.automation)
      ]);

      // PARALLEL MULTI-AGENT CREW: Instead of blocking Step 1 for 25s waiting on analysis, launch Specialist + Scout CONCURRENTLY
      // while Executor immediately jumps into Step 1 actions!
      let planText = '';
      let specialistInjected = false;
      let scoutMidAuditPromise = null;
      let scoutAuditNote = '';
      const enableParallel = settings.multiAgentParallel !== false && typeof this.gemini.generate === 'function';

      const specialistModelId = (roster.specialist && !/computer-use/i.test(roster.specialist)) ? roster.specialist : (plannerModel.id || agentModel.id);
      const scoutModelId = (roster.scout && !/computer-use/i.test(roster.scout)) ? roster.scout : (fastModel.id || agentModel.id);

      const concurrentCrewPromise = (enableParallel && settings.usePlanner !== false && specialistModelId)
        ? Promise.allSettled([
            this.gemini.generate(specialistModelId, {
              contents: [{
                role: 'user',
                parts: [
                  {
                    text: 'You are Brief\'s Specialist Architect working IN PARALLEL alongside the Desktop Executor.\n' +
                      'Do NOT stall with vague essays. Provide:\n' +
                      '1) Concrete objects/scripts/keyframes/UI buttons needed so nothing is missing or ugly.\n' +
                      '2) Exact app test steps required to prove it works (Roblox Studio: Play/Run F5/F8 + check Output; Blender/CapCut/Higgsfield/Adobe: multi-frame keyframes + Space/Play playback scrub verify; Code: run tests).\n' +
                      'Task: ' + task + '\nOpen Windows: ' + (openWindows.slice(0, 8).map((w) => w.title).join(' | ') || 'none')
                  },
                  { inlineData: { mimeType: initVisionShot.mime, data: initVisionShot.base64 } }
                ]
              }],
              generationConfig: { maxOutputTokens: 420, temperature: 0.2 }
            }, { signal: this.abortController.signal, retries: 0 }),
            (scoutModelId && scoutModelId !== specialistModelId)
              ? this.gemini.generate(scoutModelId, {
                  contents: [{
                    role: 'user',
                    parts: [
                      {
                        text: 'You are Brief\'s Fast Scout Agent. In 4 crisp bullets, list the exact visible UI controls/tabs/menus in the screenshot and OCR map that the Executor should click or watch out for.\nTask: ' + task + '\n' + initUiMap
                      },
                      { inlineData: { mimeType: initVisionShot.mime, data: initVisionShot.base64 } }
                    ]
                  }],
                  generationConfig: { maxOutputTokens: 220, temperature: 0.1 }
                }, { signal: this.abortController.signal, retries: 0 })
              : Promise.resolve(null)
          ]).then((settled) => {
            const chunks = [];
            const specRes = settled[0] && settled[0].status === 'fulfilled' ? settled[0].value : null;
            const sCand = specRes && (specRes.candidates || [])[0];
            const specTxt = ((sCand && sCand.content && sCand.content.parts) || []).map((p) => p.text || '').join('').trim();
            if (specTxt) chunks.push(`[Specialist (${specialistModelId}) Blueprint]\n${specTxt}`);

            const scoutRes = settled[1] && settled[1].status === 'fulfilled' ? settled[1].value : null;
            const scCand = scoutRes && (scoutRes.candidates || [])[0];
            const scTxt = ((scCand && scCand.content && scCand.content.parts) || []).map((p) => p.text || '').join('').trim();
            if (scTxt) chunks.push(`[Scout (${scoutModelId}) UI Map]\n${scTxt}`);

            planText = chunks.join('\n\n');
            if (planText) {
              this.emitLog({ kind: 'plan', status: 'ok', model: specialistModelId, tool: 'parallel_crew', detail: planText });
              this.emit('work-plan', { runId, chatId, model: specialistModelId, plan: planText });
            }
            return planText;
          }).catch(() => '')
        : Promise.resolve('');

      // Emit crew announcement immediately so user sees all agents working without waiting
      this.emit('work-plan', {
        runId,
        chatId,
        model: agentModel.id,
        plan: `Parallel Crew Launched — Executor: ${roster.executor} · Scout: ${roster.scout} · Specialist: ${roster.specialist} · QA Tester: ${roster.qaTester}` +
          (taskProfile.isDeepBuildTask && taskProfile.minWorkMs > 0
            ? `\nDeep Studio Mode active (target ${Math.round(taskProfile.minWorkMs / 60000)}–${Math.round(taskProfile.maxWorkMs / 60000)}m build, live testing & polish).`
            : '')
      });

      const webSearchBlock = (Array.isArray(initialWebHits) && initialWebHits.length)
        ? '\n\n[Live Web Search Results — use these facts accurately and stay strictly on the user\'s exact topic]:\n' +
          initialWebHits.map((h, i) => `${i + 1}. ${h.title} (${h.url})\n   ${h.snippet}`).join('\n')
        : '';

      const wantsLongPress = /\b(?:lo+ng[\s-]*press|hold[\s-]*(?:down|click|mouse|key|it|button|for)|press and hold|keep holding)\b/i.test(String(task || ''));
      const longPressHint = wantsLongPress
        ? '\n\n[LONG-PRESS / HOLD INSTRUCTION: The user explicitly wants a LONG PRESS / HOLD. Call `click({ x, y, hold_ms: 2500 })` or `mouse_button({ action: "long_press", x, y, duration_ms: 2500 })` or `click_element({ query, hold_ms: 2500 })` for mouse hold, or `hold_key({ key, action: "long_press", duration_ms: 2500 })` for keyboard hold — NEVER do a short quick tap!]'
        : '';

      const urgencyDirective = '\n\n[EXECUTION DIRECTIVE: Act IMMEDIATELY on Step 1 — DO NOT pause to summarize screenshots. Taking screenshots without building, typing, scripting, keyframing, and testing inside the target app is strictly rejected by QA Verifier.]';

      const initialParts = [
        {
          text: task +
            urgencyDirective +
            longPressHint +
            webSearchBlock +
            initUiMap +
            '\n\n[Initial real desktop screenshot with 0..1000 coordinate grid attached below.]'
        },
        { inlineData: { mimeType: initVisionShot.mime, data: initVisionShot.base64 } }
      ];
      if (Array.isArray(attachments)) {
        for (const att of attachments) {
          if (att.kind === 'image' && att.base64) {
            initialParts.push({ inlineData: { mimeType: att.mime || 'image/png', data: att.base64 } });
          } else if (att.textContent !== undefined) {
            initialParts.push({ text: `\n[Attached file: ${att.name}]\n\`\`\`\n${att.textContent.slice(0, 40000)}\n\`\`\`` });
          }
        }
      }
      contents.push({ role: 'user', parts: initialParts });

      const connectedMcp = this.mcpManager ? this.mcpManager.list().filter((x) => x.status === 'connected') : [];
      const mcpDecls = this.mcpManager ? this.mcpManager.getGeminiToolDeclarations() : [];

      const sysPrompt = buildWorkSystemPrompt({
        screen: this.screen,
        automation: this.automation,
        cuActive: cuAvailable || usingDirectCu,
        cuModelId: screenModel.id,
        permissionMode: settings.permissionMode || 'full',
        mcpServers: connectedMcp,
        openWindows,
        openTabs,
        screenShare
      });

      const decls = [...declarations({ includeScreen: true, cuMode: usingDirectCu }), ...mcpDecls.filter((d) => !BLOCKED_STORE_TOOL_RE.test(d.name))];
      if (cuAvailable) {
        decls.push({
          name: 'delegate_screen_control',
          description: 'Delegate a visual GUI sub-goal (clicking, typing into an app window, scrolling on screen) to Google\'s specialized Computer Use model (' + screenModel.id + '). Use only when mouse/keyboard GUI interaction is needed rather than direct file or terminal tools.',
          parameters: {
            type: 'object',
            properties: {
              goal: { type: 'string', description: 'Exact visual goal on the current screen, e.g. "Click the Search box in File Explorer and type invoice".' }
            },
            required: ['goal']
          }
        });
      }

      const toolPayload = usingDirectCu
        ? [{ computerUse: { environment: 'ENVIRONMENT_BROWSER' } }, { functionDeclarations: decls }]
        : [{ functionDeclarations: decls }];

      const failureCounts = new Map();
      const recentClicks = [];
      const failedModels = new Set();
      let activeStepModel = agentModel.id;
      let zeroWorkRejections = 0;
      let untestedRejections = 0;
      let fallbackSwitches = 0;
      let verifyRejections = 0;
      let deepPolishRejections = 0;
      let qaPasses = 0;
      let forceToolNextTurn = false;
      let mouseButtonHeld = false;
      let didHoldAction = false;

      for (let step = 1; step <= maxSteps; step++) {
        if (this.stopped) throw abortError();
        if (Date.now() - workStartMs >= taskProfile.maxWorkMs) {
          this.emit('work-note', {
            runId,
            chatId,
            step,
            text: `⏱️ Reached max ${Math.round(taskProfile.maxWorkMs / 60000)}m time window (${elapsedNowLabel()} worked). Finalizing verified summary…`
          });
          break;
        }

        // Inject finished parallel Specialist + Scout notes on Step 2+ without ever blocking Step 1
        if (!specialistInjected && step >= 2) {
          const crewNote = await Promise.race([concurrentCrewPromise, sleep(150).then(() => '')]);
          if (crewNote) {
            specialistInjected = true;
            contents.push({
              role: 'user',
              parts: [{ text: '[Parallel Multi-Agent Crew Guidance Ready — follow these concrete implementation & testing requirements:]\n' + crewNote }]
            });
          }
        }
        if (scoutAuditNote) {
          const noteToInject = scoutAuditNote;
          scoutAuditNote = '';
          contents.push({ role: 'user', parts: [{ text: noteToInject }] });
        }

        const curElapsed = elapsedNowLabel();
        this.setStatus({
          running: true,
          state: 'thinking',
          mode: 'work',
          model: activeStepModel,
          crew: [roster.executor, roster.scout, roster.specialist, roster.qaTester],
          elapsedMs: Date.now() - workStartMs,
          elapsedLabel: curElapsed,
          mutatingCount: stepLog.filter(isMutatingWorkStep).length,
          testCount: stepLog.filter(isTestEvidenceStep).length,
          step,
          maxSteps,
          stepText: `⏱ ${curElapsed} · Step ${step}/${maxSteps} · Executor working (${activeStepModel})...`
        });

        let json;
        let streamedAnyThought = false;
        let waitSecs = 0;
        let streamPhase = 'Working';
        let streamBytes = 0;
        const waitTicker = setInterval(() => {
          waitSecs += 1;
          if (!this.stopped) {
            const elapsedStr = elapsedNowLabel();
            const extra = streamBytes > 0 ? ` · ${(streamBytes / 1024).toFixed(1)} KB` : '';
            this.setStatus({
              running: true,
              state: 'thinking',
              mode: 'work',
              model: activeStepModel,
              crew: [roster.executor, roster.scout, roster.specialist, roster.qaTester],
              elapsedMs: Date.now() - workStartMs,
              elapsedLabel: elapsedStr,
              mutatingCount: stepLog.filter(isMutatingWorkStep).length,
              testCount: stepLog.filter(isTestEvidenceStep).length,
              step,
              maxSteps,
              stepText: `⏱ ${elapsedStr} · Step ${step}/${maxSteps} · ${streamPhase} (${waitSecs}s${extra}) with ${activeStepModel}...`
            });
            if (waitSecs % 2 === 1 && !mouseButtonHeld && this.getSettings().showOverlay !== false) {
              try {
                const { screen: elecScreen } = (process.versions && process.versions.electron) ? require('electron') : {};
                if (elecScreen && typeof elecScreen.getCursorScreenPoint === 'function') {
                  const pt = elecScreen.getCursorScreenPoint();
                  this.cursorEmitter({ kind: 'layer-only', x: pt.x, y: pt.y, label: `⏱ ${elapsedStr} · Step ${step}` });
                }
              } catch (_) { /* ignore */ }
            }
          }
        }, 1000);
        let switchedModel = false;
        try {
          const workTCfg = buildThinkingConfig(activeStepModel, settings.thinkingLevel || 'medium', this.getModels());
          const workPayload = {
            systemInstruction: { parts: [{ text: sysPrompt }] },
            contents: pruneHistoryScreenshots(contents, 2),
            tools: toolPayload
          };
          if (forceToolNextTurn && !usingDirectCu) {
            workPayload.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
          }
          forceToolNextTurn = false;
          if (workTCfg) workPayload.generationConfig = { thinkingConfig: workTCfg };
          const callOpts = {
            retries: 1,
            signal: this.abortController.signal,
            onThought: (delta, fullThought) => {
              streamedAnyThought = true;
              streamPhase = 'Thinking & Analyzing';
              this.emit('work-thought', { runId, chatId, step, delta, full: fullThought, streaming: true });
            },
            onText: (delta, full) => {
              this.emit('chat-delta', { runId, chatId, delta, full });
            },
            onActivity: ({ bytes, thoughtChars, textChars }) => {
              streamBytes = bytes;
              streamPhase = thoughtChars > 0 ? 'Thinking & Analyzing' : (textChars > 0 ? 'Writing reply' : 'Preparing action');
              if (!this.stopped) {
                this.setStatus({
                  running: true,
                  state: 'thinking',
                  mode: 'work',
                  model: activeStepModel,
                  step,
                  maxSteps,
                  stepText: `Step ${step}/${maxSteps} · ${streamPhase} (${waitSecs}s · ${(bytes / 1024).toFixed(1)} KB) with ${activeStepModel}...`
                });
              }
            },
            onRetry: (r) => {
              this.emitLog({ kind: 'retry', status: 'warn', model: activeStepModel, tool: 'gemini_api', detail: `Retrying (${r.error}) in ${Math.round(r.wait / 1000)}s` });
              this.setStatus({ state: 'thinking', stepText: `${activeStepModel} busy — retrying (${Math.round(r.wait / 1000)}s)...` });
            }
          };
          if (typeof this.gemini.stream === 'function') {
            try {
              json = await this.gemini.stream(activeStepModel, workPayload, callOpts);
            } catch (streamErr) {
              if (!streamedAnyThought && streamErr.kind === 'bad_request' && /stream/i.test(streamErr.message || '')) {
                json = await this.gemini.generate(activeStepModel, workPayload, callOpts);
              } else {
                throw streamErr;
              }
            }
          } else {
            json = await this.gemini.generate(activeStepModel, workPayload, callOpts);
          }
        } catch (apiErr) {
          if (this.stopped || apiErr.kind === 'aborted') throw abortError();
          const fatalAuth = ['invalid', 'nokey', 'disabled'].includes(apiErr.kind);
          const recoverable = !fatalAuth && (
            ['server', 'rate', 'quota', 'noaccess', 'timeout'].includes(apiErr.kind) ||
            usingDirectCu ||
            /high demand|overloaded|temporarily|try again|capacity|unavailable|unsupported|timed out|stalled|quota|limit:\s*0/i.test(apiErr.message || '')
          );
          if (recoverable && fallbackSwitches < 12) {
            failedModels.add(activeStepModel);
            const fallbackList = this.getFallbackModels(failedModels);
            const nextModel = fallbackList[0];
            if (nextModel) {
              fallbackSwitches += 1;
              const shortReason = String(apiErr.message || 'model busy').replace(/\s+/g, ' ').slice(0, 180);
              this.emitLog({ kind: 'retry', status: 'warn', model: activeStepModel, tool: 'model_fallback', detail: `${activeStepModel} unavailable (${shortReason}); continuing with ${nextModel}` });
              this.emit('work-note', { runId, chatId, step, text: `⚠️ ${activeStepModel} unavailable (${shortReason}). Switched automatically to ${nextModel} so your work continues.` });
              this.setStatus({ running: true, state: 'thinking', mode: 'work', model: nextModel, step, maxSteps, stepText: `${activeStepModel} busy — continuing with ${nextModel}...` });
              activeStepModel = nextModel;
              usingDirectCu = /computer-use/i.test(activeStepModel);
              if (toolPayload.length > 1 || !usingDirectCu) {
                toolPayload[0] = { functionDeclarations: [...declarations({ includeScreen: true, cuMode: usingDirectCu }), ...mcpDecls.filter((d) => !BLOCKED_STORE_TOOL_RE.test(d.name))] };
                toolPayload.length = 1;
              }
              step -= 1;
              switchedModel = true;
            }
          }
          if (!switchedModel) throw apiErr;
        } finally {
          clearInterval(waitTicker);
        }
        if (switchedModel) continue;

        const cand = (json.candidates || [])[0];
        if (!cand || !cand.content || !Array.isArray(cand.content.parts)) {
          const reason = (json.promptFeedback && json.promptFeedback.blockReason) || (cand && cand.finishReason) || 'Empty response from Gemini';
          throw new Error('Model stopped without output: ' + reason);
        }

        // Preserve exact model content (including thoughtSignature!) for multi-turn function calling.
        contents.push(cand.content);

        const parts = cand.content.parts;
        const calls = parts.filter((p) => p.functionCall);
        const visibleText = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('\n').trim();
        const thoughts = parts.filter((p) => typeof p.text === 'string' && p.thought).map((p) => p.text).join('\n').trim();

        if (thoughts && !streamedAnyThought) {
          this.emit('work-thought', { runId, chatId, step, thought: thoughts });
        }

        if (!calls.length) {
          const mutStepsNow = stepLog.filter(isMutatingWorkStep);
          const tstStepsNow = stepLog.filter(isTestEvidenceStep);
          const elapsedNow = Date.now() - workStartMs;
          const withinMaxTime = elapsedNow < taskProfile.maxWorkMs;
          const missingHold = wantsLongPress && !didHoldAction;

          // Gate 1: Reject photo-only / zero real action attempts deterministically
          if ((mutStepsNow.length === 0 || missingHold) && zeroWorkRejections < 5 && step < maxSteps && withinMaxTime) {
            zeroWorkRejections += 1;
            forceToolNextTurn = !usingDirectCu;
            if (visibleText) this.emit('work-note', { runId, chatId, step, text: visibleText });
            this.emitLog({ kind: 'verify', status: 'warn', model: activeStepModel, tool: 'action_gate', detail: missingHold ? 'Rejected: no hold/long-press performed' : `Rejected: ${stepLog.length} passive step(s), 0 real edits performed` });
            contents.push({
              role: 'user',
              parts: [{ text: missingHold
                ? 'REJECTED: You have NOT executed a long-press or hold action yet! Call `mouse_button({ action: "long_press", x, y, duration_ms: 2500 })`, `click({ x, y, hold_ms: 2500 })`, `click_element({ query, hold_ms: 2500 })`, or `hold_key({ key, action: "long_press", duration_ms: 2500 })` right now.'
                : `[REJECTED BY QA GATE — Time Worked: ${formatWorkedTime(elapsedNow)}]\nYou only looked / took screenshots / focused windows (${stepLog.length} passive action(s), ZERO real edits/builds!). Stop just taking photos and explaining what you see. Call real mutating tools NOW (\`click_text\`, \`click\`, \`type_text\`, \`drag\`, \`press_keys\`, \`write_file\`, \`run_command\`, or \`mcp__\`) to actually create, animate, or fix the work inside the app!` }]
            });
            continue;
          }

          // Gate 2: Require live app / animation / Play / command testing before completion on build tasks
          if (taskProfile.requiresAppTest && tstStepsNow.length === 0 && untestedRejections < 4 && step < maxSteps && withinMaxTime) {
            untestedRejections += 1;
            forceToolNextTurn = !usingDirectCu;
            const testDirective = taskProfile.isRoblox
              ? 'You MUST test inside Roblox Studio right now: ensure **Output** is open (`View -> Output`), run **Play / Run (`F5` or `F8`)**, test your buttons/doors/scripts live, inspect Output with `read_screen_text` for zero red errors, and fix any missing/broken parts!'
              : taskProfile.isAnimationOrCreative
                ? 'You MUST test your animation/scene live right now: check keyframes across multiple timeline frames (`I`/Keyframes), press **Space / Play** or `drag` the timeline playhead across start/mid/end frames, take screenshots during playback to verify motion, and fix any static or missing UI/visual elements!'
                : 'You MUST execute a real test command (`run_command`) or run/interact with the app live and inspect output screenshots to prove it actually works with zero errors!';
            this.emitLog({ kind: 'verify', status: 'warn', model: activeStepModel, tool: 'test_gate', detail: 'Rejected premature Done without in-app live testing' });
            this.emit('work-note', { runId, chatId, step, text: '🛡️ Blocked premature completion: no live Play/Test run verified yet. Testing the work now…' });
            contents.push({
              role: 'user',
              parts: [{ text: `[REJECTED — NO LIVE TEST RUN VERIFIED YET (${formatWorkedTime(elapsedNow)} worked)]\n` + testDirective }]
            });
            continue;
          }

          // Gate 3 & 4: Fail-Closed Independent QA Verifier Agent comparing BEFORE vs AFTER + Deep Polish Check
          const needsMoreDepth = taskProfile.isDeepBuildTask && taskProfile.minWorkMs > 0 && elapsedNow < taskProfile.minWorkMs && deepPolishRejections < 8 && step < maxSteps - 1 && withinMaxTime;
          if (!usingDirectCu && (verifyRejections < 8 || needsMoreDepth) && step < maxSteps && withinMaxTime && settings.verifyTaskBeforeFinish !== false) {
            const qaModelId = roster.qaTester || plannerModel.id || activeStepModel;
            this.setStatus({
              running: true,
              state: 'thinking',
              mode: 'work',
              model: qaModelId,
              crew: [roster.executor, roster.scout, roster.specialist, roster.qaTester],
              elapsedMs: elapsedNow,
              elapsedLabel: formatWorkedTime(elapsedNow),
              step,
              maxSteps,
              stepText: `⏱ ${formatWorkedTime(elapsedNow)} · QA Tester (${qaModelId}) verifying live changes & missing UI...`
            });
            const verdict = await this.runTaskVerifierAgent({
              task,
              taskProfile,
              planText,
              stepLog,
              mutatingCount: mutStepsNow.length,
              testCount: tstStepsNow.length,
              elapsedMs: elapsedNow,
              minWorkMs: taskProfile.minWorkMs,
              qaPasses,
              initShot: currentShotInit,
              currentShot,
              candidateAnswer: visibleText,
              modelId: qaModelId,
              deepPolishAudit: needsMoreDepth
            });

            if (verdict && verdict.verified === false) {
              verifyRejections += 1;
              if (needsMoreDepth) deepPolishRejections += 1;
              forceToolNextTurn = true;
              const rejectMsg = `🛡️ QA Tester (${qaModelId}) found gaps after ${formatWorkedTime(elapsedNow)}: ${verdict.reason || 'Work incomplete or missing verification.'} Fixing & testing now…`;
              this.emitLog({ kind: 'verify', status: 'warn', model: qaModelId, tool: 'qa_verifier', detail: verdict.reason || 'Rejected incomplete completion' });
              this.emit('work-note', { runId, chatId, step, text: rejectMsg });
              const [verifyVisionShot, verifyUiMap] = await Promise.all([
                shotForVision(currentShot, this.automation),
                describeForegroundElements(this.screen, this.automation)
              ]);
              contents.push({
                role: 'user',
                parts: [
                  {
                    text: `[QA Verifier (${qaModelId}) REJECTED completion — Time Worked: ${formatWorkedTime(elapsedNow)}]\n` +
                      'Issue found: ' + (verdict.reason || 'Not yet thoroughly built, animated, or tested.') + '\n' +
                      'Required fixes & tests NOW: ' + (verdict.next_fix || 'Fix missing UI/objects/keyframes/scripts, test Play/Playback live again, and inspect the result.') +
                      verifyUiMap
                  },
                  { inlineData: { mimeType: verifyVisionShot.mime, data: verifyVisionShot.base64 } }
                ]
              });
              continue;
            }

            qaPasses += 1;
            if (needsMoreDepth && qaPasses < 2) {
              deepPolishRejections += 1;
              forceToolNextTurn = true;
              const polishMsg = `🔍 Deep Studio Review (${formatWorkedTime(elapsedNow)} worked): First test pass succeeded — checking missing details, UI edge cases, visual polish & running second QA pass…`;
              this.emitLog({ kind: 'verify', status: 'ok', model: qaModelId, tool: 'deep_polish', detail: polishMsg });
              this.emit('work-note', { runId, chatId, step, text: polishMsg });
              contents.push({
                role: 'user',
                parts: [{ text: `[DEEP POLISH & SECOND QA PASS REQUIRED — Worked ${formatWorkedTime(elapsedNow)} / target ${Math.round(taskProfile.minWorkMs / 60000)}–${Math.round(taskProfile.maxWorkMs / 60000)}m]\nDo NOT stop after just one quick check! Inspect every detail of the scene/app carefully (all buttons, UI responsiveness, animations/keyframes/easing, lighting/geometry, error handling, edge cases), upgrade anything rough or missing, and run another full live Play/Playback test.` }]
              });
              continue;
            }

            if (verdict && verdict.reason) {
              this.emitLog({ kind: 'verify', status: 'ok', model: qaModelId, tool: 'qa_verifier', detail: verdict.reason });
            }
          }
          finalAnswer = visibleText || 'Task completed and verified.';
          break;
        }

        if (visibleText) {
          this.emit('work-note', { runId, chatId, step, text: visibleText });
        }

        const responseParts = [];
        const extraVisionImages = [];
        for (const p of calls) {
          if (this.stopped) throw abortError();
          const fc = p.functionCall;
          const name = fc.name;
          const args = fc.args || {};

          // Handle delegation to Google's Computer Use model
          if (name === 'delegate_screen_control' && cuAvailable) {
            this.emitLog({ kind: 'handoff', status: 'ok', model: screenModel.id, tool: 'delegate_screen_control', detail: 'Handing screen control to ' + screenModel.id + ': ' + (args.goal || '') });
            let cuOutcome;
            try {
              cuOutcome = await this.executeComputerUseSubtask({
                goal: String(args.goal || ''),
                cuModelId: screenModel.id,
                chatId,
                startStep: step,
                maxSubSteps: Math.min(8, maxSteps - step + 1),
                onStepEmit: (stepItem) => {
                  stepLog.push(stepItem);
                  this.emit('work-step', { runId, chatId, item: stepItem });
                }
              });
            } catch (cuErr) {
              if (this.stopped || cuErr.kind === 'aborted') throw abortError();
              cuOutcome = { ok: false, error: 'Computer Use model failed (' + cuErr.message + '). Retry using built-in screen tools (click, double_click, type_text, press_keys, open_app).' };
              this.emitLog({ kind: 'retry', status: 'warn', model: screenModel.id, tool: 'delegate_screen_control', detail: cuOutcome.error });
            }
            currentShot = cuOutcome.lastShot || await this.screen.capture({ format: 'jpeg' });
            responseParts.push({
              functionResponse: {
                name,
                response: { ok: cuOutcome.ok, summary: cuOutcome.summary || cuOutcome.error, actions: (cuOutcome.actionsTaken || []).map((x) => ({ tool: x.tool, ok: x.ok })) }
              }
            });
            continue;
          }

          const tool = getTool(name);
          const cuHandler = CU_ACTIONS[name];
          const mcpMeta = (!tool && !cuHandler && this.mcpManager) ? this.mcpManager.resolveToolMeta(name) : null;
          const handler = tool || cuHandler;

          // Choose fast model label for simple non-screen read steps, or active/CU label
          const stepModelLabel = (tool && tool.screen && screenModel.isComputerUse) ? screenModel.id : activeStepModel;
          const desc = mcpMeta
            ? `[${mcpMeta.serverName} MCP] ${mcpMeta.toolName}(${JSON.stringify(args).slice(0, 120)})`
            : (handler ? handler.describe(args) : `${name}(${JSON.stringify(args)})`);
          let dangerReason = handler && handler.dangerous ? handler.dangerous(args) : null;
          if (!dangerReason && name === 'run_command' && isPermanentDeleteCommand(args.command)) {
            dangerReason = 'This terminal command may permanently delete files.';
          }
          const safety = args.safety_decision || null;
          if (safety && safety.decision === 'blocked') {
            responseParts.push({ functionResponse: { name, response: { error: 'Action blocked by safety policy: ' + (safety.explanation || '') } } });
            continue;
          }

          // Capture small preview with coordinates highlighted when asking permission on a GUI step
          let previewDataUrl = null;
          if ((this.getSettings().permissionMode || 'full') !== 'full' || dangerReason) {
            if (tool && tool.screen) {
              const prev = await this.screen.preview(540).catch(() => null);
              previewDataUrl = prev ? prev.dataUrl : null;
            }
          }

          const isControlStep = !!((tool && (tool.screen || tool.kind === 'app' || tool.kind === 'command')) || cuHandler || mcpMeta);
          const perm = await this.requestPermission({
            chatId,
            step,
            toolName: name,
            args,
            description: desc,
            dangerReason,
            cuSafety: safety,
            screenshotPreview: previewDataUrl,
            isControlStep
          });
          if (this.stopped || perm.aborted) throw abortError();

          const t0 = Date.now();
          const toolCallId = 'tc-' + step + '-' + t0 + '-' + Math.random().toString(36).slice(2, 6);
          let resultObj;
          let stepOk = false;

          if (!perm.allowed) {
            resultObj = { error: 'Denied by user.' + (perm.note ? ' User feedback: ' + perm.note : '') + ' Try a different approach or ask the user.' };
            this.emitLog({ kind: 'action', status: 'denied', model: stepModelLabel, tool: name, detail: desc + (perm.note ? ' — ' + perm.note : '') });
          } else if (!handler && !mcpMeta) {
            resultObj = { error: `Unknown tool "${name}". Use one of the declared tools.` };
            this.emitLog({ kind: 'action', status: 'error', model: stepModelLabel, tool: name, detail: resultObj.error });
          } else {
            this.setStatus({ running: true, state: 'acting', mode: 'work', model: stepModelLabel, step, maxSteps, stepText: desc });
            this.emit('work-step', {
              runId,
              chatId,
              item: {
                step,
                toolCallId,
                running: true,
                model: stepModelLabel,
                tool: name,
                description: desc,
                args,
                seenShot: thumbOf(currentShot)
              }
            });
            if ((tool && (tool.screen || tool.kind === 'app')) && this.getSettings().showOverlay !== false && this.getSettings().minimizeDuringAgent !== false) {
              this.emit('before-screen-action', { tool: name });
              await sleep(160);
            }
            // Animate the single black OS cursor visibly to the active workspace/file/app and click when modifying or opening items.
            const skipPreClick = ['browser_tab', 'focus_window', 'window_control', 'close_other_windows', 'open_app', 'open_url', 'wait', 'take_screenshot', 'list_windows', 'web_search', 'fetch_url', 'mouse_button', 'hold_key', 'scroll', 'click', 'click_element', 'type_text', 'press_keys'].includes(name);
            if (name === 'mouse_button' && String(args.action || '').toLowerCase() === 'down') mouseButtonHeld = true;
            if (name === 'mouse_button' && String(args.action || '').toLowerCase() === 'up') mouseButtonHeld = false;
            if (name === 'mouse_button' || name === 'hold_key' || (args && (args.hold_ms > 80 || args.duration_ms > 80 || args.long_press || args.hold))) {
              didHoldAction = true;
            }
            if ((!tool || !tool.screen) && !skipPreClick && !mouseButtonHeld) {
              try {
                const { screen: elecScreen } = (process.versions && process.versions.electron) ? require('electron') : {};
                if (elecScreen && typeof elecScreen.getCursorScreenPoint === 'function') {
                  const pt = elecScreen.getCursorScreenPoint();
                  this.cursorEmitter({ kind: 'layer-only', x: pt.x, y: pt.y, label: desc.slice(0, 48) });
                }
              } catch (_) { /* ignore */ }
            }
            try {
              const out = mcpMeta
                ? await this.mcpManager.callGeminiTool(name, args)
                : await handler.run(args, this.makeToolContext());
              stepOk = true;
              if (tool && tool.screen && name !== 'read_screen_text' && name !== 'zoom_region' && name !== 'take_screenshot') {
                anyPointerMoved = true;
              }
              if (out && out._visionImage && out._visionImage.base64) {
                extraVisionImages.push({ label: desc, image: out._visionImage });
                const cleanOut = Object.assign({}, out);
                delete cleanOut._visionImage;
                resultObj = summarizeToolResult(cleanOut);
              } else {
                resultObj = summarizeToolResult(out || { ok: true });
              }
              if ((name === 'click' || name === 'double_click' || name === 'right_click') && isFinite(Number(args.x)) && isFinite(Number(args.y))) {
                const nx = Number(args.x);
                const ny = Number(args.y);
                recentClicks.push({ nx, ny });
                if (recentClicks.length > 6) recentClicks.shift();
                const nearHits = recentClicks.filter((c) => Math.abs(c.nx - nx) <= 20 && Math.abs(c.ny - ny) <= 20).length;
                if (nearHits >= 2 && resultObj && typeof resultObj === 'object') {
                  resultObj.loop_warning = `Notice: You have clicked near (${Math.round(nx)}, ${Math.round(ny)}) ${nearHits} times. Look closely at the cyan 0..1000 grid and visible UI elements — if nothing changed, try a different UI button/tab, scroll, drag, click_element, or keyboard shortcut instead of repeating the same click.`;
                }
              }
              // After opening or focusing an app/folder/file, move cursor into the newly opened window and click it
              if (['open_app', 'open_path', 'reveal_in_folder', 'focus_window'].includes(name) && this.getSettings().showOverlay !== false) {
                try {
                  await sleep(220);
                  const fgAfter = await this.automation.foreground().catch(() => null);
                  if (fgAfter && fgAfter.rect) {
                    const nums = typeof fgAfter.rect === 'string'
                      ? fgAfter.rect.split(',').map((n) => Number(n.trim()))
                      : [fgAfter.rect.left, fgAfter.rect.top, fgAfter.rect.left + fgAfter.rect.width, fgAfter.rect.top + fgAfter.rect.height];
                    if (nums.length === 4 && nums.every(isFinite) && (nums[2] - nums[0]) > 100 && (nums[3] - nums[1]) > 100) {
                      const cx = Math.round(nums[0] + (nums[2] - nums[0]) * 0.5);
                      const cy = Math.round(nums[1] + (nums[3] - nums[1]) * 0.45);
                      const { screen: elecScreen } = (process.versions && process.versions.electron) ? require('electron') : {};
                      const dipPt = (elecScreen && typeof elecScreen.screenToDipPoint === 'function') ? elecScreen.screenToDipPoint({ x: cx, y: cy }) : { x: cx, y: cy };
                      this.cursorEmitter({ kind: 'move', x: dipPt.x, y: dipPt.y, ms: 200, label: desc.slice(0, 48) });
                      await this.automation.move(cx, cy, 200).catch(() => {});
                      await sleep(60);
                      this.cursorEmitter({ kind: 'click', x: dipPt.x, y: dipPt.y, button: 'left', count: 1, label: desc.slice(0, 48) });
                      await this.automation.click('left', 1).catch(() => {});
                    }
                  }
                } catch (_) { /* ignore */ }
              }
              if (usingDirectCu && cuHandler) {
                resultObj = Object.assign({ url: 'desktop://screen' }, resultObj);
                if (safety && safety.decision === 'require_confirmation') resultObj.safety_acknowledgement = 'true';
              }
              this.emitLog({ kind: 'action', status: 'ok', model: stepModelLabel, tool: name, detail: desc, ms: Date.now() - t0 });
            } catch (err) {
              if (this.stopped || err.message === 'Stopped by user.' || err.message === 'Stopped by user (process killed).') throw abortError();
              const count = (failureCounts.get(name) || 0) + 1;
              failureCounts.set(name, count);
              resultObj = {
                ok: false,
                error: err.message,
                retry_hint: count >= 2
                  ? `Tool "${name}" has failed ${count} times. Switch to a completely different approach (e.g., terminal command, file tool, or keyboard shortcut) or report the blocker honestly.`
                  : 'Inspect the error and the new screenshot, then retry using a different approach.'
              };
              this.emitLog({ kind: 'action', status: 'error', model: stepModelLabel, tool: name, detail: desc + ' → FAILED: ' + err.message, ms: Date.now() - t0 });
            }
          }

          // Silently capture fresh desktop state for the model without flashing or attaching screenshot thumbnails in UI
          await sleep(tool && tool.screen ? 200 : 80);
          currentShot = await this.screen.capture({ format: 'jpeg' });

          const stepItem = {
            step,
            toolCallId,
            running: false,
            model: stepModelLabel,
            tool: name,
            description: desc,
            explanation: summarizeStepForUser(name, args, stepOk, resultObj),
            args,
            ok: stepOk,
            denied: !perm.allowed,
            result: resultObj,
            ms: Date.now() - t0,
            screenshot: thumbOf(currentShot)
          };
          stepLog.push(stepItem);
          this.emit('work-step', { runId, chatId, item: stepItem });

          if (usingDirectCu && cuHandler) {
            responseParts.push({
              functionResponse: {
                name,
                response: resultObj,
                parts: [{ inlineData: { mimeType: currentShot.mime, data: currentShot.base64 } }]
              }
            });
          } else {
            responseParts.push({
              functionResponse: Object.assign(fc.id ? { id: fc.id } : {}, { name, response: resultObj })
            });
          }
        }

        // Attach the fresh gridded screenshot + OCR map + live timer & schedule non-blocking Scout mid-run audit every 5 edits
        if (!usingDirectCu) {
          const [afterVisionShot, afterUiMap] = await Promise.all([
            shotForVision(currentShot, this.automation),
            describeForegroundElements(this.screen, this.automation)
          ]);
          const mutNow = stepLog.filter(isMutatingWorkStep).length;
          const tstNow = stepLog.filter(isTestEvidenceStep).length;
          const timeNow = elapsedNowLabel();
          const metricsLine = `\n[Time Worked: ${timeNow} | Real Edits: ${mutNow} | Tests Verified: ${tstNow}${taskProfile.isDeepBuildTask && taskProfile.minWorkMs > 0 ? ` | Deep Studio Target: ${Math.round(taskProfile.minWorkMs / 60000)}–${Math.round(taskProfile.maxWorkMs / 60000)}m` : ''}]`;
          responseParts.push({ text: `[Fresh desktop screenshot after step ${step} (with 0..1000 coordinate grid). Verify visually.]` + metricsLine + afterUiMap });
          responseParts.push({ inlineData: { mimeType: afterVisionShot.mime, data: afterVisionShot.base64 } });
          for (const ex of extraVisionImages.slice(-2)) {
            if (ex && ex.image && ex.image.base64) {
              responseParts.push({ text: `[Magnified Macro Zoom Crop for: ${ex.label}]` });
              responseParts.push({ inlineData: { mimeType: ex.image.mime || 'image/png', data: ex.image.base64 } });
            }
          }
          if (enableParallel && mutNow > 0 && mutNow % 5 === 0 && !scoutMidAuditPromise && scoutModelId) {
            scoutMidAuditPromise = this.gemini.generate(scoutModelId, {
              contents: [{
                role: 'user',
                parts: [
                  { text: `You are Scout Agent auditing progress mid-run after ${mutNow} edits (${timeNow}). List any missing buttons/objects, red errors, static un-animated items, or next test to run cleanly in 2-3 short lines.\nGoal: ${task}\n${afterUiMap}` },
                  { inlineData: { mimeType: afterVisionShot.mime, data: afterVisionShot.base64 } }
                ]
              }],
              generationConfig: { maxOutputTokens: 160, temperature: 0.1 }
            }, { signal: this.abortController.signal, retries: 0 }).then((r) => {
              const c = (r && r.candidates || [])[0];
              const txt = ((c && c.content && c.content.parts) || []).map((p) => p.text || '').join('').trim();
              if (txt) {
                scoutAuditNote = `[Scout (${scoutModelId}) Mid-Run Audit @ ${timeNow}]:\n${txt}`;
                this.emitLog({ kind: 'verify', status: 'ok', model: scoutModelId, tool: 'scout_audit', detail: txt });
              }
            }).catch(() => {}).finally(() => { scoutMidAuditPromise = null; });
          }
        }
        contents.push({ role: 'user', parts: responseParts });
      }

      const finalElapsedMs = Date.now() - workStartMs;
      const finalElapsedLabel = formatWorkedTime(finalElapsedMs);
      const finalMutCount = stepLog.filter(isMutatingWorkStep).length;
      const finalTestCount = stepLog.filter(isTestEvidenceStep).length;
      const usedCrewModels = [...new Set([roster.executor, roster.scout, roster.specialist, roster.qaTester, activeStepModel].filter(Boolean))];

      if (!finalAnswer) {
        const summarizer = fastModel.id || activeStepModel;
        this.setStatus({ running: true, state: 'thinking', model: summarizer, elapsedMs: finalElapsedMs, elapsedLabel: finalElapsedLabel, stepText: `⏱ ${finalElapsedLabel} · Summarizing verified results...` });
        const sumRes = await this.gemini.generate(summarizer, {
          contents: [
            ...pruneHistoryScreenshots(contents, 1),
            { role: 'user', parts: [{ text: `Worked for ${finalElapsedLabel} (${stepLog.length} total actions, ${finalMutCount} real edits, ${finalTestCount} live test steps). Summarize clearly and honestly what you built, what you tested & verified working, and anything remaining.` }] }
          ]
        }, { signal: this.abortController.signal, retries: 1 }).catch(() => null);
        const sCand = sumRes && (sumRes.candidates || [])[0];
        finalAnswer = (sCand && sCand.content && sCand.content.parts.map((x) => x.text || '').join('\n').trim()) ||
          `Completed session after ${finalElapsedLabel} (${finalMutCount} edits, ${finalTestCount} verified test actions).`;
      }

      const reportBanner = `\n\n---\n⏱️ **Time Worked:** ${finalElapsedLabel} · **Real Edits:** ${finalMutCount} · **Tests Run:** ${finalTestCount} · **Crew:** ${usedCrewModels.join(', ')}`;
      if (!finalAnswer.includes('Time Worked:')) {
        finalAnswer = finalAnswer.trim() + reportBanner;
      }

      this.cursorEmitter({ kind: 'hide' });
      this.emitLog({ kind: 'task', status: 'ok', model: activeStepModel, tool: 'work_done', detail: `Finished in ${finalElapsedLabel} (${stepLog.length} step(s), ${finalMutCount} edits, ${finalTestCount} tests)` });
      this.setStatus({ running: false, state: 'idle', elapsedMs: finalElapsedMs, elapsedLabel: finalElapsedLabel, step: 0, stepText: 'Ready' });
      return {
        text: finalAnswer,
        steps: stepLog,
        elapsedMs: finalElapsedMs,
        elapsedLabel: finalElapsedLabel,
        mutatingCount: finalMutCount,
        testCount: finalTestCount,
        crew: usedCrewModels,
        model: activeStepModel
      };
    } catch (e) {
      const stopElapsedMs = Date.now() - workStartMs;
      const stopElapsedLabel = formatWorkedTime(stopElapsedMs);
      this.cursorEmitter({ kind: 'hide' });
      if (this.stopped || e.kind === 'aborted' || e.name === 'AbortError') {
        this.emitLog({ kind: 'task', status: 'stopped', model: agentModel.id, tool: 'work_stop', detail: `Stopped by user after ${stopElapsedLabel} (${stepLog.length} step(s)).` });
        this.setStatus({ running: false, state: 'stopped', elapsedMs: stopElapsedMs, elapsedLabel: stopElapsedLabel, stepText: 'Stopped by user' });
        return {
          text: `Task stopped by user after **${stopElapsedLabel}** (${stepLog.length} step(s)).`,
          steps: stepLog,
          elapsedMs: stopElapsedMs,
          elapsedLabel: stopElapsedLabel,
          stopped: true,
          model: agentModel.id
        };
      }
      errorNote = e.message;
      this.emitLog({ kind: 'task', status: 'error', model: agentModel.id, tool: 'work_error', detail: e.message });
      this.setStatus({ running: false, state: 'error', elapsedMs: stopElapsedMs, elapsedLabel: stopElapsedLabel, stepText: e.message });
      throw e;
    } finally {
      this.running = false;
      this.abortController = null;
      this.pendingApproval = null;
      this.automation.release().catch(() => {});
      if (settings.alignCursorBack !== false && anyPointerMoved && userOriginPos && isFinite(userOriginPos.x) && isFinite(userOriginPos.y) && typeof this.automation.move === 'function') {
        await this.automation.move(userOriginPos.x, userOriginPos.y, 220).catch(() => {});
      }
      if (typeof this.automation.setBlackCursor === 'function') this.automation.setBlackCursor(false).catch(() => {});
      void errorNote;
    }
  }
}

module.exports = {
  AgentRunner,
  formatWorkedTime,
  isMutatingWorkStep,
  isTestEvidenceStep,
  detectDeepTaskProfile
};
