'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  stop: () => ipcRenderer.invoke('agent:stop', 'Stopped from floating widget'),
  showMain: () => ipcRenderer.invoke('app:show-main'),
  onStatus: (fn) => {
    const h = (_e, p) => fn(p);
    ipcRenderer.on('agent:status', h);
    return () => ipcRenderer.removeListener('agent:status', h);
  },
  onCursor: (fn) => {
    const h = (_e, p) => fn(p);
    ipcRenderer.on('cursor:event', h);
    return () => ipcRenderer.removeListener('cursor:event', h);
  }
});
