import { afterEach, describe, expect, it } from 'vitest';
import { callTool, getTokens, odata, parseResult, startApp, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.close());

async function login(over: Record<string, string> = {}) {
  env = await startApp(over);
  env.fake.withLogin();
  const { tokens } = await getTokens(env);
  return tokens.access_token as string;
}

describe('read tools', () => {
  it('list_vat_codes filters purchase codes and maps the type', async () => {
    const token = await login();
    env.fake.on((url) => {
      if (!url.pathname.endsWith('/vat/VATCodes')) return undefined;
      expect(url.searchParams.get('$filter')).toContain("VATTransactionType eq 'P'");
      return odata([{ ID: 'v', Code: '2  ', Description: 'Hoog', Percentage: 0.21, Type: 'E', VATTransactionType: 'B' }]);
    });
    const r = parseResult((await callTool(env, token, 'list_vat_codes', { use: 'purchase' })).body);
    expect(r.data[0]).toMatchObject({ code: '2', type: 'excluding', use: 'both' });
  });
  it('list_bank_transaction_lines needs a date range and filters on it', async () => {
    const token = await login();
    env.fake.on((url) => {
      if (!url.pathname.endsWith('/financialtransaction/BankEntryLines')) return undefined;
      expect(url.searchParams.get('$filter')).toContain("Date ge datetime'2026-10-01'");
      return odata([{ ID: 'b', Date: '/Date(1761955200000)/', AmountDC: -121, AmountFC: -121, Description: 'Acme INV-1' }]);
    });
    const r = parseResult((await callTool(env, token, 'list_bank_transaction_lines', { date_from: '2026-10-01', date_to: '2026-11-30' })).body);
    expect(r.data.lines[0]).toMatchObject({ amount_dc: -121, date: '2025-11-01' });
  });
});
