const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopShell', {
  onCommand(handler) {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, command) => handler(command);
    ipcRenderer.on('desktop-command', listener);
    ipcRenderer.invoke('desktop-command:flush').then((commands) => {
      if (!Array.isArray(commands)) return;
      commands.forEach((command) => handler(command));
    });
    return () => ipcRenderer.removeListener('desktop-command', listener);
  },
});

// Apple Intelligence: narrow, explicit methods only — no generic invoke and
// no direct ipcRenderer exposure (docs/apple-intelligence/protocol.md).
contextBridge.exposeInMainWorld('appleIntelligence', {
  getAvailability() {
    return ipcRenderer.invoke('apple-intelligence:availability');
  },
  analyze(request) {
    return ipcRenderer.invoke('apple-intelligence:analyze', request);
  },
  cancel(requestId) {
    return ipcRenderer.invoke('apple-intelligence:cancel', requestId);
  },
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, nativeEvent) => listener(nativeEvent);
    ipcRenderer.on('apple-intelligence:event', wrapped);
    return () => ipcRenderer.removeListener('apple-intelligence:event', wrapped);
  },
});
