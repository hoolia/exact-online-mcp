import { z } from 'zod';
import { defineTool, type ToolContext } from './types.js';
import { divisionField, fmt, guidField, isoDate, readOnly, topField, totalsByCurrency, totalsText, trimCode } from './common.js';
import { and, date, guid, str } from '../exact/odata.js';
import { ExactError } from '../exact/errors.js';

// --- sales entries (verkoopboekingen in a financial sales journal) ---

export const SALES_STATUS: Record<string, number> = { open: 20, processed: 50 };
const salesStatusName = (n: number) => (n === 20 ? 'open' : n === 50 ? 'processed' : n === 5 ? 'rejected' : String(n));

export const SALES_ENTRY_SELECT = ['EntryID', 'EntryNumber', 'InvoiceNumber', 'Customer', 'CustomerName', 'EntryDate', 'DueDate', 'AmountDC', 'AmountFC', 'VATAmountFC', 'Currency', 'Description', 'Journal', 'Status', 'Type', 'YourRef', 'PaymentReference', 'Document'];

export const salesEntryShape = (r: any) => ({
  id: r.EntryID, entry_number: r.EntryNumber, invoice_number: r.InvoiceNumber, customer_id: r.Customer, customer_name: r.CustomerName,
  entry_date: r.EntryDate?.slice(0, 10), due_date: r.DueDate?.slice(0, 10), amount_dc: r.AmountDC, amount_fc: r.AmountFC, vat_amount_fc: r.VATAmountFC,
  currency: r.Currency, description: r.Description, journal: trimCode(r.Journal), status: salesStatusName(r.Status),
  type: r.Type === 21 ? 'credit_note' : 'invoice', your_ref: r.YourRef, payment_reference: r.PaymentReference, document_id: r.Document ?? null,
});

export const listSalesEntries = defineTool({
  name: 'list_sales_entries',
  title: 'List sales entries',
  description: 'Lists sales entries booked in a financial sales journal (verkoopboekingen, also self-billing invoices a customer issued), newest first, optionally filtered by entry date range, customer, status (open/processed) and your_ref. Sales invoices made in the invoicing module are list_sales_invoices; both end up here once processed.',
  inputSchema: {
    date_from: isoDate('Entry date from (inclusive).').optional(), date_to: isoDate('Entry date to (inclusive).').optional(),
    customer_id: guidField('Customer account GUID.').optional(), status: z.enum(['open', 'processed']).optional(),
    your_ref: z.string().min(1).max(60).optional().describe('Reference of the source document (exact match).'),
    division: divisionField, top: topField(),
  },
  annotations: readOnly,
  async run(ctx, a) {
    const filter = and([a.date_from && `EntryDate ge ${date(a.date_from)}`, a.date_to && `EntryDate le ${date(a.date_to)}`, a.customer_id && `Customer eq ${guid(a.customer_id)}`, a.status && `Status eq ${SALES_STATUS[a.status]}`, a.your_ref && `YourRef eq ${str(a.your_ref)}`]);
    const { rows, truncated } = await ctx.exact.list('salesentry/SalesEntries', { select: SALES_ENTRY_SELECT, filter, orderby: 'EntryDate desc' }, { division: a.division, maxRows: a.top, maxPages: 10 });
    const totals = totalsByCurrency(rows.map((r: any) => ({ amount: r.AmountFC ?? 0, currency: r.Currency ?? '' })));
    return { summary: `Found ${rows.length} sales entr${rows.length === 1 ? 'y' : 'ies'} totalling ${totalsText(totals)}${truncated ? ' (more exist; narrow the filters)' : ''}.`, data: { totals, truncated, entries: rows.map(salesEntryShape) } };
  },
});

export const getSalesEntry = defineTool({
  name: 'get_sales_entry',
  title: 'Get sales entry',
  description: 'Returns one sales entry with its lines (G/L account, amount, VAT code). Identify it by entry_id (GUID) or entry_number.',
  inputSchema: { entry_id: guidField('Sales entry GUID.').optional(), entry_number: z.number().int().positive().optional(), division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    let e: any;
    if (a.entry_id) e = await ctx.exact.getOne(`salesentry/SalesEntries(${guid(a.entry_id)})`, { select: SALES_ENTRY_SELECT }, { division: a.division });
    else if (a.entry_number) e = (await ctx.exact.list('salesentry/SalesEntries', { select: SALES_ENTRY_SELECT, filter: `EntryNumber eq ${a.entry_number}` }, { division: a.division, maxRows: 1, maxPages: 1 })).rows[0];
    else throw new ExactError('invalid_input', 'Provide entry_id or entry_number.');
    if (!e) throw new ExactError('invalid_input', 'Sales entry not found.');
    const { rows: lines } = await ctx.exact.list('salesentry/SalesEntryLines', {
      select: ['LineNumber', 'Description', 'GLAccount', 'GLAccountCode', 'GLAccountDescription', 'AmountFC', 'AmountDC', 'VATCode', 'VATPercentage', 'VATAmountFC', 'CostCenter'],
      filter: `EntryID eq ${guid(e.EntryID)}`, orderby: 'LineNumber',
    }, { division: a.division, maxRows: 200, maxPages: 4 });
    return {
      summary: `Sales entry ${e.EntryNumber} for ${e.CustomerName}: ${e.Currency} ${fmt(e.AmountFC ?? 0)}, ${lines.length} line(s), ${salesStatusName(e.Status)}.`,
      data: { ...salesEntryShape(e), lines: lines.map((l: any) => ({ line: l.LineNumber, description: l.Description, gl_account_id: l.GLAccount, gl_account: trimCode(l.GLAccountCode), gl_description: l.GLAccountDescription, amount_fc: l.AmountFC, amount_dc: l.AmountDC, vat_code: trimCode(l.VATCode), vat_percentage: l.VATPercentage, vat_amount_fc: l.VATAmountFC, cost_center: trimCode(l.CostCenter) })) },
    };
  },
});

// --- general journal entries (memoriaal) ---

const GJ_SELECT = ['EntryID', 'EntryNumber', 'FinancialYear', 'FinancialPeriod', 'JournalCode', 'JournalDescription', 'Status', 'Reversal', 'Created'];
const gjShape = (r: any) => ({ id: r.EntryID, entry_number: r.EntryNumber, year: r.FinancialYear, period: r.FinancialPeriod, journal: trimCode(r.JournalCode), journal_description: r.JournalDescription, status: salesStatusName(r.Status), reversal: !!r.Reversal, created: r.Created });

export const listGeneralJournalEntries = defineTool({
  name: 'list_general_journal_entries',
  title: 'List general journal entries',
  description: 'Lists general journal (memoriaal) entries, newest first, optionally filtered by financial year and period, journal code and status. For the lines use get_general_journal_entry.',
  inputSchema: {
    year: z.number().int().min(2000).max(2100).optional(), period: z.number().int().min(1).max(13).optional(),
    journal: z.string().min(1).max(10).optional(), status: z.enum(['open', 'processed']).optional(), division: divisionField, top: topField(),
  },
  annotations: readOnly,
  async run(ctx, a) {
    const filter = and([a.year && `FinancialYear eq ${a.year}`, a.period && `FinancialPeriod eq ${a.period}`, a.journal && `JournalCode eq ${str(a.journal)}`, a.status && `Status eq ${SALES_STATUS[a.status]}`]);
    const { rows, truncated } = await ctx.exact.list('generaljournalentry/GeneralJournalEntries', { select: GJ_SELECT, filter, orderby: 'EntryNumber desc' }, { division: a.division, maxRows: a.top, maxPages: 10 });
    return { summary: `Found ${rows.length} general journal entr${rows.length === 1 ? 'y' : 'ies'}${truncated ? ' (more exist; narrow the filters)' : ''}.`, data: { truncated, entries: rows.map(gjShape) } };
  },
});

export const getGeneralJournalEntry = defineTool({
  name: 'get_general_journal_entry',
  title: 'Get general journal entry',
  description: 'Returns one general journal entry with its lines (G/L account, debit positive amount, VAT, relation). Identify it by entry_id (GUID) or entry_number.',
  inputSchema: { entry_id: guidField('General journal entry GUID.').optional(), entry_number: z.number().int().positive().optional(), division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    let e: any;
    if (a.entry_id) e = await ctx.exact.getOne(`generaljournalentry/GeneralJournalEntries(${guid(a.entry_id)})`, { select: GJ_SELECT }, { division: a.division });
    else if (a.entry_number) e = (await ctx.exact.list('generaljournalentry/GeneralJournalEntries', { select: GJ_SELECT, filter: `EntryNumber eq ${a.entry_number}` }, { division: a.division, maxRows: 1, maxPages: 1 })).rows[0];
    else throw new ExactError('invalid_input', 'Provide entry_id or entry_number.');
    if (!e) throw new ExactError('invalid_input', 'General journal entry not found.');
    const { rows: lines } = await ctx.exact.list('generaljournalentry/GeneralJournalEntryLines', {
      select: ['Date', 'Description', 'GLAccount', 'GLAccountCode', 'GLAccountDescription', 'AmountFC', 'AmountDC', 'AmountVATFC', 'VATCode', 'Account', 'AccountName', 'CostCenter'],
      filter: `EntryID eq ${guid(e.EntryID)}`,
    }, { division: a.division, maxRows: 500, maxPages: 10 });
    const debit = lines.reduce((s: number, l: any) => s + Math.max(0, Number(l.AmountDC ?? 0)), 0);
    return {
      summary: `General journal entry ${e.EntryNumber} (journal ${trimCode(e.JournalCode)}, ${e.FinancialYear}/${e.FinancialPeriod}): ${lines.length} line(s), debit ${fmt(debit)}, ${salesStatusName(e.Status)}.`,
      data: { ...gjShape(e), lines: lines.map((l: any) => ({ date: l.Date?.slice(0, 10), description: l.Description, gl_account_id: l.GLAccount, gl_account: trimCode(l.GLAccountCode), gl_description: l.GLAccountDescription, amount_fc: l.AmountFC, amount_dc: l.AmountDC, vat_amount_fc: l.AmountVATFC, vat_code: trimCode(l.VATCode), account_id: l.Account, account_name: l.AccountName, cost_center: trimCode(l.CostCenter) })) },
    };
  },
});

// --- documents ---

const DOC_SELECT = ['ID', 'Subject', 'Type', 'TypeDescription', 'Account', 'AccountName', 'DocumentDate', 'Created', 'FinancialTransactionEntryID'];
const docShape = (d: any) => ({ id: d.ID, subject: d.Subject, type: d.Type, type_description: d.TypeDescription, account_id: d.Account, account_name: d.AccountName, document_date: d.DocumentDate?.slice(0, 10), created: d.Created, entry_id: d.FinancialTransactionEntryID ?? null });

export const listDocuments = defineTool({
  name: 'list_documents',
  title: 'List documents',
  description: 'Lists documents in Exact (invoices, receipts, bank import files), newest first, optionally filtered by relation, document type (list_document_types), subject text and creation date. get_document returns the attachments and can download one.',
  inputSchema: {
    account_id: guidField('Relation GUID.').optional(), type: z.number().int().positive().optional().describe('Document type id.'),
    subject: z.string().min(1).max(100).optional().describe('Text contained in the subject.'),
    created_from: isoDate('Created on or after this date.').optional(), division: divisionField, top: topField(),
  },
  annotations: readOnly,
  async run(ctx, a) {
    const filter = and([a.account_id && `Account eq ${guid(a.account_id)}`, a.type && `Type eq ${a.type}`, a.subject && `substringof(${str(a.subject)}, Subject) eq true`, a.created_from && `Created ge ${date(a.created_from)}`]);
    const { rows, truncated } = await ctx.exact.list('documents/Documents', { select: DOC_SELECT, filter, orderby: 'Created desc' }, { division: a.division, maxRows: a.top, maxPages: 10 });
    return { summary: `Found ${rows.length} document(s)${truncated ? ' (more exist; narrow the filters)' : ''}.`, data: { truncated, documents: rows.map(docShape) } };
  },
});

async function documentAttachments(ctx: ToolContext, documentId: string, division?: number) {
  const { rows } = await ctx.exact.list('documents/DocumentAttachments', { select: ['ID', 'FileName', 'FileSize', 'Url'], filter: `Document eq ${guid(documentId)}` }, { division, maxRows: 50, maxPages: 1 });
  return rows;
}

export const getDocument = defineTool({
  name: 'get_document',
  title: 'Get document',
  description: 'Returns one document with its attachments (file name, size). With download_attachment_id it also returns that file as content_base64 (up to the attachment size limit), e.g. to read the PDF of a booked invoice.',
  inputSchema: { document_id: guidField('Document GUID (list_documents, or document_id of an entry).'), download_attachment_id: guidField('Attachment GUID to download.').optional(), division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const d: any = await ctx.exact.getOne(`documents/Documents(${guid(a.document_id)})`, { select: DOC_SELECT }, { division: a.division });
    if (!d) throw new ExactError('invalid_input', 'Document not found.');
    const atts = await documentAttachments(ctx, d.ID, a.division);
    let download: { attachment_id: string; file_name: string; content_type: string | null; bytes: number; content_base64: string } | null = null;
    if (a.download_attachment_id) {
      const att: any = atts.find((x: any) => String(x.ID).toLowerCase() === a.download_attachment_id!.toLowerCase());
      if (!att) throw new ExactError('invalid_input', 'That attachment does not belong to this document.');
      const f = await ctx.exact.download(att.Url, ctx.config.maxAttachmentBytes);
      download = { attachment_id: att.ID, file_name: att.FileName, content_type: f.contentType, bytes: f.bytes.length, content_base64: f.bytes.toString('base64') };
    }
    return {
      summary: `Document "${d.Subject}" (${d.TypeDescription ?? d.Type}) with ${atts.length} attachment(s)${download ? `; downloaded ${download.file_name} (${download.bytes} bytes)` : ''}.`,
      data: { ...docShape(d), attachments: atts.map((x: any) => ({ id: x.ID, file_name: x.FileName, size: x.FileSize })), download },
    };
  },
});

// --- generic read ---

const RESOURCE = /^(?:[A-Za-z]+\/)+[A-Za-z]+$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)?$/;

export const queryExact = defineTool({
  name: 'query_exact',
  title: 'Query any Exact Online resource (read only)',
  description: 'Reads any Exact Online REST resource the dedicated tools do not cover, for example "cashflow/Payments", "cashflow/Receivables", "financialtransaction/TransactionLines", "assets/Assets", "payroll/Employments", "project/Projects", "crm/BankAccounts", "vat/VatPercentages". Give the resource path after the division, the fields to select, and optionally an OData v2 $filter (e.g. "EntryDate ge datetime\'2026-01-01\'", "Account eq guid\'...\'") and $orderby. See the Exact Online REST API reference for the fields. GET only.',
  inputSchema: {
    resource: z.string().min(3).max(80).regex(RESOURCE, 'use the form "area/Resource", e.g. cashflow/Payments'),
    select: z.array(z.string().regex(FIELD, 'field name')).min(1).max(40),
    filter: z.string().min(1).max(1000).optional(), orderby: z.string().min(1).max(200).regex(/^[A-Za-z0-9_/ ,]+$/, 'fields with asc/desc').optional(),
    division: divisionField, top: topField(100, 1000),
  },
  annotations: readOnly,
  async run(ctx, a) {
    const { rows, truncated } = await ctx.exact.list(a.resource, { select: a.select, filter: a.filter, orderby: a.orderby }, { division: a.division, maxRows: a.top, maxPages: 20 });
    return { summary: `Found ${rows.length} ${a.resource} row(s)${truncated ? ' (more exist; narrow the filter)' : ''}.`, data: { truncated, rows } };
  },
});
