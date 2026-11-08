import { z } from 'zod';
import type { LimitSettings } from './exact/limits.js';
import type { JwtSettings } from './auth/jwt.js';
import { DEFAULT_TIER_POLICY, type TierPolicy } from './policy/tiers.js';
import { DEFAULT_ANSWER_POLICY, type AnswerPolicy } from './policy/approval.js';
import { DEFAULT_DESCRIPTION_TEMPLATE, DescriptionError, checkTemplate } from './policy/description.js';

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
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL').optional(),
  APPROVAL_SIGNING_KEY: z.string().min(32, 'must be at least 32 characters').optional(),
  DESCRIPTION_TEMPLATE: z.string().min(1).default(DEFAULT_DESCRIPTION_TEMPLATE),
  DESCRIPTION_MAX_LENGTH: z.coerce.number().int().min(20).max(255).default(60),
  DUPLICATE_WINDOW_DAYS: z.coerce.number().int().min(0).max(366).default(7),
  TIER_AUTO_MAX_EUR: z.coerce.number().min(0).default(DEFAULT_TIER_POLICY.autoMaxEur),
  TIER_AUTO_MIN_SUPPLIER_ENTRIES: z.coerce.number().int().min(0).default(DEFAULT_TIER_POLICY.autoMinSupplierEntries),
  TIER_AUTO_HOLD_HOURS: z.coerce.number().min(0).default(DEFAULT_TIER_POLICY.autoHoldHours),
  TIER_TWO_STEP_ABOVE_EUR: z.coerce.number().min(0).default(DEFAULT_TIER_POLICY.twoStepAboveEur),
  TIER_BALANCE_ACCOUNT_ALLOWLIST: z.string().optional(),
  TIER_PAYROLL_JOURNALS: z.string().optional(),
  ENABLE_MATCHSETS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  EXACT_PROCESS_MODE: z.enum(['record', 'api']).default('record'),
  APPROVAL_ANSWER_APPROVE: z.string().optional(),
  APPROVAL_ANSWER_REJECT: z.string().optional(),
  AUDIT_MODEL_HEADER: z.string().regex(/^[A-Za-z0-9-]+$/).default('x-model-version'),
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
  /** Postgres for the idempotency ledger and audit log; null: ledger write tools stay disabled */
  databaseUrl: string | null;
  /** HMAC key of approval tokens; null: process_entry and create_matchset stay disabled */
  approvalSigningKey: string | null;
  descriptionTemplate: string;
  descriptionMaxLength: number;
  duplicateWindowDays: number;
  tiers: TierPolicy;
  enableMatchsets: boolean;
  /** record: process_entry records the release, a person processes in Exact; api: it also sets Status 50 (purchase entries) */
  processMode: 'record' | 'api';
  auditModelHeader: string;
  /** answers that count as approval and as rejection (case-insensitive regular expressions) */
  answerPolicy: AnswerPolicy;
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
  try { checkTemplate(c.DESCRIPTION_TEMPLATE); } catch (e) {
    if (e instanceof DescriptionError) throw new Error(`Invalid configuration:\n  - DESCRIPTION_TEMPLATE: ${e.message}`);
    throw e;
  }
  const regex = (name: string, v: string | undefined, d: RegExp) => {
    if (!v) return d;
    try { return new RegExp(v, 'i'); } catch { throw new Error(`Invalid configuration:\n  - ${name}: not a valid regular expression`); }
  };
  const answerPolicy: AnswerPolicy = {
    approve: regex('APPROVAL_ANSWER_APPROVE', c.APPROVAL_ANSWER_APPROVE, DEFAULT_ANSWER_POLICY.approve),
    reject: regex('APPROVAL_ANSWER_REJECT', c.APPROVAL_ANSWER_REJECT, DEFAULT_ANSWER_POLICY.reject),
  };
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
    databaseUrl: c.DATABASE_URL ?? null,
    approvalSigningKey: c.APPROVAL_SIGNING_KEY ?? null,
    descriptionTemplate: c.DESCRIPTION_TEMPLATE,
    descriptionMaxLength: c.DESCRIPTION_MAX_LENGTH,
    duplicateWindowDays: c.DUPLICATE_WINDOW_DAYS,
    tiers: {
      autoMaxEur: c.TIER_AUTO_MAX_EUR, autoMinSupplierEntries: c.TIER_AUTO_MIN_SUPPLIER_ENTRIES, autoHoldHours: c.TIER_AUTO_HOLD_HOURS,
      twoStepAboveEur: c.TIER_TWO_STEP_ABOVE_EUR, balanceAccountAllowlist: csv(c.TIER_BALANCE_ACCOUNT_ALLOWLIST), payrollJournals: csv(c.TIER_PAYROLL_JOURNALS),
    },
    enableMatchsets: c.ENABLE_MATCHSETS,
    processMode: c.EXACT_PROCESS_MODE,
    auditModelHeader: c.AUDIT_MODEL_HEADER.toLowerCase(),
    answerPolicy,
    limits: { perMinute: c.EXACT_RATE_PER_MINUTE, perDay: c.EXACT_RATE_PER_DAY, breakerErrors: c.EXACT_BREAKER_ERRORS, breakerWindowMs: 60 * 60 * 1000 },
  };
}
