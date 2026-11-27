'use strict';
/**
 * Locally — Preload bridge (contextIsolation = true).
 * Exposes only explicit local desktop & Gemini IPC actions to the UI. No remote eval or node globals.
 */
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler) {
  const fn = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

contextBridge.exposeInMainWorld('locallyAPI', {
  // App & state
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  showMain: () => ipcRenderer.invoke('app:show-main'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  checkRemoteUpdate: () => ipcRenderer.invoke('app:check-update'),
  installDesktopUpdate: (url) => ipcRenderer.invoke('app:install-update', url),
  openPath: (p) => ipcRenderer.invoke('app:open-path', p),
  pickFolder: (defaultPath) => ipcRenderer.invoke('app:pick-folder', defaultPath),
  pickFiles: (opts) => ipcRenderer.invoke('app:pick-files', opts),
  pickFolderAttachment: (opts) => ipcRenderer.invoke('app:pick-folder-attachment', opts),
  captureScreenAttachment: () => ipcRenderer.invoke('app:capture-screenshot-attachment'),
  listDrives: () => ipcRenderer.invoke('app:list-drives'),

  // API key & validation
  getKeyStatus: () => ipcRenderer.invoke('key:status'),
  getKeySlots: () => ipcRenderer.invoke('key:slots'),
  switchKeySlot: (provider) => ipcRenderer.invoke('key:switch-slot', { provider }),
  peekKey: () => ipcRenderer.invoke('key:peek'),
  testKeyOnly: (key, testModel) => ipcRenderer.invoke('key:test-only', { key, testModel }),
  saveKeyOnly: (key, testModel) => ipcRenderer.invoke('key:save-only', { key, testModel }),
  saveAndValidateKey: (key, testModel) => ipcRenderer.invoke('key:save-validate', { key, testModel }),
  validateCurrentKey: (testModel) => ipcRenderer.invoke('key:validate-current', { testModel }),
  removeKey: (provider) => ipcRenderer.invoke('key:remove', provider ? { provider } : {}),
  testCustomModel: (modelId) => ipcRenderer.invoke('models:test', { modelId }),
  refreshModels: () => ipcRenderer.invoke('models:refresh'),

  // Usage & settings
  getUsage: () => ipcRenderer.invoke('usage:get'),
  resetUsage: () => ipcRenderer.invoke('usage:reset'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  setPermissionMode: (mode, confirmedFull) => ipcRenderer.invoke('permission:set', { mode, confirmedFull }),
  setHotkey: (accelerator) => ipcRenderer.invoke('hotkey:set', { accelerator }),

  // Chats & projects
  saveChatsData: (data) => ipcRenderer.invoke('chats:save', data),

  // OS diagnostics & testing
  getDiagnostics: () => ipcRenderer.invoke('os:diagnostics'),
  testAutomation: () => ipcRenderer.invoke('os:test-automation'),
  testOverlay: () => ipcRenderer.invoke('os:test-overlay'),
  toggleWidget: (show) => ipcRenderer.invoke('widget:toggle', show),
  toggleCursorOverlay: (show) => ipcRenderer.invoke('cursor:toggle', show),
  listShareSources: () => ipcRenderer.invoke('screenshare:list'),
  captureSharePreview: (source) => ipcRenderer.invoke('screenshare:preview', source),

  // Chat / Work agent execution
  runChat: (payload) => ipcRenderer.invoke('agent:chat', payload),
  runWork: (payload) => ipcRenderer.invoke('agent:work', payload),
  stopAgent: (reason) => ipcRenderer.invoke('agent:stop', reason),
  resolveApproval: (decision) => ipcRenderer.invoke('agent:approval', decision),

  // MCP Servers
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpDetectApps: () => ipcRenderer.invoke('mcp:detect-apps'),
  mcpScanLive: () => ipcRenderer.invoke('mcp:scan-live'),
  mcpBridgeInfo: () => ipcRenderer.invoke('mcp:bridge-info'),
  mcpSaveServer: (cfg) => ipcRenderer.invoke('mcp:save-server', cfg),
  mcpConnect: (payload) => ipcRenderer.invoke('mcp:connect', payload),
  mcpDisconnect: (id) => ipcRenderer.invoke('mcp:disconnect', id),
  mcpRemove: (id) => ipcRenderer.invoke('mcp:remove', id),

  // Events from main process
  onStatus: (fn) => subscribe('agent:status', fn),
  onLog: (fn) => subscribe('agent:log', fn),
  onChatDelta: (fn) => subscribe('agent:chat-delta', fn),
  onWorkPlan: (fn) => subscribe('agent:work-plan', fn),
  onWorkThought: (fn) => subscribe('agent:work-thought', fn),
  onWorkNote: (fn) => subscribe('agent:work-note', fn),
  onWorkStep: (fn) => subscribe('agent:work-step', fn),
  onCommandOutput: (fn) => subscribe('agent:command-output', fn),
  onApprovalRequired: (fn) => subscribe('agent:approval-required', fn),
  onApprovalResolved: (fn) => subscribe('agent:approval-resolved', fn),
  onUsage: (fn) => subscribe('usage:update', fn),
  onSettingsChanged: (fn) => subscribe('settings:changed', fn),
  onModelsUpdated: (fn) => subscribe('models:updated', fn),
  onMcpUpdated: (fn) => subscribe('mcp:updated', fn),
  onCursorEvent: (fn) => subscribe('cursor:event', fn)
});
