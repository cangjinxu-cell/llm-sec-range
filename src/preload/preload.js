'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  status: () => ipcRenderer.invoke('dsh:status'),
  probe: (url) => ipcRenderer.invoke('dsh:probe', url),
  discover: () => ipcRenderer.invoke('dsh:discover'),
  connect: (input) => ipcRenderer.invoke('dsh:connect', input),
  disconnect: () => ipcRenderer.invoke('dsh:disconnect'),
  launch: (opts) => ipcRenderer.invoke('dsh:launch', opts),
  stopChild: () => ipcRenderer.invoke('dsh:stop-child'),
  locateDsh: (explicit) => ipcRenderer.invoke('dsh:locate-dsh', explicit),
  pickDir: () => ipcRenderer.invoke('dsh:pick-dir'),
  openDir: (dir) => ipcRenderer.invoke('dsh:open-dir', dir),
  reveal: (file) => ipcRenderer.invoke('dsh:reveal', file),
  copy: (text) => ipcRenderer.invoke('dsh:copy', text),
  paste: () => ipcRenderer.invoke('dsh:paste'),
  openExternal: (url) => ipcRenderer.invoke('dsh:open-external', url),
  sessions: (limit) => ipcRenderer.invoke('dsh:sessions', limit),
  saveSettings: (patch) => ipcRenderer.invoke('dsh:save-settings', patch),
  onStatus: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('dsh:status', listener);
    return () => ipcRenderer.removeListener('dsh:status', listener);
  },
  onHarnessLog: (cb) => {
    const listener = (_event, lines) => cb(lines);
    ipcRenderer.on('dsh:harness-log', listener);
    return () => ipcRenderer.removeListener('dsh:harness-log', listener);
  },
};

contextBridge.exposeInMainWorld('dsh', api);