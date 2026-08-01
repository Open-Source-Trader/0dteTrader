// Resolves the sidecar executable path. Canonical spec:
// docs/apple-intelligence/packaging-and-signing.md — packaged mode resolves
// from process.resourcesPath, development mode uses one deterministic
// repository-relative path, never PATH, never a renderer-provided path.
const fs = require('node:fs');
const path = require('node:path');

// `npm run build`/`build:shim` produces the release configuration — dev mode
// intentionally resolves the same release binary rather than a separate
// debug one, so "it works in dev" and "it works packaged" exercise the same
// artifact.
const DEV_BUILD_RELATIVE_PATH = path.join(
  'native/apple-intelligence-shim/.build/release/AppleIntelligenceShim',
);
const PACKAGED_RELATIVE_PATH = path.join(
  'native',
  'apple-intelligence-shim',
  'AppleIntelligenceShim',
);

/**
 * @param {{ isPackaged: boolean, resourcesPath?: string, appRoot: string }} context
 * @returns {string | null} absolute path to the sidecar executable, or null
 *   if no candidate exists — callers treat null as "unavailable", never
 *   search PATH as a fallback.
 */
function resolveShimPath(context) {
  const candidate = context.isPackaged
    ? path.join(context.resourcesPath ?? '', PACKAGED_RELATIVE_PATH)
    : path.join(context.appRoot, DEV_BUILD_RELATIVE_PATH);

  if (!fs.existsSync(candidate)) return null;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
  } catch {
    return null;
  }
  return candidate;
}

module.exports = { resolveShimPath, DEV_BUILD_RELATIVE_PATH, PACKAGED_RELATIVE_PATH };
