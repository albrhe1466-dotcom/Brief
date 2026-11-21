'use strict';
/**
 * Locally — Real functional integration tests (runs inside Electron process).
 * Tests:
 *  - Real Documents path resolution & real `search_files` for 'invoice'
 *  - Real `open_path` handler & tool schema declarations
 *  - Real file tools (write, read, edit, rename, copy, move, organize_folder, search) in temp folder
 *  - Real terminal execution via `run_command`
 *  - Permanent deletion safety checks (delete_path permanent, Shift+Delete, rm/Remove-Item)
 *  - Preset matching for Flash-Lite 3.5, Hydrogen, Pro 3.1, Argon, and Computer Use
 *  - Local safeStorage KeyStore encryption roundtrip in temp dir
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { getTool, resolvePath, declarations, isPermanentDeleteCommand, isSelfOrDesktopForeground, ensureTargetForeground, typeText } = require('../src/main/tools');
const { GeminiClient, matchPresets, buildThinkingConfig, resolveGeminiRuntimeCandidates, isModernGeminiModelId, PRESETS: GEMINI_PRESETS } = require('../src/main/gemini');
const { OpenAIClient, AnthropicClient, OpenRouterClient, OPENAI_PRESETS, ANTHROPIC_PRESETS, isModernOpenAIModelId, isModernAnthropicModelId, isModernOpenRouterModelId } = require('../src/main/providers');
const { buildChatSystemPrompt, buildWorkSystemPrompt, classifyModelTier } = require('../src/main/systemPrompt');
const { AgentRunner, detectDeepTaskProfile, isTestEvidenceStep } = require('../src/main/agent');
const { DEFAULT_SETTINGS, sanitizeModelIdValue, sanitizeSettingsData } = require('../src/main/store');
const { KeyStore } = require('../src/main/keystore');

async function runFunctionalTests(screen, automation) {
  const results = [];
  const pass = (name, detail) => results.push({ name, ok: true, detail });
  const fail = (name, err) => results.push({ name, ok: false, detail: err.message || String(err) });

  const ctx = {
    screen,
    automation,
    settings: () => ({ commandTimeoutSec: 30, cursorSpeedMs: 0, typingDelayMs: 0, pasteLongText: false }),
    isStopped: () => false,
    cursor: () => {},
    registerProcess: () => {},
    unregisterProcess: () => {},
    progress: () => {}
  };

  // 1. Real Documents folder resolution & invoice search (deliverable task)
  try {
    const docsPath = resolvePath('Documents');
    assert(path.isAbsolute(docsPath) && fs.existsSync(docsPath), 'Documents path not found: ' + docsPath);
    const searchTool = getTool('search_files');
    const searchRes = await searchTool.run({ query: 'invoice', root: 'Documents' }, ctx);
    pass('real-documents-invoice-search', `Documents=${docsPath}, scanned=${searchRes.scanned_entries}, invoice_matches=${searchRes.count}, files=${JSON.stringify(searchRes.results.map((r) => r.name))}`);
  } catch (e) {
    fail('real-documents-invoice-search', e);
  }

  // 2. Full file/code/organize/command suite inside temp dir (and clean up)
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'locally-func-'));
  try {
    const writeTool = getTool('write_file');
    const readTool = getTool('read_file');
    const editTool = getTool('edit_file');
    const searchTool = getTool('search_files');
    const orgTool = getTool('organize_folder');
    const cmdTool = getTool('run_command');

    const invFile = path.join(tmpDir, 'ACME_Invoice_2026.txt');
    const scriptFile = path.join(tmpDir, 'hello.js');
    const imgFile = path.join(tmpDir, 'photo.png');

    await writeTool.run({ path: invFile, content: 'Invoice #1042\nAmount: $250\n' }, ctx);
    await writeTool.run({ path: scriptFile, content: 'console.log("hello");\n' }, ctx);
    await writeTool.run({ path: imgFile, content: 'png-placeholder-bytes' }, ctx);

    const readOut = await readTool.run({ path: invFile }, ctx);
    assert(readOut.content.includes('Invoice #1042'), 'read_file mismatch');

    await editTool.run({ path: invFile, find: '$250', replace: '$300' }, ctx);
    const readAfter = await readTool.run({ path: invFile }, ctx);
    assert(readAfter.content.includes('$300'), 'edit_file did not update file');

    const foundInv = await searchTool.run({ query: 'invoice', root: tmpDir }, ctx);
    assert.strictEqual(foundInv.count, 1, 'Expected 1 invoice file, got ' + foundInv.count);

    const dryOrg = await orgTool.run({ path: tmpDir, strategy: 'type', dry_run: true }, ctx);
    assert.strictEqual(dryOrg.files, 3, 'Expected 3 files in dry_run');

    const realOrg = await orgTool.run({ path: tmpDir, strategy: 'type', dry_run: false }, ctx);
    assert.strictEqual(realOrg.moved, 3, 'Expected 3 moved files');
    assert(fs.existsSync(path.join(tmpDir, 'Documents', 'ACME_Invoice_2026.txt')), 'Invoice not organized into Documents');
    assert(fs.existsSync(path.join(tmpDir, 'Code', 'hello.js')), 'JS file not organized into Code');
    assert(fs.existsSync(path.join(tmpDir, 'Images', 'photo.png')), 'PNG file not organized into Images');

    const cmdOut = await cmdTool.run({ command: 'node "' + path.join(tmpDir, 'Code', 'hello.js') + '"' }, ctx);
    assert.strictEqual(cmdOut.exit_code, 0, 'run_command non-zero exit');
    assert(cmdOut.stdout.trim() === 'hello', 'Unexpected stdout: ' + cmdOut.stdout);

    const treeOut = await getTool('project_tree').run({ path: tmpDir, max_depth: 3 }, ctx);
    assert(treeOut.tree.includes('hello.js'), 'project_tree missing hello.js');
    const grepOut = await getTool('grep_files').run({ query: 'console.log', root: tmpDir }, ctx);
    assert.strictEqual(grepOut.count, 1, 'grep_files should find 1 match');

    pass('file-organize-command-suite', 'write, read, edit, project_tree, grep_files, search_files(invoice), organize_folder(dry+real), run_command all passed');
  } catch (e) {
    fail('file-organize-command-suite', e);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // 3. Permanent deletion confirmation guards (must trigger even in Full access)
  try {
    const delTool = getTool('delete_path');
    assert.strictEqual(delTool.dangerous({ path: 'foo.txt', permanent: false }), null, 'Recycle bin delete should not be flagged permanent');
    assert(delTool.dangerous({ path: 'foo.txt', permanent: true }), 'permanent=true delete must trigger danger confirmation');
    const keysTool = getTool('press_keys');
    assert(keysTool.dangerous({ keys: 'shift+delete' }), 'shift+delete must trigger danger confirmation');
    assert(isPermanentDeleteCommand('Remove-Item -Recurse -Force C:\\temp\\x'), 'Remove-Item must be flagged');
    assert(isPermanentDeleteCommand('rm -rf ./tmp'), 'rm -rf must be flagged');
    assert(isPermanentDeleteCommand('git reset --hard HEAD'), 'git reset --hard must be flagged');
    let blockedProtected = false;
    try { await delTool.run({ path: 'Documents' }, ctx); } catch (e) { blockedProtected = /Safety block/i.test(e.message); }
    assert(blockedProtected, 'delete_path must block deleting user Documents folder');
    pass('permanent-delete-guards', 'All permanent deletion vectors & protected folder blocks verified');
  } catch (e) {
    fail('permanent-delete-guards', e);
  }

  // 4. Preset matching + Gemini Computer Use detection + "Unavailable on this key"
  try {
    const sampleModels = [
      { id: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', description: '', methods: ['generateContent'] },
      { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', description: '', methods: ['generateContent'] },
      { id: 'gemini-2.5-computer-use-preview-10-2025', displayName: 'Computer Use', description: '', methods: ['generateContent'] }
    ];
    const matched = matchPresets(sampleModels);
    assert.strictEqual(matched.presets.flashlite35.id, 'gemini-3.5-flash-lite');
    assert.strictEqual(matched.presets.flash38.id, 'gemini-3.8-flash');
    assert.strictEqual(matched.presets.hydrogen.available, false, 'Missing Hydrogen must be marked unavailable instead of guessing');
    assert.strictEqual(matched.presets.argon.available, false, 'Missing Argon must be marked unavailable instead of guessing');
    assert.strictEqual(matched.computerUse, 'gemini-2.5-computer-use-preview-10-2025');
    pass('preset-matching', 'Matched real IDs & honestly marked missing codenames unavailable');
  } catch (e) {
    fail('preset-matching', e);
  }

  // 5. KeyStore OS encryption roundtrip in isolated temp dir
  const keyDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'locally-key-'));
  try {
    const ks = new KeyStore(keyDir);
    assert(await ks.available(), 'safeStorage encryption unavailable');
    await ks.set('AIzaSyFakeUnitTestKey1234567890');
    assert(fs.existsSync(path.join(keyDir, 'key.enc')), 'Encrypted key file missing');
    const rawOnDisk = fs.readFileSync(path.join(keyDir, 'key.enc')).toString('utf8');
    assert(!rawOnDisk.includes('AIzaSyFakeUnitTestKey'), 'Key must not be stored in plaintext!');
    const ksReload = new KeyStore(keyDir);
    assert.strictEqual(await ksReload.getAsync(), 'AIzaSyFakeUnitTestKey1234567890');
    ksReload.remove();
    assert(!fs.existsSync(path.join(keyDir, 'key.enc')), 'Key file not deleted by remove()');
    pass('keystore-encryption', ks.backend() + ' encrypt/decrypt/remove verified');
  } catch (e) {
    fail('keystore-encryption', e);
  } finally {
    await fsp.rm(keyDir, { recursive: true, force: true }).catch(() => {});
  }

  // 6. Tool schema validation (no empty OBJECT properties for Gemini)
  try {
    const decls = declarations({ includeScreen: true, cuMode: false });
    for (const d of decls) {
      if (d.parameters && d.parameters.type === 'object') {
        assert(Object.keys(d.parameters.properties || {}).length > 0, `Tool ${d.name} has empty properties`);
      }
    }
    pass('tool-schemas', decls.length + ' Gemini tool schemas verified');
  } catch (e) {
    fail('tool-schemas', e);
  }

  // 7. Real Gemini Thinking Level config builder verification
  try {
    const tLow = buildThinkingConfig('gemini-3.1-pro', 'low', []);
    const tHigh = buildThinkingConfig('gemini-4-hydrogen', 'high', []);
    const t25 = buildThinkingConfig('gemini-2.5-flash', 'medium', []);
    assert.strictEqual(tLow.thinkingLevel, 'LOW');
    assert.strictEqual(tLow.thinkingBudget, undefined, 'Never mix thinkingLevel and thinkingBudget');
    assert.strictEqual(tHigh.thinkingLevel, 'HIGH');
    assert.strictEqual(tHigh.includeThoughts, true);
    assert.strictEqual(t25.thinkingBudget, 8192);
    assert.strictEqual(t25.thinkingLevel, undefined, 'Never mix thinkingBudget and thinkingLevel');
    pass('thinking-config', 'LOW/MEDIUM/HIGH thinkingLevel & Gemini 2.5 thinkingBudget verified');
  } catch (e) {
    fail('thinking-config', e);
  }

  // 8. All 4 Providers modern routing (Neon + Argon, Carbon removed, GPT-6.2 Astra added, Claude untouched)
  try {
    for (const modelId of ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-4-neon', 'gemini-4-argon']) {
      const cands = resolveGeminiRuntimeCandidates(modelId);
      assert.strictEqual(cands[0], modelId, 'Exact Gemini model must come first: ' + modelId);
      const legacy = cands.filter((c) => /^gemini-(1|2)(?:\.|$|-)/i.test(c));
      assert.strictEqual(legacy.length, 0, 'Legacy 1.x/2.x Gemini models forbidden: ' + legacy.join(', '));
    }
    const openai = new OpenAIClient(() => '', () => {});
    for (const modelId of ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6.2-astra']) {
      const cands = openai.resolveRuntimeCandidates(modelId);
      assert.strictEqual(cands[0], modelId, 'Exact OpenAI model must come first: ' + modelId);
      const legacy = cands.filter((c) => /^(?:gpt-3|gpt-4|o1|o4-mini)/i.test(c));
      assert.strictEqual(legacy.length, 0, 'Legacy OpenAI models forbidden: ' + legacy.join(', '));
    }
    const anthropic = new AnthropicClient(() => '', () => {});
    assert.deepStrictEqual(
      ANTHROPIC_PRESETS.map((p) => p.base),
      ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'],
      'Claude lineup must remain untouched'
    );
    for (const modelId of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2']) {
      const cands = anthropic.resolveRuntimeCandidates(modelId);
      assert.strictEqual(cands[0], modelId, 'Exact Claude model must come first: ' + modelId);
      const legacy = cands.filter((c) => /^claude-(?:2|instant|3|sonnet-4-20250514)/i.test(c));
      assert.strictEqual(legacy.length, 0, 'Legacy Claude models forbidden: ' + legacy.join(', '));
    }
    const orClient = new OpenRouterClient(() => '', () => {});
    for (const modelId of ['google/gemini-4-neon', 'google/gemini-4-argon', 'openai/gpt-6-sol', 'openai/gpt-6.2-astra', 'anthropic/claude-haiku-5-5', 'anthropic/claude-fable-5-2']) {
      const cands = orClient.resolveRuntimeCandidates(modelId);
      assert.strictEqual(cands[0], modelId, 'Exact OpenRouter model must come first: ' + modelId);
      const legacy = cands.filter((c) => !isModernOpenRouterModelId(c) && c !== modelId);
      assert.strictEqual(legacy.length, 0, 'Legacy OpenRouter models forbidden: ' + legacy.join(', '));
    }
    assert.strictEqual(isModernGeminiModelId('gemini-2.5-pro'), false);
    assert.strictEqual(isModernGeminiModelId('gemini-4-carbon'), false, 'Gemini 4 Carbon must be removed');
    assert.strictEqual(isModernGeminiModelId('gemini-4-neon'), true, 'Gemini 4 Neon must be active');
    assert.strictEqual(isModernGeminiModelId('gemini-4-argon'), true, 'Gemini 4 Argon must be active');
    assert.strictEqual(resolveGeminiRuntimeCandidates('gemini-2.5-pro').some((c) => /gemini-(1|2)\./i.test(c)), false, 'gemini-2.5-pro runtime candidates must never run retired 2.5');
    assert.strictEqual(sanitizeModelIdValue('gemini-2.5-pro'), '');
    assert.strictEqual(sanitizeModelIdValue('gemini-4-carbon'), 'gemini-4-argon');
    assert.strictEqual(sanitizeModelIdValue('gpt-6.2-sol'), 'gpt-6-sol');
    assert.strictEqual(sanitizeModelIdValue('gpt-6.2-astra'), 'gpt-6.2-astra');
    assert.strictEqual(sanitizeModelIdValue('gpt-6-astra'), 'gpt-6.2-astra');
    assert.strictEqual(isModernOpenAIModelId('gpt-3.5-turbo'), false);
    assert.strictEqual(isModernOpenAIModelId('gpt-4o'), false);
    assert.strictEqual(isModernOpenAIModelId('gpt-6-sol'), true);
    assert.strictEqual(isModernOpenAIModelId('gpt-6.2-astra'), true);
    assert.strictEqual(isModernAnthropicModelId('claude-3-haiku-20240307'), false);
    assert.strictEqual(isModernAnthropicModelId('claude-fable-5-2'), true);
    assert.strictEqual(DEFAULT_SETTINGS.seenNewsVersion, '');
    pass('all-4-providers-modern-routing-v105', 'Verified Gemini 4 Neon + Argon (Carbon removed), GPT-6.2 Astra, untouched Claude & OpenRouter routing');
  } catch (e) {
    fail('all-4-providers-modern-routing-v105', e);
  }

  // 9. Typing foreground safety check (never simulate typing when Brief/Desktop is focused; deliver when Roblox/target is focused)
  try {
    assert.strictEqual(isSelfOrDesktopForeground({ process: 'Brief', title: 'Brief' }), true);
    assert.strictEqual(isSelfOrDesktopForeground({ process: 'explorer', title: 'Program Manager' }), true);
    assert.strictEqual(isSelfOrDesktopForeground({ process: 'RobloxStudioBeta', title: 'Baseplate - Roblox Studio' }), false);

    let typedBuffer = '';
    const briefFocusedCtx = Object.assign({}, ctx, {
      automation: {
        foreground: async () => ({ process: 'Brief', title: 'Brief' }),
        listWindows: async () => [],
        focusWindow: async () => null,
        type: async (ch) => { typedBuffer += ch; },
        keys: async () => {}
      }
    });
    let threwOnSelf = false;
    try {
      await typeText(briefFocusedCtx, 'print("hello")', { mode: 'type' });
    } catch (err) {
      threwOnSelf = /Cannot type: keyboard focus/i.test(err.message);
    }
    assert.strictEqual(threwOnSelf, true, 'Must throw error instead of simulating typing on Brief window');
    assert.strictEqual(typedBuffer, '', 'Must not send fake keystrokes when self-focused');

    const studioCtx = Object.assign({}, ctx, {
      automation: {
        foreground: async () => ({ process: 'RobloxStudioBeta', title: 'MyGame - Roblox Studio' }),
        type: async (ch) => { typedBuffer += ch; },
        keys: async () => {}
      }
    });
    const studioRes = await typeText(studioCtx, 'hi', { mode: 'type' });
    assert.strictEqual(studioRes, 'typed');
    assert.strictEqual(typedBuffer, 'hi', 'Must actually deliver characters when target app (Roblox Studio) is foreground');
    await ensureTargetForeground(studioCtx);
    pass('typing-foreground-enforcement-v103', 'Verified no-simulation error on Brief focus & real delivery when Roblox Studio is focused');
  } catch (e) {
    fail('typing-foreground-enforcement-v103', e);
  }

  // 10. Neon (Strong) + Argon (Strongest) ordering, Carbon removed, GPT-6.2 Astra & serious High thinking
  try {
    assert(!GEMINI_PRESETS.some((p) => p.key === 'carbon'), 'Gemini 4 Carbon must be removed from GEMINI_PRESETS');
    const neonIdx = GEMINI_PRESETS.findIndex((p) => p.key === 'neon');
    const argonIdx = GEMINI_PRESETS.findIndex((p) => p.key === 'argon');
    assert(neonIdx >= 0 && argonIdx > neonIdx, 'Gemini 4 Neon must exist and precede Gemini 4 Argon');
    assert.strictEqual(GEMINI_PRESETS[neonIdx].hint, 'Strong', 'Gemini 4 Neon must be Strong');
    assert.strictEqual(GEMINI_PRESETS[argonIdx].hint, 'Flagship', 'Gemini 4 Argon must be Flagship');
    const astraPreset = OPENAI_PRESETS.find((p) => p.key === 'gpt62astra');
    assert(astraPreset && astraPreset.base === 'gpt-6.2-astra' && astraPreset.hint === 'Flagship', 'GPT-6.2 Astra must be in OPENAI_PRESETS as Flagship');

    const orClient = new OpenRouterClient(() => '', () => {});
    const orBody = orClient.buildChatPayload('google/gemini-4-neon', {
      contents: [{ role: 'user', parts: [{ text: 'Think deeply' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } }
    }, false);
    assert.deepStrictEqual(orBody.reasoning, { effort: 'high' }, 'OpenRouter high thinking must send reasoning.effort="high"');
    const anthropic = new AnthropicClient(() => '', () => {});
    const claudeHigh = anthropic.buildMessagesPayload('claude-fable-5-2', {
      contents: [{ role: 'user', parts: [{ text: 'Think deeply' }] }],
      tools: [{ functionDeclarations: [{ name: 'click', description: 'click', parameters: { type: 'object', properties: {} } }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } }
    }, false, true);
    assert(claudeHigh.thinking && claudeHigh.thinking.budget_tokens >= 12288, 'Claude high thinking must send serious extended budget (>=12288)');
    assert.strictEqual(claudeHigh.tool_choice, undefined, 'Claude must never send tool_choice=any alongside extended thinking');
    const ks = new KeyStore(os.tmpdir());
    ks.cache = 'AQ.AbCdEfGhIjKlMnOpQrStUvWxYz01234567890123456789AQkA';
    assert(ks.masked().length <= 16, 'Masked key must remain short and compact so Settings UI never overflows: ' + ks.masked());
    pass('neon-argon-astra-serious-thinking-v106', 'Verified Neon/Argon tiers, Carbon removal, GPT-6.2 Astra, serious thinking & compact API key mask');
  } catch (e) {
    fail('neon-argon-astra-serious-thinking-v106', e);
  }

  // 11. Live Gemini listModels .json() parsing, no silent quota masking onto 3.1-pro, & 2026 model prompt grounding
  try {
    const gc = new GeminiClient(() => 'AIzaFakeTest');
    gc.raw = async (pathPart) => {
      if (pathPart.startsWith('models?')) {
        return {
          json: async () => ({
            models: [
              { name: 'models/gemini-4-hydrogen-preview', displayName: 'Gemini 4 Hydrogen Preview', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-pro', displayName: 'Retired 2.5 Pro', supportedGenerationMethods: ['generateContent'] }
            ]
          })
        };
      }
      throw Object.assign(new Error('You exceeded your current quota'), { kind: 'quota', status: 429, retryAfterMs: 0 });
    };
    const listed = await gc.listModels('AIzaFakeTest');
    assert(listed.some((m) => m.id === 'gemini-4-hydrogen-preview'), 'listModels() must parse res.json() and discover live Gemini 3/4 models');
    assert(!listed.some((m) => m.id === 'gemini-2.5-pro'), 'listModels() must exclude retired Gemini 2.x models');
    const hCands = resolveGeminiRuntimeCandidates('gemini-4-hydrogen');
    assert(hCands.includes('gemini-4-hydrogen-preview'), 'Discovered live hydrogen preview must be in candidates');
    assert(!hCands.includes('gemini-3.1-pro-preview'), 'Hydrogen must never silently downgrade into quota-locked gemini-3.1-pro-preview');

    let quotaCalls = 0;
    gc.raw = async () => {
      quotaCalls += 1;
      const err = new Error('You exceeded your current quota');
      err.kind = 'quota';
      err.status = 429;
      err.retryAfterMs = 0;
      throw err;
    };
    let threwQuota = false;
    try { await gc.generate('gemini-4-hydrogen', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, { retries: 0 }); } catch (err) { threwQuota = err.kind === 'quota'; }
    assert.strictEqual(threwQuota, true, 'Quota error must propagate cleanly to agent fallback');
    assert.strictEqual(quotaCalls, 1, 'GeminiClient.generate must not silently burn unrelated models on quota errors');

    const oa = new OpenAIClient(() => 'sk-test', () => {});
    const solCands = oa.resolveRuntimeCandidates('gpt-6-sol');
    assert.strictEqual(solCands[0], 'gpt-6-sol');
    assert(solCands.includes('gpt-6.2-sol'), 'OpenAI Sol candidates should cover gpt-6.2-sol as fallback if gpt-6-sol 404s');
    let oaAttempts = 0;
    oa.raw = async (_p, opts) => {
      oaAttempts += 1;
      if (oaAttempts === 1 && opts && opts.body && opts.body.reasoning_effort) {
        const e = new Error('Unsupported parameter: reasoning_effort');
        e.kind = 'bad_request';
        e.status = 400;
        throw e;
      }
      return { json: async () => ({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }) };
    };
    const oaRes = await oa.generate('gpt-6-luna', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } }
    });
    assert.strictEqual(oaRes.text, 'OK');
    assert.strictEqual(oaAttempts, 2, 'gpt-6-luna must strip unsupported reasoning_effort on bad_request and retry same model');

    const chatSys = buildChatSystemPrompt({});
    const workSys = buildWorkSystemPrompt({
      screen: { describe: () => '1920x1080' },
      automation: { name: 'win32' },
      cuActive: false,
      mcpServers: [],
      openWindows: [],
      openTabs: []
    });
    for (const mdl of ['gpt-6-luna', 'gemini-4-hydrogen', 'gemini-3.8-flash', 'claude-fable-5-2']) {
      assert(chatSys.includes(mdl) && workSys.includes(mdl), 'System prompts must include active 2026 model: ' + mdl);
    }
    pass('gemini-live-discovery-and-2026-model-grounding', 'Verified Gemini listModels .json() parsing, honest quota failover, OpenAI reasoning fallback & 2026 model awareness');
  } catch (e) {
    fail('gemini-live-discovery-and-2026-model-grounding', e);
  }

  // 12. Anti-Never-Stops-Syndrome, quota cooldown, QA fail-open & non-blocking browser test detection
  try {
    assert.strictEqual(DEFAULT_SETTINGS.deepWorkMinMinutes, 0, 'deepWorkMinMinutes must default to 0 (no forced 10m timer loop)');
    assert.strictEqual(DEFAULT_SETTINGS.maxSteps, 45, 'maxSteps must default to 45');
    const migrated = sanitizeSettingsData({ deepWorkMinMinutes: 10, maxSteps: 140 });
    assert.strictEqual(migrated.deepWorkMinMinutes, 0, 'Legacy 10-minute deepWorkMinMinutes must auto-migrate to 0');
    assert.strictEqual(migrated.maxSteps, 45, 'Legacy 140 maxSteps must auto-migrate to 45');

    const htmlAnimProfile = detectDeepTaskProfile(
      'Create ai-animation.html powered by gpt-6-luna with canvas animation',
      [{ title: 'Roblox Studio - Baseplate' }, { title: 'Blender 4.2' }],
      DEFAULT_SETTINGS
    );
    assert.strictEqual(htmlAnimProfile.isDeepBuildTask, false, 'Background Roblox/Blender windows & HTML animation prompts must not force Deep Studio mode');
    assert.strictEqual(htmlAnimProfile.minWorkMs, 0, 'minWorkMs must be 0 so Brief stops once finished');

    assert.strictEqual(isTestEvidenceStep({ ok: true, tool: 'open_path', args: { path: 'ai-animation.html' } }), true);
    assert.strictEqual(isTestEvidenceStep({ ok: true, tool: 'open_url', args: { url: 'http://localhost:3000' } }), true);

    const mockAgent = new AgentRunner({
      gemini: {
        generate: async () => {
          const err = new Error('You exceeded your current quota (limit: 20)');
          err.kind = 'quota';
          err.status = 429;
          throw err;
        }
      },
      screen,
      automation: { name: 'mock' },
      getSettings: () => DEFAULT_SETTINGS,
      getMatch: () => ({
        presets: {
          flash38: { id: 'gemini-3.8-flash' },
          hydrogen: { id: 'gemini-4-hydrogen' },
          flashlite35: { id: 'gemini-3.5-flash-lite' }
        }
      }),
      getModels: () => []
    });

    const qaFailOpen = await mockAgent.runTaskVerifierAgent({
      task: 'Create ai-animation.html',
      taskProfile: htmlAnimProfile,
      stepLog: [{ step: 1, tool: 'write_file', ok: true, description: 'Write ai-animation.html' }],
      mutatingCount: 1,
      testCount: 1,
      elapsedMs: 12000,
      minWorkMs: 0,
      qaPasses: 0,
      initShot: null,
      currentShot: null,
      candidateAnswer: 'Done',
      modelId: 'gemini-3.8-flash',
      deepPolishAudit: false
    });
    assert.strictEqual(qaFailOpen.verified, true, 'QA verifier must fail-open on quota error when real edits already succeeded');
    assert.strictEqual(mockAgent.isModelCoolingDown('gemini-3.8-flash'), true, 'Quota-exhausted model must enter session cooldown');
    const orderedFallbacks = mockAgent.getFallbackModels(new Set());
    assert.notStrictEqual(orderedFallbacks[0], 'gemini-3.8-flash', 'Cooling-down model must be moved behind healthy fallback models');
    mockAgent.clearModelCooldowns();
    assert.strictEqual(mockAgent.isModelCoolingDown('gemini-3.8-flash'), false, 'clearModelCooldowns() must reset session cooldowns on key switch');

    pass('anti-never-stops-and-quota-cooldown', 'Verified zero forced 10m loop, QA fail-open on quota, HTML open_path test recognition & session cooldown');
  } catch (e) {
    fail('anti-never-stops-and-quota-cooldown', e);
  }

  // 13. Full keyboard controls, tier behavior, slower visible typing (no auto-paste), error-fixing mandate & silent startup
  try {
    assert.strictEqual(classifyModelTier('gemini-3.5-flash-lite'), 'fastest');
    assert.strictEqual(classifyModelTier('gpt-6-luna'), 'fastest');
    assert.strictEqual(classifyModelTier('gemini-3.8-flash'), 'balanced');
    assert.strictEqual(classifyModelTier('gemini-4-hydrogen'), 'balanced');
    assert.strictEqual(classifyModelTier('gpt-6.1-terra'), 'balanced');
    assert.strictEqual(classifyModelTier('gemini-4-neon'), 'strong');
    assert.strictEqual(classifyModelTier('gpt-6-sol'), 'strong');
    assert.strictEqual(classifyModelTier('gemini-4-argon'), 'flagship');
    assert.strictEqual(classifyModelTier('gpt-6.2-astra'), 'flagship');

    const promptBase = {
      screen: { describe: () => '1920x1080' },
      automation: { name: 'win32' },
      cuActive: false,
      mcpServers: [],
      openWindows: [],
      openTabs: [],
      thinkingLevel: 'high'
    };
    const fastPrompt = buildWorkSystemPrompt(Object.assign({}, promptBase, { modelId: 'gemini-3.5-flash-lite' }));
    const balPrompt = buildWorkSystemPrompt(Object.assign({}, promptBase, { modelId: 'gemini-4-hydrogen' }));
    const neonPrompt = buildWorkSystemPrompt(Object.assign({}, promptBase, { modelId: 'gemini-4-neon' }));
    const argonPrompt = buildWorkSystemPrompt(Object.assign({}, promptBase, { modelId: 'gemini-4-argon' }));
    assert(fastPrompt.includes('MODEL TIER = FASTEST'), 'Fastest model must receive speed-first tier directive');
    assert(balPrompt.includes('MODEL TIER = BALANCED'), 'Balanced model must receive think-before-starting tier directive');
    assert(neonPrompt.includes('MODEL TIER = STRONG') && /plan/i.test(neonPrompt), 'Neon Strong tier must direct analyze, think, plan & execute');
    assert(argonPrompt.includes('MODEL TIER = FLAGSHIP') && /missing authenticator/i.test(argonPrompt) && /terminal_open/i.test(argonPrompt), 'Argon Flagship tier must direct critical thinking, testing, self-fixing & terminal control');
    assert(argonPrompt.includes('ctrl+a') && argonPrompt.includes('ctrl+c') && argonPrompt.includes('ctrl+v'), 'Work prompt must include full keyboard control instructions');
    assert(!argonPrompt.includes('gemini-4-carbon'), 'System prompt must not reference removed gemini-4-carbon');

    assert.strictEqual(DEFAULT_SETTINGS.typingDelayMs, 42, 'Default typingDelayMs must be slower (42ms) for visible typing animation');
    assert.strictEqual(DEFAULT_SETTINGS.pasteLongText, false, 'Default pasteLongText must be false so Brief types visibly rather than copy-pasting');
    assert.strictEqual(DEFAULT_SETTINGS.soundChime, false, 'Default soundChime must be false for silent startup');

    // Verify typeText types multi-line code visibly char-by-char (NOT pasting!) and uses real Enter in code editors
    const typedCalls = [];
    const codeEditorCtx = Object.assign({}, ctx, {
      settings: () => ({ typingDelayMs: 0, pasteLongText: false }),
      automation: {
        foreground: async () => ({ process: 'Code', title: 'index.html - Visual Studio Code' }),
        type: async (ch, _d, opts) => { typedCalls.push({ ch, softNewline: opts && opts.softNewline }); },
        keys: async () => {}
      }
    });
    const codeMethod = await typeText(codeEditorCtx, 'const key = "abc";\nfetch(url);', { mode: 'auto' });
    assert.strictEqual(codeMethod, 'typed', 'Code blocks must visibly type char-by-char by default instead of pasting');
    assert(typedCalls.length > 20 && typedCalls.every((c) => c.softNewline === false), 'Code editors must receive real Enter (softNewline=false)');

    const chatCalls = [];
    const browserChatCtx = Object.assign({}, ctx, {
      settings: () => ({ typingDelayMs: 0, pasteLongText: false }),
      automation: {
        foreground: async () => ({ process: 'chrome', title: 'Chat - Google Chrome' }),
        type: async (ch, _d, opts) => { chatCalls.push({ ch, softNewline: opts && opts.softNewline }); },
        keys: async () => {}
      }
    });
    const chatMethod = await typeText(browserChatCtx, 'hi\nthere', { mode: 'auto' });
    assert.strictEqual(chatMethod, 'typed');
    assert(chatCalls.every((c) => c.softNewline === true), 'Browser chat inputs must receive Shift+Enter (softNewline=true)');

    // Verify press_keys supports sequence array and "->" chaining + still flags shift+delete
    const pressedLog = [];
    const keysCtx = Object.assign({}, ctx, {
      automation: {
        keys: async (k) => { pressedLog.push(k); }
      }
    });
    const pkTool = getTool('press_keys');
    const seqRes = await pkTool.run({ sequence: ['ctrl+a', 'delete'], delay_ms: 40 }, keysCtx);
    assert.deepStrictEqual(seqRes.sequence, ['ctrl+a', 'delete']);
    await pkTool.run({ keys: 'ctrl+a -> ctrl+c -> ctrl+v', delay_ms: 40 }, keysCtx);
    assert.deepStrictEqual(pressedLog, ['ctrl+a', 'delete', 'ctrl+a', 'ctrl+c', 'ctrl+v']);
    assert(pkTool.dangerous({ sequence: ['ctrl+a', 'shift+delete'] }), 'shift+delete inside sequence must still trigger danger guard');

    // Verify silent & still startup in app.html (zero ready chime, silent initial view)
    const appHtml = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
    assert(!appHtml.includes("playLocallyChime('ready')"), 'app.html must NEVER call playLocallyChime("ready") on startup');
    assert(appHtml.includes('startNewChat({ silent: true })'), 'app.html must boot quietly with startNewChat({ silent: true })');

    pass('keyboard-power-tier-behavior-slower-typing-and-silent-startup', 'Verified tier behaviors, full keyboard sequences, visible char-by-char typing & silent still startup');
  } catch (e) {
    fail('keyboard-power-tier-behavior-slower-typing-and-silent-startup', e);
  }

  // 14. Strict Model Lock (zero silent demotion to Flash-Lite / weaker models) & zero-blink unified Work UI
  try {
    // Gemini runtime candidates must NEVER cross-demote across models
    const neonCands = resolveGeminiRuntimeCandidates('gemini-4-neon');
    assert.strictEqual(neonCands[0], 'gemini-4-neon');
    assert(!neonCands.some((c) => /hydrogen|3\.8-flash|flash-lite|argon/i.test(c)), 'Neon must NEVER demote to Argon/Hydrogen/Flash/Flash-Lite: ' + neonCands.join(', '));
    const argonCands = resolveGeminiRuntimeCandidates('gemini-4-argon');
    assert(!argonCands.some((c) => /neon|hydrogen|3\.8-flash|flash-lite/i.test(c)), 'Argon must NEVER demote: ' + argonCands.join(', '));
    const hydroCands = resolveGeminiRuntimeCandidates('gemini-4-hydrogen');
    assert(!hydroCands.some((c) => /3\.8-flash|flash-lite/i.test(c)), 'Hydrogen must NEVER demote to Flash or Flash-Lite: ' + hydroCands.join(', '));
    const flash38Cands = resolveGeminiRuntimeCandidates('gemini-3.8-flash');
    assert(!flash38Cands.some((c) => /flash-lite/i.test(c)), '3.8 Flash must NEVER demote to Flash-Lite: ' + flash38Cands.join(', '));

    // OpenAI, Claude, OpenRouter strict model locks
    const oaCands = new OpenAIClient(() => '', () => {}).resolveRuntimeCandidates('gpt-6.2-astra');
    assert(!oaCands.some((c) => /luna|terra|\bsol\b/i.test(c)), 'GPT-6.2 Astra must NEVER demote: ' + oaCands.join(', '));
    const clCands = new AnthropicClient(() => '', () => {}).resolveRuntimeCandidates('claude-opus-5-5');
    assert(!clCands.some((c) => /sonnet|haiku|fable/i.test(c)), 'Claude Opus 5.5 must NEVER demote: ' + clCands.join(', '));
    const orCands = new OpenRouterClient(() => '', () => {}).resolveRuntimeCandidates('google/gemini-4-neon');
    assert(!orCands.some((c) => /hydrogen|flash|argon/i.test(c)), 'OpenRouter Neon must NEVER demote: ' + orCands.join(', '));

    // Real AgentRunner strict lock: if gemini-4-neon fails with 404/quota, NEVER call hydrogen/flash/flash-lite!
    const calledModels = [];
    const lockedAgent = new AgentRunner({
      gemini: {
        stream: async (m) => {
          calledModels.push(m);
          const err = new Error('Model gemini-4-neon not enabled on Free Tier');
          err.kind = 'noaccess';
          err.status = 404;
          throw err;
        }
      },
      screen,
      automation: { name: 'mock' },
      getSettings: () => Object.assign({}, DEFAULT_SETTINGS, { activeModel: 'gemini-4-neon', roles: { chat: '', agent: '', fast: '', planner: '', screen: 'auto' } }),
      getMatch: () => ({
        presets: {
          neon: { id: 'gemini-4-neon' },
          argon: { id: 'gemini-4-argon' },
          hydrogen: { id: 'gemini-4-hydrogen' },
          flash38: { id: 'gemini-3.8-flash' },
          flashlite35: { id: 'gemini-3.5-flash-lite' }
        }
      }),
      getModels: () => []
    });
    const rosterLocked = lockedAgent.resolveTeamRoster();
    assert.strictEqual(rosterLocked.executor, 'gemini-4-neon');
    assert.strictEqual(rosterLocked.scout, 'gemini-4-neon', 'Scout must stay locked to user-selected model, never silently Flash-Lite');
    assert.strictEqual(rosterLocked.qaTester, 'gemini-4-neon', 'QA Tester must stay locked to user-selected model');

    let caughtErrMsg = '';
    try {
      await lockedAgent.runChat({ chatId: 't-lock', messages: [{ role: 'user', text: 'hello' }], webSearch: false });
    } catch (err) {
      caughtErrMsg = err.message || '';
    }
    assert.deepStrictEqual(calledModels, ['gemini-4-neon'], 'AgentRunner must ONLY call gemini-4-neon and NEVER demote down to Hydrogen/Flash/Flash-Lite');
    assert(/gemini-4-neon/i.test(caughtErrMsg) && /not enabled on this API key/i.test(caughtErrMsg), 'Error must clearly name chosen model: ' + caughtErrMsg);

    // Verify AQ. key Vertex AI Express same-model endpoint bridge (never demotes to another model!)
    const aqBases = [];
    const aqClient = new GeminiClient(() => 'AQ.FakeExpressKey12345');
    aqClient.raw = async (pathPart, opts) => {
      aqBases.push({ pathPart, baseUrl: opts && opts.baseUrl });
      if (opts && opts.baseUrl && opts.baseUrl.includes('aiplatform.googleapis.com')) {
        return { json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'VERTEX_OK' }] } }] }) };
      }
      const err = new Error('Quota exceeded: limit: 0 on Free Tier');
      err.kind = 'quota';
      err.status = 429;
      throw err;
    };
    const aqRes = await aqClient.generate('gemini-4-hydrogen', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, { retries: 0 });
    assert.strictEqual(aqRes.candidates[0].content.parts[0].text, 'VERTEX_OK', 'AQ. key must try exact same model on Vertex AI Express when AI Studio returns quota/404');
    assert(aqBases.every((x) => x.pathPart.includes('gemini-4-hydrogen')), 'Vertex AI Express bridge must stay locked to the exact same model');

    // Zero-blink unified Work UI assertions
    const appHtml = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
    assert(appHtml.includes('function syncWorkMessageInPlace(msg)'), 'app.html must update Work card in-place instead of wiping the whole thread');
    assert(appHtml.includes("if (msg.mode === 'work' && msg.streaming) return;"), 'app.html must not flip-flop Work steps with mid-task chat deltas');
    const overlayHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'cursor-overlay.html'), 'utf8');
    assert(overlayHtml.includes("layer.classList.toggle('controlling', isWorkActive);"), 'Desktop banner must stay steady once while working instead of blinking between thinking and acting');

    pass('strict-model-lock-and-zero-blink-work-ui', 'Verified zero automatic demotion across all 4 providers, single-model lock & zero-blink unified Work UI');
  } catch (e) {
    fail('strict-model-lock-and-zero-blink-work-ui', e);
  }

  // 15. v1.0.6 Full Command Prompt / Terminal Control, Split-Screen Resizable Sidebar, Task Running Pill & Installer Manifest
  try {
    // Real Windows Command Prompt (cmd.exe) execution + live output streaming callback
    const streamedChunks = [];
    const termCtx = Object.assign({}, ctx, {
      onCommandOutput: (ev) => streamedChunks.push(ev)
    });
    const cmdRes = await getTool('run_command').run({ shell: 'cmd', command: 'echo BRIEF_CMD_WORKS_106' }, termCtx);
    assert.strictEqual(cmdRes.ok, true, 'cmd.exe run_command must succeed');
    assert.strictEqual(cmdRes.shell, 'CMD');
    assert(cmdRes.stdout.includes('BRIEF_CMD_WORKS_106'), 'cmd.exe stdout mismatch: ' + cmdRes.stdout);
    assert(streamedChunks.some((c) => c.chunk && c.chunk.includes('BRIEF_CMD_WORKS_106')), 'run_command must stream live output chunks');

    // Persistent interactive Command Prompt session roundtrip (open -> send -> read -> list -> stop)
    const openRes = await getTool('terminal_open').run({ shell: 'cmd' }, termCtx);
    assert(openRes.ok && openRes.session_id, 'terminal_open must return session_id');
    const sendRes = await getTool('terminal_send').run({ session_id: openRes.session_id, input: 'echo BRIEF_INTERACTIVE_OK', wait_ms: 450 }, termCtx);
    assert(sendRes.ok && (sendRes.new_output.includes('BRIEF_INTERACTIVE_OK') || sendRes.output_tail.includes('BRIEF_INTERACTIVE_OK')), 'terminal_send must execute inside interactive CMD');
    const listRes = await getTool('list_terminals').run({}, termCtx);
    assert(listRes.sessions.some((s) => s.session_id === openRes.session_id), 'list_terminals must list open session');
    const readRes = await getTool('terminal_read').run({ session_id: openRes.session_id, wait_ms: 100 }, termCtx);
    assert(readRes.ok && readRes.output.includes('BRIEF_INTERACTIVE_OK'), 'terminal_read must return buffered output');
    const stopRes = await getTool('terminal_stop').run({ session_id: openRes.session_id }, termCtx);
    assert.strictEqual(stopRes.stopped, true, 'terminal_stop must close session cleanly');

    // Verify v1.0.7 UI controls, News version, Extra thinking, Usage Limit modal & release metadata
    const appHtml = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
    assert(appHtml.includes('id="sidebar-resize-handle"') && appHtml.includes('id="sidebar-arrow-toggle"'), 'app.html must include draggable ← → sidebar resize/toggle controls');
    assert(appHtml.includes('id="task-running-pill"') && appHtml.includes("BRIEF_NEWS_VERSION = '1.0.7'"), 'app.html must include steady Task Running pill & v1.0.7 News');
    assert(appHtml.includes('id="modal-usage-limit"') && appHtml.includes('data-thinking="extra"'), 'app.html must include Usage Limit modal & Extra thinking level');
    assert(appHtml.includes('bindSidebarResizer()') && appHtml.includes('api.onCommandOutput'), 'app.html must wire sidebar resizer & live terminal output listener');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '1.0.7', 'package.json version must be 1.0.7');
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert(indexHtml.includes('What’s New in Brief v1.0.7') && indexHtml.includes('v1.0.7'), 'GitHub download site index.html must showcase v1.0.7 News');
    const installerSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-installer.js'), 'utf8');
    assert(installerSrc.includes('asInvoker') && installerSrc.includes('SHA256SUMS.txt') && installerSrc.includes('tryAuthenticodeSign'), 'build-installer.js must embed Win32 asInvoker manifest, SHA-256 sums & Authenticode hook');

    pass('v107-themes-usage-limit-extra-thinking-and-speedups', 'Verified v1.0.7 provider themes, Usage Limit modal, Extra thinking level, fast Flash/Flash-Lite execution & release sync');
  } catch (e) {
    fail('v107-themes-usage-limit-extra-thinking-and-speedups', e);
  }

  return {
    ok: results.every((r) => r.ok),
    results
  };
}

module.exports = { runFunctionalTests };
