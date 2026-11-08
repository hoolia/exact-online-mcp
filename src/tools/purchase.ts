import { z } from 'zod';
import { defineTool, type ToolContext } from './types.js';
import { divisionField, fmt, guidField, isoDate, readOnly, round2, topField, trimCode } from './common.js';
import { and, date, guid, str } from '../exact/odata.js';
import { ExactError } from '../exact/errors.js';

export const ENTRY_STATUS: Record<string, number> = { rejected: 5, open: 20, processed: 50 };
export const entryStatusName = (n: number) => (n === 5 ? 'rejected' : n === 20 ? 'open' : n === 50 ? 'processed' : String(n));

export const ENTRY_SELECT = ['EntryID', 'EntryNumber', 'InvoiceNumber', 'Supplier', 'SupplierName', 'EntryDate', 'DueDate', 'AmountDC', 'AmountFC', 'VATAmountFC', 'Currency', 'Description', 'Journal', 'Status', 'Type', 'YourRef', 'PaymentReference', 'Document', 'DocumentSubject'];

export const entryShape = (r: any) => ({
  id: r.EntryID, entry_number: r.EntryNumber, invoice_number: r.InvoiceNumber, supplier_id: r.Supplier, supplier_name: r.SupplierName,
  entry_date: r.EntryDate?.slice(0, 10), due_date: r.DueDate?.slice(0, 10), amount_dc: r.AmountDC, amount_fc: r.AmountFC, vat_amount_fc: r.VATAmountFC,
  currency: r.Currency, description: r.Description, journal: trimCode(r.Journal), status: entryStatusName(r.Status),
  type: r.Type === 31 ? 'credit_note' : 'invoice', your_ref: r.YourRef, payment_reference: r.PaymentReference,
  document_id: r.Document ?? null, document_subject: r.DocumentSubject ?? null,
});

export async function findEntry(ctx: ToolContext, a: { entry_id?: string; entry_number?: number; division?: number }) {
  if (a.entry_id) return ctx.exact.getOne(`purchaseentry/PurchaseEntries(${guid(a.entry_id)})`, { select: ENTRY_SELECT }, { division: a.division });
  if (a.entry_number) return (await ctx.exact.list('purchaseentry/PurchaseEntries', { select: ENTRY_SELECT, filter: `EntryNumber eq ${a.entry_number}` }, { division: a.division, maxRows: 1, maxPages: 1 })).rows[0] ?? null;
  throw new ExactError('invalid_input', 'Provide entry_id or entry_number.');
}

export const getPurchaseEntry = defineTool({
  name: 'get_purchase_entry',
  title: 'Get purchase entry',
  description: 'Returns one purchase entry (supplier invoice booking) with its lines (G/L account, amount, VAT code) and its linked document, if any. Identify it by entry_id (GUID) or entry_number.',
  inputSchema: { entry_id: guidField('Purchase entry GUID.').optional(), entry_number: z.number().int().positive().optional().describe('Entry number.'), division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const e: any = await findEntry(ctx, a);
    if (!e) throw new ExactError('invalid_input', 'Purchase entry not found.');
    const { rows: lines } = await ctx.exact.list('purchaseentry/PurchaseEntryLines', {
      select: ['ID', 'LineNumber', 'Description', 'GLAccount', 'GLAccountCode', 'GLAccountDescription', 'AmountFC', 'AmountDC', 'VATCode', 'VATCodeDescription', 'VATPercentage', 'VATAmountFC', 'CostCenter', 'Notes'],
      filter: `EntryID eq ${guid(e.EntryID)}`, orderby: 'LineNumber',
    }, { division: a.division, maxRows: 200, maxPages: 4 });
    const data = {
      ...entryShape(e),
      lines: lines.map((l: any) => ({ line: l.LineNumber, description: l.Description, gl_account_id: l.GLAccount, gl_account: trimCode(l.GLAccountCode), gl_description: l.GLAccountDescription, amount_fc: l.AmountFC, amount_dc: l.AmountDC, vat_code: trimCode(l.VATCode), vat_description: l.VATCodeDescription, vat_percentage: l.VATPercentage, vat_amount_fc: l.VATAmountFC, cost_center: l.CostCenter, notes: l.Notes })),
    };
    return { summary: `Purchase entry ${e.EntryNumber} of ${e.SupplierName} (${e.YourRef ?? 'no supplier invoice number'}): ${e.Currency} ${fmt(e.AmountFC ?? 0)}, ${lines.length} line(s), ${entryStatusName(e.Status)}${e.Document ? ', document attached' : ', no document'}.`, data };
  },
});

export const listBankTransactionLines = defineTool({
  name: 'list_bank_transaction_lines',
  title: 'List bank transaction lines',
  description: 'Lists bank statement lines (bank and payment service journals) in a date range, newest first, with the relation, G/L account, description and amount (sign as Exact stores it on the line; compare one known payment first). Lines still on a suspense account have no relation yet. Use to match payments to open purchase or sales invoices (list_open_payables / list_open_receivables).',
  inputSchema: {
    date_from: isoDate('Statement line date from (inclusive).'), date_to: isoDate('Statement line date to (inclusive).'),
    account_id: guidField('Only lines of this relation (supplier/customer GUID from search_accounts).').optional(),
    gl_account_id: guidField('Only lines booked on this G/L account (GUID from list_gl_accounts).').optional(),
    description: z.string().min(1).max(100).optional().describe('Text contained in the line description.'),
    amount_min: z.number().optional().describe('Only lines with amount (transaction currency) >= this value.'),
    amount_max: z.number().optional().describe('Only lines with amount (transaction currency) <= this value.'),
    division: divisionField, top: topField(100, 500),
  },
  annotations: readOnly,
  async run(ctx, a) {
    const filter = and([
      `Date ge ${date(a.date_from)}`, `Date le ${date(a.date_to)}`,
      a.account_id && `Account eq ${guid(a.account_id)}`, a.gl_account_id && `GLAccount eq ${guid(a.gl_account_id)}`,
      a.description && `substringof(${str(a.description)}, Description) eq true`,
      a.amount_min !== undefined && `AmountFC ge ${a.amount_min}`, a.amount_max !== undefined && `AmountFC le ${a.amount_max}`,
    ]);
    const select = ['ID', 'EntryID', 'EntryNumber', 'LineNumber', 'Date', 'Description', 'Notes', 'Account', 'AccountCode', 'AccountName', 'GLAccount', 'GLAccountCode', 'GLAccountDescription', 'AmountFC', 'AmountDC', 'OurRef', 'Document'];
    const { rows, truncated } = await ctx.exact.list('financialtransaction/BankEntryLines', { select, filter, orderby: 'Date desc' }, { division: a.division, maxRows: a.top, maxPages: 10 });
    const net = round2(rows.reduce((s: number, r: any) => s + (r.AmountDC ?? 0), 0));
    return {
      summary: `Found ${rows.length} bank line(s), net ${fmt(net)} (default currency)${truncated ? ' (more exist; narrow the filters)' : ''}.`,
      data: { net_amount_dc: net, truncated, lines: rows.map((r: any) => ({ id: r.ID, entry_id: r.EntryID, entry_number: r.EntryNumber, line: r.LineNumber, date: r.Date?.slice(0, 10), description: r.Description, notes: r.Notes, account_id: r.Account, account_code: trimCode(r.AccountCode), account_name: r.AccountName, gl_account_id: r.GLAccount, gl_account: trimCode(r.GLAccountCode), gl_description: r.GLAccountDescription, amount_fc: r.AmountFC, amount_dc: r.AmountDC, our_ref: r.OurRef, document_id: r.Document ?? null })) },
    };
  },
});

export const listVatCodes = defineTool({
  name: 'list_vat_codes',
  title: 'List VAT codes',
  description: 'Lists VAT codes (code, description, percentage, calculation type, purchase/sales use). Use the code in draft_purchase_entry lines.',
  inputSchema: {
    query: z.string().min(1).max(100).optional().describe('Text contained in the description, or the exact code.'),
    use: z.enum(['purchase', 'sales', 'any']).default('any').describe('Only codes usable for purchase or sales transactions.'),
    include_blocked: z.boolean().default(false),
    division: divisionField,
  },
  annotations: readOnly,
  async run(ctx, a) {
    const filter = and([
      a.query && `(substringof(${str(a.query)}, Description) eq true or Code eq ${str(a.query)})`,
      a.use === 'purchase' && `(VATTransactionType eq 'P' or VATTransactionType eq 'B')`,
      a.use === 'sales' && `(VATTransactionType eq 'S' or VATTransactionType eq 'B')`,
      !a.include_blocked && 'IsBlocked eq false',
    ]);
    const select = ['ID', 'Code', 'Description', 'Percentage', 'Type', 'VATTransactionType', 'IsBlocked', 'Charged', 'GLToClaimCode', 'GLToPayCode'];
    const { rows } = await ctx.exact.list('vat/VATCodes', { select, filter, orderby: 'Code' }, { division: a.division, maxRows: 500, maxPages: 10 });
    const TYPE: Record<string, string> = { B: 'zero_rate_base_only', E: 'excluding', I: 'including', N: 'no_vat' };
    const USE: Record<string, string> = { B: 'both', P: 'purchase', S: 'sales' };
    return { summary: `Found ${rows.length} VAT code(s).`, data: rows.map((v: any) => ({ id: v.ID, code: trimCode(v.Code), description: v.Description, percentage: v.Percentage, type: TYPE[v.Type] ?? v.Type, use: USE[v.VATTransactionType] ?? v.VATTransactionType, blocked: !!v.IsBlocked, reverse_charge: !!v.Charged, gl_to_claim: trimCode(v.GLToClaimCode), gl_to_pay: trimCode(v.GLToPayCode) })) };
  },
});

export const listJournals = defineTool({
  name: 'list_journals',
  title: 'List journals',
  description: 'Lists financial journals (code, description, type: bank, cash, sales, purchase, general). draft_purchase_entry needs the code of a purchase journal.',
  inputSchema: { kind: z.enum(['purchase', 'sales', 'bank', 'cash', 'general', 'any']).default('any'), division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const TYPES: Record<string, number[]> = { cash: [10], bank: [12], sales: [20, 21], purchase: [22, 23], general: [90] };
    const filter = a.kind === 'any' ? undefined : `(${TYPES[a.kind]!.map((t) => `Type eq ${t}`).join(' or ')})`;
    const { rows } = await ctx.exact.list('financial/Journals', { select: ['ID', 'Code', 'Description', 'Type', 'TypeDescription', 'Currency', 'GLAccountCode'], filter, orderby: 'Code' }, { division: a.division, maxRows: 200, maxPages: 4 });
    return { summary: `Found ${rows.length} journal(s).`, data: rows.map((j: any) => ({ code: trimCode(j.Code), description: j.Description, type: j.TypeDescription ?? j.Type, type_id: j.Type, currency: j.Currency, gl_account: trimCode(j.GLAccountCode) })) };
  },
});

export const listDocumentTypes = defineTool({
  name: 'list_document_types',
  title: 'List document types',
  description: 'Lists Exact document types (id, description, whether documents of the type can be created). attach_document takes the id as document_type.',
  inputSchema: { division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const { rows } = await ctx.exact.list('documents/DocumentTypes', { select: ['ID', 'Description', 'DocumentIsCreatable'], orderby: 'ID' }, { division: a.division, maxRows: 300, maxPages: 5 });
    return { summary: `Found ${rows.length} document type(s).`, data: rows.map((t: any) => ({ id: t.ID, description: t.Description, creatable: !!t.DocumentIsCreatable })) };
  },
});
