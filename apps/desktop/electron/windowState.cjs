const fs = require('node:fs');

const DEFAULT_STATE = {
  width: 1440,
  height: 960,
  minWidth: 960,
  minHeight: 720,
  maximized: false,
};

function clampState(state, displays) {
  const bounds = displays.flatMap((display) => {
    const { x, y, width, height } = display.workArea;
    return [{ left: x, top: y, right: x + width, bottom: y + height }];
  });
  const width = Math.max(DEFAULT_STATE.minWidth, Math.round(state.width || DEFAULT_STATE.width));
  const height = Math.max(
    DEFAULT_STATE.minHeight,
    Math.round(state.height || DEFAULT_STATE.height),
  );
  const left = Number.isFinite(state.x) ? Math.round(state.x) : null;
  const top = Number.isFinite(state.y) ? Math.round(state.y) : null;
  if (left === null || top === null) return { width, height };

  const visible = bounds.some(
    (area) =>
      left + 120 >= area.left &&
      top + 120 >= area.top &&
      left <= area.right - 120 &&
      top <= area.bottom - 120,
  );
  if (!visible) return { width, height };
  return { x: left, y: top, width, height };
}

function loadWindowState(filePath, displays) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      ...DEFAULT_STATE,
      ...clampState(parsed, displays),
      maximized: parsed.maximized === true,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveWindowState(filePath, window) {
  const bounds = window.getBounds();
  const state = {
    ...bounds,
    maximized: window.isMaximized(),
  };
  fs.mkdirSync(require('node:path').dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

module.exports = {
  DEFAULT_STATE,
  loadWindowState,
  saveWindowState,
};
