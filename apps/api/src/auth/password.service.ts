import { Injectable, Logger } from '@nestjs/common';

/**
 * Password hashing. Primary: Argon2id (memory 64 MiB, time 3, parallelism 4 —
 * docs/SECURITY.md §3) via the `argon2` package. If the native argon2 module
 * cannot be loaded on this machine, falls back to scrypt via node:crypto with
 * OWASP-recommended parameters (N=2^15, r=8, p=1) and a self-describing hash
 * format (`scrypt$N$r$p$salt$hash`), so both implementations can verify only
 * their own hashes.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

const ARGON2_PARAMS = {
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
} as const;

class Argon2Hasher implements PasswordHasher {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  private readonly argon2 = require('argon2') as typeof import('argon2');

  hash(password: string): Promise<string> {
    return this.argon2.hash(password, {
      type: this.argon2.argon2id,
      ...ARGON2_PARAMS,
    });
  }

  verify(hash: string, password: string): Promise<boolean> {
    return this.argon2.verify(hash, password);
  }
}

class ScryptHasher implements PasswordHasher {
  private readonly N = 32768; // 2^15
  private readonly r = 8;
  private readonly p = 1;
  private readonly keylen = 64;

  async hash(password: string): Promise<string> {
    const crypto = await import('node:crypto');
    const salt = crypto.randomBytes(16);
    const derived = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(
        password,
        salt,
        this.keylen,
        { N: this.N, r: this.r, p: this.p },
        (err, key) => (err ? reject(err) : resolve(key)),
      );
    });
    return `scrypt$${this.N}$${this.r}$${this.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    const crypto = await import('node:crypto');
    const parts = hash.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltHex, keyHex] = parts;
    const derived = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(
        password,
        Buffer.from(saltHex, 'hex'),
        keyHex.length / 2,
        { N: Number(N), r: Number(r), p: Number(p) },
        (err, key) => (err ? reject(err) : resolve(key)),
      );
    });
    return crypto.timingSafeEqual(derived, Buffer.from(keyHex, 'hex'));
  }
}

@Injectable()
export class PasswordService implements PasswordHasher {
  private readonly impl: PasswordHasher;

  constructor() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('argon2');
      this.impl = new Argon2Hasher();
    } catch (err) {
      new Logger(PasswordService.name).warn(
        `argon2 native module unavailable (${(err as Error).message}); ` +
          'falling back to scrypt password hashing',
      );
      this.impl = new ScryptHasher();
    }
  }

  hash(password: string): Promise<string> {
    return this.impl.hash(password);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await this.impl.verify(hash, password);
    } catch {
      // Malformed/foreign hash formats are a non-match, not an error.
      return false;
    }
  }
}
