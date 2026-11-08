import type { z } from 'zod';
import type { ExactApi } from '../exact/client.js';
import type { UserRecord } from '../store.js';
import type { Config } from '../config.js';
import type { CallerIdentity } from '../auth/jwt.js';
import type { PgStore } from '../db/ledger.js';

export interface ToolContext {
  exact: ExactApi;
  user: UserRecord;
  config: Config;
  caller: CallerIdentity;
  /** idempotency ledger and audit log; null without DATABASE_URL (ledger tools are then not registered) */
  ledger: PgStore | null;
  now: () => number;
  audit: (entry: { tool: string; division: number | null; payloadHash: string; exactId?: string | null }) => void;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  inputSchema: S;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(ctx: ToolContext, args: any): Promise<{ summary: string; data: unknown }>;
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S> & { run(ctx: ToolContext, args: z.infer<z.ZodObject<S>>): Promise<{ summary: string; data: unknown }> }): ToolDef {
  return def as unknown as ToolDef;
}
