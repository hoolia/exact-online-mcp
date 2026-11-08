import { z } from 'zod';
import type { LimitSettings } from './exact/limits.js';
import type { JwtSettings } from './auth/jwt.js';

export const REGIONS = ['nl', 'be', 'de', 'uk', 'fr', 'es', 'us'] as const;
export type Region = (typeof REGIONS)[number];

const csv = (s: string | undefined) =>
  (s ?? '').split(',').map((v) => v.trim()).filter(Boolean);

const schema = z.object({
  PUBLIC_BASE_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  EXACT_CLIENT_ID: z.string().min(1),
  EXACT_CLIENT_SECRET: z.string().min(1),
  EXACT_REDIRECT_URI: z.url(),
  EXACT_DEFAULT_REGION: z.enum(REGIONS).default('nl'),
  EXACT_ENABLED_REGIONS: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().refine((k) => Buffer.from(k, 'base64').length === 32, {
    message: 'must be 32 bytes, base64 encoded (openssl rand -base64 32)',
  }),
  SESSION_SIGNING_KEY: z.string().min(32, 'must be at least 32 characters'),
  ENABLE_WRITE_TOOLS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  WRITE_TOOLS: z.string().optional(),
  MAX_ATTACHMENT_MB: z.coerce.number().positive().max(100).default(20),
  ALLOWED_EXACT_USER_IDS: z.string().optional(),
  EXTRA_REDIRECT_URIS: z.string().optional(),
  DB_PATH: z.string().default('/data/connector.db'),
  EXACT_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(60).default(50),
  EXACT_RATE_PER_DAY: z.coerce.number().int().min(1).max(5000).default(4500),
  EXACT_BREAKER_ERRORS: z.coerce.number().int().min(1).max(9).default(8),
  JWT_ISSUER: z.url().optional(),
  JWT_AUDIENCE: z.string().min(1).optional(),
  JWT_JWKS_URL: z.url().optional(),
  JWT_ALLOWED_CLIENTS: z.string().optional(),
  JWT_EXACT_USER_ID: z.string().regex(/^[0-9a-fA-F-]{36}$/, 'must be an Exact UserID GUID').optional(),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export interface Config {
  publicBaseUrl: string;
  port: number;
  exactClientId: string;
  exactClientSecret: string;
  exactRedirectUri: string;
  defaultRegion: Region;
  enabledRegions: Region[];
  tokenEncryptionKey: Buffer;
  sessionSigningKey: string;
  enableWriteTools: boolean;
  /** write tools to register; empty with enableWriteTools: all of them */
  writeTools: string[];
  maxAttachmentBytes: number;
  allowedExactUserIds: string[];
  extraRedirectUris: string[];
  dbPath: string;
  logLevel: string;
  limits: LimitSettings;
  /** workload callers with OIDC access tokens; null: only the OAuth broker */
  jwt: (JwtSettings & { exactUserId: string }) | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  const enabled = csv(c.EXACT_ENABLED_REGIONS) as Region[];
  const bad = enabled.filter((r) => !(REGIONS as readonly string[]).includes(r));
  if (bad.length) throw new Error(`Invalid configuration:\n  - EXACT_ENABLED_REGIONS: unknown region(s) ${bad.join(', ')}`);
  let jwt: Config['jwt'] = null;
  if (c.JWT_ISSUER) {
    const missing = (['JWT_AUDIENCE', 'JWT_EXACT_USER_ID'] as const).filter((k) => !c[k]);
    if (missing.length) throw new Error(`Invalid configuration:\n${missing.map((k) => `  - ${k}: required with JWT_ISSUER`).join('\n')}`);
    const issuer = c.JWT_ISSUER.replace(/\/+$/, '');
    jwt = {
      issuer, audience: c.JWT_AUDIENCE!, jwksUrl: c.JWT_JWKS_URL ?? `${issuer}/protocol/openid-connect/certs`,
      allowedClients: csv(c.JWT_ALLOWED_CLIENTS), exactUserId: c.JWT_EXACT_USER_ID!.toLowerCase(),
    };
  }
  const enabledRegions = enabled.length ? enabled : [c.EXACT_DEFAULT_REGION];
  if (!enabledRegions.includes(c.EXACT_DEFAULT_REGION)) enabledRegions.unshift(c.EXACT_DEFAULT_REGION);
  return {
    publicBaseUrl: c.PUBLIC_BASE_URL,
    port: c.PORT,
    exactClientId: c.EXACT_CLIENT_ID,
    exactClientSecret: c.EXACT_CLIENT_SECRET,
    exactRedirectUri: c.EXACT_REDIRECT_URI,
    defaultRegion: c.EXACT_DEFAULT_REGION,
    enabledRegions,
    tokenEncryptionKey: Buffer.from(c.TOKEN_ENCRYPTION_KEY, 'base64'),
    sessionSigningKey: c.SESSION_SIGNING_KEY,
    enableWriteTools: c.ENABLE_WRITE_TOOLS || csv(c.WRITE_TOOLS).length > 0,
    writeTools: csv(c.WRITE_TOOLS),
    maxAttachmentBytes: Math.round(c.MAX_ATTACHMENT_MB * 1024 * 1024),
    allowedExactUserIds: csv(c.ALLOWED_EXACT_USER_IDS).map((s) => s.toLowerCase()),
    extraRedirectUris: csv(c.EXTRA_REDIRECT_URIS),
    dbPath: c.DB_PATH,
    logLevel: c.LOG_LEVEL,
    jwt,
    limits: { perMinute: c.EXACT_RATE_PER_MINUTE, perDay: c.EXACT_RATE_PER_DAY, breakerErrors: c.EXACT_BREAKER_ERRORS, breakerWindowMs: 60 * 60 * 1000 },
  };
}
