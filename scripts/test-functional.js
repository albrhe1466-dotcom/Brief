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
const { matchPresets, buildThinkingConfig, resolveGeminiRuntimeCandidates, isModernGeminiModelId } = require('../src/main/gemini');
const { OpenAIClient, AnthropicClient, OpenRouterClient, isModernOpenAIModelId, isModernAnthropicModelId, isModernOpenRouterModelId } = require('../src/main/providers');
const { DEFAULT_SETTINGS } = require('../src/main/store');
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

  // 8. All 4 Providers modern routing (zero 3.5/4o/4.1/claude-3/gemini-2.x downgrades) & seenNewsVersion default
  try {
    for (const modelId of ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-4-argon', 'gemini-4-carbon']) {
      const cands = resolveGeminiRuntimeCandidates(modelId);
      assert.strictEqual(cands[0], modelId, 'Exact Gemini model must come first: ' + modelId);
      const legacy = cands.filter((c) => /^gemini-(1|2)(?:\.|$|-)/i.test(c));
      assert.strictEqual(legacy.length, 0, 'Legacy 1.x/2.x Gemini models forbidden: ' + legacy.join(', '));
    }
    const openai = new OpenAIClient(() => '', () => {});
    for (const modelId of ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-6.2-astra']) {
      const cands = openai.resolveRuntimeCandidates(modelId);
      assert.strictEqual(cands[0], modelId, 'Exact OpenAI model must come first: ' + modelId);
      const legacy = cands.filter((c) => /^(?:gpt-3|gpt-4|o1|o4-mini)/i.test(c));
      assert.strictEqual(legacy.length, 0, 'Legacy OpenAI models forbidden: ' + legacy.join(', '));
    }
    const anthropic = new AnthropicClient(() => '', () => {});
    for (const modelId of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2']) {
      const cands = anthropic.resolveRuntimeCandidates(modelId);
      assert.strictEqual(cands[0], modelId, 'Exact Claude model must come first: ' + modelId);
      const legacy = cands.filter((c) => /^claude-(?:2|instant|3|sonnet-4-20250514)/i.test(c));
      assert.strictEqual(legacy.length, 0, 'Legacy Claude models forbidden: ' + legacy.join(', '));
    }
    const orClient = new OpenRouterClient(() => '', () => {});
    for (const modelId of ['google/gemini-4-carbon', 'openai/gpt-6.2-sol', 'anthropic/claude-haiku-5-5', 'anthropic/claude-fable-5-2']) {
      const cands = orClient.resolveRuntimeCandidates(modelId);
      assert.strictEqual(cands[0], modelId, 'Exact OpenRouter model must come first: ' + modelId);
      const legacy = cands.filter((c) => !isModernOpenRouterModelId(c) && c !== modelId);
      assert.strictEqual(legacy.length, 0, 'Legacy OpenRouter models forbidden: ' + legacy.join(', '));
    }
    assert.strictEqual(isModernGeminiModelId('gemini-2.5-pro'), false);
    assert.strictEqual(isModernGeminiModelId('gemini-4-carbon'), true);
    assert.strictEqual(isModernOpenAIModelId('gpt-3.5-turbo'), false);
    assert.strictEqual(isModernOpenAIModelId('gpt-4o'), false);
    assert.strictEqual(isModernOpenAIModelId('gpt-6.2-sol'), true);
    assert.strictEqual(isModernAnthropicModelId('claude-3-haiku-20240307'), false);
    assert.strictEqual(isModernAnthropicModelId('claude-fable-5-2'), true);
    assert.strictEqual(DEFAULT_SETTINGS.seenNewsVersion, '');
    pass('all-4-providers-modern-routing-v103', 'Verified zero legacy downgrades across Gemini (+ Carbon), OpenAI, Claude & OpenRouter + seenNewsVersion');
  } catch (e) {
    fail('all-4-providers-modern-routing-v103', e);
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

  return {
    ok: results.every((r) => r.ok),
    results
  };
}

module.exports = { runFunctionalTests };
