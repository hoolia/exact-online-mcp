import { z } from 'zod';
import { defineTool } from './types.js';
import { readOnly } from './common.js';

export const whoami = defineTool({
  name: 'whoami',
  title: 'Current Exact Online user',
  description: 'Returns the signed-in Exact Online user (name, email), their region and default_division: the division every tool uses when division is omitted. exact_web_division is the division last opened in the Exact web app and is not used by the tools. Use first to confirm which administration questions will apply to.',
  inputSchema: {},
  annotations: readOnly,
  async run(ctx) {
    const me = await ctx.exact.me();
    // the tools act on the division stored at connect; Exact's own current division follows the user's web session
    const data = {
      name: me?.FullName ?? ctx.user.name, email: me?.Email ?? ctx.user.email, user_id: me?.UserID ?? ctx.user.exactUserId,
      region: ctx.user.region, default_division: ctx.user.currentDivision, exact_web_division: me?.CurrentDivision ?? null,
    };
    return { summary: `Signed in as ${data.name} (region ${data.region}, tools default to division ${data.default_division}; pass division to use another).`, data };
  },
});

export const listDivisions = defineTool({
  name: 'list_divisions',
  title: 'List divisions',
  description: 'Lists the Exact Online divisions (administrations) the user can access, with code, name and status. Accountants may see many client divisions. Use the code as the `division` parameter of other tools.',
  inputSchema: { include_inactive: z.boolean().default(false).describe('Also list inactive/archived divisions.') },
  annotations: readOnly,
  async run(ctx, { include_inactive }) {
    const all = await ctx.exact.listDivisions();
    const rows = all
      .filter((d: any) => include_inactive || d.Status === 1)
      .map((d: any) => ({ code: d.Code, name: d.Description, status: d.Status === 1 ? 'active' : d.Status === 2 ? 'archived' : 'inactive', country: d.Country, currency: d.Currency, is_current: d.Code === ctx.user.currentDivision }));
    return { summary: `${rows.length} division(s) accessible.`, data: rows };
  },
});
