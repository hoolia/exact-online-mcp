import { z } from 'zod';
import { defineTool } from './types.js';
import { divisionField, guidField, hashPayload, trimCode } from './common.js';
import { guid, str } from '../exact/odata.js';
import { ExactError } from '../exact/errors.js';

const dryRun = z.boolean().default(true).describe('Default true: returns the payload and the duplicate check, writes nothing. Set false ONLY after the user confirmed.');
const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const compact = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
const normIban = (s: string) => s.replace(/\s+/g, '').toUpperCase();
const normVat = (s: string) => s.replace(/[\s.]/g, '').toUpperCase();

const fields = {
  name: z.string().min(1).max(100).describe('Legal name of the relation.'),
  email: z.string().email().max(100).optional(),
  phone: z.string().max(30).optional(),
  address_line: z.string().max(100).optional().describe('Street and number.'),
  postcode: z.string().max(20).optional(),
  city: z.string().max(60).optional(),
  country: z.string().length(2).optional().describe('ISO country code, e.g. NL.'),
  vat_number: z.string().min(4).max(30).optional().describe('VAT number (btw-nummer), e.g. NL123456789B01.'),
  chamber_of_commerce: z.string().min(4).max(30).optional().describe('Chamber of commerce number (KvK).'),
  payment_condition_purchase: z.string().max(8).optional().describe('Payment condition code for purchases (list_payment_conditions).'),
  payment_condition_sales: z.string().max(8).optional().describe('Payment condition code for sales.'),
  purchase_vat_code: z.string().max(8).optional().describe('Default purchase VAT code.'),
  sales_vat_code: z.string().max(8).optional().describe('Default sales VAT code.'),
  gl_account_purchase_id: guidField('Default cost G/L account GUID for purchase entries.').optional(),
  gl_account_sales_id: guidField('Default revenue G/L account GUID for sales entries.').optional(),
};

const ACCOUNT_SELECT = ['ID', 'Code', 'Name', 'Status', 'IsSupplier', 'VATNumber', 'ChamberOfCommerce', 'City', 'Blocked'];
const shape = (r: any) => ({ id: r.ID, code: trimCode(r.Code), name: r.Name, is_customer: r.Status === 'C', is_supplier: !!r.IsSupplier, vat_number: r.VATNumber, chamber_of_commerce: r.ChamberOfCommerce, city: r.City, blocked: !!r.Blocked });

function body(a: any) {
  return compact({
    Name: a.name, Email: a.email, Phone: a.phone, AddressLine1: a.address_line, Postcode: a.postcode, City: a.city, Country: a.country?.toUpperCase(),
    VATNumber: a.vat_number ? normVat(a.vat_number) : undefined, ChamberOfCommerce: a.chamber_of_commerce,
    PaymentConditionPurchase: a.payment_condition_purchase, PaymentConditionSales: a.payment_condition_sales,
    PurchaseVATCode: a.purchase_vat_code, SalesVATCode: a.sales_vat_code, GLAccountPurchase: a.gl_account_purchase_id, GLAccountSales: a.gl_account_sales_id,
  });
}

export const createAccount = defineTool({
  name: 'create_account',
  title: 'Create relation (supplier or customer)',
  description: 'Creates a relation in Exact: a supplier, a customer, or both, with address, VAT and chamber of commerce numbers, default VAT codes, G/L accounts and payment conditions, and optionally its IBAN. Refuses when a relation with the same VAT number, chamber of commerce number or exact name exists (use update_account then). WRITES to Exact Online; dry_run first.',
  inputSchema: {
    ...fields,
    supplier: z.boolean().default(true).describe('Mark the relation as supplier.'),
    customer: z.boolean().default(false).describe('Mark the relation as customer (Status C).'),
    iban: z.string().min(15).max(40).optional().describe('IBAN to register as the main bank account.'),
    division: divisionField, dry_run: dryRun,
  },
  annotations: writeAnnotations,
  async run(ctx, a) {
    if (!a.supplier && !a.customer) throw new ExactError('invalid_input', 'A relation must be a supplier, a customer, or both.');
    const iban = a.iban ? normIban(a.iban) : undefined;
    if (iban && !IBAN.test(iban)) throw new ExactError('invalid_input', 'iban is not a valid IBAN.');
    const div = await ctx.exact.resolveDivision(a.division);
    const ors = [`Name eq ${str(a.name)}`, a.vat_number && `VATNumber eq ${str(normVat(a.vat_number))}`, a.chamber_of_commerce && `ChamberOfCommerce eq ${str(a.chamber_of_commerce)}`].filter(Boolean);
    const { rows: existing } = await ctx.exact.list('crm/Accounts', { select: ACCOUNT_SELECT, filter: ors.join(' or ') }, { division: div, maxRows: 5, maxPages: 1 });
    if (existing.length) {
      return { summary: `REFUSED: relation ${existing.map((e: any) => `${e.Name} (${trimCode(e.Code)})`).join(', ')} already exists with this name, VAT or chamber of commerce number. Nothing was written; use update_account.`, data: { refused: true, duplicate: true, division: div, existing: existing.map(shape) } };
    }
    const payload = { ...body(a), IsSupplier: a.supplier, Status: a.customer ? 'C' : undefined };
    const plan = { division: div, account: compact(payload), bank_account: iban ? { BankAccount: iban, BankAccountHolderName: a.name, Main: true } : null };
    if (a.dry_run) return { summary: `DRY RUN (nothing was created in division ${div}). New ${[a.supplier && 'supplier', a.customer && 'customer'].filter(Boolean).join(' and ')} ${a.name}${iban ? ` with IBAN ${iban}` : ''}. Confirm with the user, then call again with dry_run=false.`, data: { dry_run: true, ...plan } };
    let created: any;
    try {
      created = await ctx.exact.post('crm/Accounts', plan.account, { division: div });
    } finally {
      ctx.audit({ tool: 'create_account', division: div, payloadHash: hashPayload(plan), exactId: created?.ID ?? null });
    }
    if (!created?.ID) throw new ExactError('api', 'Exact Online returned no account id.');
    let bank: string | null = null;
    let bankError: string | null = null;
    if (plan.bank_account) {
      try { bank = (await ctx.exact.post('crm/BankAccounts', { ...plan.bank_account, Account: created.ID }, { division: div }))?.ID ?? null; }
      catch (e) { bankError = e instanceof ExactError ? e.userMessage : 'unknown error'; }
    }
    return {
      summary: `Created relation ${a.name} (code ${trimCode(created.Code) ?? '?'}) in division ${div}${bank ? ' with its IBAN' : ''}${bankError ? `; the IBAN was NOT added: ${bankError}` : ''}.`,
      data: { dry_run: false, division: div, id: created.ID, code: trimCode(created.Code), bank_account_id: bank, bank_account_error: bankError },
    };
  },
});

export const updateAccount = defineTool({
  name: 'update_account',
  title: 'Update relation',
  description: 'Changes fields of an existing relation (supplier or customer): name, address, VAT and chamber of commerce numbers, default VAT codes, G/L accounts, payment conditions, supplier/customer flags, blocked; and adds an IBAN. Only the fields given change. WRITES to Exact Online; dry_run first.',
  inputSchema: {
    account_id: guidField('Relation GUID (search_accounts).'),
    ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])) as { [K in keyof typeof fields]: z.ZodOptional<z.ZodTypeAny> },
    supplier: z.boolean().optional(), customer: z.boolean().optional().describe('true: Status C (customer).'),
    blocked: z.boolean().optional(),
    add_iban: z.string().min(15).max(40).optional().describe('IBAN to add as a bank account of the relation.'),
    division: divisionField, dry_run: dryRun,
  },
  annotations: writeAnnotations,
  async run(ctx, a: any) {
    const iban = a.add_iban ? normIban(a.add_iban) : undefined;
    if (iban && !IBAN.test(iban)) throw new ExactError('invalid_input', 'add_iban is not a valid IBAN.');
    const div = await ctx.exact.resolveDivision(a.division);
    const current: any = await ctx.exact.getOne(`crm/Accounts(${guid(a.account_id)})`, { select: [...ACCOUNT_SELECT, 'Email', 'Phone', 'AddressLine1', 'Postcode', 'Country', 'PaymentConditionPurchase', 'PaymentConditionSales', 'PurchaseVATCode', 'SalesVATCode'] }, { division: div });
    if (!current) throw new ExactError('invalid_input', 'Relation not found.');
    const change = compact({ ...body(a), IsSupplier: a.supplier, Status: a.customer === undefined ? undefined : a.customer ? 'C' : 'A', Blocked: a.blocked });
    if (!Object.keys(change).length && !iban) throw new ExactError('invalid_input', 'Nothing to change.');
    const before = Object.fromEntries(Object.keys(change).map((k) => [k, current[k] ?? null]));
    if (a.dry_run) return { summary: `DRY RUN (nothing was changed in division ${div}). Relation ${current.Name}: ${Object.keys(change).join(', ') || 'no fields'}${iban ? `, add IBAN ${iban}` : ''}. Confirm with the user, then call again with dry_run=false.`, data: { dry_run: true, division: div, account: shape(current), before, after: change, add_iban: iban ?? null } };
    try {
      if (Object.keys(change).length) await ctx.exact.put(`crm/Accounts(${guid(a.account_id)})`, change, { division: div });
      if (iban) await ctx.exact.post('crm/BankAccounts', { Account: a.account_id, BankAccount: iban, BankAccountHolderName: a.name ?? current.Name }, { division: div });
    } finally {
      ctx.audit({ tool: 'update_account', division: div, payloadHash: hashPayload({ change, iban }), exactId: a.account_id });
    }
    return { summary: `Updated relation ${current.Name} in division ${div}: ${[...Object.keys(change), ...(iban ? ['IBAN'] : [])].join(', ')}.`, data: { dry_run: false, division: div, id: a.account_id, before, after: change, added_iban: iban ?? null } };
  },
});
