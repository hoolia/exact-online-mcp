import { z } from 'zod';
import { defineTool } from './types.js';
import { divisionField, fmt, guidField, isoDate, readOnly, round2, topField, totalsByCurrency, totalsText } from './common.js';
import { and, date, guid, str } from '../exact/odata.js';
import { ENTRY_STATUS, entryShape } from './purchase.js';
import { ExactError } from '../exact/errors.js';

const STATUS: Record<string, number> = { draft: 10, open: 20, processed: 50 };
const statusName = (n: number) => (n === 10 ? 'draft' : n === 20 ? 'open' : n === 50 ? 'processed' : String(n));
const INVOICE_SELECT = ['InvoiceID', 'InvoiceNumber', 'InvoiceDate', 'DueDate', 'OrderedBy', 'OrderedByName', 'Status', 'Type', 'Currency', 'AmountDC', 'AmountFC', 'VATAmountFC', 'Description', 'Journal', 'YourRef'];

const invoiceShape = (i: any) => ({
  id: i.InvoiceID, number: i.InvoiceNumber, invoice_date: i.InvoiceDate?.slice(0, 10), due_date: i.DueDate?.slice(0, 10),
  customer_id: i.OrderedBy, customer_name: i.OrderedByName, status: statusName(i.Status), type: i.Type === 8021 ? 'credit_note' : 'invoice',
  currency: i.Currency, amount_excl_vat_dc: i.AmountDC, amount_fc: i.AmountFC, vat_amount_fc: i.VATAmountFC, description: i.Description, journal: i.Journal, your_ref: i.YourRef,
});

export const listSalesInvoices = defineTool({
  name: 'list_sales_invoices',
  title: 'List sales invoices',
  description: 'Lists sales invoices, newest first, optionally filtered by invoice date range, status (draft/open/processed) and customer account. Returns totals per currency. For open/unpaid invoices and ageing use list_open_receivables instead.',
  inputSchema: {
    date_from: isoDate('Invoice date from (inclusive).').optional(), date_to: isoDate('Invoice date to (inclusive).').optional(),
    status: z.enum(['draft', 'open', 'processed']).optional(), account_id: guidField('Customer account GUID.').optional(),
    division: divisionField, top: topField(),
  },
  annotations: readOnly,
  async run(ctx, a) {
    const filter = and([a.date_from && `InvoiceDate ge ${date(a.date_from)}`, a.date_to && `InvoiceDate le ${date(a.date_to)}`, a.status && `Status eq ${STATUS[a.status]}`, a.account_id && `OrderedBy eq ${guid(a.account_id)}`]);
    const { rows, truncated } = await ctx.exact.list('salesinvoice/SalesInvoices', { select: INVOICE_SELECT, filter, orderby: 'InvoiceDate desc' }, { division: a.division, maxRows: a.top, maxPages: 10 });
    const totals = totalsByCurrency(rows.map((r: any) => ({ amount: r.AmountFC ?? 0, currency: r.Currency ?? '' })));
    return { summary: `Found ${rows.length} sales invoice(s) totalling ${totalsText(totals)} excl. VAT${truncated ? ' (more exist; narrow the filters)' : ''}.`, data: { totals_excl_vat: totals, truncated, invoices: rows.map(invoiceShape) } };
  },
});

export const getSalesInvoice = defineTool({
  name: 'get_sales_invoice',
  title: 'Get sales invoice',
  description: 'Returns one sales invoice with its lines. Identify it by invoice_id (GUID) or invoice_number.',
  inputSchema: { invoice_id: guidField('Invoice GUID.').optional(), invoice_number: z.number().int().positive().optional().describe('Invoice number.'), division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    if (!a.invoice_id && !a.invoice_number) throw new ExactError('invalid_input', 'Provide invoice_id or invoice_number.');
    let inv: any;
    if (a.invoice_id) inv = await ctx.exact.getOne(`salesinvoice/SalesInvoices(${guid(a.invoice_id)})`, { select: INVOICE_SELECT }, { division: a.division });
    else inv = (await ctx.exact.list('salesinvoice/SalesInvoices', { select: INVOICE_SELECT, filter: `InvoiceNumber eq ${a.invoice_number}` }, { division: a.division, maxRows: 1, maxPages: 1 })).rows[0];
    if (!inv) throw new ExactError('invalid_input', 'Sales invoice not found.');
    const { rows: lines } = await ctx.exact.list('salesinvoice/SalesInvoiceLines', {
      select: ['ID', 'LineNumber', 'Description', 'ItemCode', 'ItemDescription', 'Quantity', 'UnitCode', 'UnitPrice', 'NetPrice', 'AmountDC', 'AmountFC', 'VATAmountFC', 'VATCode', 'VATPercentage'],
      filter: `InvoiceID eq ${guid(inv.InvoiceID)}`, orderby: 'LineNumber',
    }, { division: a.division, maxRows: 200, maxPages: 4 });
    const data = { ...invoiceShape(inv), lines: lines.map((l: any) => ({ line: l.LineNumber, description: l.Description ?? l.ItemDescription, item_code: l.ItemCode?.trim?.() ?? l.ItemCode, quantity: l.Quantity, unit: l.UnitCode, unit_price: l.UnitPrice, net_price: l.NetPrice, amount_dc: l.AmountDC, amount_fc: l.AmountFC, vat_amount_fc: l.VATAmountFC, vat_code: l.VATCode?.trim?.() ?? l.VATCode, vat_percentage: l.VATPercentage })) };
    return { summary: `Invoice ${inv.InvoiceNumber} for ${inv.OrderedByName}: ${inv.Currency} ${fmt(inv.AmountFC)} excl. VAT, ${lines.length} line(s), ${statusName(inv.Status)}.`, data };
  },
});

export const listPurchaseEntries = defineTool({
  name: 'list_purchase_entries',
  title: 'List purchase entries',
  description: 'Lists purchase (supplier) invoice entries, newest first, optionally filtered by entry date range, supplier, status (open = not yet processed, processed, rejected) and supplier invoice number (your_ref). For unpaid supplier invoices with ageing use list_open_payables; for the lines of one entry use get_purchase_entry.',
  inputSchema: {
    date_from: isoDate('Entry date from (inclusive).').optional(), date_to: isoDate('Entry date to (inclusive).').optional(),
    supplier_id: guidField('Supplier account GUID.').optional(),
    status: z.enum(['open', 'processed', 'rejected']).optional().describe('open = Status 20, not yet processed.'),
    your_ref: z.string().min(1).max(60).optional().describe("Supplier's invoice number (exact match)."),
    division: divisionField, top: topField(),
  },
  annotations: readOnly,
  async run(ctx, a) {
    const filter = and([a.date_from && `EntryDate ge ${date(a.date_from)}`, a.date_to && `EntryDate le ${date(a.date_to)}`, a.supplier_id && `Supplier eq ${guid(a.supplier_id)}`, a.status && `Status eq ${ENTRY_STATUS[a.status]}`, a.your_ref && `YourRef eq ${str(a.your_ref)}`]);
    const select = ['EntryID', 'EntryNumber', 'InvoiceNumber', 'Supplier', 'SupplierName', 'EntryDate', 'DueDate', 'AmountDC', 'AmountFC', 'VATAmountFC', 'Currency', 'Description', 'Journal', 'Status', 'Type', 'YourRef', 'PaymentReference', 'Document', 'DocumentSubject'];
    const { rows, truncated } = await ctx.exact.list('purchaseentry/PurchaseEntries', { select, filter, orderby: 'EntryDate desc' }, { division: a.division, maxRows: a.top, maxPages: 10 });
    const totals = totalsByCurrency(rows.map((r: any) => ({ amount: r.AmountFC ?? 0, currency: r.Currency ?? '' })));
    return {
      summary: `Found ${rows.length} purchase entr${rows.length === 1 ? 'y' : 'ies'} totalling ${totalsText(totals)}${truncated ? ' (more exist; narrow the filters)' : ''}.`,
      data: { totals, truncated, entries: rows.map(entryShape) },
    };
  },
});

export const searchItems = defineTool({
  name: 'search_items',
  title: 'Search items',
  description: 'Searches items/products by code or description. Returns id (GUID, used by write tools), code, description, standard sales price, cost price and stock.',
  inputSchema: { query: z.string().min(1).max(100).optional().describe('Text in the code or description.'), sales_items_only: z.boolean().default(false), division: divisionField, top: topField() },
  annotations: readOnly,
  async run(ctx, a) {
    const q = a.query?.replace(/'/g, "''");
    const filter = and([q && `(substringof('${q}', Description) eq true or substringof('${q}', Code) eq true)`, a.sales_items_only && 'IsSalesItem eq true']);
    const select = ['ID', 'Code', 'Description', 'StandardSalesPrice', 'CostPriceStandard', 'Unit', 'IsSalesItem', 'IsPurchaseItem', 'IsStockItem', 'Stock', 'Barcode'];
    const { rows, truncated } = await ctx.exact.list('logistics/Items', { select, filter, orderby: 'Code' }, { division: a.division, maxRows: a.top });
    return { summary: `Found ${rows.length} item(s)${truncated ? ' (more exist; refine the search)' : ''}.`, data: rows.map((i: any) => ({ id: i.ID, code: i.Code?.trim?.() ?? i.Code, description: i.Description, standard_sales_price: i.StandardSalesPrice, cost_price: i.CostPriceStandard, unit: i.Unit, is_sales_item: !!i.IsSalesItem, is_purchase_item: !!i.IsPurchaseItem, is_stock_item: !!i.IsStockItem, stock: i.Stock, barcode: i.Barcode })) };
  },
});
