import { JwtService } from '@nestjs/jwt';
import { AppThrottlerGuard } from './app-throttler.guard';

/** getTracker/decodeUserId are protected/private — build a real guard
 *  instance (ThrottlerGuard's own constructor deps are unused by these
 *  methods) and reach in, the same pattern other specs in this repo use for
 *  otherwise-inaccessible members. */
function makeGuard(): { getTracker(req: Record<string, unknown>): Promise<string> } {
  const guard = new AppThrottlerGuard(
    { throttlers: [] },
    {} as never,
    { getAllAndOverride: () => undefined } as never,
    new JwtService(),
  );
  return guard as unknown as { getTracker(req: Record<string, unknown>): Promise<string> };
}

function bearerToken(payload: object): string {
  const jwt = new JwtService();
  return jwt.sign(payload, { secret: 'irrelevant-for-decode', expiresIn: '1h' });
}

describe('AppThrottlerGuard.getTracker', () => {
  it('falls back to IP when there is no Authorization header', async () => {
    const guard = makeGuard();
    const tracker = await guard.getTracker({ ip: '1.2.3.4', headers: {} });
    expect(tracker).toBe('1.2.3.4');
  });

  it('falls back to IP when the header is not a bearer token', async () => {
    const guard = makeGuard();
    const tracker = await guard.getTracker({
      ip: '1.2.3.4',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(tracker).toBe('1.2.3.4');
  });

  it('falls back to IP when the token does not decode to a usable sub', async () => {
    const guard = makeGuard();
    const tracker = await guard.getTracker({
      ip: '1.2.3.4',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(tracker).toBe('1.2.3.4');
  });

  it('keys on IP + decoded user id when a bearer token is present', async () => {
    const guard = makeGuard();
    const token = bearerToken({ sub: 'user-42' });
    const tracker = await guard.getTracker({
      ip: '1.2.3.4',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(tracker).toBe('1.2.3.4:user-42');
  });

  it('separates two users sharing one IP into distinct buckets', async () => {
    const guard = makeGuard();
    const tokenA = bearerToken({ sub: 'user-a' });
    const tokenB = bearerToken({ sub: 'user-b' });
    const trackerA = await guard.getTracker({
      ip: '9.9.9.9',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const trackerB = await guard.getTracker({
      ip: '9.9.9.9',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(trackerA).not.toBe(trackerB);
  });

  it('does not let a forged sub escape its IP-scoped bucket', async () => {
    // Unverified decode trusts whatever `sub` a token claims — a request
    // rotating fake identities must still land in the same IP bucket, or
    // this would be a rate-limit bypass rather than a fix.
    const guard = makeGuard();
    const forgedA = bearerToken({ sub: 'attacker-fake-1' });
    const forgedB = bearerToken({ sub: 'attacker-fake-2' });
    const trackerA = await guard.getTracker({
      ip: '5.5.5.5',
      headers: { authorization: `Bearer ${forgedA}` },
    });
    const trackerB = await guard.getTracker({
      ip: '5.5.5.5',
      headers: { authorization: `Bearer ${forgedB}` },
    });
    expect(trackerA).toBe('5.5.5.5:attacker-fake-1');
    expect(trackerB).toBe('5.5.5.5:attacker-fake-2');
  });
});
