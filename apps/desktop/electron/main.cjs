// Optional desktop shell: a fixed iPhone-Pro-Max-sized window around the web
// app. Requires `npm i -D electron` (not installed by default). Usage:
//   ELECTRON_START_URL=http://localhost:5173 electron electron/main.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

function createWindow() {
  const win = new BrowserWindow({
    width: 430,
    height: 932,
    useContentSize: true,
    resizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#0B0C10',
  });
  win.loadURL(
    process.env.ELECTRON_START_URL ?? `file://${path.join(__dirname, '../dist/index.html')}`,
  );
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
