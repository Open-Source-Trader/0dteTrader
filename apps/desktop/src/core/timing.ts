/**
 * Times a synchronous or async operation and logs its duration to the
 * console when enabled. Off by default so the performance.now() calls never
 * run on a normal user's machine — flip on with `setTimingEnabled(true)`
 * from a devtools console.
 */
let enabled = false;

export function setTimingEnabled(value: boolean): void {
  enabled = value;
}

export function timed<T>(label: string, fn: () => T): T {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    console.debug(`${label} took ${(performance.now() - start).toFixed(1)}ms`);
  }
}

export async function timedAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    console.debug(`${label} took ${(performance.now() - start).toFixed(1)}ms`);
  }
}
