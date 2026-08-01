// Architecture-boundary checks from docs/apple-intelligence/architecture-enforcement.md
// and gotchas-and-boundaries.md, made executable rather than left as prose.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(thisDir, '..');
const desktopRoot = path.resolve(thisDir, '..', '..');
const preloadSource = readFileSync(path.join(desktopRoot, 'electron/preload.cjs'), 'utf8');
const mainSource = readFileSync(path.join(desktopRoot, 'electron/main.cjs'), 'utf8');

function listFiles(dir, exts) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

describe('preload cannot spawn native processes', () => {
  it('preload.cjs does not require child_process', () => {
    expect(preloadSource).not.toMatch(/require\(\s*['"]node:child_process['"]\s*\)/);
    expect(preloadSource).not.toMatch(/require\(\s*['"]child_process['"]\s*\)/);
  });
});

describe('renderer source cannot spawn native processes or address arbitrary IPC', () => {
  const rendererFiles = listFiles(path.join(desktopRoot, 'src'), ['.ts', '.tsx']);

  it('found renderer source files to check (sanity guard against an empty scan)', () => {
    expect(rendererFiles.length).toBeGreaterThan(0);
  });

  it('no renderer file imports child_process', () => {
    const offenders = rendererFiles.filter((file) =>
      /from\s+['"]node:child_process['"]|from\s+['"]child_process['"]/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('no renderer file references ipcRenderer directly (must go through preload)', () => {
    const offenders = rendererFiles.filter((file) =>
      readFileSync(file, 'utf8').includes('ipcRenderer'),
    );
    expect(offenders).toEqual([]);
  });

  it('no renderer file calls a generic native-invoke API', () => {
    const offenders = rendererFiles.filter((file) =>
      /window\.native\s*\.\s*invoke/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('sidecar stdout stays protocol-only', () => {
  it('appleIntelligence feature modules use console.error (stderr), never console.log, for diagnostics', () => {
    const files = listFiles(path.join(electronDir, 'appleIntelligence'), ['.cjs']).filter(
      (f) => !f.endsWith('.test.cjs'),
    );
    const offenders = files.filter((file) => /console\.log\s*\(/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('Apple Intelligence cannot reach order execution (placeholder — expands in Phase 1+)', () => {
  it('main.cjs has no apple-intelligence-to-order coupling yet', () => {
    // Once electron/appleIntelligence/* modules exist that import application
    // order/broker modules, this test must fail. Today there is no such
    // import to check, so this asserts the negative precondition holds.
    expect(mainSource).not.toMatch(/appleIntelligence.*order|order.*appleIntelligence/i);
  });

  it('renderer AI modules only type-import trading stores — no runtime import, no execution surface', () => {
    // architecture-enforcement.md: AI modules must not import order
    // placement/mutation or broker execution modules. `import type` is
    // erased at compile time and carries no runtime capability; anything
    // else from trade/, api/, or broker paths is a boundary violation.
    const aiDir = path.join(desktopRoot, 'src/features/appleIntelligence');
    const files = listFiles(aiDir, ['.ts', '.tsx']).filter((f) => !/\.test\.tsx?$/.test(f));
    const offenders = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const runtimeImports =
        source.match(/^import\s+(?!type\b)[^;]*from\s+['"][^'"]*\/(trade|api|broker)\//gm) ?? [];
      if (runtimeImports.length > 0) offenders.push({ file, runtimeImports });
    }
    expect(offenders).toEqual([]);
  });

  it('renderer AI modules never call order methods on any store', () => {
    const aiDir = path.join(desktopRoot, 'src/features/appleIntelligence');
    const files = listFiles(aiDir, ['.ts', '.tsx']);
    const offenders = files.filter((file) =>
      /\.(arm|submitOrder|placeOrder|cancelOrder|flatten)\s*\(/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('no second Electron bootstrap or preload root is introduced', () => {
  it('exactly one preload.cjs exists under electron/', () => {
    const preloadFiles = listFiles(electronDir, ['.cjs']).filter((f) =>
      f.endsWith('preload.cjs'),
    );
    expect(preloadFiles).toHaveLength(1);
  });

  it('main.cjs contains exactly one app.whenReady bootstrap', () => {
    const matches = mainSource.match(/app\.whenReady\(\)/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
