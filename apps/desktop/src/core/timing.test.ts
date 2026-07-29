import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTimingEnabled, timed, timedAsync } from './timing';

afterEach(() => {
  setTimingEnabled(false);
  vi.restoreAllMocks();
});

describe('timed', () => {
  it('returns the wrapped result without logging when disabled', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    expect(timed('op', () => 42)).toBe(42);
    expect(spy).not.toHaveBeenCalled();
  });

  it('logs a duration when enabled', () => {
    setTimingEnabled(true);
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    expect(timed('my-op', () => 'ok')).toBe('ok');
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^my-op took [\d.]+ms$/));
  });
});

describe('timedAsync', () => {
  it('returns the wrapped result without logging when disabled', async () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    await expect(timedAsync('op', async () => 42)).resolves.toBe(42);
    expect(spy).not.toHaveBeenCalled();
  });

  it('logs a duration and rethrows on failure when enabled', async () => {
    setTimingEnabled(true);
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const err = new Error('boom');
    await expect(
      timedAsync('failing-op', async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^failing-op took [\d.]+ms$/));
  });
});
