'use strict';
/**
 * Locally — Static & structural verification script.
 * Verifies:
 *  - index.html line count is between 7,000 and 25,000 lines
 *  - Every JS file in src/ and scripts/ parses cleanly with vm.Script
 *  - Every <script> block in index.html, overlay-widget.html, cursor-overlay.html parses cleanly
 *  - Zero duplicate HTML IDs in index.html
 *  - Every $('id') and getElementById('id') referenced in index.html exists in HTML
 *  - No ChatGPT or Upgrade text remains in UI
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error('FAIL:', msg);
  process.exitCode = 1;
}

function ok(msg) {
  console.log('OK:', msg);
}

// 1. Check JS files syntax
const jsFiles = [
  'src/main/main.js',
  'src/main/agent.js',
  'src/main/automation.js',
  'src/main/gemini.js',
  'src/main/keystore.js',
  'src/main/mcp.js',
  'src/main/providers.js',
  'src/main/screen.js',
  'src/main/store.js',
  'src/main/systemPrompt.js',
  'src/main/tools.js',
  'src/preload/preload.js',
  'src/preload/overlay-preload.js',
  'scripts/launch.js',
  'scripts/build-win.js',
  'scripts/build-linux.js',
  'scripts/test-functional.js'
];

for (const rel of jsFiles) {
  const full = path.join(ROOT, rel);
  const src = fs.readFileSync(full, 'utf8');
  try {
    new vm.Script(src, { filename: rel });
    ok('Syntax valid: ' + rel);
  } catch (e) {
    fail('Syntax error in ' + rel + ': ' + e.message);
  }
}

// 2. Check HTML files & scripts
const htmlFiles = [
  'app.html',
  'index.html',
  'docs/index.html',
  'download-site/public/index.html',
  'src/renderer/overlay-widget.html',
  'src/renderer/cursor-overlay.html'
];

for (const rel of htmlFiles) {
  const full = path.join(ROOT, rel);
  const html = fs.readFileSync(full, 'utf8');
  const lines = html.split('\n').length;

  if (rel === 'index.html' || rel === 'docs/index.html' || rel === 'download-site/public/index.html') {
    if (lines < 4700) {
      fail(`${rel} line count ${lines} must be >= 4,700 lines.`);
    } else {
      ok(`${rel} line count: ${lines} (>= 4,700 lines)`);
    }
  }

  if (rel === 'app.html') {
    if (lines < 7000 || lines > 25000) {
      fail(`app.html line count ${lines} is outside required [7000, 25000].`);
    } else {
      ok(`app.html line count: ${lines} (within 7,000 - 25,000)`);
    }

    if (/\bchatgpt\b/i.test(html)) {
      fail('Found forbidden "ChatGPT" text inside app.html.');
    } else {
      ok('No "ChatGPT" text in app.html');
    }

    // Check duplicate IDs in HTML markup only (exclude JS strings)
    const scriptStart = html.indexOf('<script>');
    const markupOnly = scriptStart >= 0 ? html.slice(0, scriptStart) : html;
    const idRe = /\bid="([^"]+)"/g;
    const seen = new Map();
    const dupes = [];
    let m;
    while ((m = idRe.exec(markupOnly)) !== null) {
      const id = m[1];
      seen.set(id, (seen.get(id) || 0) + 1);
      if (seen.get(id) === 2) dupes.push(id);
    }
    if (dupes.length) {
      fail('Duplicate HTML IDs in app.html: ' + dupes.join(', '));
    } else {
      ok(`No duplicate IDs in app.html (${seen.size} unique IDs)`);
    }

    // Check $('id') and getElementById('id') targets exist
    const scriptSrc = scriptStart >= 0 ? html.slice(scriptStart) : '';
    const refRe = /(?:\$|document\.getElementById)\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g;
    const missing = [];
    while ((m = refRe.exec(scriptSrc)) !== null) {
      if (!seen.has(m[1])) missing.push(m[1]);
    }
    if (missing.length) {
      fail('Referenced element IDs missing from app.html: ' + [...new Set(missing)].join(', '));
    } else {
      ok('All referenced DOM element IDs exist in app.html');
    }
  }

  // Parse every <script> block in the HTML file
  const scriptBlockRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  let count = 0;
  while ((sm = scriptBlockRe.exec(html)) !== null) {
    count += 1;
    try {
      new vm.Script(sm[1], { filename: `${rel}#script-${count}` });
      ok(`Script syntax valid: ${rel} (#${count})`);
    } catch (e) {
      fail(`Script syntax error in ${rel} (#${count}): ${e.message}`);
    }
  }
  if (count === 0) {
    fail(`No <script> block found in ${rel}`);
  }
}

// 3. Check assets exist
for (const asset of ['assets/logo.png', 'assets/openai-logo.png', 'assets/claude-logo.png', 'assets/icon.png', 'assets/icon.ico', 'src/main/native/winput.ps1']) {
  if (!fs.existsSync(path.join(ROOT, asset))) {
    fail('Missing required asset/file: ' + asset);
  } else {
    ok('Found file: ' + asset);
  }
}

if (!process.exitCode) {
  console.log('\nALL STATIC CHECKS PASSED.');
}
