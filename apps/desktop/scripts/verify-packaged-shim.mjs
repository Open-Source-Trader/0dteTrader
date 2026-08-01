#!/usr/bin/env node
// Canonical spec: docs/apple-intelligence/packaging-and-signing.md
// (release verification) and acceptance-criteria.md ("Packaged application
// contains the expected native executable... runnable, signed... compatible
// with supported architectures"). Verifies a built .app bundle; exits
// non-zero on any failure so dist:mac fails loudly instead of shipping a
// bundle whose AI feature silently reports binary-not-found.
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const desktopRoot = path.resolve(new URL('..', import.meta.url).pathname);

function findAppBundle() {
  const explicit = process.argv[2];
  if (explicit) return explicit;
  const releaseDir = path.join(desktopRoot, 'release');
  if (!existsSync(releaseDir)) fail(`no release directory at ${releaseDir}; build first`);
  for (const entry of readdirSync(releaseDir)) {
    const candidate = path.join(releaseDir, entry, '0dteTrader.app');
    if (entry.startsWith('mac') && existsSync(candidate)) return candidate;
  }
  fail(`no 0dteTrader.app found under ${releaseDir}/mac*`);
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`✓ ${message}`);
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const appPath = findAppBundle();
// Must match PACKAGED_RELATIVE_PATH in electron/appleIntelligence/binaryResolver.cjs.
const shimPath = path.join(
  appPath,
  'Contents',
  'Resources',
  'native',
  'apple-intelligence-shim',
  'AppleIntelligenceShim',
);

// 1. Binary exists at the resolver's canonical packaged location.
if (!existsSync(shimPath)) fail(`shim missing at ${shimPath}`);
pass(`shim present at Contents/Resources/native/apple-intelligence-shim`);

// 2. Executable permission survived packaging.
try {
  accessSync(shimPath, constants.X_OK);
  pass('shim is executable');
} catch {
  fail('shim exists but is not executable');
}

// 3. Architecture: the binary must contain the host architecture slice
//    (packaging-and-signing.md: "Architecture mismatch may appear only on
//    another supported Mac" — CI should run this on each supported arch).
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const archs = run('lipo', ['-archs', shimPath]).trim();
if (!archs.split(/\s+/).includes(hostArch)) {
  fail(`shim archs [${archs}] missing host arch ${hostArch}`);
}
pass(`shim architecture ok (${archs})`);

// 4. Code signature is valid — for the shim itself and the whole bundle
//    (a signed parent does not prove the nested executable is signed).
for (const [label, target] of [
  ['shim', shimPath],
  ['app bundle', appPath],
]) {
  try {
    run('codesign', ['--verify', '--strict', target]);
    pass(`${label} signature verifies`);
  } catch (error) {
    fail(`${label} signature invalid: ${error.stderr ?? error.message}`);
  }
}

// 5. Report the signing identity so release logs show what signed the build
//    (ad-hoc in development; must be Developer ID + notarization in release).
//    codesign -dv prints its details to stderr even on success.
const details = spawnSync('codesign', ['-dvv', shimPath], { encoding: 'utf8' }).stderr;
const authority = details.match(/(Authority=.*|Signature=.*)/g) ?? ['unknown'];
console.log(`  signing: ${authority.join('; ')}`);

console.log('packaged shim verification passed');
