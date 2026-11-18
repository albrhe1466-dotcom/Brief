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
   * Independent QA Verifier Agent (Agent 4): verifies real screenshot, OCR text, and executed tool evidence
   * against the user's requirements before allowing Brief to say "Done".
   */
  async runTaskVerifierAgent({ task, planText, stepLog, candidateAnswer, currentShot, modelId }) {
    if (!this.gemini || typeof this.gemini.generate !== 'function') return { verified: true };
    try {
      const [visionShot, uiMap] = await Promise.all([
        shotForVision(currentShot, this.automation),
        describeForegroundElements(this.screen, this.automation)
      ]);
      const traceLines = (Array.isArray(stepLog) ? stepLog : []).slice(-24).map((s) =>
        `Step ${s.step} [${s.tool}] (${s.ok ? 'OK' : 'FAILED'}): ${s.description}${s.result && s.result.error ? ' · ERR: ' + String(s.result.error).slice(0, 120) : ''}`
      ).join('\n');
      const prompt = [
        'You are Brief\'s Independent QA Verifier Agent. Decide whether the Executor actually completed, tested, and verified the user\'s request on the real machine.',
        'STRICT RULES FOR APPROVAL:',
        '1. Writing code or copy-pasting into a file/message WITHOUT actually putting/running/testing it in the requested app/Roblox/website is NOT done -> verified=false.',
        '2. For Roblox Studio (elevator/obby/GUI/script): Parts/Scripts MUST exist inside Studio AND Play/Run test + Output must have been checked for zero errors -> otherwise verified=false.',
        '3. For CapCut / editor tasks: the requested animation/clip/text/effect must visibly be applied in the timeline/preview and tested -> otherwise verified=false.',
        '4. If a previous tool failed cleanly or nothing on screen reflects completion yet -> verified=false.',
        'Reply ONLY with strict JSON: {"verified":true,"reason":"...","next_fix":""} or {"verified":false,"reason":"specific gap","next_fix":"exact actions/tests to finish now"}.',
        '',
        'USER REQUEST: ' + task,
        planText ? ('PLAN CHECKLIST:\n' + planText) : '',
        'EXECUTED STEPS:\n' + (traceLines || '(none)'),
        'EXECUTOR CLAIMED: ' + (candidateAnswer || '(no summary)'),
        uiMap
      ].filter(Boolean).join('\n');

      const vPayload = {
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: visionShot.mime, data: visionShot.base64 } }
          ]
        }],
        generationConfig: { maxOutputTokens: 320, temperature: 0.1 }
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
        } catch (_) { /* ignore malformed json */ }
      }
      if (/\b(?:VERIFIED\s*:\s*NO|NOT\s+VERIFIED|verified["']?\s*:\s*false)\b/i.test(txt)) {
        return { verified: false, reason: txt.slice(0, 180), next_fix: 'Inspect the current screen & output logs, complete all unfinished steps, test it live, then verify.' };
      }
      return { verified: true, reason: txt.slice(0, 160), next_fix: '' };
    } catch (_) {
      return { verified: true };
    }
  }

  /**
   * Runs the full real multi-agent desktop pipeline (Strategist + Scout + Precision Executor + QA Verifier).
   */
  async runWork({ chatId, messages, task, attachments, webSearch, screenShare }) {
    if (this.running) throw new Error('An agent task is already running. Press Stop first.');
    this.running = true;
    this.stopped = false;
    this.abortController = new AbortController();
    this.screen.resetSession();

    const runId = ++this.runId;
    const settings = this.getSettings();
    const maxSteps = Math.max(1, Math.min(80, Number(settings.maxSteps) || 40));
    const agentModel = this.resolveModelForJob('agent');
    const fastModel = this.resolveModelForJob('fast');
    const screenModel = this.resolveModelForJob('screen');
    const plannerModel = this.resolveModelForJob('planner');

    if (!agentModel.id) {
      this.running = false;
      throw new Error('No Gemini model is selected or available on this API key. Open Settings → API Key & Models.');
    }

    const userOriginPos = (this.automation && typeof this.automation.position === 'function')
      ? await this.automation.position().catch(() => null)
      : null;
    let anyPointerMoved = false;

    const cuAvailable = screenModel.isComputerUse && screenModel.id !== agentModel.id;
    let usingDirectCu = agentModel.isComputerUse;
    const stepLog = [];
    let finalAnswer = '';
    let errorNote = null;

    this.setStatus({
      running: true,
      state: 'observing',
      mode: 'work',
      model: agentModel.id,
      step: 0,
      maxSteps,
      stepText: 'Scout Agent scanning screen & OCR text...'
    });
    this.emitLog({ kind: 'task', status: 'started', model: agentModel.id, tool: 'work_start', detail: task });

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

      const obsShotThumb = thumbOf(currentShotInit);
      this.emit('work-step', {
        runId,
        chatId,
        item: {
          step: 0,
          toolCallId: 'observe-init',
          running: true,
          model: agentModel.id,
          tool: 'observe_screen',
          description: screenShare && screenShare.enabled
            ? ('Third Eye looking at "' + (screenShare.name || 'screen') + '"…')
            : 'Looking at your screen & finding the target tab/app…',
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
          this.cursorEmitter({ kind: 'move', x: startMap.dip.x, y: startMap.dip.y, ms: 200, label: 'Working…' });
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

      let planText = '';
      if (settings.usePlanner && plannerModel.id && !/computer-use/i.test(plannerModel.id)) {
        let planSecs = 0;
        this.setStatus({ running: true, state: 'thinking', mode: 'work', model: plannerModel.id, step: 0, maxSteps, stepText: 'Planner Agent strategizing (' + plannerModel.id + ')...' });
        const planTimer = setInterval(() => {
          planSecs += 1;
          if (!this.stopped) this.setStatus({ running: true, state: 'thinking', mode: 'work', model: plannerModel.id, step: 0, maxSteps, stepText: `Planner Agent (${planSecs}s) with ${plannerModel.id}...` });
        }, 1000);
        try {
          const planPayload = {
            contents: [{
              role: 'user',
              parts: [
                {
                  text: 'You are Brief\'s Strategist/Planner Agent. Look closely at the task, current desktop screenshot, and Scout OCR/UI map below.\n' +
                    'Write a crisp, concrete execution & TEST plan (4-6 bullets) PLUS explicit VERIFICATION CRITERIA defining what MUST be visibly checked & tested before saying Done.\n' +
                    '- If coding/app: must actually run/execute tests, NOT just write or copy code.\n' +
                    '- If Roblox Studio: must build objects & ServerScript/LocalScript in Studio (via MCP or Command Bar), press Play/Run (F8/F5), and verify Output + motion.\n' +
                    '- If CapCut / desktop UI: must locate buttons via `click_text`/OCR, apply real timeline/keyframe changes, and verify visually.\n\n' +
                    'Task: ' + task + '\nOpen Windows: ' + (openWindows.slice(0, 10).map((w) => w.title).join(' | ') || 'none') +
                    '\nConnected MCP: ' + ((this.mcpManager ? this.mcpManager.list().filter((x) => x.status === 'connected').map((s) => s.name).join(', ') : '') || 'none') +
                    initUiMap
                },
                { inlineData: { mimeType: initVisionShot.mime, data: initVisionShot.base64 } }
              ]
            }],
            generationConfig: { maxOutputTokens: 450, temperature: 0.2 }
          };
          const planTCfg = buildThinkingConfig(plannerModel.id, settings.thinkingLevel || 'medium', this.getModels());
          if (planTCfg) planPayload.generationConfig.thinkingConfig = planTCfg;
          const planRes = await this.gemini.generate(plannerModel.id, planPayload, { signal: this.abortController.signal, retries: 1 });
          const pCand = (planRes.candidates || [])[0];
          planText = ((pCand && pCand.content && pCand.content.parts) || []).map((p) => p.text || '').join('').trim();
          if (planText) {
            this.emitLog({ kind: 'plan', status: 'ok', model: plannerModel.id, tool: 'planner', detail: planText });
            this.emit('work-plan', { runId, chatId, model: plannerModel.id, plan: planText });
          }
        } catch (planErr) {
          if (this.stopped || planErr.kind === 'aborted') throw abortError();
          this.emitLog({ kind: 'plan', status: 'warn', model: plannerModel.id, tool: 'planner', detail: 'Planner skipped: ' + planErr.message });
        } finally {
          clearInterval(planTimer);
        }
      }

      const webSearchBlock = (Array.isArray(initialWebHits) && initialWebHits.length)
        ? '\n\n[Live Web Search Results — use these facts accurately and stay strictly on the user\'s exact topic]:\n' +
          initialWebHits.map((h, i) => `${i + 1}. ${h.title} (${h.url})\n   ${h.snippet}`).join('\n')
        : '';

      const wantsLongPress = /\b(?:lo+ng[\s-]*press|hold[\s-]*(?:down|click|mouse|key|it|button|for)|press and hold|keep holding)\b/i.test(String(task || ''));
      const longPressHint = wantsLongPress
        ? '\n\n[LONG-PRESS / HOLD INSTRUCTION: The user explicitly wants a LONG PRESS / HOLD. Call `click({ x, y, hold_ms: 2500 })` or `mouse_button({ action: "long_press", x, y, duration_ms: 2500 })` or `click_element({ query, hold_ms: 2500 })` for mouse hold, or `hold_key({ key, action: "long_press", duration_ms: 2500 })` for keyboard hold — NEVER do a short quick tap!]'
        : '';

      const initialParts = [
        {
          text: task +
            longPressHint +
            webSearchBlock +
            (planText ? '\n\n[Suggested Plan]\n' + planText : '') +
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
      let zeroActionNudges = 0;
      let fallbackSwitches = 0;
      let verifyRejections = 0;
      let forceToolNextTurn = false;
      let mouseButtonHeld = false;
      let didHoldAction = false;

      for (let step = 1; step <= maxSteps; step++) {
        if (this.stopped) throw abortError();
        this.setStatus({
          running: true,
          state: 'thinking',
          mode: 'work',
          model: activeStepModel,
          step,
          maxSteps,
          stepText: `Step ${step}/${maxSteps} · Thinking with ${activeStepModel}...`
        });

        let json;
        let streamedAnyThought = false;
        let waitSecs = 0;
        let streamPhase = 'Thinking & Analyzing';
        let streamBytes = 0;
        const waitTicker = setInterval(() => {
          waitSecs += 1;
          if (!this.stopped) {
            const extra = streamBytes > 0 ? ` · ${(streamBytes / 1024).toFixed(1)} KB` : '';
            this.setStatus({
              running: true,
              state: 'thinking',
              mode: 'work',
              model: activeStepModel,
              step,
              maxSteps,
              stepText: `Step ${step}/${maxSteps} · ${streamPhase} (${waitSecs}s${extra}) with ${activeStepModel}...`
            });
            if (waitSecs % 2 === 1 && !mouseButtonHeld && this.getSettings().showOverlay !== false) {
              try {
                const { screen: elecScreen } = (process.versions && process.versions.electron) ? require('electron') : {};
                if (elecScreen && typeof elecScreen.getCursorScreenPoint === 'function') {
                  const pt = elecScreen.getCursorScreenPoint();
                  this.cursorEmitter({ kind: 'layer-only', x: pt.x, y: pt.y, label: `Step ${step} · ${streamPhase}` });
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
          const missingHold = wantsLongPress && !didHoldAction;
          if ((stepLog.length === 0 || missingHold) && zeroActionNudges < 2 && step < maxSteps) {
            zeroActionNudges += 1;
            forceToolNextTurn = !usingDirectCu;
            if (visibleText) this.emit('work-note', { runId, chatId, step, text: visibleText });
            contents.push({
              role: 'user',
              parts: [{ text: missingHold
                ? 'You have NOT executed a long-press or hold action yet! Do NOT finish with a quick tap — call `mouse_button({ action: "long_press", x, y, duration_ms: 2500 })`, `click({ x, y, hold_ms: 2500 })`, `click_element({ query, hold_ms: 2500 })`, or `hold_key({ key, action: "long_press", duration_ms: 2500 })` right now.'
                : 'You responded with text only and took ZERO desktop/file/tool actions. Do NOT just describe what you plan to do — call a real tool right now (such as open_app, click_text, click, write_file, list_directory, or run_command) to actually carry out the task on the computer.' }]
            });
            continue;
          }
          // QA Verifier Agent gate: reject premature "Done" claims unless the real screen/logs/tests prove it works!
          if (!usingDirectCu && verifyRejections < 3 && step < maxSteps && stepLog.length >= 1 && settings.verifyTaskBeforeFinish !== false) {
            this.setStatus({
              running: true,
              state: 'thinking',
              mode: 'work',
              model: activeStepModel,
              step,
              maxSteps,
              stepText: 'QA Verifier Agent testing & verifying real work...'
            });
            const verdict = await this.runTaskVerifierAgent({
              task,
              planText,
              stepLog,
              candidateAnswer: visibleText,
              currentShot,
              modelId: plannerModel.id || activeStepModel
            });
            if (verdict && verdict.verified === false) {
              verifyRejections += 1;
              forceToolNextTurn = true;
              const rejectMsg = '🛡️ QA Verifier Agent caught incomplete work: ' + (verdict.reason || 'Requirements not verified working yet.') + ' Continuing work & testing…';
              this.emitLog({ kind: 'verify', status: 'warn', model: plannerModel.id || activeStepModel, tool: 'qa_verifier', detail: verdict.reason || 'Rejected incomplete completion' });
              this.emit('work-note', { runId, chatId, step, text: rejectMsg });
              const [verifyVisionShot, verifyUiMap] = await Promise.all([
                shotForVision(currentShot, this.automation),
                describeForegroundElements(this.screen, this.automation)
              ]);
              contents.push({
                role: 'user',
                parts: [
                  {
                    text: '[QA Verifier Agent REJECTED your completion claim — DO NOT say it is ready yet!]\n' +
                      'Reason: ' + (verdict.reason || 'Not yet verified working.') + '\n' +
                      'Required next actions/tests: ' + (verdict.next_fix || 'Complete the remaining steps, run/play/test inside the real target app, and verify visually before finishing.') +
                      verifyUiMap
                  },
                  { inlineData: { mimeType: verifyVisionShot.mime, data: verifyVisionShot.base64 } }
                ]
              });
              continue;
            }
            if (verdict && verdict.reason) {
              this.emitLog({ kind: 'verify', status: 'ok', model: plannerModel.id || activeStepModel, tool: 'qa_verifier', detail: verdict.reason });
            }
          }
          finalAnswer = visibleText || 'Task completed.';
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

        // Attach the fresh gridded screenshot + any zoomed region close-ups + OCR/UI element map
        if (!usingDirectCu) {
          const [afterVisionShot, afterUiMap] = await Promise.all([
            shotForVision(currentShot, this.automation),
            describeForegroundElements(this.screen, this.automation)
          ]);
          responseParts.push({ text: `[Fresh desktop screenshot after step ${step} (with 0..1000 coordinate grid). Verify whether the action worked.]` + afterUiMap });
          responseParts.push({ inlineData: { mimeType: afterVisionShot.mime, data: afterVisionShot.base64 } });
          for (const ex of extraVisionImages.slice(-2)) {
            if (ex && ex.image && ex.image.base64) {
              responseParts.push({ text: `[Magnified Macro Zoom Crop for: ${ex.label}]` });
              responseParts.push({ inlineData: { mimeType: ex.image.mime || 'image/png', data: ex.image.base64 } });
            }
          }
        }
        contents.push({ role: 'user', parts: responseParts });
      }

      if (!finalAnswer) {
        // Optional fast-model final summary if max steps reached without a concluding message
        const summarizer = fastModel.id || activeStepModel;
        this.setStatus({ running: true, state: 'thinking', model: summarizer, stepText: 'Summarizing results...' });
        const sumRes = await this.gemini.generate(summarizer, {
          contents: [
            ...pruneHistoryScreenshots(contents, 1),
            { role: 'user', parts: [{ text: 'Reached the step limit. Summarize clearly and honestly what you completed, what you found, and anything still remaining.' }] }
          ]
        }, { signal: this.abortController.signal, retries: 1 }).catch(() => null);
        const sCand = sumRes && (sumRes.candidates || [])[0];
        finalAnswer = (sCand && sCand.content && sCand.content.parts.map((x) => x.text || '').join('\n').trim()) ||
          `Stopped after ${maxSteps} steps.`;
      }

      this.cursorEmitter({ kind: 'hide' });
      this.emitLog({ kind: 'task', status: 'ok', model: activeStepModel, tool: 'work_done', detail: `Finished in ${stepLog.length} step(s)` });
      this.setStatus({ running: false, state: 'idle', step: 0, stepText: 'Ready' });
      return { text: finalAnswer, steps: stepLog, model: activeStepModel };
    } catch (e) {
      this.cursorEmitter({ kind: 'hide' });
      if (this.stopped || e.kind === 'aborted' || e.name === 'AbortError') {
        this.emitLog({ kind: 'task', status: 'stopped', model: agentModel.id, tool: 'work_stop', detail: 'Stopped by user after ' + stepLog.length + ' step(s).' });
        this.setStatus({ running: false, state: 'stopped', stepText: 'Stopped by user' });
        return { text: 'Task stopped by user after ' + stepLog.length + ' step(s).', steps: stepLog, stopped: true, model: agentModel.id };
      }
      errorNote = e.message;
      this.emitLog({ kind: 'task', status: 'error', model: agentModel.id, tool: 'work_error', detail: e.message });
      this.setStatus({ running: false, state: 'error', stepText: e.message });
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

module.exports = { AgentRunner };
