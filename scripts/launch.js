'use strict';
/**
 * Locally — Cross-platform launcher.
 * Clears ELECTRON_RUN_AS_NODE (which Electron-based editors like VS Code sometimes inherit)
 * so `npm start` always launches Electron cleanly as a real desktop application.
 */
const { spawn } = require('child_process');
const path = require('path');

const electronPath = require('electron');
const root = path.resolve(__dirname, '..');
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [root, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  windowsHide: false
});

child.on('exit', (code, signal) => {
  if (code === null) {
    console.error('Locally exited with signal', signal);
    process.exit(1);
  }
  process.exit(code);
});
