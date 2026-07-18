// Desktop shell: a resizable window around the 430x932 iPhone-frame web app.
// The web layer scales its content to fit the window, so any size works.
// Launch (Linux/Wayland needs the X11 flag, VSCode shells leak RUN_AS_NODE):
//   env -u ELECTRON_RUN_AS_NODE ELECTRON_START_URL=http://localhost:5173 \
//     npx electron electron/main.cjs --ozone-platform=x11 --disable-gpu
const { app, BrowserWindow, screen } = require('electron');
const path = require('node:path');

function createWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const scale = Math.min(1, (workAreaSize.height - 80) / 932, (workAreaSize.width - 40) / 430);
  const win = new BrowserWindow({
    width: Math.round(430 * scale),
    height: Math.round(932 * scale),
    useContentSize: true,
    resizable: true,
    minWidth: 240,
    minHeight: 520,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
  });
  win.setAspectRatio(430 / 932);
  win.loadURL(
    process.env.ELECTRON_START_URL ?? `file://${path.join(__dirname, '../dist/index.html')}`,
  );
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
