import { afterEach, describe, expect, it } from 'vitest';
import { callTool, getTokens, odata, parseResult, startApp, type TestEnv } from './helpers.js';

const GL = '22222222-2222-2222-2222-222222222222';
let env: TestEnv;
afterEach(() => env?.close());

async function login() {
  env = await startApp();
  env.fake.withLogin();
  return (await getTokens(env)).tokens.access_token as string;
}

describe('RGS', () => {
  it('list_gl_account_rgs_mappings keeps the RGS scheme and filters on the code prefix', async () => {
    const token = await login();
    env.fake.on((url) => {
      if (!url.pathname.endsWith('/financial/GLAccountClassificationMappings')) return undefined;
      expect(url.searchParams.get('$filter')).toContain("startswith(ClassificationCode, 'WBed')");
      return odata([
        { GLAccount: GL, GLAccountCode: '4000 ', ClassificationCode: 'WBedHuiHur', ClassificationDescription: 'Huur', GLSchemeCode: 'RGS3.5', GLSchemeDescription: 'Referentie GrootboekSchema' },
        { GLAccount: GL, GLAccountCode: '4000', ClassificationCode: 'WBedX', GLSchemeCode: 'OWN', GLSchemeDescription: 'Own scheme' },
      ]);
    });
    const r = parseResult((await callTool(env, token, 'list_gl_account_rgs_mappings', { rgs_code_prefix: 'WBed' })).body);
    expect(r.data.mappings).toEqual([expect.objectContaining({ gl_account: '4000', rgs_code: 'WBedHuiHur', scheme_code: 'RGS3.5' })]);
  });
  it('list_gl_accounts adds the RGS code only when asked', async () => {
    const token = await login();
    env.fake.on((url) => (url.pathname.endsWith('/financial/GLAccountClassificationMappings') ? odata([{ GLAccount: GL, ClassificationCode: 'WBedHuiHur', ClassificationDescription: 'Huur', GLSchemeCode: 'RGS3.5' }]) : undefined));
    env.fake.on((url) => (url.pathname.endsWith('/financial/GLAccounts') ? odata([{ ID: GL, Code: '4000', Description: 'Huur', BalanceType: 'W' }]) : undefined));
    const plain = parseResult((await callTool(env, token, 'list_gl_accounts', {})).body);
    expect(plain.data[0]).not.toHaveProperty('rgs_code');
    const r = parseResult((await callTool(env, token, 'list_gl_accounts', { include_rgs: true })).body);
    expect(r.data[0]).toMatchObject({ code: '4000', rgs_code: 'WBedHuiHur', rgs_description: 'Huur' });
  });
});
