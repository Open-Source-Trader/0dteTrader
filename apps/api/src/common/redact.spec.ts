import { redact } from './redact';

describe('redact', () => {
  it('redacts sensitive keys in plain objects', () => {
    const out = redact({ password: 'hunter2', symbol: 'SPY' });
    expect(out).toEqual({ password: '[REDACTED]', symbol: 'SPY' });
  });

  it('preserves message and stack on errors', () => {
    const err = new Error('boot failed');
    const out = redact(err) as Error;
    expect(out.message).toBe('boot failed');
    expect(out.stack).toBe(err.stack);
  });

  it('redacts sensitive enumerable fields carried on errors', () => {
    const err = new Error('request failed') as Error & Record<string, unknown>;
    err.authorization = 'Bearer secret-token';
    err.config = { headers: { Authorization: 'Bearer secret-token' } };
    const out = redact(err) as Error & Record<string, unknown>;
    expect(out.message).toBe('request failed');
    expect(out.authorization).toBe('[REDACTED]');
    expect((out.config as { headers: Record<string, string> }).headers.Authorization).toBe(
      '[REDACTED]',
    );
  });

  it('handles errors nested inside logged objects', () => {
    const err = new Error('nested') as Error & Record<string, unknown>;
    err.token = 'abc123';
    const out = redact({ error: err }) as { error: Error & Record<string, unknown> };
    expect(out.error.message).toBe('nested');
    expect(out.error.token).toBe('[REDACTED]');
  });
});
