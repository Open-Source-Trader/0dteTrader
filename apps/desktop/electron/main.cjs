// Desktop shell: a resizable window around the 430x932 iPhone-frame web app.
// The web layer scales its content to fit the window, so any size works.
// Launch (Linux/Wayland needs the X11 flag, VSCode shells leak RUN_AS_NODE):
//   env -u ELECTRON_RUN_AS_NODE ELECTRON_START_URL=http://localhost:5173 \
//     npx electron electron/main.cjs --ozone-platform=x11 --disable-gpu
//
// Production loads dist/ over a loopback HTTP server, not file:// — Chromium
// blocks ES-module scripts and stylesheets on file:// origins (blank window),
// and http keeps webSecurity intact (no CORS bypass needed).
const { app, BrowserWindow, screen, shell } = require('electron');
const { spawn } = require('node:child_process');
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

/**
 * Serves the Vite build from ../dist on a loopback port. A FIXED port is
 * preferred so the origin stays stable across launches — localStorage is
 * keyed by origin, and an ephemeral port would silently wipe the user's
 * saved settings (indicators, layout, last symbol) on every start. Falls
 * back to an ephemeral port only when the fixed one is taken.
 */
const DIST_PORT = 41730;

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
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Another instance holds the fixed port — ephemeral fallback (its
        // settings live under that instance's origin anyway).
        server.listen(0, '127.0.0.1', () => resolve(server));
      } else {
        reject(err);
      }
    });
    server.listen(DIST_PORT, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Backend lifecycle: the app owns its API process. On launch, an already-
 * running backend on the API port is reused (and left alone on quit — it
 * isn't ours); otherwise the built API is spawned and killed again when the
 * last window closes.
 */
const API_PORT = Number(process.env.PORT) || 3000;
const API_DIR = path.resolve(path.join(__dirname, '../../api'));
let apiProcess = null;

function apiIsUp() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: API_PORT, path: '/v1/health', timeout: 1500 },
      (res) => {
        res.resume();
        resolve(true); // any HTTP answer means something serves the port
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function ensureBackend() {
  if (await apiIsUp()) {
    console.log(`[desktop] reusing backend already on :${API_PORT}`);
    return;
  }
  const entry = path.join(API_DIR, 'dist/main.js');
  if (!fs.existsSync(entry)) {
    console.error(
      `[desktop] backend build missing (${entry}) — run: npm run build --workspace apps/api`,
    );
    return;
  }
  console.log(`[desktop] starting backend on :${API_PORT}`);
  apiProcess = spawn('node', [entry], {
    cwd: API_DIR, // Nest resolves ../../.env from here
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  apiProcess.on('exit', (code) => {
    console.log(`[desktop] backend exited (code ${code})`);
    apiProcess = null;
  });
  for (let i = 0; i < 30; i++) {
    if (await apiIsUp()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.warn('[desktop] backend did not answer within 15s — window opens anyway');
}

function stopBackend() {
  if (!apiProcess) return;
  const child = apiProcess;
  child.kill('SIGTERM');
  // Escalate if graceful shutdown hangs; unref so the timer can't keep the
  // main process alive after quit.
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }, 3000).unref();
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
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

app.whenReady().then(async () => {
  await ensureBackend();
  await createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', stopBackend);
// Terminal kills and session logouts must also take the backend down.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => app.quit());
}
// Last resort for abnormal exits — 'exit' handlers must be synchronous.
process.on('exit', () => {
  if (apiProcess) {
    try {
      apiProcess.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
});

// Open external URLs (SnapTrade Connection Portal, etc.) in the system browser.
const { ipcMain } = require('electron');
ipcMain.handle('open-external', (_event, url) => shell.openExternal(url));
