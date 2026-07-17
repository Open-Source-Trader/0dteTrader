import { ConfigService } from '@nestjs/config';
import { CryptoService } from './crypto.service';

const TEST_KEY = Buffer.alloc(32, 0x42).toString('base64');

function makeService(key: string | undefined = TEST_KEY): CryptoService {
  const config = new ConfigService({
    credEncryptionKey: key,
    nodeEnv: 'test',
  });
  const service = new CryptoService(config);
  service.onModuleInit();
  return service;
}

describe('CryptoService (AES-256-GCM)', () => {
  const service = makeService();

  it('round-trips plaintext', () => {
    const secret = 'webull-app-secret-xyzzy';
    const blob = service.encrypt(secret);
    expect(service.decrypt(blob)).toEqual(secret);
  });

  it('stores iv (12B) + authTag (16B) + ciphertext in one blob', () => {
    const blob = service.encrypt('12345');
    expect(blob.length).toBe(12 + 16 + 5);
    // Never contains plaintext.
    expect(blob.toString('utf8')).not.toContain('12345');
  });

  it('uses a random IV per write (same plaintext, different blobs)', () => {
    const a = service.encrypt('same-input');
    const b = service.encrypt('same-input');
    expect(a.equals(b)).toBe(false);
    // ...but both decrypt to the same value.
    expect(service.decrypt(a)).toBe('same-input');
    expect(service.decrypt(b)).toBe('same-input');
  });

  it('detects ciphertext tampering (GCM auth failure)', () => {
    const blob = service.encrypt('tamper-me');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => service.decrypt(tampered)).toThrow(/decryption failed/i);
  });

  it('detects auth-tag tampering', () => {
    const blob = service.encrypt('tamper-me');
    const tampered = Buffer.from(blob);
    tampered[12] ^= 0x01; // first auth-tag byte
    expect(() => service.decrypt(tampered)).toThrow(/decryption failed/i);
  });

  it('fails to decrypt with the wrong key', () => {
    const blob = service.encrypt('key-mismatch');
    const other = makeService(Buffer.alloc(32, 0x99).toString('base64'));
    expect(() => other.decrypt(blob)).toThrow(/decryption failed/i);
  });

  it('rejects a malformed blob', () => {
    expect(() => service.decrypt(Buffer.alloc(10))).toThrow(/too short/i);
  });

  it('rejects an invalid key at init', () => {
    const config = new ConfigService({
      credEncryptionKey: Buffer.alloc(10).toString('base64'), // 10 bytes ≠ 32
      nodeEnv: 'test',
    });
    expect(() => new CryptoService(config).onModuleInit()).toThrow(/32 bytes/);
  });

  it('falls back to a dev key when unset outside production', () => {
    const dev = makeService(undefined);
    const blob = dev.encrypt('dev-mode');
    expect(dev.decrypt(blob)).toBe('dev-mode');
  });
});
