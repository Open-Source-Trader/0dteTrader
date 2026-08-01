// Desktop shell: a standard resizable desktop window around the trading app.
// The renderer handles its own responsive layout inside the available space.
// Launch (Linux/Wayland needs the X11 flag, VSCode shells leak RUN_AS_NODE):
//   env -u ELECTRON_RUN_AS_NODE ELECTRON_START_URL=http://localhost:5173 \
//     npx electron electron/main.cjs --ozone-platform=x11 --disable-gpu
//
// Production loads dist/ over a loopback HTTP server, not file:// — Chromium
// blocks ES-module scripts and stylesheets on file:// origins (blank window),
// and http keeps webSecurity intact (no CORS bypass needed).
const { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { loadWindowState, saveWindowState } = require('./windowState.cjs');
const { NativeProcessSupervisor } = require('./appleIntelligence/supervisor.cjs');
const { RequestRegistry } = require('./appleIntelligence/requestRegistry.cjs');

const APP_NAME = '0dteTrader';
const APP_PROTOCOL = 'odtetrader';
app.setName(APP_NAME);

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
const APP_ICON = path.resolve(path.join(__dirname, 'assets/icon.png'));
const WINDOW_STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');

/**
 * Serves the Vite build from ../dist on a loopback port. A FIXED port is
 * preferred so the origin stays stable across launches — localStorage is
 * keyed by origin, and an ephemeral port would silently wipe the user's
 * saved settings (indicators, layout, last symbol) on every start. Falls
 * back to an ephemeral port only when the fixed one is taken.
 */
const DIST_PORT = 41730;
let distServer = null;
let startUrlPromise = null;
let mainWindow = null;
let tray = null;
let allowedAppOrigin = null;
let desktopBridgeReady = false;
const pendingDesktopCommands = [];

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
}

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

async function getStartUrl() {
  if (startUrlPromise) return startUrlPromise;
  startUrlPromise = (async () => {
    if (process.env.ELECTRON_START_URL) {
      return process.env.ELECTRON_START_URL;
    }
    distServer = await serveDist();
    app.on('will-quit', () => distServer?.close());
    const url = `http://127.0.0.1:${distServer.address().port}/`;
    console.log(`[desktop] serving dist at ${url}`);
    return url;
  })();
  return startUrlPromise;
}

/**
 * Backend lifecycle: the app owns its API process. On launch, an already-
 * running backend on the API port is reused (and left alone on quit — it
 * isn't ours); otherwise the built API is spawned and killed again when the
 * app quits.
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

/**
 * Apple Intelligence sidecar lifecycle: one supervisor for the app session,
 * started best-effort alongside the backend and stopped on quit. Analysis
 * remains fully optional — a failed/unavailable start never blocks the
 * window or backend (docs/apple-intelligence/acceptance-criteria.md).
 */
const appleIntelligence = new NativeProcessSupervisor();

/**
 * Electron main is authoritative for native analysis-request lifecycle and
 * deadlines (docs/apple-intelligence/lifecycle-and-concurrency.md "Request
 * ownership"). The registry tracks one entry per in-flight `analysis.run`,
 * assigns a bounded deadline, and is the sole router from a native event to
 * a specific renderer's webContents — never a broadcast.
 */
const appleIntelligenceRequests = new RequestRegistry({
  send: (request) => appleIntelligence.send(request),
  dispatch: (webContentsId, payload) => {
    const contents = webContentsForId(webContentsId);
    if (!contents || contents.isDestroyed()) return;
    contents.send('apple-intelligence:event', payload);
  },
});

function webContentsForId(id) {
  // Single-window today, but resolved by ID rather than assumed to be
  // mainWindow — cross-window isolation must hold even though only one
  // window exists in practice (security-boundary.md "Cross-window leakage").
  return BrowserWindow.getAllWindows().find(
    (win) => !win.isDestroyed() && win.webContents.id === id,
  )?.webContents;
}

// requestIds the supervisor itself owns outside the analysis registry
// (runtime.hello's handshake response, runtime.shutdown's ack) — expected
// to never appear in the registry, not a protocol anomaly worth logging.
const SUPERVISOR_OWNED_REQUEST_IDS = new Set(['runtime', 'shutdown']);

appleIntelligence.onEvent((event) => {
  if (event.type === 'native-event') {
    if (SUPERVISOR_OWNED_REQUEST_IDS.has(event.payload.requestId)) return;
    const result = appleIntelligenceRequests.handleNativeEvent(event.payload);
    if (!result.routed && result.reason === 'unknown-request') {
      console.error(
        `[desktop] apple-intelligence: event for unknown requestId "${event.payload.requestId}" (${event.payload.event})`,
      );
    }
    return;
  }
  if (event.type === 'exit') {
    // Sidecar exited: every pending request is unreachable and must be
    // rejected deterministically (lifecycle-and-concurrency.md "Crashed").
    appleIntelligenceRequests.rejectAll('native_process_exited');
  }
});

async function startAppleIntelligence() {
  try {
    await appleIntelligence.start({
      appRoot: path.resolve(path.join(__dirname, '..')),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });
  } catch (error) {
    console.error('[desktop] apple-intelligence sidecar failed to start:', error);
  }
}

function isSafeInternalUrl(url) {
  if (!allowedAppOrigin) return false;
  try {
    return new URL(url).origin === allowedAppOrigin;
  } catch {
    return false;
  }
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function queueDesktopCommand(command) {
  if (!command) return;
  if (desktopBridgeReady && mainWindow?.webContents && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('desktop-command', command);
    return;
  }
  pendingDesktopCommands.push(command);
}

function flushDesktopCommands() {
  if (!desktopBridgeReady || !mainWindow?.webContents || pendingDesktopCommands.length === 0) {
    return;
  }
  const commands = pendingDesktopCommands.splice(0, pendingDesktopCommands.length);
  commands.forEach((command) => mainWindow.webContents.send('desktop-command', command));
}

function openExternalUrl(url) {
  if (/^https?:/i.test(url)) void shell.openExternal(url);
}

function parseProtocolUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_PROTOCOL}:`) return null;

  if (url.hostname === 'trade') {
    const symbol = url.searchParams.get('symbol')?.trim().toUpperCase() ?? '';
    if (!/^[A-Z0-9.\-]{1,15}$/.test(symbol)) return null;
    const interval = url.searchParams.get('interval')?.trim() ?? null;
    return { type: 'open-trade-symbol', symbol, interval };
  }

  if (url.hostname === 'server') {
    const serverUrl = url.searchParams.get('url')?.trim() ?? '';
    if (!serverUrl) return null;
    return { type: 'open-server-selector', url: serverUrl };
  }

  return null;
}

function handleProtocolUrl(rawUrl) {
  const command = parseProtocolUrl(rawUrl);
  if (!command) return;
  if (!mainWindow) {
    void createWindow().then(() => queueDesktopCommand(command));
    return;
  }
  focusMainWindow();
  queueDesktopCommand(command);
}

function extractProtocolArg(argv) {
  return argv.find((arg) => arg.startsWith(`${APP_PROTOCOL}://`)) ?? null;
}

function installApplicationMenu() {
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    iconPath: APP_ICON,
  });

  const template =
    process.platform === 'darwin'
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about', label: `About ${APP_NAME}` },
              { type: 'separator' },
              {
                label: 'Change Server…',
                click: () => queueDesktopCommand({ type: 'open-server-selector' }),
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide', label: `Hide ${APP_NAME}` },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: `Quit ${APP_NAME}` },
            ],
          },
        ]
      : [
          {
            label: 'File',
            submenu: [
              {
                label: `Show ${APP_NAME}`,
                click: () => {
                  if (!mainWindow) {
                    void createWindow();
                    return;
                  }
                  focusMainWindow();
                },
              },
              {
                label: 'Change Server…',
                click: () => queueDesktopCommand({ type: 'open-server-selector' }),
              },
              { type: 'separator' },
              { role: 'quit', label: `Quit ${APP_NAME}` },
            ],
          },
        ];

  template.push(
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu:
        process.platform === 'darwin'
          ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
          : [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      label: 'Help',
      submenu: [
        ...(process.platform === 'darwin' ? [] : [{ role: 'about', label: `About ${APP_NAME}` }]),
        {
          label: 'Change Server…',
          click: () => queueDesktopCommand({ type: 'open-server-selector' }),
        },
      ],
    },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(APP_ICON);
  tray = new Tray(icon.resize({ width: 18, height: 18 }));
  tray.setToolTip(APP_NAME);
  const menu = Menu.buildFromTemplate([
    {
      label: `Show ${APP_NAME}`,
      click: () => {
        if (!mainWindow) {
          void createWindow();
          return;
        }
        focusMainWindow();
      },
    },
    {
      label: 'Change Server…',
      click: () => queueDesktopCommand({ type: 'open-server-selector' }),
    },
    { type: 'separator' },
    {
      label: `Quit ${APP_NAME}`,
      click: () => app.quit(),
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (!mainWindow) {
      void createWindow();
      return;
    }
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
      return;
    }
    focusMainWindow();
  });
}

function saveWindowStateSoon(window) {
  if (window.isDestroyed()) return;
  if (window.isMaximized() || window.isFullScreen()) return;
  saveWindowState(WINDOW_STATE_PATH, window);
}

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return mainWindow;
  }

  const state = loadWindowState(WINDOW_STATE_PATH, screen.getAllDisplays());
  const targetWidth = 1440;
  const targetHeight = 960;
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const shouldMaximize =
    state.maximized || workArea.width < targetWidth || workArea.height < targetHeight;

  desktopBridgeReady = false;

  const win = new BrowserWindow({
    ...state,
    width: state.width,
    height: state.height,
    useContentSize: true,
    resizable: true,
    minWidth: state.minWidth,
    minHeight: state.minHeight,
    autoHideMenuBar: process.platform !== 'darwin',
    backgroundColor: '#000000',
    icon: APP_ICON,
    show: false,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => {
    if (shouldMaximize) {
      win.maximize();
    }
    win.show();
    flushDesktopCommands();
  });

  win.on('resize', () => saveWindowStateSoon(win));
  win.on('move', () => saveWindowStateSoon(win));
  win.on('close', () => saveWindowState(WINDOW_STATE_PATH, win));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  // A destroyed renderer can no longer receive results — cancel whatever it
  // had in flight rather than let it run to a terminal event nobody reads
  // (lifecycle-and-concurrency.md "cancel requests when the owning window is
  // destroyed").
  win.webContents.on('destroyed', () => {
    appleIntelligenceRequests.cancelForWebContents(win.webContents.id);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeInternalUrl(url)) {
      return { action: 'allow' };
    }
    openExternalUrl(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isSafeInternalUrl(url)) return;
    event.preventDefault();
    openExternalUrl(url);
  });

  const startUrl = await getStartUrl();
  try {
    allowedAppOrigin = new URL(startUrl).origin;
  } catch {
    allowedAppOrigin = null;
  }
  await win.loadURL(startUrl);
  return win;
}

ipcMain.handle('desktop-command:flush', () => {
  desktopBridgeReady = true;
  return pendingDesktopCommands.splice(0, pendingDesktopCommands.length);
});

app.on('second-instance', (_event, argv) => {
  if (!mainWindow) {
    void createWindow();
  }
  focusMainWindow();
  const protocolUrl = extractProtocolArg(argv);
  if (protocolUrl) handleProtocolUrl(protocolUrl);
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});

app.whenReady().then(async () => {
  // Windows ties renderer Notifications to the AppUserModelID; without it they
  // attribute to a generic Electron identity or drop silently.
  app.setAppUserModelId('com.odtetrader.desktop');
  app.setAsDefaultProtocolClient(APP_PROTOCOL);
  installApplicationMenu();
  installTray();
  if (process.platform === 'darwin') {
    app.dock.setIcon(APP_ICON);
  }
  // Run in parallel, not sequentially: ensureBackend can poll for up to 15s
  // before giving up, and createWindow doesn't need the backend up to show
  // the renderer — the app already handles a not-yet-ready API gracefully
  // (inline login errors, QuoteSocket's own reconnect-with-backoff). Cold
  // start no longer looks frozen for the length of that poll. The Apple
  // Intelligence sidecar is best-effort and optional — its promise never
  // blocks window creation.
  await Promise.all([ensureBackend(), createWindow(), startAppleIntelligence()]);
  const protocolUrl = extractProtocolArg(process.argv);
  if (protocolUrl) handleProtocolUrl(protocolUrl);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
    return;
  }
  focusMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', stopBackend);
// Clear all pending-request timers before the sidecar itself stops — no
// renderer or child process will be around to receive further events, and
// an uncleared timer would otherwise still fire after shutdown.
app.on('will-quit', () => appleIntelligenceRequests.clear());
app.on('will-quit', () => void appleIntelligence.stop());
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
  if (appleIntelligence.child) {
    try {
      appleIntelligence.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
});

// Open external URLs (SnapTrade Connection Portal, etc.) in the system browser.
ipcMain.handle('open-external', (_event, url) => shell.openExternal(url));

// Apple Intelligence: narrow, feature-scoped IPC surface only (no generic
// invoke). Runtime-validates renderer payloads before translating them into
// native requests (docs/apple-intelligence/architecture-enforcement.md).
ipcMain.handle('apple-intelligence:availability', () => {
  if (appleIntelligence.state !== 'ready') {
    return { state: 'unavailable', reason: appleIntelligence.state };
  }
  return { state: 'ready' };
});

ipcMain.handle('apple-intelligence:analyze', (event, request) => {
  if (typeof request?.requestId !== 'string' || request.requestId.length === 0) {
    throw new Error('apple-intelligence:analyze requires a string requestId');
  }
  // Main validates, creates the registry entry, and assigns the deadline
  // before anything is sent to Swift — main is authoritative for the
  // request's existence and lifetime, not merely a passthrough.
  const entry = appleIntelligenceRequests.register({
    requestId: request.requestId,
    originatingWebContentsId: event.sender.id,
  });
  appleIntelligence.send({
    protocolVersion: 1,
    requestId: request.requestId,
    method: 'analysis.run',
    deadlineAt: entry.deadlineAt,
    payload: request.payload ?? {},
  });
  return { requestId: request.requestId };
});

ipcMain.handle('apple-intelligence:cancel', (event, requestId) => {
  if (typeof requestId !== 'string' || requestId.length === 0) return;
  // Cross-window isolation: a renderer may only cancel a request it owns.
  // Silently ignore otherwise rather than let one window affect another's
  // in-flight analysis (security-boundary.md "Cross-window leakage").
  if (!appleIntelligenceRequests.isOwnedBy(requestId, event.sender.id)) return;
  appleIntelligence.send({
    protocolVersion: 1,
    requestId,
    method: 'analysis.cancel',
    payload: {},
  });
});
