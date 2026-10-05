import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { decrypt, encrypt, sign, unsign } from '../src/crypto.js';
import { randomBytes } from 'node:crypto';
import { baseEnv } from './helpers.js';

describe('config', () => {
  it('accepts a valid env', () => {
    const c = loadConfig(baseEnv({ ENABLE_WRITE_TOOLS: 'true', ALLOWED_EXACT_USER_IDS: 'A, b' }));
    expect(c.enableWriteTools).toBe(true);
    expect(c.allowedExactUserIds).toEqual(['a', 'b']);
    expect(c.enabledRegions).toEqual(['nl']);
  });
  it('fails fast with a readable message', () => {
    expect(() => loadConfig({})).toThrow(/Invalid configuration[\s\S]*PUBLIC_BASE_URL/);
    expect(() => loadConfig(baseEnv({ TOKEN_ENCRYPTION_KEY: 'short' }))).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});

describe('crypto', () => {
  const key = randomBytes(32);
  it('round-trips and detects tampering', () => {
    const enc = encrypt(key, 'secret-token');
    expect(enc).not.toContain('secret-token');
    expect(decrypt(key, enc)).toBe('secret-token');
    const buf = Buffer.from(enc, 'base64'); buf[buf.length - 1]! ^= 1;
    expect(() => decrypt(key, buf.toString('base64'))).toThrow();
    expect(() => decrypt(randomBytes(32), enc)).toThrow();
  });
  it('signs and verifies state', () => {
    const s = sign('k'.repeat(32), 'abc');
    expect(unsign('k'.repeat(32), s)).toBe('abc');
    expect(unsign('k'.repeat(32), s + 'x')).toBeNull();
    expect(unsign('z'.repeat(32), s)).toBeNull();
  });
});
