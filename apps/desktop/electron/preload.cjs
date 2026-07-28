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
