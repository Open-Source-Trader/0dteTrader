import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes and verifies a password', async () => {
    const hash = await service.hash('correct horse battery staple');
    expect(hash).not.toContain('correct horse');
    await expect(
      service.verify(hash, 'correct horse battery staple'),
    ).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await service.hash('password-one');
    await expect(service.verify(hash, 'password-two')).resolves.toBe(false);
  });

  it('produces unique salts (same password, different hashes)', async () => {
    const [a, b] = await Promise.all([
      service.hash('same-password'),
      service.hash('same-password'),
    ]);
    expect(a).not.toEqual(b);
    await expect(service.verify(a, 'same-password')).resolves.toBe(true);
    await expect(service.verify(b, 'same-password')).resolves.toBe(true);
  });

  it('uses argon2id when the native module is available (scrypt otherwise)', async () => {
    const hash = await service.hash('format-check');
    // Either $argon2id$... (argon2) or scrypt$N$r$p$salt$hash (fallback).
    expect(hash.startsWith('$argon2id$') || hash.startsWith('scrypt$')).toBe(true);
  });

  it('returns false for a malformed hash', async () => {
    await expect(service.verify('not-a-real-hash', 'x')).resolves.toBe(false);
  });
});
