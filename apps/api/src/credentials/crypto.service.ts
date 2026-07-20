import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const IV_BYTES = 12; // 96-bit nonce, the GCM recommendation
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256

/**
 * AES-256-GCM encryption of Webull credential fields (docs/SECURITY.md §2).
 *
 * Output format is a self-contained blob: iv (12) || authTag (16) ||
 * ciphertext. Every field of every write gets a fresh random 12-byte IV, so
 * nonces are never reused under the key.
 *
 * The key comes from CRED_ENCRYPTION_KEY (base64, 32 bytes). When the variable
 * is unset outside production, a well-known deterministic development key is
 * used (with a warning) so local dev and tests boot without setup; production
 * boots are rejected by config validation if the key is missing/invalid.
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);
  private key!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const configured = this.config.get<string>('credEncryptionKey');
    if (configured) {
      const decoded = Buffer.from(configured, 'base64');
      if (decoded.length !== KEY_BYTES) {
        throw new Error('CRED_ENCRYPTION_KEY must decode to exactly 32 bytes (base64)');
      }
      this.key = decoded;
      return;
    }
    if (this.config.get<string>('nodeEnv') === 'production') {
      throw new Error('CRED_ENCRYPTION_KEY is required in production');
    }
    this.logger.warn(
      'CRED_ENCRYPTION_KEY not set — using a built-in development-only key. Do NOT use in production.',
    );
    this.key = createHash('sha256').update('0dtetrader-dev-only-key').digest();
  }

  /** Encrypt UTF-8 text; returns iv || authTag || ciphertext. */
  // Prisma 7 types Bytes columns as Uint8Array<ArrayBuffer>, so the blob is
  // copied out of Buffer's pooled ArrayBufferLike backing store.
  encrypt(plaintext: string): Uint8Array<ArrayBuffer> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
  }

  /**
   * Decrypt a blob produced by encrypt(). Throws on any tampering or key
   * mismatch (GCM authentication failure).
   */
  decrypt(bytes: Uint8Array): string {
    const blob = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (blob.length < IV_BYTES + TAG_BYTES) {
      throw new Error('Invalid encrypted blob (too short)');
    }
    const iv = blob.subarray(0, IV_BYTES);
    const authTag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new Error(
        'Credential decryption failed: data is corrupt, tampered, or the key is wrong',
      );
    }
  }
}
