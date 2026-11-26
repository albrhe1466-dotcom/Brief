'use strict';
/**
 * Locally - Gemini API client (REST, v1beta).
 * The API key is only ever sent to generativelanguage.googleapis.com in the x-goog-api-key header.
 * No other network endpoints are contacted by Locally.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const VERTEX_EXPRESS_BASE = 'https://aiplatform.googleapis.com/v1/publishers/google';

// Hardcoded allowlist: 5 active Gemini models shown to users (Argon replaced with Carbon).
const PRESETS = [
  {
    key: 'flashlite35',
    label: 'Gemini 3.5 Flash-Lite',
    hint: 'Fastest',
    desc: 'Fastest & lightest — quick, helpful answers and rapid fixes as fast as possible',
    match: (m) => /gemini-?3\.5-?flash-?lite/i.test(m.id) && isGeneral(m),
    base: 'gemini-3.5-flash-lite'
  },
  {
    key: 'flash38',
    label: 'Gemini 3.8 Flash',
    hint: 'Balanced',
    desc: 'Balanced — thinks carefully before starting, then helps cleanly',
    match: (m) => /gemini-?3\.8-?flash(?!-?lite)/i.test(m.id) && !/lite/i.test(m.id) && isGeneral(m),
    base: 'gemini-3.8-flash'
  },
  {
    key: 'hydrogen',
    label: 'Gemini 4 Hydrogen',
    hint: 'Balanced',
    desc: 'Balanced — thinks before starting and solves daily & multi-step tasks cleanly',
    match: (m) => /(hydrogen|gemini-?4(?:\.0)?(?!(?:.*argon|.*neon|.*carbon|.*pro|.*flash-lite)))/i.test(m.id + ' ' + m.displayName + ' ' + m.description) && !/(?:argon|neon|carbon)/i.test(m.id + ' ' + m.displayName) && isGeneral(m),
    base: 'gemini-4-hydrogen'
  },
  {
    key: 'neon',
    label: 'Gemini 4 Neon',
    hint: 'Strong',
    desc: 'Strong — analyzes, thinks, makes a clear plan, then executes & inspects deeply',
    match: (m) => /neon|gemini-?4(?:\.0)?-?neon/i.test(m.id + ' ' + m.displayName + ' ' + m.description) && isGeneral(m),
    base: 'gemini-4-neon'
  },
  {
    key: 'carbon',
    label: 'Gemini 4 Carbon',
    hint: 'Flagship',
    desc: 'Flagship — analyzes, critically thinks, executes, tests, reports issues & keeps fixing',
    match: (m) => /carbon|gemini-?4(?:\.0)?-?carbon/i.test(m.id + ' ' + m.displayName + ' ' + m.description) && isGeneral(m),
    base: 'gemini-4-carbon'
  }
];

function isGeneral(m) {
  return !/(image|tts|audio|live|embedding|aqa|imagen|veo|native-audio|computer-use|robotics)/i.test(m.id);
}

function stripModelPrefix(id) {
  const s = String(id || '').trim();
  if (s.startsWith('models/')) return s.slice(7);
  return s;
}

function modelPath(id) {
  const s = String(id || '').trim();
  if (s.startsWith('tunedModels/') || s.startsWith('models/')) return s;
  return 'models/' + s;
}

/**
 * Builds a real Gemini v1beta thinkingConfig block without mixing thinkingLevel and thinkingBudget.
 * Gemini 3 / 4 / Hydrogen / Argon use thinkingLevel ("LOW" | "MEDIUM" | "HIGH").
 * Gemini 2.5 uses thinkingBudget (1024 | 8192 | 24576).
 */
function buildThinkingConfig(modelId, level, modelsList) {
  const id = stripModelPrefix(modelId).toLowerCase();
  const norm = String(level || 'medium').toLowerCase().replace(/[\s_-]+/g, '_');
  const isExtra = norm === 'extra' || norm === 'extra_high';
  const isFlashLite = /flash-?lite/.test(id);
  const isFlash = !isFlashLite && /\bflash\b/.test(id);
  const tier = norm === 'low' ? 'LOW' : ((norm === 'high' || isExtra) ? 'HIGH' : 'MEDIUM');
  if (!id || /computer-use|image|tts|embedding|gemini-2\.0/.test(id)) return null;

  const meta = Array.isArray(modelsList) ? modelsList.find((m) => m.id.toLowerCase() === id) : null;
  if (meta && meta.thinking === false && !/pro|thinking|hydrogen|neon|carbon|gemini-3|gemini-4|gemini-2\.5/.test(id)) {
    return null;
  }

  if (/gemini-2\.5/.test(id)) {
    let budget;
    if (isFlashLite) {
      if (norm === 'low') return null;
      budget = isExtra ? 12288 : (norm === 'high' ? 4096 : 1024);
    } else if (isFlash) {
      budget = norm === 'low' ? 0 : (isExtra ? 16384 : (norm === 'high' ? 8192 : 2048));
    } else {
      budget = norm === 'low' ? 1024 : (isExtra ? 24576 : (norm === 'high' ? 16384 : 8192));
    }
    return { thinkingBudget: budget, includeThoughts: norm !== 'low' && budget > 0 };
  }
  if (/gemini-(3|4)|hydrogen|neon|carbon|thinking/.test(id) || (meta && meta.thinking)) {
    if (isFlashLite) {
      if (norm === 'low') return { thinkingLevel: 'MINIMAL', includeThoughts: false };
      if (norm === 'medium') return { thinkingLevel: 'LOW', includeThoughts: false };
      if (norm === 'high') return { thinkingLevel: 'MEDIUM', includeThoughts: true };
      return { thinkingLevel: 'HIGH', includeThoughts: true };
    }
    if (isFlash) {
      if (norm === 'low') return { thinkingLevel: 'LOW', includeThoughts: false };
      if (norm === 'medium') return { thinkingLevel: 'LOW', includeThoughts: true };
      if (norm === 'high') return { thinkingLevel: 'HIGH', includeThoughts: true };
      return { thinkingLevel: 'HIGH', includeThoughts: true };
    }
    return { thinkingLevel: tier, includeThoughts: norm !== 'low' };
  }
  return null;
}

function versionOf(id) {
  const m = /gemini-(\d+(?:\.\d+)?)/.exec(id);
  return m ? parseFloat(m[1]) : 0;
}

function rankCandidates(list, base) {
  return list.slice().sort((a, b) => score(b) - score(a) || b.id.localeCompare(a.id));
  function score(m) {
    let s = 0;
    if (base && m.id === base) s += 100;
    if (/latest/.test(m.id)) s += 30;
    if (!/preview/.test(m.id)) s += 20;
    if (!/exp/.test(m.id)) s += 10;
    if (!/customtools/i.test(m.id)) s += 40;
    s += versionOf(m.id);
    return s;
  }
}

function matchPresets(models) {
  const gen = models.filter((m) => m.methods.includes('generateContent'));
  const presets = {};
  for (const p of PRESETS) {
    const c = rankCandidates(gen.filter(p.match), p.base);
    presets[p.key] = {
      key: p.key,
      label: p.label,
      hint: p.hint,
      id: c.length ? c[0].id : null,
      displayName: c.length ? c[0].displayName : null,
      alternatives: c.slice(1, 6).map((x) => x.id),
      available: c.length > 0
    };
  }
  const cu = rankCandidates(gen.filter((m) => /computer-use/i.test(m.id)), '');
  const flashLite = gen.filter((m) => /^gemini-[\d.]+-flash-lite/.test(m.id) && isGeneral(m))
    .sort((a, b) => versionOf(b.id) - versionOf(a.id) || rankScoreStable(b) - rankScoreStable(a));
  const flash = gen.filter((m) => /^gemini-[\d.]+-flash(?!-lite)/.test(m.id) && isGeneral(m))
    .sort((a, b) => versionOf(b.id) - versionOf(a.id) || rankScoreStable(b) - rankScoreStable(a));
  const pro = gen.filter((m) => /^gemini-[\d.]+-pro/.test(m.id) && isGeneral(m))
    .sort((a, b) => versionOf(b.id) - versionOf(a.id) || rankScoreStable(b) - rankScoreStable(a));
  return {
    presets,
    computerUse: cu.length ? cu[0].id : null,
    computerUseAll: cu.map((m) => m.id),
    fast: (flashLite[0] || flash[0] || null) ? (flashLite[0] || flash[0]).id : null,
    bestFlash: flash[0] ? flash[0].id : null,
    bestPro: pro[0] ? pro[0].id : null
  };
}

function rankScoreStable(m) { return (/preview|exp/.test(m.id) ? 0 : 1); }

class ApiError extends Error {
  constructor(info) {
    super(info.message);
    this.kind = info.kind;
    this.status = info.status;
    this.apiStatus = info.apiStatus;
    this.retryAfterMs = info.retryAfterMs || 0;
  }
}

function classify(status, body, context) {
  const err = (body && body.error) || {};
  const msg = err.message || (typeof body === 'string' ? body : '') || ('HTTP ' + status);
  const apiStatus = err.status || '';
  const details = Array.isArray(err.details) ? err.details : [];
  const reasons = details.map((d) => d.reason || '').join(' ');
  let retryAfterMs = 0;
  for (const d of details) {
    if (d['@type'] && d['@type'].includes('RetryInfo') && d.retryDelay) {
      const s = parseFloat(String(d.retryDelay));
      if (!isNaN(s)) retryAfterMs = Math.round(s * 1000);
    }
  }
  // Parse human-readable retry durations directly from Google error text (e.g. "Please retry in 14.5s" or "14h53m47s")
  if (!retryAfterMs && msg) {
    const hms = /retry in\s+(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i.exec(msg);
    if (hms) {
      const hrs = parseInt(hms[1] || '0', 10) || 0;
      const mins = parseInt(hms[2] || '0', 10) || 0;
      const secs = parseFloat(hms[3] || '0') || 0;
      retryAfterMs = Math.round(((hrs * 3600) + (mins * 60) + secs) * 1000);
    }
  }
  let kind = 'error';
  if (status === 400 && (/API key not valid|API_KEY_INVALID/i.test(msg + reasons))) kind = 'invalid';
  else if (status === 400 && /API key expired|API_KEY_EXPIRED/i.test(msg + reasons)) kind = 'invalid';
  else if (status === 401) kind = 'invalid';
  else if (status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(msg + reasons)) kind = 'disabled';
  else if (status === 403 && context === 'list') kind = 'invalid';
  else if (status === 403) kind = 'noaccess';
  else if (status === 404) kind = 'noaccess';
  else if (status === 429) {
    // Distinguish permanent daily/zero-quota caps from temporary per-minute RPM/TPM limits (which recover after retryAfterMs).
    const isHardQuota = /limit:\s*0\b|per[\s_-]*day|PerDay|GenerateRequestsPerDay|generate_content_free_tier_requests|billing/i.test(msg)
      || retryAfterMs > 120000;
    kind = isHardQuota ? 'quota' : 'rate';
  }
  else if (status >= 500) kind = 'server';
  else if (status === 400) kind = 'bad_request';
  return new ApiError({ kind, status, apiStatus, message: msg, retryAfterMs });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(t); reject(abortError()); return; }
      signal.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
    }
  });
}

function abortError() { const e = new Error('Stopped by user.'); e.name = 'AbortError'; e.kind = 'aborted'; return e; }

function emptyUsage() { return { requests: 0, prompt: 0, output: 0, thoughts: 0, cached: 0, tool: 0, total: 0 }; }

let LIVE_GEMINI_34_MODELS = [];

function isModernGeminiModelId(id) {
  const clean = stripModelPrefix(id).toLowerCase();
  if (!clean) return false;
  if (/^gemini-(1|2)(?:\.|$|-)/.test(clean)) return false;
  if (/argon/.test(clean)) return false;
  if (/(image|tts|audio|live|embedding|aqa|imagen|veo|native-audio|robotics|bison|gecko|learnlm)/i.test(clean)) return false;
  return /^(gemini-(?:3|4|5)|.*hydrogen|.*neon|.*carbon)/.test(clean);
}

function resolveGeminiRuntimeCandidates(model) {
  const exact = stripModelPrefix(model);
  const id = exact.toLowerCase();
  const out = [];
  const push = (cand) => {
    const clean = stripModelPrefix(cand);
    if (clean && !out.includes(clean)) out.push(clean);
  };
  if (isModernGeminiModelId(exact) && !/^gemini-(?:1|2)(?:\.|$|-)/i.test(id)) {
    push(exact);
  }

  const live = Array.isArray(LIVE_GEMINI_34_MODELS) ? LIVE_GEMINI_34_MODELS : [];
  if (/3\.5.*flash.*lite|flash.*lite/.test(id)) {
    for (const m of live) if (/3\.5.*flash.*lite|3\.1.*flash.*lite/i.test(m)) push(m);
    push('gemini-3.5-flash-lite');
    push('gemini-3.1-flash-lite-preview');
    push('gemini-2.5-flash-lite');
    push('gemini-2.5-flash');
    return out;
  }
  if (/3\.8.*flash|\bflash\b/.test(id)) {
    for (const m of live) if (/(?:3\.8|3(?:\.0)?).*flash/i.test(m) && !/lite/i.test(m)) push(m);
    push('gemini-3.8-flash');
    push('gemini-3-flash-preview');
    push('gemini-2.5-flash');
    push('gemini-2.0-flash');
    return out;
  }
  if (/neon/.test(id)) {
    for (const m of live) if (/neon|3\.1-pro/i.test(m)) push(m);
    push('gemini-4-neon');
    push('gemini-3.1-pro-preview');
    push('gemini-2.5-pro');
    push('gemini-3-flash-preview');
    push('gemini-2.5-flash');
    push('gemini-2.0-flash');
    return out;
  }
  if (/hydrogen/.test(id)) {
    for (const m of live) if (/hydrogen|3-flash/i.test(m) && !/lite/i.test(m)) push(m);
    push('gemini-4-hydrogen');
    push('gemini-3-flash-preview');
    push('gemini-2.5-flash');
    push('gemini-2.0-flash');
    return out;
  }
  if (/carbon|argon|\bpro\b/.test(id)) {
    for (const m of live) if (/carbon|3\.1-pro/i.test(m)) push(m);
    push('gemini-4-carbon');
    push('gemini-3.1-pro-preview');
    push('gemini-2.5-pro');
    push('gemini-3-flash-preview');
    push('gemini-2.5-flash');
    push('gemini-2.0-flash');
    return out;
  }
  if (out.length) return out;
  push('gemini-4-hydrogen');
  push('gemini-3-flash-preview');
  push('gemini-2.5-flash');
  return out;
}

function ensureThoughtSignatures(payload, fillAllUnsigned = false) {
  if (!payload || !Array.isArray(payload.contents)) return payload;
  let dirty = false;
  for (const msg of payload.contents) {
    if (!msg || msg.role !== 'model' || !Array.isArray(msg.parts)) continue;
    const fcParts = msg.parts.filter((p) => p && p.functionCall);
    if (!fcParts.length) continue;
    const turnSigPart = msg.parts.find((p) => p && (p.thoughtSignature || p.thought_signature));
    const turnSig = turnSigPart ? (turnSigPart.thoughtSignature || turnSigPart.thought_signature) : '';
    const first = fcParts[0];
    if (!first.thoughtSignature && !first.thought_signature) {
      dirty = true;
    } else if (fillAllUnsigned && fcParts.some((p) => !p.thoughtSignature && !p.thought_signature)) {
      dirty = true;
    }
    if (!dirty && !turnSig) continue;
  }
  if (!dirty) return payload;
  const copy = JSON.parse(JSON.stringify(payload));
  for (const msg of copy.contents) {
    if (!msg || msg.role !== 'model' || !Array.isArray(msg.parts)) continue;
    const fcParts = msg.parts.filter((p) => p && p.functionCall);
    if (!fcParts.length) continue;
    const sigPart = msg.parts.find((p) => p && (p.thoughtSignature || p.thought_signature));
    const sig = sigPart ? (sigPart.thoughtSignature || sigPart.thought_signature) : '';
    if (!fcParts[0].thoughtSignature && !fcParts[0].thought_signature) {
      fcParts[0].thoughtSignature = sig || 'skip_thought_signature_validator';
    }
    if (fillAllUnsigned) {
      for (const fp of fcParts) {
        if (!fp.thoughtSignature && !fp.thought_signature) {
          fp.thoughtSignature = 'skip_thought_signature_validator';
        }
      }
    }
  }
  return copy;
}

function adaptGeminiPayloadForTarget(payload, targetId) {
  const sigSafe = ensureThoughtSignatures(payload, false);
  if (!sigSafe || !sigSafe.generationConfig || !sigSafe.generationConfig.thinkingConfig) return sigSafe;
  const tid = stripModelPrefix(targetId).toLowerCase();
  const tc = sigSafe.generationConfig.thinkingConfig;
  if (/gemini-2\.0/.test(tid)) {
    const copy = JSON.parse(JSON.stringify(sigSafe));
    delete copy.generationConfig.thinkingConfig;
    if (!Object.keys(copy.generationConfig).length) delete copy.generationConfig;
    return copy;
  }
  if (/gemini-2\.5/.test(tid) && tc.thinkingLevel) {
    const copy = JSON.parse(JSON.stringify(sigSafe));
    const lvl = String(tc.thinkingLevel || 'MEDIUM').toUpperCase();
    const isLite = /lite/.test(tid);
    let budget = 2048;
    if (lvl === 'MINIMAL' || lvl === 'LOW') budget = isLite ? 0 : 512;
    else if (lvl === 'HIGH') budget = isLite ? 4096 : 12288;
    if (budget <= 0) {
      delete copy.generationConfig.thinkingConfig;
      if (!Object.keys(copy.generationConfig).length) delete copy.generationConfig;
    } else {
      copy.generationConfig.thinkingConfig = {
        thinkingBudget: budget,
        includeThoughts: !!tc.includeThoughts
      };
    }
    return copy;
  }
  if (/gemini-(3|4)/.test(tid) && tc.thinkingBudget !== undefined && !tc.thinkingLevel) {
    const copy = JSON.parse(JSON.stringify(sigSafe));
    const b = Number(tc.thinkingBudget) || 0;
    copy.generationConfig.thinkingConfig = {
      thinkingLevel: b <= 512 ? 'LOW' : (b >= 8192 ? 'HIGH' : 'MEDIUM'),
      includeThoughts: !!tc.includeThoughts
    };
    return copy;
  }
  return sigSafe;
}

const GEMINI_ALLOWLIST = [
  { id: 'gemini-3.5-flash-lite', name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', description: 'Fastest — jumps right in and fixes issues as fast as possible', methods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536, thinking: true },
  { id: 'gemini-3.8-flash', name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', description: 'Balanced — analyzes the issue first, then fixes it cleanly', methods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536, thinking: true },
  { id: 'gemini-4-hydrogen', name: 'models/gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', description: 'Balanced — analyzes carefully first, then fixes daily & multi-step tasks', methods: ['generateContent'], inputTokenLimit: 2097152, outputTokenLimit: 65536, thinking: true },
  { id: 'gemini-4-neon', name: 'models/gemini-4-neon', displayName: 'Gemini 4 Neon', description: 'Strong (Newest) — goes deeper to inspect, scroll & solve root causes', methods: ['generateContent'], inputTokenLimit: 2097152, outputTokenLimit: 65536, thinking: true },
  { id: 'gemini-4-carbon', name: 'models/gemini-4-carbon', displayName: 'Gemini 4 Carbon', description: 'Strongest — goes the deepest of all for complex analysis & full fixes', methods: ['generateContent'], inputTokenLimit: 2097152, outputTokenLimit: 65536, thinking: true }
];

class GeminiClient {
  constructor(getKey) {
    this.getKey = getKey;
    this.usage = { startedAt: Date.now(), session: emptyUsage(), byModel: {} };
    this.listeners = new Set();
  }

  onUsage(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  recordUsage(model, meta) {
    if (!meta) return;
    const add = (u) => {
      u.requests += 1;
      u.prompt += meta.promptTokenCount || 0;
      u.output += meta.candidatesTokenCount || 0;
      u.thoughts += meta.thoughtsTokenCount || 0;
      u.cached += meta.cachedContentTokenCount || 0;
      u.tool += meta.toolUsePromptTokenCount || 0;
      u.total += meta.totalTokenCount || 0;
    };
    add(this.usage.session);
    const id = stripModelPrefix(model);
    if (!this.usage.byModel[id]) this.usage.byModel[id] = emptyUsage();
    add(this.usage.byModel[id]);
    for (const fn of this.listeners) { try { fn(this.usage); } catch (_) { /* ignore */ } }
  }

  resetUsage() {
    this.usage = { startedAt: Date.now(), session: emptyUsage(), byModel: {} };
    for (const fn of this.listeners) { try { fn(this.usage); } catch (_) { /* ignore */ } }
  }

  async raw(pathPart, { method = 'GET', body, signal, key, context, timeoutMs = 55000, baseUrl } = {}) {
    const apiKey = key || this.getKey();
    if (!apiKey) throw new ApiError({ kind: 'nokey', status: 0, message: 'No API key is saved. Open Settings → API key.' });
    const reqAc = new AbortController();
    let timedOut = false;
    const onParentAbort = () => reqAc.abort();
    if (signal) {
      if (signal.aborted) reqAc.abort();
      else signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      reqAc.abort();
    }, timeoutMs) : null;
    let res;
    try {
      const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
      if (String(pathPart || '').includes('alt=sse')) {
        headers.Accept = 'text/event-stream';
        headers['Cache-Control'] = 'no-cache';
      }
      res = await fetch((baseUrl || BASE) + '/' + pathPart, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: reqAc.signal
      });
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onParentAbort);
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onParentAbort);
      if (timedOut) {
        throw new ApiError({ kind: 'timeout', status: 408, message: 'Gemini request timed out after ' + Math.round(timeoutMs / 1000) + 's waiting for a response.' });
      }
      if (e && e.name === 'AbortError') throw abortError();
      throw new ApiError({ kind: 'network', status: 0, message: 'Could not reach generativelanguage.googleapis.com: ' + (e.cause && e.cause.code ? e.cause.code : e.message) });
    }
    if (!res.ok) {
      let parsed = null;
      const text = await res.text().catch(() => '');
      try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
      throw classify(res.status, parsed, context);
    }
    return res;
  }

  async listModels(key) {
    const out = GEMINI_ALLOWLIST.map((m) => Object.assign({}, m));
    const seen = new Set(out.map((m) => m.id));
    try {
      const discoveredIds = [];
      let pageToken = '';
      for (let page = 0; page < 4; page++) {
        const pathPart = pageToken
          ? ('models?pageSize=200&pageToken=' + encodeURIComponent(pageToken))
          : 'models?pageSize=200';
        const res = await this.raw(pathPart, { key, context: 'list' });
        const json = await res.json();
        const rawModels = (json && Array.isArray(json.models)) ? json.models : [];
        for (const rm of rawModels) {
          const id = stripModelPrefix(rm && rm.name);
          const methods = Array.isArray(rm && rm.supportedGenerationMethods) ? rm.supportedGenerationMethods : [];
          if (!id || !methods.includes('generateContent') || !isModernGeminiModelId(id)) continue;
          discoveredIds.push(id);
          if (!seen.has(id)) {
            seen.add(id);
            out.push({
              id,
              name: 'models/' + id,
              displayName: (rm && rm.displayName) || id,
              description: (rm && rm.description) || 'Active Gemini 3/4 model',
              methods: methods.slice(),
              inputTokenLimit: (rm && rm.inputTokenLimit) || 1048576,
              outputTokenLimit: (rm && rm.outputTokenLimit) || 65536,
              thinking: true
            });
          }
        }
        pageToken = (json && json.nextPageToken) || '';
        if (!pageToken) break;
      }
      if (discoveredIds.length) {
        LIVE_GEMINI_34_MODELS = discoveredIds;
      }
    } catch (e) {
      if (e.kind === 'invalid' || e.kind === 'disabled') throw e;
    }
    return out;
  }

  async generate(model, body, { signal, key, retries = 3, onRetry, timeoutMs = 60000 } = {}) {
    let attempt = 0;
    if (!this._good) this._good = new Map();
    if (!this._useVertexExpress) this._useVertexExpress = new Set();
    const apiKey = key || this.getKey();
    const isAqKey = /^AQ\./i.test(String(apiKey || '').trim());
    const _base = resolveGeminiRuntimeCandidates(model);
    const _g = this._good.get(model);
    const runtimeCands = _g && _base.includes(_g) ? [_g].concat(_base.filter((c) => c !== _g)) : _base;
    let candIdx = 0;
    let targetModel = runtimeCands[0];
    let payload = adaptGeminiPayloadForTarget(body, targetModel);
    let retriedThoughtSig = false;
    let triedVertexExpress = this._useVertexExpress.has(targetModel);
    for (;;) {
      const useVertex = isAqKey && this._useVertexExpress.has(targetModel);
      try {
        const res = await this.raw(modelPath(targetModel) + ':generateContent', {
          method: 'POST',
          body: payload,
          signal,
          key,
          context: 'generate',
          timeoutMs,
          baseUrl: useVertex ? VERTEX_EXPRESS_BASE : BASE
        });
        const json = await res.json();
        this.recordUsage(targetModel, json.usageMetadata);
        this._good.set(model, targetModel);
        return json;
      } catch (e) {
        if (e.kind === 'aborted' || e.name === 'AbortError') throw e;
        if (e.kind === 'bad_request' && /thought_signature|thoughtSignature/i.test(e.message || '') && !retriedThoughtSig) {
          retriedThoughtSig = true;
          payload = ensureThoughtSignatures(payload, true);
          continue;
        }
        // For AQ. Vertex Express keys, try the exact same model on Google's official Vertex Express endpoint if AI Studio returned 404/403/quota.
        if (isAqKey && !triedVertexExpress && ['noaccess', 'quota'].includes(e.kind)) {
          triedVertexExpress = true;
          try {
            const vRes = await this.raw(modelPath(targetModel) + ':generateContent', {
              method: 'POST',
              body: payload,
              signal,
              key,
              context: 'generate',
              timeoutMs,
              baseUrl: VERTEX_EXPRESS_BASE
            });
            const vJson = await vRes.json();
            this._useVertexExpress.add(targetModel);
            this.recordUsage(targetModel, vJson.usageMetadata);
            this._good.set(model, targetModel);
            return vJson;
          } catch (_) { /* keep original Google error */ }
        }
        const modelRetiredOrMissing = /no longer available|deprecated|retired|unknown model|not found|not supported for generateContent/i.test(e.message || '');
        const isCandUnavailableOrExhausted = e.kind === 'noaccess' || e.status === 404 || modelRetiredOrMissing || e.kind === 'quota' || e.kind === 'rate' || e.kind === 'server' || e.kind === 'timeout';
        if (isCandUnavailableOrExhausted && candIdx + 1 < runtimeCands.length) {
          candIdx += 1;
          targetModel = runtimeCands[candIdx];
          payload = adaptGeminiPayloadForTarget(body, targetModel);
          continue;
        }
        // If a model rejects MINIMAL thinkingLevel, fall back to LOW first; otherwise strip thinkingConfig cleanly.
        if (e.kind === 'bad_request' && payload && payload.generationConfig && payload.generationConfig.thinkingConfig && /thinking|includeThoughts|not supported|budget|level|minimal/i.test(e.message)) {
          payload = JSON.parse(JSON.stringify(payload));
          if (payload.generationConfig.thinkingConfig.thinkingLevel === 'MINIMAL') {
            payload.generationConfig.thinkingConfig.thinkingLevel = 'LOW';
          } else {
            delete payload.generationConfig.thinkingConfig;
            if (!Object.keys(payload.generationConfig).length) delete payload.generationConfig;
          }
          continue;
        }
        const retriable = ['rate', 'server', 'network', 'timeout'].includes(e.kind) || (e.kind === 'quota' && e.retryAfterMs > 0 && e.retryAfterMs <= 65000);
        if (!retriable || attempt >= retries) throw e;
        attempt += 1;
        const wait = Math.min(62000, e.retryAfterMs || (2000 * Math.pow(2, attempt - 1)));
        if (onRetry) onRetry({ attempt, wait, error: e.message, kind: e.kind });
        await sleep(wait, signal);
      }
    }
  }

  /** Streams a response with Server-Sent Events. Calls onText(delta, fullText) as text arrives. */
  async stream(model, body, { signal, onText, onThought, onActivity, chunkTimeoutMs = 55000, timeoutMs = 55000, retries = 4, onRetry } = {}) {
    let attempt = 0;
    if (!this._good) this._good = new Map();
    if (!this._useVertexExpress) this._useVertexExpress = new Set();
    const apiKey = this.getKey();
    const isAqKey = /^AQ\./i.test(String(apiKey || '').trim());
    const _base = resolveGeminiRuntimeCandidates(model);
    const _g = this._good.get(model);
    const runtimeCands = _g && _base.includes(_g) ? [_g].concat(_base.filter((c) => c !== _g)) : _base;
    let candIdx = 0;
    let targetModel = runtimeCands[0];
    let payload = adaptGeminiPayloadForTarget(body, targetModel);
    let retriedThoughtSig = false;
    let triedVertexExpress = this._useVertexExpress.has(targetModel);
    let res;
    for (;;) {
      const useVertex = isAqKey && this._useVertexExpress.has(targetModel);
      try {
        res = await this.raw(modelPath(targetModel) + ':streamGenerateContent?alt=sse', {
          method: 'POST',
          body: payload,
          signal,
          context: 'generate',
          timeoutMs,
          baseUrl: useVertex ? VERTEX_EXPRESS_BASE : BASE
        });
        this._good.set(model, targetModel);
        break;
      } catch (e) {
        if (e.kind === 'aborted' || e.name === 'AbortError') throw e;
        if (e.kind === 'bad_request' && /thought_signature|thoughtSignature/i.test(e.message || '') && !retriedThoughtSig) {
          retriedThoughtSig = true;
          payload = ensureThoughtSignatures(payload, true);
          continue;
        }
        if (isAqKey && !triedVertexExpress && ['noaccess', 'quota'].includes(e.kind)) {
          triedVertexExpress = true;
          try {
            res = await this.raw(modelPath(targetModel) + ':streamGenerateContent?alt=sse', {
              method: 'POST',
              body: payload,
              signal,
              context: 'generate',
              timeoutMs,
              baseUrl: VERTEX_EXPRESS_BASE
            });
            this._useVertexExpress.add(targetModel);
            this._good.set(model, targetModel);
            break;
          } catch (_) { /* keep original Google error */ }
        }
        const modelRetiredOrMissing = /no longer available|deprecated|retired|unknown model|not found|not supported for generateContent/i.test(e.message || '');
        const isCandUnavailableOrExhausted = e.kind === 'noaccess' || e.status === 404 || modelRetiredOrMissing || e.kind === 'quota' || e.kind === 'rate' || e.kind === 'server' || e.kind === 'timeout';
        if (isCandUnavailableOrExhausted && candIdx + 1 < runtimeCands.length) {
          candIdx += 1;
          targetModel = runtimeCands[candIdx];
          payload = adaptGeminiPayloadForTarget(body, targetModel);
          continue;
        }
        if (e.kind === 'bad_request' && payload && payload.generationConfig && payload.generationConfig.thinkingConfig && /thinking|includeThoughts|not supported|budget|level|minimal/i.test(e.message)) {
          payload = JSON.parse(JSON.stringify(payload));
          if (payload.generationConfig.thinkingConfig.thinkingLevel === 'MINIMAL') {
            payload.generationConfig.thinkingConfig.thinkingLevel = 'LOW';
          } else {
            delete payload.generationConfig.thinkingConfig;
            if (!Object.keys(payload.generationConfig).length) delete payload.generationConfig;
          }
          continue;
        }
        const retriable = ['rate', 'server', 'network', 'timeout'].includes(e.kind) || (e.kind === 'quota' && e.retryAfterMs > 0 && e.retryAfterMs <= 65000);
        if (!retriable || attempt >= retries) throw e;
        attempt += 1;
        const wait = Math.min(62000, e.retryAfterMs || (2000 * attempt));
        if (onRetry) onRetry({ attempt, wait, error: e.message, kind: e.kind });
        await sleep(wait, signal);
      }
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let full = '';
    let thoughtFull = '';
    const candParts = [];
    let usage = null;
    let finishReason = '';
    let blocked = '';
    let totalBytes = 0;
    const readWithTimeout = () => {
      if (signal && signal.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          reader.cancel().catch(() => {});
          reject(abortError());
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        if (chunkTimeoutMs > 0) {
          timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            if (signal) signal.removeEventListener('abort', onAbort);
            reader.cancel().catch(() => {});
            reject(new ApiError({ kind: 'timeout', status: 408, message: 'Gemini stream stalled for ' + Math.round(chunkTimeoutMs / 1000) + 's without incoming data.' }));
          }, chunkTimeoutMs);
        }
        reader.read().then((chunk) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(chunk);
        }, (err) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        });
      });
    };
    const handle = (chunkStr) => {
      let json;
      try { json = JSON.parse(chunkStr); } catch (_) { return; }
      if (json.promptFeedback && json.promptFeedback.blockReason) blocked = json.promptFeedback.blockReason;
      if (json.usageMetadata) usage = json.usageMetadata;
      const cand = (json.candidates || [])[0];
      if (!cand) return;
      if (cand.finishReason) finishReason = cand.finishReason;
      const parts = (cand.content && cand.content.parts) || [];
      for (const p of parts) {
        const sig = p.thoughtSignature || p.thought_signature;
        const prev = candParts[candParts.length - 1];
        if (typeof p.text === 'string') {
          if (p.thought) {
            thoughtFull += p.text;
            if (onThought && p.text) onThought(p.text, thoughtFull);
          } else {
            full += p.text;
            if (onText && p.text) onText(p.text, full);
          }
          if (sig && !p.text && prev && prev.functionCall && !prev.thoughtSignature && !prev.thought_signature) {
            prev.thoughtSignature = sig;
          } else if (prev && typeof prev.text === 'string' && !!prev.thought === !!p.thought && !prev.functionCall && !prev.thoughtSignature && !prev.thought_signature) {
            prev.text += p.text;
            if (sig) prev.thoughtSignature = sig;
          } else {
            candParts.push(Object.assign({}, p));
          }
        } else {
          if (sig && !p.functionCall && prev && prev.functionCall && !prev.thoughtSignature && !prev.thought_signature) {
            prev.thoughtSignature = sig;
          } else {
            candParts.push(JSON.parse(JSON.stringify(p)));
          }
        }
      }
    };
    try {
      for (;;) {
        const { done, value } = await readWithTimeout();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength || value.length || 0;
        }
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (line.startsWith('data:')) handle(line.slice(5).trim());
        }
        if (onActivity && totalBytes > 0) {
          onActivity({ bytes: totalBytes, parts: candParts.length, thoughtChars: thoughtFull.length, textChars: full.length });
        }
      }
      if (buf.startsWith('data:')) handle(buf.slice(5).trim());
    } catch (e) {
      if (e && e.kind) throw e;
      if (e && e.name === 'AbortError') throw abortError();
      throw e;
    }
    this.recordUsage(model, usage);
    return {
      text: full,
      thought: thoughtFull,
      parts: candParts,
      candidates: candParts.length ? [{ content: { role: 'model', parts: candParts }, finishReason }] : [],
      promptFeedback: blocked ? { blockReason: blocked } : undefined,
      usage,
      usageMetadata: usage,
      finishReason,
      blocked
    };
  }

  /**
   * Validates a key: 1) list models, 2) send a tiny real request to the chosen model.
   * Returns a structured, honest result for the UI.
   */
  async validate(key, preferredModel) {
    const result = { status: 'unknown', icon: '', title: '', message: '', models: [], match: null, testModel: null, usage: null, steps: [] };
    let models;
    try {
      models = await this.listModels(key);
      result.steps.push({ step: 'list-models', ok: true, detail: models.length + ' models visible to this key' });
    } catch (e) {
      result.steps.push({ step: 'list-models', ok: false, detail: e.message });
      return Object.assign(result, describeFailure(e, true));
    }
    result.models = models;
    result.match = matchPresets(models);
    const gen = models.filter((m) => m.methods.includes('generateContent'));
    const genIds = new Set(gen.map((m) => m.id));

    const candidates = [];
    const pushCand = (id) => {
      const clean = stripModelPrefix(id || '');
      if (clean && genIds.has(clean) && !candidates.includes(clean)) candidates.push(clean);
    };
    const pref = stripModelPrefix(preferredModel || '');
    if (pref && pref !== 'auto' && genIds.has(pref)) pushCand(pref);
    for (const m of gen) pushCand(m.id);

    if (!candidates.length) {
      return Object.assign(result, { status: 'noaccess', icon: '❌', title: 'No access to allowlisted models', message: 'No allowlisted Gemini models available.' });
    }

    let lastErr = null;
    for (const test of candidates.slice(0, 8)) {
      result.testModel = test;
      try {
        const body = {
          contents: [{ role: 'user', parts: [{ text: 'Reply with exactly one word: OK' }] }],
          generationConfig: { maxOutputTokens: 64, temperature: 0 }
        };
        if (/computer-use/i.test(test)) {
          body.tools = [{ computerUse: { environment: 'ENVIRONMENT_BROWSER' } }];
        }
        const json = await this.generate(test, body, { key, retries: 0, timeoutMs: 12000 });
        result.usage = json.usageMetadata || null;
        result.steps.push({ step: 'test-request', ok: true, detail: test + ' answered (' + ((json.usageMetadata && json.usageMetadata.totalTokenCount) || 0) + ' tokens)' });
        return Object.assign(result, {
          status: 'valid',
          icon: '✅',
          title: 'Real & Ready',
          message: 'API key verified and ready! ' + models.length + ' models listed, and a live test to ' + test + ' succeeded.'
        });
      } catch (e) {
        lastErr = e;
        result.steps.push({ step: 'test-request (' + test + ')', ok: false, detail: e.message });
        if (e.kind === 'invalid' || e.kind === 'disabled' || e.kind === 'nokey') {
          return Object.assign(result, describeFailure(e, false, test));
        }
      }
    }
    if (lastErr && (lastErr.kind === 'server' || lastErr.kind === 'timeout' || /high demand|overloaded|temporarily/i.test(lastErr.message || ''))) {
      return Object.assign(result, {
        status: 'rate',
        icon: '⚠️',
        title: 'Key Real & Saved (Model Busy)',
        message: 'Key accepted (' + models.length + ' models loaded). Temporary demand spike on tested models: ' + lastErr.message
      });
    }
    return Object.assign(result, describeFailure(lastErr, false, result.testModel));
  }
}

function describeFailure(e, duringList, model) {
  switch (e.kind) {
    case 'invalid':
      return { status: 'invalid', icon: '❌', title: 'Invalid key', message: e.message };
    case 'disabled':
      return { status: 'invalid', icon: '❌', title: 'Invalid key', message: 'The Generative Language API is disabled for this key\'s Google Cloud project. ' + e.message };
    case 'rate':
      return { status: 'rate', icon: '⚠️', title: 'Rate-limited', message: 'Google returned 429 (too many requests). Wait a moment and try again. ' + e.message };
    case 'quota':
      return { status: 'rate', icon: '⚠️', title: 'Quota exceeded', message: 'Google returned 429 RESOURCE_EXHAUSTED: the quota for this key/model is used up. ' + e.message };
    case 'noaccess':
      return { status: 'noaccess', icon: '❌', title: 'No access to this model', message: (model ? model + ': ' : '') + e.message };
    case 'network':
      return { status: 'network', icon: '⚠️', title: 'Network problem', message: e.message };
    default:
      return { status: duringList ? 'invalid' : 'error', icon: '❌', title: duringList ? 'Invalid key' : 'Test request failed', message: e.message };
  }
}

module.exports = { GeminiClient, matchPresets, PRESETS, stripModelPrefix, modelPath, buildThinkingConfig, adaptGeminiPayloadForTarget, ensureThoughtSignatures, resolveGeminiRuntimeCandidates, isModernGeminiModelId, ApiError, abortError, sleep };
