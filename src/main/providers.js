'use strict';
/**
 * Locally — Real Multi-Provider AI Client & Router (Google Gemini, OpenAI, Anthropic Claude).
 * Detects provider automatically from the user's real API key prefix, talks directly to each
 * official endpoint (zero proxies, zero telemetry), and normalizes streaming + tool calls so
 * Work mode (desktop control, 4K screenshots, MCP, cursor) runs identically across all providers.
 */
const { GeminiClient, PRESETS: GEMINI_PRESETS, matchPresets: matchGeminiPresets, stripModelPrefix, ApiError, abortError } = require('./gemini');

const OPENAI_PRESETS = [
  {
    key: 'openai_auto',
    label: 'Auto',
    hint: 'Smart',
    match: (m) => m.id === 'auto' || /gpt-?6|gpt-?5|gpt-?4/i.test(m.id),
    base: 'auto'
  },
  {
    key: 'gpt6luna',
    label: 'GPT-6 Luna',
    hint: 'Fastest',
    match: (m) => /gpt-?6-?luna/i.test(m.id),
    base: 'gpt-6-luna'
  },
  {
    key: 'gpt61terra',
    label: 'GPT-6.1 Terra',
    hint: 'Balanced',
    match: (m) => /gpt-?6(?:\.1)?-?terra/i.test(m.id),
    base: 'gpt-6.1-terra'
  },
  {
    key: 'gpt6sol',
    label: 'GPT-6.2 Sol',
    hint: 'Strong',
    match: (m) => /gpt-?6(?:\.2)?-?sol/i.test(m.id),
    base: 'gpt-6-sol'
  },
  {
    key: 'gpt62astra',
    label: 'GPT-6.2 Astra',
    hint: 'Flagship',
    match: (m) => /gpt-?6(?:\.2)?-?astra/i.test(m.id),
    base: 'gpt-6.2-astra'
  }
];

const ANTHROPIC_PRESETS = [
  {
    key: 'claudehaiku55',
    label: 'Claude Haiku 5.5',
    hint: 'Fastest',
    match: (m) => /claude-?(?:haiku-?5\.5|5\.5-?haiku|haiku-?5-5|5-5-?haiku)/i.test(m.id + ' ' + (m.displayName || '')),
    base: 'claude-haiku-5-5'
  },
  {
    key: 'claudesonnet55',
    label: 'Claude Sonnet 5.5',
    hint: 'Balanced',
    match: (m) => /claude-?(?:sonnet-?5\.5|5\.5-?sonnet|sonnet-?5-5|5-5-?sonnet)/i.test(m.id + ' ' + (m.displayName || '')),
    base: 'claude-sonnet-5-5'
  },
  {
    key: 'claudeopus55',
    label: 'Claude Opus 5.5',
    hint: 'Strong',
    match: (m) => /claude-?(?:opus-?5\.5|5\.5-?opus|opus-?5-5|5-5-?opus)/i.test(m.id + ' ' + (m.displayName || '')),
    base: 'claude-opus-5-5'
  },
  {
    key: 'claudefable52',
    label: 'Claude Fable 5.2',
    hint: 'Reasoning',
    match: (m) => /fable-?5(?:\.|-)2/i.test(m.id + ' ' + (m.displayName || '')),
    base: 'claude-fable-5-2'
  }
];

// Hardcoded allowlist: active flagship models accessible via OpenRouter
const OPENROUTER_PRESETS = [
  // Gemini via OpenRouter
  { key: 'or_flashlite35', label: 'Gemini 3.5 Flash-Lite', hint: 'Fastest',  base: 'google/gemini-3.5-flash-lite' },
  { key: 'or_flash38',     label: 'Gemini 3.8 Flash',      hint: 'Balanced', base: 'google/gemini-3.8-flash' },
  { key: 'or_hydrogen',    label: 'Gemini 4 Hydrogen',     hint: 'Balanced', base: 'google/gemini-4-hydrogen' },
  { key: 'or_neon',        label: 'Gemini 4 Neon',         hint: 'Strong',    base: 'google/gemini-4-neon' },
  { key: 'or_carbon',      label: 'Gemini 4 Carbon',       hint: 'Flagship',  base: 'google/gemini-4-carbon' },
  // OpenAI via OpenRouter
  { key: 'or_gpt6luna',    label: 'GPT-6 Luna',            hint: 'Fastest',   base: 'openai/gpt-6-luna' },
  { key: 'or_gpt61terra',  label: 'GPT-6.1 Terra',         hint: 'Balanced',  base: 'openai/gpt-6.1-terra' },
  { key: 'or_gpt6sol',     label: 'GPT-6 Sol',             hint: 'Strong',    base: 'openai/gpt-6-sol' },
  { key: 'or_gpt62astra',  label: 'GPT-6.2 Astra',         hint: 'Flagship',  base: 'openai/gpt-6.2-astra' },
  // Claude via OpenRouter
  { key: 'or_haiku55',     label: 'Claude Haiku 5.5',      hint: 'Fastest',  base: 'anthropic/claude-haiku-5-5' },
  { key: 'or_sonnet55',    label: 'Claude Sonnet 5.5',     hint: 'Balanced', base: 'anthropic/claude-sonnet-5-5' },
  { key: 'or_opus55',      label: 'Claude Opus 5.5',       hint: 'Strong',   base: 'anthropic/claude-opus-5-5' },
  { key: 'or_fable52',     label: 'Claude Fable 5.2',      hint: 'Reasoning',base: 'anthropic/claude-fable-5-2' }
];

const OPENAI_ALLOWLIST = [
  { id: 'auto', name: 'models/auto', displayName: 'Auto', description: 'Automatically selects speed vs. deep reasoning by prompt complexity', methods: ['generateContent'], inputTokenLimit: 128000, outputTokenLimit: 16384, thinking: true },
  { id: 'gpt-6-luna', name: 'models/gpt-6-luna', displayName: 'GPT-6 Luna', description: 'Fastest', methods: ['generateContent'], inputTokenLimit: 128000, outputTokenLimit: 16384, thinking: true },
  { id: 'gpt-6.1-terra', name: 'models/gpt-6.1-terra', displayName: 'GPT-6.1 Terra', description: 'Balanced', methods: ['generateContent'], inputTokenLimit: 128000, outputTokenLimit: 16384, thinking: true },
  { id: 'gpt-6-sol', name: 'models/gpt-6-sol', displayName: 'GPT-6.2 Sol', description: 'Strong', methods: ['generateContent'], inputTokenLimit: 128000, outputTokenLimit: 16384, thinking: true },
  { id: 'gpt-6.2-astra', name: 'models/gpt-6.2-astra', displayName: 'GPT-6.2 Astra', description: 'Flagship', methods: ['generateContent'], inputTokenLimit: 1050000, outputTokenLimit: 128000, thinking: true }
];

const ANTHROPIC_ALLOWLIST = [
  { id: 'claude-haiku-5-5', name: 'models/claude-haiku-5-5', displayName: 'Claude Haiku 5.5', description: 'Fastest', methods: ['generateContent'], inputTokenLimit: 200000, outputTokenLimit: 8192, thinking: false },
  { id: 'claude-sonnet-5-5', name: 'models/claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', description: 'Balanced', methods: ['generateContent'], inputTokenLimit: 200000, outputTokenLimit: 8192, thinking: true },
  { id: 'claude-opus-5-5', name: 'models/claude-opus-5-5', displayName: 'Claude Opus 5.5', description: 'Strong', methods: ['generateContent'], inputTokenLimit: 200000, outputTokenLimit: 8192, thinking: true },
  { id: 'claude-fable-5-2', name: 'models/claude-fable-5-2', displayName: 'Claude Fable 5.2', description: 'Reasoning', methods: ['generateContent'], inputTokenLimit: 200000, outputTokenLimit: 8192, thinking: true }
];

const OPENROUTER_ALLOWLIST = [
  // Gemini
  { id: 'google/gemini-3.5-flash-lite', name: 'models/google/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', description: 'Fastest', methods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536, thinking: true },
  { id: 'google/gemini-3.8-flash', name: 'models/google/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', description: 'Balanced', methods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536, thinking: true },
  { id: 'google/gemini-4-hydrogen', name: 'models/google/gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', description: 'Balanced', methods: ['generateContent'], inputTokenLimit: 2097152, outputTokenLimit: 65536, thinking: true },
  { id: 'google/gemini-4-neon', name: 'models/google/gemini-4-neon', displayName: 'Gemini 4 Neon', description: 'Strong', methods: ['generateContent'], inputTokenLimit: 2097152, outputTokenLimit: 65536, thinking: true },
  { id: 'google/gemini-4-carbon', name: 'models/google/gemini-4-carbon', displayName: 'Gemini 4 Carbon', description: 'Strongest', methods: ['generateContent'], inputTokenLimit: 2097152, outputTokenLimit: 65536, thinking: true },
  // OpenAI
  { id: 'openai/gpt-6-luna', name: 'models/openai/gpt-6-luna', displayName: 'GPT-6 Luna', description: 'Fastest', methods: ['generateContent'], inputTokenLimit: 128000, outputTokenLimit: 16384, thinking: true },
  { id: 'openai/gpt-6.1-terra', name: 'models/openai/gpt-6.1-terra', displayName: 'GPT-6.1 Terra', description: 'Balanced', methods: ['generateContent'], inputTokenLimit: 128000, outputTokenLimit: 16384, thinking: true },
  { id: 'openai/gpt-6-sol', name: 'models/openai/gpt-6-sol', displayName: 'GPT-6 Sol', description: 'Strong', methods: ['generateContent'], inputTokenLimit: 128000, outputTokenLimit: 16384, thinking: true },
  { id: 'openai/gpt-6.2-astra', name: 'models/openai/gpt-6.2-astra', displayName: 'GPT-6.2 Astra', description: 'Strongest', methods: ['generateContent'], inputTokenLimit: 1050000, outputTokenLimit: 128000, thinking: true },
  // Claude
  { id: 'anthropic/claude-haiku-5-5', name: 'models/anthropic/claude-haiku-5-5', displayName: 'Claude Haiku 5.5', description: 'Fastest', methods: ['generateContent'], inputTokenLimit: 200000, outputTokenLimit: 8192, thinking: false },
  { id: 'anthropic/claude-sonnet-5-5', name: 'models/anthropic/claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', description: 'Balanced', methods: ['generateContent'], inputTokenLimit: 200000, outputTokenLimit: 8192, thinking: true },
  { id: 'anthropic/claude-opus-5-5', name: 'models/anthropic/claude-opus-5-5', displayName: 'Claude Opus 5.5', description: 'Strong', methods: ['generateContent'], inputTokenLimit: 200000, outputTokenLimit: 8192, thinking: true },
  { id: 'anthropic/claude-fable-5-2', name: 'models/anthropic/claude-fable-5-2', displayName: 'Claude Fable 5.2', description: 'Reasoning', methods: ['generateContent'], inputTokenLimit: 200000, outputTokenLimit: 8192, thinking: true }
];

function detectKeyProvider(key) {
  const k = String(key || '').trim();
  if (!k) return 'gemini';
  if (/^sk-or-/i.test(k)) return 'openrouter';
  if (/^sk-ant-/i.test(k)) return 'anthropic';
  if (/^sk-/i.test(k)) return 'openai';
  if (/^(?:AIza|AQ\.)/i.test(k)) return 'gemini';
  return 'gemini';
}

function providerMeta(provider) {
  if (provider === 'openai') {
    return {
      id: 'openai',
      name: 'OpenAI',
      logo: 'assets/openai-logo.png',
      endpoint: 'api.openai.com',
      presets: OPENAI_PRESETS.map((p) => ({ key: p.key, label: p.label, hint: p.hint }))
    };
  }
  if (provider === 'anthropic') {
    return {
      id: 'anthropic',
      name: 'Claude',
      logo: 'assets/claude-logo.png',
      endpoint: 'api.anthropic.com',
      presets: ANTHROPIC_PRESETS.map((p) => ({ key: p.key, label: p.label, hint: p.hint }))
    };
  }
  if (provider === 'openrouter') {
    return {
      id: 'openrouter',
      name: 'OpenRouter',
      logo: 'assets/openrouter-logo.png',
      endpoint: 'openrouter.ai',
      presets: OPENROUTER_PRESETS.map((p) => ({ key: p.key, label: p.label, hint: p.hint }))
    };
  }
  return {
    id: 'gemini',
    name: 'Gemini',
    logo: 'assets/logo.png',
    endpoint: 'generativelanguage.googleapis.com',
    presets: GEMINI_PRESETS.map((p) => ({ key: p.key, label: p.label, hint: p.hint }))
  };
}

function matchPresetsForProvider(provider, models) {
  const list = Array.isArray(models) ? models : [];
  if (provider === 'openai') {
    const presets = {
      openai_auto: { key: 'openai_auto', label: 'Auto', hint: 'Smart', id: 'auto', displayName: 'Auto', alternatives: [], available: true },
      gpt6luna: { key: 'gpt6luna', label: 'GPT-6 Luna', hint: 'Fastest', id: 'gpt-6-luna', displayName: 'GPT-6 Luna', alternatives: [], available: true },
      gpt61terra: { key: 'gpt61terra', label: 'GPT-6.1 Terra', hint: 'Balanced', id: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', alternatives: [], available: true },
      gpt6sol: { key: 'gpt6sol', label: 'GPT-6.2 Sol', hint: 'Strong', id: 'gpt-6-sol', displayName: 'GPT-6.2 Sol', alternatives: [], available: true },
      gpt62astra: { key: 'gpt62astra', label: 'GPT-6.2 Astra', hint: 'Flagship', id: 'gpt-6.2-astra', displayName: 'GPT-6.2 Astra', alternatives: [], available: true }
    };
    return {
      provider: 'openai',
      presets,
      computerUse: null,
      computerUseAll: [],
      fast: 'gpt-6-luna',
      bestFlash: 'gpt-6.1-terra',
      bestPro: 'gpt-6.2-astra'
    };
  }

  if (provider === 'anthropic') {
    const presets = {};
    for (const p of ANTHROPIC_PRESETS) {
      const hits = list.filter(p.match);
      presets[p.key] = {
        key: p.key,
        label: p.label,
        hint: p.hint,
        id: hits.length ? hits[0].id : null,
        displayName: hits.length ? hits[0].displayName : null,
        alternatives: hits.slice(1, 5).map((x) => x.id),
        available: hits.length > 0
      };
    }
    const gen = list.filter((m) => m.methods && m.methods.includes('generateContent'));
    const haiku = gen.find((m) => /haiku/i.test(m.id));
    const sonnet = gen.find((m) => /sonnet/i.test(m.id));
    const opus = gen.find((m) => /opus/i.test(m.id));
    return {
      provider: 'anthropic',
      presets,
      computerUse: null,
      computerUseAll: [],
      fast: (haiku && haiku.id) || (gen[0] && gen[0].id) || null,
      bestFlash: (sonnet && sonnet.id) || (gen[0] && gen[0].id) || null,
      bestPro: (opus && opus.id) || (sonnet && sonnet.id) || (gen[0] && gen[0].id) || null
    };
  }

  // OpenRouter uses hardcoded preset IDs — no live model list needed.
  if (provider === 'openrouter') {
    const presets = {};
    for (const p of OPENROUTER_PRESETS) {
      presets[p.key] = {
        key: p.key, label: p.label, hint: p.hint,
        id: p.base, displayName: p.label,
        alternatives: [], available: true
      };
    }
    return {
      provider: 'openrouter', presets,
      computerUse: null, computerUseAll: [],
      fast: OPENROUTER_PRESETS[0].base,
      bestFlash: OPENROUTER_PRESETS[1].base,
      bestPro: OPENROUTER_PRESETS[3].base
    };
  }
  return Object.assign({ provider: 'gemini' }, matchGeminiPresets(list));
}

function classifyHttpError(provider, status, parsed) {
  const msg = (parsed && parsed.error && parsed.error.message) ||
    (typeof parsed === 'string' ? parsed : '') ||
    ('HTTP ' + status);
  let kind = 'error';
  if (status === 401 || /invalid.*api.?key|incorrect api key|authentication_error/i.test(msg)) kind = 'invalid';
  else if (status === 403) kind = 'noaccess';
  else if (status === 404 || /model_not_found|does not exist/i.test(msg)) kind = 'noaccess';
  else if (status === 429 || /insufficient_quota|credit balance|billing.*limit|exceeded.*quota/i.test(msg)) kind = /insufficient_quota|billing|credit balance|quota/i.test(msg) ? 'quota' : 'rate';
  else if (status >= 500 || /overloaded/i.test(msg)) kind = 'server';
  else if (status === 400) kind = 'bad_request';
  return new ApiError({ kind, status, apiStatus: provider, message: msg, retryAfterMs: 0 });
}

async function fetchWithTimeout(url, options, timeoutMs = 55000, parentSignal) {
  const ac = new AbortController();
  let timedOut = false;
  const onParent = () => ac.abort();
  if (parentSignal) {
    if (parentSignal.aborted) ac.abort();
    else parentSignal.addEventListener('abort', onParent, { once: true });
  }
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs) : null;
  try {
    return await fetch(url, Object.assign({}, options, { signal: ac.signal }));
  } catch (e) {
    if (timedOut) throw new ApiError({ kind: 'timeout', status: 408, message: 'Request timed out after ' + Math.round(timeoutMs / 1000) + 's.' });
    if (e && e.name === 'AbortError') throw abortError();
    throw new ApiError({ kind: 'network', status: 0, message: 'Network error contacting ' + new URL(url).host + ': ' + e.message });
  } finally {
    if (timer) clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', onParent);
  }
}

/* ------------------------------------------------------------------ */
/* OpenAI Client                                                      */
/* ------------------------------------------------------------------ */

function geminiToOpenAIMessages(payload) {
  const out = [];
  const sysParts = (payload.systemInstruction && payload.systemInstruction.parts) || [];
  const sysText = sysParts.map((p) => p.text || '').join('\n').trim();
  if (sysText) out.push({ role: 'system', content: sysText });

  const issuedToolIds = [];
  for (const turn of payload.contents || []) {
    const parts = Array.isArray(turn.parts) ? turn.parts : [];
    if (turn.role === 'model') {
      const texts = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('\n');
      const calls = parts.filter((p) => p.functionCall);
      const msg = { role: 'assistant', content: texts || (calls.length ? null : '') };
      if (calls.length) {
        msg.tool_calls = calls.map((p, idx) => {
          const fc = p.functionCall;
          const id = fc.id || ('call_' + issuedToolIds.length + '_' + idx);
          issuedToolIds.push({ id, name: fc.name });
          return {
            id,
            type: 'function',
            function: { name: fc.name, arguments: JSON.stringify(fc.args || {}) }
          };
        });
      }
      out.push(msg);
      continue;
    }

    const resps = parts.filter((p) => p.functionResponse);
    for (const r of resps) {
      const fr = r.functionResponse;
      let matchId = fr.id;
      if (!matchId) {
        const idx = issuedToolIds.findIndex((x) => x.name === fr.name);
        if (idx >= 0) matchId = issuedToolIds.splice(idx, 1)[0].id;
        else matchId = 'call_' + Date.now();
      }
      out.push({
        role: 'tool',
        tool_call_id: matchId,
        content: typeof fr.response === 'string' ? fr.response : JSON.stringify(fr.response || {})
      });
    }

    const userContent = [];
    for (const p of parts) {
      if (typeof p.text === 'string' && p.text) {
        userContent.push({ type: 'text', text: p.text });
      } else if (p.inlineData && p.inlineData.data) {
        const mime = p.inlineData.mimeType || 'image/jpeg';
        userContent.push({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + p.inlineData.data, detail: 'high' } });
      }
    }
    if (userContent.length) {
      out.push({
        role: 'user',
        content: userContent.length === 1 && userContent[0].type === 'text' ? userContent[0].text : userContent
      });
    }
  }
  return out;
}

function sanitizeJsonSchemaForOpenAI(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  return JSON.parse(JSON.stringify(schema));
}

function openAIToolsFromGemini(payload) {
  const decls = [];
  for (const t of payload.tools || []) {
    if (Array.isArray(t.functionDeclarations)) {
      for (const fd of t.functionDeclarations) {
        decls.push({
          type: 'function',
          function: {
            name: fd.name,
            description: fd.description || fd.name,
            parameters: sanitizeJsonSchemaForOpenAI(fd.parameters)
          }
        });
      }
    }
  }
  return decls;
}

let LIVE_OPENAI_MODELS = [];

function isModernOpenAIModelId(id) {
  const clean = stripModelPrefix(id).toLowerCase();
  if (!clean) return false;
  if (clean === 'auto' || clean === 'openai_auto') return true;
  if (/^(?:gpt-3|gpt-4(?:\.|o|-|$)|o1(?:-|$)|o4-mini|davinci|babbage|curie|ada)/i.test(clean)) return false;
  if (/(whisper|tts|dall-e|embedding|moderation|realtime|transcribe|sora|audio|image|search-preview|instruct)/i.test(clean)) return false;
  return /^(?:gpt-5|gpt-6|gpt-oss|o3|o4-pro|o5)/i.test(clean);
}

class OpenAIClient {
  constructor(getKey, onRecordUsage) {
    this.getKey = getKey;
    this.recordUsage = onRecordUsage;
  }

  async raw(pathPart, { method = 'GET', body, signal, key, timeoutMs = 55000 } = {}) {
    const apiKey = key || this.getKey();
    if (!apiKey) throw new ApiError({ kind: 'nokey', status: 0, message: 'No OpenAI API key saved.' });
    const res = await fetchWithTimeout('https://api.openai.com/v1/' + pathPart, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: body ? JSON.stringify(body) : undefined
    }, timeoutMs, signal);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      let parsed = txt;
      try { parsed = JSON.parse(txt); } catch (_) { /* ignore */ }
      throw classifyHttpError('openai', res.status, parsed);
    }
    return res;
  }

  async listModels(key) {
    const out = OPENAI_ALLOWLIST.map((m) => Object.assign({}, m));
    const seen = new Set(out.map((m) => m.id));
    try {
      const res = await this.raw('models', { key, timeoutMs: 15000 });
      const json = await res.json();
      const rawModels = (json && Array.isArray(json.data)) ? json.data : [];
      const discovered = [];
      for (const rm of rawModels) {
        const id = stripModelPrefix(rm && rm.id);
        if (!id || id === 'auto' || !isModernOpenAIModelId(id)) continue;
        discovered.push(id);
      }
      if (discovered.length) LIVE_OPENAI_MODELS = discovered;
    } catch (e) {
      if (e.kind === 'invalid') throw e;
    }
    return out;
  }

  buildChatPayload(model, payload, stream = false) {
    const body = {
      model: stripModelPrefix(model),
      messages: geminiToOpenAIMessages(payload),
      stream
    };
    const tools = openAIToolsFromGemini(payload);
    if (tools.length) {
      body.tools = tools;
      const mode = payload.toolConfig && payload.toolConfig.functionCallingConfig && payload.toolConfig.functionCallingConfig.mode;
      if (mode === 'ANY') body.tool_choice = 'required';
    }
    const genCfg = payload.generationConfig || {};
    if (genCfg.maxOutputTokens) body.max_completion_tokens = genCfg.maxOutputTokens;
    if (genCfg.thinkingConfig && genCfg.thinkingConfig.thinkingLevel && /^(?:o3|o4|o5|gpt-5|gpt-6)/i.test(body.model)) {
      const eff = String(genCfg.thinkingConfig.thinkingLevel).toLowerCase();
      body.reasoning_effort = eff === 'extra' ? 'high' : eff;
    }
    return body;
  }

  normalizeResponse(model, json) {
    const ch = (json.choices || [])[0] || {};
    const m = ch.message || {};
    const parts = [];
    if (typeof m.content === 'string' && m.content) parts.push({ text: m.content });
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let args = {};
        try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (_) { args = {}; }
        parts.push({ functionCall: { id: tc.id, name: tc.function && tc.function.name, args } });
      }
    }
    const u = json.usage ? {
      promptTokenCount: json.usage.prompt_tokens || 0,
      candidatesTokenCount: json.usage.completion_tokens || 0,
      totalTokenCount: json.usage.total_tokens || 0
    } : null;
    if (u) this.recordUsage(model, u);
    return {
      text: typeof m.content === 'string' ? m.content : '',
      thought: '',
      parts,
      candidates: parts.length ? [{ content: { role: 'model', parts }, finishReason: ch.finish_reason || 'stop' }] : [],
      usage: u,
      usageMetadata: u
    };
  }

  resolveRuntimeCandidates(model, payload) {
    const exact = stripModelPrefix(model);
    const id = exact.toLowerCase();
    const out = [];
    const push = (cand) => {
      const clean = stripModelPrefix(cand);
      if (clean && clean !== 'auto' && !out.includes(clean)) out.push(clean);
    };
    const live = Array.isArray(LIVE_OPENAI_MODELS) ? LIVE_OPENAI_MODELS : [];
    if (id === 'auto' || id === 'openai_auto') {
      let promptText = '';
      let hasToolsOrImages = false;
      if (payload && typeof payload === 'object') {
        if (Array.isArray(payload.tools) && payload.tools.length) hasToolsOrImages = true;
        if (Array.isArray(payload.contents)) {
          for (const turn of payload.contents) {
            for (const p of (turn && turn.parts) || []) {
              if (p && p.inlineData) hasToolsOrImages = true;
              if (p && typeof p.text === 'string') promptText += ' ' + p.text;
            }
          }
        }
      }
      const isComplex = hasToolsOrImages ||
        promptText.trim().length > 180 ||
        /\b(code|debug|fix|implement|build|refactor|algorithm|architecture|analyze|compare|prove|calculate|sql|python|javascript|typescript|rust|java|kotlin|html|css|step[- ]by[- ]step|detailed|plan)\b|```/i.test(promptText);
      if (isComplex) {
        for (const m of live) if (/terra|\bgpt-5\b/i.test(m)) push(m);
        push('gpt-6.1-terra');
        push('gpt-5');
        push('gpt-5-mini');
        push('gpt-4.1');
        push('gpt-4o');
      } else {
        for (const m of live) if (/luna|5-mini|5-nano/i.test(m)) push(m);
        push('gpt-6-luna');
        push('gpt-5-mini');
        push('gpt-5-nano');
        push('gpt-4.1-mini');
        push('gpt-4o-mini');
      }
      return out;
    }
    push(exact);
    // Same-tier endpoint resolution: try exact model slug first, then same-tier live endpoints on the key so it never 404s.
    if (/luna/.test(id)) {
      for (const m of live) if (/luna|5-nano|5-mini/i.test(m)) push(m);
      push('gpt-6-luna');
      push('gpt-5-nano');
      push('gpt-5-mini');
      push('gpt-4.1-nano');
      push('gpt-4o-mini');
      return out;
    }
    if (/terra/.test(id)) {
      for (const m of live) if (/terra|5-mini|\bgpt-5\b/i.test(m)) push(m);
      push('gpt-6.1-terra');
      push('gpt-5-mini');
      push('gpt-5');
      push('gpt-4.1-mini');
      push('gpt-4o');
      return out;
    }
    if (/sol/.test(id)) {
      for (const m of live) if (/\bsol\b|gpt-6.*sol|\bgpt-5\b|\bo3\b/i.test(m)) push(m);
      push('gpt-6-sol');
      push('gpt-6.2-sol');
      push('gpt-5');
      push('o3');
      push('gpt-4.1');
      return out;
    }
    if (/astra/.test(id)) {
      for (const m of live) if (/astra|\bgpt-5\b|\bo3\b/i.test(m)) push(m);
      push('gpt-6.2-astra');
      push('gpt-6-astra');
      push('gpt-5');
      push('o3');
      push('gpt-4.1');
      return out;
    }
    return out;
  }

  async _sendChatCandidate(cand, payload, stream, { signal, key, timeoutMs }) {
    const body = this.buildChatPayload(cand, payload, stream);
    if (stream) body.stream_options = { include_usage: true };
    try {
      return await this.raw('chat/completions', { method: 'POST', body, signal, key, timeoutMs });
    } catch (e) {
      if (e.kind === 'bad_request' && body.reasoning_effort) {
        delete body.reasoning_effort;
        return await this.raw('chat/completions', { method: 'POST', body, signal, key, timeoutMs });
      }
      throw e;
    }
  }

  async generate(model, payload, { signal, key, timeoutMs = 55000 } = {}) {
    const cands = this._orderGood(model, this.resolveRuntimeCandidates(model, payload));
    let lastErr;
    for (const cand of cands) {
      try {
        const res = await this._sendChatCandidate(cand, payload, false, { signal, key, timeoutMs });
        const json = await res.json();
        { if (String(model).toLowerCase() !== 'auto') this._goodSet(model, cand); return this.normalizeResponse(model, json); }
      } catch (e) {
        lastErr = e;
        if (e.kind === 'noaccess' || e.status === 404 || e.kind === 'bad_request') continue;
        throw e;
      }
    }
    throw lastErr;
  }

  async stream(model, payload, { signal, onText, onThought, onActivity, chunkTimeoutMs = 55000, timeoutMs = 55000 } = {}) {
    const cands = this._orderGood(model, this.resolveRuntimeCandidates(model, payload));
    let res;
    let lastErr;
    for (const cand of cands) {
      try {
        res = await this._sendChatCandidate(cand, payload, true, { signal, timeoutMs });
        if (String(model).toLowerCase() !== 'auto') this._goodSet(model, cand);
        break;
      } catch (e) {
        lastErr = e;
        if (e.kind === 'noaccess' || e.status === 404 || e.kind === 'bad_request') continue;
        throw e;
      }
    }
    if (!res) throw lastErr;
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let full = '';
    let thoughtFull = '';
    let finishReason = 'stop';
    let usage = null;
    const toolMap = new Map();
    let totalBytes = 0;

    const readWithTimeout = () => new Promise((resolve, reject) => {
      let settled = false;
      const timer = chunkTimeoutMs > 0 ? setTimeout(() => {
        if (settled) return;
        settled = true;
        reader.cancel().catch(() => {});
        reject(new ApiError({ kind: 'timeout', status: 408, message: 'OpenAI stream stalled.' }));
      }, chunkTimeoutMs) : null;
      reader.read().then((c) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(c);
      }, (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });

    for (;;) {
      const { done, value } = await readWithTimeout();
      if (done) break;
      if (value) totalBytes += value.byteLength || 0;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (dataStr === '[DONE]') continue;
        let obj;
        try { obj = JSON.parse(dataStr); } catch (_) { continue; }
        if (obj.usage) {
          usage = {
            promptTokenCount: obj.usage.prompt_tokens || 0,
            candidatesTokenCount: obj.usage.completion_tokens || 0,
            totalTokenCount: obj.usage.total_tokens || 0
          };
        }
        const ch = (obj.choices || [])[0];
        if (!ch) continue;
        if (ch.finish_reason) finishReason = ch.finish_reason;
        const delta = ch.delta || {};
        const rDelta = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
        if (rDelta) {
          thoughtFull += rDelta;
          if (onThought) onThought(rDelta, thoughtFull);
        }
        if (typeof delta.content === 'string' && delta.content) {
          full += delta.content;
          if (onText) onText(delta.content, full);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const keyIdx = tc.index !== undefined ? tc.index : 0;
            if (!toolMap.has(keyIdx)) toolMap.set(keyIdx, { id: tc.id || '', name: '', arguments: '' });
            const cur = toolMap.get(keyIdx);
            if (tc.id) cur.id = tc.id;
            if (tc.function && tc.function.name) cur.name += tc.function.name;
            if (tc.function && tc.function.arguments) cur.arguments += tc.function.arguments;
          }
        }
      }
      if (onActivity && totalBytes > 0) onActivity({ bytes: totalBytes, parts: toolMap.size, thoughtChars: thoughtFull.length, textChars: full.length });
    }

    const parts = [];
    if (thoughtFull) parts.push({ text: thoughtFull, thought: true });
    if (full) parts.push({ text: full });
    for (const [, tc] of Array.from(toolMap.entries()).sort((a, b) => a[0] - b[0])) {
      let args = {};
      try { args = JSON.parse(tc.arguments || '{}'); } catch (_) { args = {}; }
      parts.push({ functionCall: { id: tc.id || ('call_' + Date.now()), name: tc.name, args } });
    }
    if (usage) this.recordUsage(model, usage);
    return {
      text: full,
      thought: thoughtFull,
      parts,
      candidates: parts.length ? [{ content: { role: 'model', parts }, finishReason }] : [],
      usage,
      usageMetadata: usage
    };
  }

  async validate(key, preferredModel) {
    const result = { status: 'unknown', icon: '', title: '', message: '', models: [], match: null, testModel: null, usage: null, steps: [], provider: 'openai' };
    let models;
    try {
      models = await this.listModels(key);
      result.steps.push({ step: 'list-models', ok: true, detail: models.length + ' OpenAI models visible to this key' });
    } catch (e) {
      result.steps.push({ step: 'list-models', ok: false, detail: e.message });
      return Object.assign(result, { status: e.kind === 'invalid' ? 'invalid' : 'error', icon: '❌', title: e.kind === 'invalid' ? 'Invalid OpenAI key' : 'Connection error', message: e.message });
    }
    result.models = models;
    result.match = matchPresetsForProvider('openai', models);
    const ids = new Set(models.map((m) => m.id));
    const cands = [];
    const add = (id) => { if (id && ids.has(id) && !cands.includes(id)) cands.push(id); };
    add(preferredModel);
    for (const m of models) add(m.id);
    if (!cands.length) return Object.assign(result, { status: 'noaccess', icon: '❌', title: 'No allowlisted models on key', message: 'No allowlisted OpenAI models are available.' });

    let lastErr = null;
    for (const test of cands.slice(0, 5)) {
      result.testModel = test;
      try {
        const res = await this.generate(test, {
          contents: [{ role: 'user', parts: [{ text: 'Reply with OK' }] }],
          generationConfig: { maxOutputTokens: 16 }
        }, { key, timeoutMs: 14000 });
        result.usage = res.usage;
        result.steps.push({ step: 'test-request', ok: true, detail: test + ' answered cleanly' });
        return Object.assign(result, {
          status: 'valid',
          icon: '✅',
          title: 'OpenAI Key Verified · Real & Ready',
          message: 'OpenAI API key accepted! ' + models.length + ' models loaded and tested with ' + test + '.'
        });
      } catch (e) {
        lastErr = e;
        result.steps.push({ step: 'test-request (' + test + ')', ok: false, detail: e.message });
        if (e.kind === 'invalid') break;
      }
    }
    return Object.assign(result, { status: lastErr && lastErr.kind === 'quota' ? 'rate' : 'error', icon: '⚠️', title: 'OpenAI Check Warning', message: (lastErr && lastErr.message) || 'Validation failed.' });
  }
}

/* ------------------------------------------------------------------ */
/* Anthropic Claude Client                                            */
/* ------------------------------------------------------------------ */

function geminiToAnthropicMessages(payload) {
  const sysParts = (payload.systemInstruction && payload.systemInstruction.parts) || [];
  const system = sysParts.map((p) => p.text || '').join('\n').trim();
  const messages = [];
  const issuedToolIds = [];

  for (const turn of payload.contents || []) {
    const parts = Array.isArray(turn.parts) ? turn.parts : [];
    if (turn.role === 'model') {
      const blocks = [];
      for (const p of parts) {
        if (typeof p.text === 'string' && !p.thought && p.text) {
          blocks.push({ type: 'text', text: p.text });
        } else if (p.functionCall) {
          const id = p.functionCall.id || ('toolu_' + issuedToolIds.length + '_' + Date.now());
          issuedToolIds.push({ id, name: p.functionCall.name });
          blocks.push({ type: 'tool_use', id, name: p.functionCall.name, input: p.functionCall.args || {} });
        }
      }
      if (blocks.length) messages.push({ role: 'assistant', content: blocks });
      continue;
    }

    const blocks = [];
    for (const p of parts) {
      if (p.functionResponse) {
        const fr = p.functionResponse;
        let matchId = fr.id;
        if (!matchId) {
          const idx = issuedToolIds.findIndex((x) => x.name === fr.name);
          if (idx >= 0) matchId = issuedToolIds.splice(idx, 1)[0].id;
          else matchId = 'toolu_' + Date.now();
        }
        blocks.push({
          type: 'tool_result',
          tool_use_id: matchId,
          content: typeof fr.response === 'string' ? fr.response : JSON.stringify(fr.response || {})
        });
      } else if (typeof p.text === 'string' && p.text) {
        blocks.push({ type: 'text', text: p.text });
      } else if (p.inlineData && p.inlineData.data) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: p.inlineData.mimeType || 'image/jpeg', data: p.inlineData.data }
        });
      }
    }
    if (blocks.length) messages.push({ role: 'user', content: blocks });
  }
  return { system, messages };
}

let LIVE_ANTHROPIC_MODELS = [];

function isModernAnthropicModelId(id) {
  const clean = stripModelPrefix(id).toLowerCase();
  if (!clean) return false;
  if (/^claude-(?:2|instant|3(?:\.|-|$)|sonnet-4-20250514|opus-4-20250514)/i.test(clean)) return false;
  return /^claude-(?:haiku|sonnet|opus|fable|mythos)?-?(?:4[.-][56]|5(?:[.-]\d+)?)/i.test(clean) || /^claude-(?:fable|mythos)/i.test(clean);
}

class AnthropicClient {
  constructor(getKey, onRecordUsage) {
    this.getKey = getKey;
    this.recordUsage = onRecordUsage;
  }

  async raw(pathPart, { method = 'GET', body, signal, key, timeoutMs = 55000 } = {}) {
    const apiKey = key || this.getKey();
    if (!apiKey) throw new ApiError({ kind: 'nokey', status: 0, message: 'No Claude (Anthropic) API key saved.' });
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/' + pathPart, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: body ? JSON.stringify(body) : undefined
    }, timeoutMs, signal);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      let parsed = txt;
      try { parsed = JSON.parse(txt); } catch (_) { /* ignore */ }
      throw classifyHttpError('anthropic', res.status, parsed);
    }
    return res;
  }

  async listModels(key) {
    const out = ANTHROPIC_ALLOWLIST.map((m) => Object.assign({}, m));
    const seen = new Set(out.map((m) => m.id));
    try {
      const res = await this.raw('models?limit=100', { key, timeoutMs: 15000 });
      const json = await res.json();
      const rawModels = (json && Array.isArray(json.data)) ? json.data : [];
      const discovered = [];
      for (const rm of rawModels) {
        const id = stripModelPrefix(rm && rm.id);
        if (!id || !isModernAnthropicModelId(id)) continue;
        discovered.push(id);
        if (!seen.has(id)) {
          seen.add(id);
          out.push({
            id,
            name: 'models/' + id,
            displayName: (rm && rm.display_name) || id,
            description: 'Active Claude 4.5+/5 model',
            methods: ['generateContent'],
            inputTokenLimit: 200000,
            outputTokenLimit: 16384,
            thinking: !/haiku/i.test(id)
          });
        }
      }
      if (discovered.length) LIVE_ANTHROPIC_MODELS = discovered;
    } catch (e) {
      if (e.kind === 'invalid') throw e;
    }
    return out;
  }

  buildMessagesPayload(model, payload, stream = false, includeThinking = true) {
    const { system, messages } = geminiToAnthropicMessages(payload);
    const body = {
      model: stripModelPrefix(model),
      max_tokens: (payload.generationConfig && payload.generationConfig.maxOutputTokens) || 4096,
      messages,
      stream
    };
    if (system) body.system = system;
    const tools = [];
    for (const t of payload.tools || []) {
      if (Array.isArray(t.functionDeclarations)) {
        for (const fd of t.functionDeclarations) {
          tools.push({
            name: fd.name,
            description: fd.description || fd.name,
            input_schema: fd.parameters || { type: 'object', properties: {} }
          });
        }
      }
    }
    const tCfg = payload.generationConfig && payload.generationConfig.thinkingConfig;
    const willThink = !!(includeThinking && tCfg && tCfg.thinkingLevel && /(sonnet|opus|fable|mythos|5-5|5-2|4-6|4-5)/i.test(body.model));
    if (tools.length) {
      body.tools = tools;
      const mode = payload.toolConfig && payload.toolConfig.functionCallingConfig && payload.toolConfig.functionCallingConfig.mode;
      // Anthropic API forbids tool_choice="any" when extended thinking is active.
      if (mode === 'ANY' && !willThink) body.tool_choice = { type: 'any' };
    }
    if (willThink) {
      const tier = String(tCfg.thinkingLevel).toUpperCase();
      const budget = tCfg.extra ? 16384 : (tier === 'HIGH' ? 12288 : (tier === 'LOW' ? 2048 : 5120));
      if (body.max_tokens <= budget) body.max_tokens = budget + 2048;
      body.thinking = { type: 'enabled', budget_tokens: budget };
    }
    return body;
  }

  normalizeResponse(model, json) {
    const parts = [];
    let fullText = '';
    let thoughtText = '';
    for (const blk of json.content || []) {
      if (blk.type === 'thinking' && blk.thinking) {
        thoughtText += blk.thinking;
        parts.push({ text: blk.thinking, thought: true });
      } else if (blk.type === 'text' && blk.text) {
        fullText += blk.text;
        parts.push({ text: blk.text });
      } else if (blk.type === 'tool_use') {
        parts.push({ functionCall: { id: blk.id, name: blk.name, args: blk.input || {} } });
      }
    }
    const u = json.usage ? {
      promptTokenCount: json.usage.input_tokens || 0,
      candidatesTokenCount: json.usage.output_tokens || 0,
      totalTokenCount: (json.usage.input_tokens || 0) + (json.usage.output_tokens || 0)
    } : null;
    if (u) this.recordUsage(model, u);
    return {
      text: fullText,
      thought: thoughtText,
      parts,
      candidates: parts.length ? [{ content: { role: 'model', parts }, finishReason: json.stop_reason || 'end_turn' }] : [],
      usage: u,
      usageMetadata: u
    };
  }

  resolveRuntimeCandidates(model) {
    const exact = stripModelPrefix(model);
    const id = exact.toLowerCase();
    const out = [];
    const push = (cand) => {
      const clean = stripModelPrefix(cand);
      if (clean && !out.includes(clean)) out.push(clean);
    };
    push(exact);
    const live = Array.isArray(LIVE_ANTHROPIC_MODELS) ? LIVE_ANTHROPIC_MODELS : [];
    // Same-tier endpoint resolution: try exact model slug first, then same-tier live Claude endpoints so it never 404s.
    if (/haiku/.test(id)) {
      for (const m of live) if (/haiku/i.test(m)) push(m);
      push('claude-haiku-5-5');
      push('claude-haiku-4-5');
      push('claude-3-5-haiku-latest');
      return out;
    }
    if (/opus/.test(id)) {
      for (const m of live) if (/opus/i.test(m)) push(m);
      push('claude-opus-5-5');
      push('claude-opus-4-6');
      push('claude-opus-4-5');
      push('claude-sonnet-4-6');
      return out;
    }
    if (/fable|mythos/.test(id)) {
      for (const m of live) if (/fable|mythos|opus/i.test(m)) push(m);
      push('claude-fable-5-2');
      push('claude-opus-4-6');
      push('claude-opus-4-5');
      push('claude-sonnet-4-6');
      return out;
    }
    if (/sonnet/.test(id)) {
      for (const m of live) if (/sonnet/i.test(m)) push(m);
      push('claude-sonnet-5-5');
      push('claude-sonnet-4-6');
      push('claude-sonnet-4-5');
      push('claude-3-7-sonnet-latest');
      return out;
    }
    return out;
  }

  async generate(model, payload, { signal, key, timeoutMs = 55000 } = {}) {
    const cands = this._orderGood(model, this.resolveRuntimeCandidates(model));
    let lastErr;
    for (const cand of cands) {
      let body = this.buildMessagesPayload(cand, payload, false, true);
      try {
        const res = await this.raw('messages', { method: 'POST', body, signal, key, timeoutMs });
        { this._goodSet(model, cand); return this.normalizeResponse(model, await res.json()); }
      } catch (e) {
        if (e.kind === 'bad_request' && body.thinking) {
          try {
            body = this.buildMessagesPayload(cand, payload, false, false);
            const res = await this.raw('messages', { method: 'POST', body, signal, key, timeoutMs });
            { this._goodSet(model, cand); return this.normalizeResponse(model, await res.json()); }
          } catch (e2) {
            lastErr = e2;
            if (e2.kind === 'noaccess' || e2.status === 404) continue;
            throw e2;
          }
        }
        lastErr = e;
        if (e.kind === 'noaccess' || e.status === 404) continue;
        throw e;
      }
    }
    throw lastErr;
  }

  async stream(model, payload, { signal, onText, onThought, onActivity, chunkTimeoutMs = 55000, timeoutMs = 55000 } = {}) {
    const cands = this._orderGood(model, this.resolveRuntimeCandidates(model));
    let res;
    let lastErr;
    for (const cand of cands) {
      let body = this.buildMessagesPayload(cand, payload, true, true);
      try {
        res = await this.raw('messages', { method: 'POST', body, signal, timeoutMs });
        this._goodSet(model, cand);
        break;
      } catch (e) {
        if (e.kind === 'bad_request' && body.thinking) {
          try {
            body = this.buildMessagesPayload(cand, payload, true, false);
            res = await this.raw('messages', { method: 'POST', body, signal, timeoutMs });
            this._goodSet(model, cand);
            break;
          } catch (e2) {
            lastErr = e2;
            if (e2.kind === 'noaccess' || e2.status === 404) continue;
            throw e2;
          }
        }
        lastErr = e;
        if (e.kind === 'noaccess' || e.status === 404) continue;
        throw e;
      }
    }
    if (!res) throw lastErr;

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let full = '';
    let thoughtFull = '';
    const blocks = new Map();
    let stopReason = 'end_turn';
    let inTokens = 0;
    let outTokens = 0;
    let totalBytes = 0;

    const readWithTimeout = () => new Promise((resolve, reject) => {
      let settled = false;
      const timer = chunkTimeoutMs > 0 ? setTimeout(() => {
        if (settled) return;
        settled = true;
        reader.cancel().catch(() => {});
        reject(new ApiError({ kind: 'timeout', status: 408, message: 'Claude stream stalled.' }));
      }, chunkTimeoutMs) : null;
      reader.read().then((c) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(c);
      }, (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });

    for (;;) {
      const { done, value } = await readWithTimeout();
      if (done) break;
      if (value) totalBytes += value.byteLength || 0;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        let obj;
        try { obj = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
        if (obj.type === 'message_start' && obj.message && obj.message.usage) {
          inTokens = obj.message.usage.input_tokens || 0;
        } else if (obj.type === 'content_block_start' && obj.content_block) {
          blocks.set(obj.index, {
            type: obj.content_block.type,
            id: obj.content_block.id || '',
            name: obj.content_block.name || '',
            text: obj.content_block.text || '',
            thinking: obj.content_block.thinking || '',
            inputJson: ''
          });
        } else if (obj.type === 'content_block_delta' && obj.delta) {
          const blk = blocks.get(obj.index);
          if (obj.delta.type === 'thinking_delta' && obj.delta.thinking) {
            thoughtFull += obj.delta.thinking;
            if (blk) blk.thinking += obj.delta.thinking;
            if (onThought) onThought(obj.delta.thinking, thoughtFull);
          } else if (obj.delta.type === 'text_delta' && obj.delta.text) {
            full += obj.delta.text;
            if (blk) blk.text += obj.delta.text;
            if (onText) onText(obj.delta.text, full);
          } else if (obj.delta.type === 'input_json_delta' && obj.delta.partial_json && blk) {
            blk.inputJson += obj.delta.partial_json;
          }
        } else if (obj.type === 'message_delta') {
          if (obj.delta && obj.delta.stop_reason) stopReason = obj.delta.stop_reason;
          if (obj.usage && obj.usage.output_tokens) outTokens = obj.usage.output_tokens;
        }
      }
      if (onActivity && totalBytes > 0) onActivity({ bytes: totalBytes, parts: blocks.size, thoughtChars: thoughtFull.length, textChars: full.length });
    }

    const parts = [];
    for (const [, blk] of Array.from(blocks.entries()).sort((a, b) => a[0] - b[0])) {
      if (blk.type === 'thinking' && blk.thinking) parts.push({ text: blk.thinking, thought: true });
      else if (blk.type === 'text' && blk.text) parts.push({ text: blk.text });
      else if (blk.type === 'tool_use') {
        let args = {};
        try { args = JSON.parse(blk.inputJson || '{}'); } catch (_) { args = {}; }
        parts.push({ functionCall: { id: blk.id || ('toolu_' + Date.now()), name: blk.name, args } });
      }
    }
    const usage = { promptTokenCount: inTokens, candidatesTokenCount: outTokens, totalTokenCount: inTokens + outTokens };
    this.recordUsage(model, usage);
    return {
      text: full,
      thought: thoughtFull,
      parts,
      candidates: parts.length ? [{ content: { role: 'model', parts }, finishReason: stopReason }] : [],
      usage,
      usageMetadata: usage
    };
  }

  async validate(key, preferredModel) {
    const result = { status: 'unknown', icon: '', title: '', message: '', models: [], match: null, testModel: null, usage: null, steps: [], provider: 'anthropic' };
    let models;
    try {
      models = await this.listModels(key);
      result.steps.push({ step: 'list-models', ok: true, detail: models.length + ' Claude models visible to this key' });
    } catch (e) {
      result.steps.push({ step: 'list-models', ok: false, detail: e.message });
      return Object.assign(result, { status: e.kind === 'invalid' ? 'invalid' : 'error', icon: '❌', title: e.kind === 'invalid' ? 'Invalid Claude key' : 'Connection error', message: e.message });
    }
    result.models = models;
    result.match = matchPresetsForProvider('anthropic', models);
    const ids = new Set(models.map((m) => m.id));
    const cands = [];
    const add = (id) => { if (id && ids.has(id) && !cands.includes(id)) cands.push(id); };
    add(preferredModel);
    for (const m of models) add(m.id);
    if (!cands.length) return Object.assign(result, { status: 'noaccess', icon: '❌', title: 'No allowlisted Claude models', message: 'Connected to Anthropic, but no allowlisted models returned.' });

    let lastErr = null;
    for (const test of cands.slice(0, 4)) {
      result.testModel = test;
      try {
        const res = await this.generate(test, {
          contents: [{ role: 'user', parts: [{ text: 'Reply with OK' }] }],
          generationConfig: { maxOutputTokens: 16 }
        }, { key, timeoutMs: 14000 });
        result.usage = res.usage;
        result.steps.push({ step: 'test-request', ok: true, detail: test + ' answered cleanly' });
        return Object.assign(result, {
          status: 'valid',
          icon: '✅',
          title: 'Claude Key Verified · Real & Ready',
          message: 'Anthropic Claude API key accepted! ' + models.length + ' models loaded and tested with ' + test + '.'
        });
      } catch (e) {
        lastErr = e;
        result.steps.push({ step: 'test-request (' + test + ')', ok: false, detail: e.message });
        if (e.kind === 'invalid') break;
      }
    }
    return Object.assign(result, { status: lastErr && lastErr.kind === 'quota' ? 'rate' : 'error', icon: '⚠️', title: 'Claude Check Warning', message: (lastErr && lastErr.message) || 'Validation failed.' });
  }
}

/* ------------------------------------------------------------------ */
/* OpenRouter Client (proxies our 12 hardcoded models via openrouter.ai)*/
/* ------------------------------------------------------------------ */

let LIVE_OPENROUTER_MODELS = [];

function isModernOpenRouterModelId(id) {
  const clean = stripModelPrefix(id).toLowerCase();
  if (!clean) return false;
  if (/gemini-(?:1|2)(?:\.|-|$)|gpt-(?:3|4(?:\.|o|-|$))|claude-(?:2|3(?:\.|-|$)|sonnet-4$|sonnet-4-)|o1|o4-mini/i.test(clean)) return false;
  if (/(image|tts|audio|embedding|moderation|realtime|whisper|dall-e|sora|:free$)/i.test(clean)) return false;
  return /^(?:google\/gemini-(?:3|4|5)|openai\/gpt-(?:5|6|oss)|anthropic\/claude-(?:haiku|sonnet|opus|fable|mythos)-?(?:4\.[56]|5))/i.test(clean);
}

class OpenRouterClient {
  constructor(getKey, onRecordUsage) {
    this.getKey = getKey;
    this.recordUsage = onRecordUsage;
  }

  async raw(pathPart, { method = 'GET', body, signal, key, timeoutMs = 55000 } = {}) {
    const apiKey = key || this.getKey();
    if (!apiKey) throw new ApiError({ kind: 'nokey', status: 0, message: 'No OpenRouter API key saved.' });
    const res = await fetchWithTimeout('https://openrouter.ai/api/v1/' + pathPart, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'HTTP-Referer': 'https://locally.app',
        'X-Title': 'LOCALLY'
      },
      body: body ? JSON.stringify(body) : undefined
    }, timeoutMs, signal);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      let parsed = txt;
      try { parsed = JSON.parse(txt); } catch (_) { /* ignore */ }
      throw classifyHttpError('openrouter', res.status, parsed);
    }
    return res;
  }

  // OpenRouter uses the same OpenAI-compatible chat endpoint, so we reuse the OpenAI helpers.
  buildChatPayload(model, payload, stream = false) {
    const rawModel = String(model || '').replace(/^models\//, '');
    const body = {
      model: rawModel,
      messages: geminiToOpenAIMessages(payload),
      stream
    };
    const tools = openAIToolsFromGemini(payload);
    const genCfg = payload.generationConfig || {};
    let wantReasoning = null;
    if (genCfg.thinkingConfig && genCfg.thinkingConfig.thinkingLevel && !/(?:flash-lite|haiku|luna)/i.test(body.model)) {
      const lvl = String(genCfg.thinkingConfig.thinkingLevel).toLowerCase();
      wantReasoning = { effort: lvl === 'low' ? 'low' : ((lvl === 'high' || lvl === 'extra' || genCfg.thinkingConfig.extra) ? 'high' : 'medium') };
      body.reasoning = wantReasoning;
    }
    if (tools.length) {
      body.tools = tools;
      const mode = payload.toolConfig && payload.toolConfig.functionCallingConfig && payload.toolConfig.functionCallingConfig.mode;
      if (mode === 'ANY' && !(wantReasoning && /anthropic\/claude/i.test(body.model))) body.tool_choice = 'required';
    }
    if (genCfg.maxOutputTokens) body.max_completion_tokens = genCfg.maxOutputTokens;
    return body;
  }

  normalizeResponse(model, json) {
    const ch = (json.choices || [])[0] || {};
    const m = ch.message || {};
    const parts = [];
    const rTxt = typeof m.reasoning_content === 'string' ? m.reasoning_content : (typeof m.reasoning === 'string' ? m.reasoning : '');
    if (rTxt) parts.push({ text: rTxt, thought: true });
    if (typeof m.content === 'string' && m.content) parts.push({ text: m.content });
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let args = {};
        try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (_) { args = {}; }
        parts.push({ functionCall: { id: tc.id, name: tc.function && tc.function.name, args } });
      }
    }
    const u = json.usage ? {
      promptTokenCount: json.usage.prompt_tokens || 0,
      candidatesTokenCount: json.usage.completion_tokens || 0,
      totalTokenCount: json.usage.total_tokens || 0
    } : null;
    if (u) this.recordUsage(model, u);
    return {
      text: typeof m.content === 'string' ? m.content : '',
      thought: rTxt, parts,
      candidates: parts.length ? [{ content: { role: 'model', parts }, finishReason: ch.finish_reason || 'stop' }] : [],
      usage: u, usageMetadata: u
    };
  }

  resolveRuntimeCandidates(model) {
    const exact = stripModelPrefix(model);
    const id = exact.toLowerCase();
    const out = [];
    const push = (cand) => {
      const clean = stripModelPrefix(cand);
      if (clean && !out.includes(clean)) out.push(clean);
    };
    push(exact);
    const live = Array.isArray(LIVE_OPENROUTER_MODELS) ? LIVE_OPENROUTER_MODELS : [];
    // Same-tier endpoint resolution on OpenRouter: try exact slug first, then same-tier live OpenRouter endpoints so it never 404s.
    if (/flash.*lite/.test(id)) {
      for (const m of live) if (/google\/gemini.*(?:3\.5|3\.1|2\.5).*flash.*lite/i.test(m)) push(m);
      push('google/gemini-3.5-flash-lite');
      push('google/gemini-3.1-flash-lite-preview');
      push('google/gemini-2.5-flash-lite');
      return out;
    }
    if (/neon/.test(id)) {
      for (const m of live) if (/google\/gemini.*(?:neon|3\.1-pro|2\.5-pro)/i.test(m)) push(m);
      push('google/gemini-4-neon');
      push('google/gemini-3.1-pro-preview');
      push('google/gemini-2.5-pro');
      push('google/gemini-3-flash-preview');
      return out;
    }
    if (/hydrogen/.test(id)) {
      for (const m of live) if (/google\/gemini.*(?:hydrogen|3-flash|2\.5-flash)/i.test(m) && !/lite/i.test(m)) push(m);
      push('google/gemini-4-hydrogen');
      push('google/gemini-3-flash-preview');
      push('google/gemini-2.5-flash');
      return out;
    }
    if (/3\.8.*flash|flash/.test(id)) {
      for (const m of live) if (/google\/gemini.*(?:3\.8|3|2\.5).*flash/i.test(m) && !/lite/i.test(m)) push(m);
      push('google/gemini-3.8-flash');
      push('google/gemini-3-flash-preview');
      push('google/gemini-2.5-flash');
      return out;
    }
    if (/carbon|argon/.test(id)) {
      for (const m of live) if (/google\/gemini.*(?:carbon|3\.1-pro|2\.5-pro)/i.test(m)) push(m);
      push('google/gemini-4-carbon');
      push('google/gemini-3.1-pro-preview');
      push('google/gemini-2.5-pro');
      push('google/gemini-2.5-flash');
      return out;
    }
    if (/luna/.test(id)) {
      for (const m of live) if (/openai\/gpt.*(?:luna|5-nano|5-mini)/i.test(m)) push(m);
      push('openai/gpt-6-luna');
      push('openai/gpt-5-nano');
      push('openai/gpt-5-mini');
      push('openai/gpt-4.1-nano');
      push('openai/gpt-4o-mini');
      return out;
    }
    if (/terra/.test(id)) {
      for (const m of live) if (/openai\/gpt.*(?:terra|5-mini|\bgpt-5\b)/i.test(m)) push(m);
      push('openai/gpt-6.1-terra');
      push('openai/gpt-5-mini');
      push('openai/gpt-5');
      push('openai/gpt-4.1-mini');
      push('openai/gpt-4o');
      return out;
    }
    if (/astra/.test(id)) {
      for (const m of live) if (/openai\/(?:gpt.*astra|gpt-5|o3)/i.test(m)) push(m);
      push('openai/gpt-6.2-astra');
      push('openai/gpt-6-astra');
      push('openai/gpt-5');
      push('openai/o3');
      push('openai/gpt-4.1');
      return out;
    }
    if (/sol/.test(id)) {
      for (const m of live) if (/openai\/(?:gpt.*sol|gpt-5|o3)/i.test(m)) push(m);
      push('openai/gpt-6-sol');
      push('openai/gpt-6.2-sol');
      push('openai/gpt-5');
      push('openai/o3');
      push('openai/gpt-4.1');
      return out;
    }
    if (/haiku/.test(id)) {
      for (const m of live) if (/anthropic\/claude.*haiku/i.test(m)) push(m);
      push('anthropic/claude-haiku-5-5');
      push('anthropic/claude-haiku-4.5');
      push('anthropic/claude-3.5-haiku');
      return out;
    }
    if (/opus/.test(id)) {
      for (const m of live) if (/anthropic\/claude.*opus/i.test(m)) push(m);
      push('anthropic/claude-opus-5-5');
      push('anthropic/claude-opus-4.6');
      push('anthropic/claude-opus-4.5');
      push('anthropic/claude-sonnet-4.6');
      return out;
    }
    if (/fable|mythos/.test(id)) {
      for (const m of live) if (/anthropic\/claude.*(?:fable|mythos|opus)/i.test(m)) push(m);
      push('anthropic/claude-fable-5-2');
      push('anthropic/claude-opus-4.6');
      push('anthropic/claude-opus-4.5');
      push('anthropic/claude-sonnet-4.6');
      return out;
    }
    if (/sonnet/.test(id)) {
      for (const m of live) if (/anthropic\/claude.*sonnet/i.test(m)) push(m);
      push('anthropic/claude-sonnet-5-5');
      push('anthropic/claude-sonnet-4.6');
      push('anthropic/claude-sonnet-4.5');
      push('anthropic/claude-3.7-sonnet');
      return out;
    }
    return out;
  }

  async generate(model, payload, { signal, key, timeoutMs = 55000 } = {}) {
    const cands = this._orderGood(model, this.resolveRuntimeCandidates(model));
    let lastErr;
    for (const cand of cands) {
      try {
        const body = this.buildChatPayload(cand, payload, false);
        const res = await this.raw('chat/completions', { method: 'POST', body, signal, key, timeoutMs });
        { this._goodSet(model, cand); return this.normalizeResponse(model, await res.json()); }
      } catch (e) {
        lastErr = e;
        if (e.kind === 'noaccess' || e.status === 404 || e.kind === 'bad_request') continue;
        throw e;
      }
    }
    throw lastErr;
  }

  async stream(model, payload, { signal, onText, onThought, onActivity, chunkTimeoutMs = 55000, timeoutMs = 55000 } = {}) {
    const cands = this._orderGood(model, this.resolveRuntimeCandidates(model));
    let res;
    let lastErr;
    for (const cand of cands) {
      try {
        const body = this.buildChatPayload(cand, payload, true);
        body.stream_options = { include_usage: true };
        res = await this.raw('chat/completions', { method: 'POST', body, signal, timeoutMs });
        this._goodSet(model, cand);
        break;
      } catch (e) {
        lastErr = e;
        if (e.kind === 'noaccess' || e.status === 404 || e.kind === 'bad_request') continue;
        throw e;
      }
    }
    if (!res) throw lastErr;
    // Reuse the OpenAI streaming parser (identical SSE format)
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '', full = '', thoughtFull = '', finishReason = 'stop', usage = null;
    const toolMap = new Map();
    let totalBytes = 0;

    const readWithTimeout = () => new Promise((resolve, reject) => {
      let settled = false;
      const timer = chunkTimeoutMs > 0 ? setTimeout(() => {
        if (settled) return; settled = true;
        reader.cancel().catch(() => {});
        reject(new ApiError({ kind: 'timeout', status: 408, message: 'OpenRouter stream stalled.' }));
      }, chunkTimeoutMs) : null;
      reader.read().then((c) => {
        if (settled) return; settled = true;
        if (timer) clearTimeout(timer); resolve(c);
      }, (err) => {
        if (settled) return; settled = true;
        if (timer) clearTimeout(timer); reject(err);
      });
    });

    for (;;) {
      const { done, value } = await readWithTimeout();
      if (done) break;
      if (value) totalBytes += value.byteLength || 0;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (dataStr === '[DONE]') continue;
        let obj; try { obj = JSON.parse(dataStr); } catch (_) { continue; }
        if (obj.usage) {
          usage = { promptTokenCount: obj.usage.prompt_tokens || 0, candidatesTokenCount: obj.usage.completion_tokens || 0, totalTokenCount: obj.usage.total_tokens || 0 };
        }
        const ch = (obj.choices || [])[0]; if (!ch) continue;
        if (ch.finish_reason) finishReason = ch.finish_reason;
        const delta = ch.delta || {};
        const rDelta = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
        if (rDelta) { thoughtFull += rDelta; if (onThought) onThought(rDelta, thoughtFull); }
        if (typeof delta.content === 'string' && delta.content) { full += delta.content; if (onText) onText(delta.content, full); }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const keyIdx = tc.index !== undefined ? tc.index : 0;
            if (!toolMap.has(keyIdx)) toolMap.set(keyIdx, { id: tc.id || '', name: '', arguments: '' });
            const cur = toolMap.get(keyIdx);
            if (tc.id) cur.id = tc.id;
            if (tc.function && tc.function.name) cur.name += tc.function.name;
            if (tc.function && tc.function.arguments) cur.arguments += tc.function.arguments;
          }
        }
      }
      if (onActivity && totalBytes > 0) onActivity({ bytes: totalBytes, parts: toolMap.size, thoughtChars: thoughtFull.length, textChars: full.length });
    }
    const parts = [];
    if (thoughtFull) parts.push({ text: thoughtFull, thought: true });
    if (full) parts.push({ text: full });
    for (const [, tc] of Array.from(toolMap.entries()).sort((a, b) => a[0] - b[0])) {
      let args = {}; try { args = JSON.parse(tc.arguments || '{}'); } catch (_) { args = {}; }
      parts.push({ functionCall: { id: tc.id || ('call_' + Date.now()), name: tc.name, args } });
    }
    if (usage) this.recordUsage(model, usage);
    return {
      text: full, thought: thoughtFull, parts,
      candidates: parts.length ? [{ content: { role: 'model', parts }, finishReason }] : [],
      usage, usageMetadata: usage
    };
  }

  async listModels(key) {
    if (key) {
      try {
        await this.raw('auth/key', { key, timeoutMs: 15000 });
      } catch (e) {
        if (e.kind === 'invalid') throw e;
      }
    }
    const out = OPENROUTER_ALLOWLIST.map((m) => Object.assign({}, m));
    const seen = new Set(out.map((m) => m.id));
    try {
      const res = await this.raw('models', { key, timeoutMs: 15000 });
      const json = await res.json();
      const rawModels = (json && Array.isArray(json.data)) ? json.data : [];
      const discovered = [];
      for (const rm of rawModels) {
        const id = stripModelPrefix(rm && rm.id);
        if (!id || !isModernOpenRouterModelId(id)) continue;
        discovered.push(id);
        if (!seen.has(id)) {
          seen.add(id);
          out.push({
            id,
            name: 'models/' + id,
            displayName: (rm && rm.name) || id,
            description: 'Active OpenRouter 2026 model',
            methods: ['generateContent'],
            inputTokenLimit: (rm && rm.context_length) || 200000,
            outputTokenLimit: 16384,
            thinking: !/(?:flash-lite|haiku|luna)/i.test(id)
          });
        }
      }
      if (discovered.length) LIVE_OPENROUTER_MODELS = discovered;
    } catch (e) {
      if (e.kind === 'invalid') throw e;
    }
    return out;
  }

  async validate(key, preferredModel) {
    const result = { status: 'unknown', icon: '', title: '', message: '', models: [], match: null, testModel: null, usage: null, steps: [], provider: 'openrouter' };
    let models;
    try {
      models = await this.listModels(key);
      result.steps.push({ step: 'list-models', ok: true, detail: models.length + ' OpenRouter models in allowlist' });
    } catch (e) {
      result.steps.push({ step: 'list-models', ok: false, detail: e.message });
      return Object.assign(result, { status: e.kind === 'invalid' ? 'invalid' : 'error', icon: '❌', title: e.kind === 'invalid' ? 'Invalid OpenRouter key' : 'Connection error', message: e.message });
    }
    result.models = models;
    result.match = matchPresetsForProvider('openrouter', models);

    const ids = new Set(models.map((m) => m.id));
    const cleanPref = stripModelPrefix(preferredModel || '');
    const isApiKeyStr = /^(?:sk-|AIza|AQ\.)/i.test(cleanPref);
    const testModel = (!isApiKeyStr && cleanPref && ids.has(cleanPref))
      ? cleanPref
      : (OPENROUTER_ALLOWLIST[0] ? OPENROUTER_ALLOWLIST[0].id : (models[0] && models[0].id) || 'google/gemini-3.5-flash-lite');
    result.testModel = testModel;
    try {
      const res = await this.generate(testModel, {
        contents: [{ role: 'user', parts: [{ text: 'Reply with OK' }] }],
        generationConfig: { maxOutputTokens: 16 }
      }, { key, timeoutMs: 20000 });
      result.usage = res.usage;
      result.steps.push({ step: 'test-request', ok: true, detail: testModel + ' answered cleanly' });
      return Object.assign(result, {
        status: 'valid', icon: '✅',
        title: 'OpenRouter Key Verified · Real & Ready',
        message: 'OpenRouter API key accepted! ' + models.length + ' allowlisted models available.'
      });
    } catch (e) {
      result.steps.push({ step: 'test-request (' + testModel + ')', ok: false, detail: e.message });
      return Object.assign(result, {
        status: e.kind === 'invalid' ? 'invalid' : (e.kind === 'quota' ? 'rate' : 'error'),
        icon: e.kind === 'invalid' ? '❌' : '⚠️',
        title: e.kind === 'invalid' ? 'Invalid OpenRouter key' : 'OpenRouter Check Warning',
        message: e.message
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Unified Provider Router (wraps Gemini, OpenAI, Claude & OpenRouter) */
/* ------------------------------------------------------------------ */

class ProviderRouter {
  constructor(getKey, getProvider) {
    this.getKey = getKey;
    this.getProvider = getProvider || (() => detectKeyProvider(getKey()));
    this.gemini = new GeminiClient(getKey);
    const record = (model, meta) => this.gemini.recordUsage(model, meta);
    this.openai = new OpenAIClient(getKey, record);
    this.anthropic = new AnthropicClient(getKey, record);
    this.openrouter = new OpenRouterClient(getKey, record);
  }

  get usage() { return this.gemini.usage; }
  onUsage(fn) { return this.gemini.onUsage(fn); }
  resetUsage() { return this.gemini.resetUsage(); }
  recordUsage(model, meta) { return this.gemini.recordUsage(model, meta); }

  activeProvider(overrideKey) {
    if (overrideKey) return detectKeyProvider(overrideKey);
    const k = this.getKey();
    if (k) return detectKeyProvider(k);
    return this.getProvider() || 'gemini';
  }

  clientFor(provider) {
    if (provider === 'openai') return this.openai;
    if (provider === 'anthropic') return this.anthropic;
    if (provider === 'openrouter') return this.openrouter;
    return this.gemini;
  }

  async listModels(key) {
    const prov = this.activeProvider(key);
    return await this.clientFor(prov).listModels(key);
  }

  async validate(key, preferredModel) {
    const prov = this.activeProvider(key);
    const res = await this.clientFor(prov).validate(key, preferredModel);
    res.provider = prov;
    res.providerInfo = providerMeta(prov);
    if (!res.match) res.match = matchPresetsForProvider(prov, res.models || []);
    return res;
  }

  async generate(model, body, opts) {
    const prov = this.activeProvider(opts && opts.key);
    const cleanBody = prov === 'gemini' ? stripToolIdsForGemini(body) : body;
    return await this.clientFor(prov).generate(model, cleanBody, opts);
  }

  async stream(model, body, opts) {
    const prov = this.activeProvider(opts && opts.key);
    const cleanBody = prov === 'gemini' ? stripToolIdsForGemini(body) : body;
    return await this.clientFor(prov).stream(model, cleanBody, opts);
  }
}

function stripToolIdsForGemini(payload) {
  if (!payload || !Array.isArray(payload.contents)) return payload;
  const copy = Object.assign({}, payload);
  copy.contents = payload.contents.map((turn) => {
    if (!turn || !Array.isArray(turn.parts)) return turn;
    return Object.assign({}, turn, {
      parts: turn.parts.map((p) => {
        if (p && p.functionResponse && p.functionResponse.id !== undefined) {
          const fr = Object.assign({}, p.functionResponse);
          delete fr.id;
          return Object.assign({}, p, { functionResponse: fr });
        }
        return p;
      })
    });
  });
  return copy;
}

for (const C of [OpenAIClient, AnthropicClient, OpenRouterClient]) {
  C.prototype._goodSet = function (model, cand) { if (!this._good) this._good = new Map(); this._good.set(model, cand); };
  C.prototype._orderGood = function (model, list) {
    const g = this._good && this._good.get(model);
    return g ? [g].concat(list.filter((c) => c !== g)) : list;
  };
}

module.exports = {
  ProviderRouter,
  OpenAIClient,
  AnthropicClient,
  OpenRouterClient,
  GEMINI_PRESETS,
  OPENAI_PRESETS,
  ANTHROPIC_PRESETS,
  OPENROUTER_PRESETS,
  detectKeyProvider,
  providerMeta,
  matchPresetsForProvider,
  isModernOpenAIModelId,
  isModernAnthropicModelId,
  isModernOpenRouterModelId
};
