// Desktop shell: a resizable window around the 430x932 iPhone-frame web app.
// The web layer scales its content to fit the window, so any size works.
// Launch (Linux/Wayland needs the X11 flag, VSCode shells leak RUN_AS_NODE):
//   env -u ELECTRON_RUN_AS_NODE ELECTRON_START_URL=http://localhost:5173 \
//     npx electron electron/main.cjs --ozone-platform=x11 --disable-gpu
//
// Production loads dist/ over a loopback HTTP server, not file:// — Chromium
// blocks ES-module scripts and stylesheets on file:// origins (blank window),
// and http keeps webSecurity intact (no CORS bypass needed).
const { app, BrowserWindow, screen } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** Serves the Vite build from ../dist on an ephemeral loopback port. */
function serveDist() {
  const root = path.resolve(path.join(__dirname, '../dist'));
  const server = http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    } catch {
      // Malformed % escape — reject instead of crashing the main process.
      res.writeHead(400).end();
      return;
    }
    const filePath = path.resolve(path.join(root, urlPath === '/' ? 'index.html' : urlPath));
    // Containment via path.relative: a raw prefix test would pass siblings
    // that share the root's prefix (e.g. dist-anything/).
    const relative = path.relative(root, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function createWindow() {
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

  let startUrl = process.env.ELECTRON_START_URL;
  if (!startUrl) {
    const server = await serveDist();
    app.on('will-quit', () => server.close());
    startUrl = `http://127.0.0.1:${server.address().port}/`;
    console.log(`[desktop] serving dist at ${startUrl}`);
  }
  win.loadURL(startUrl);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
