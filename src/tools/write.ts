import { z } from 'zod';
import { defineTool, type ToolContext } from './types.js';
import { divisionField, guidField, hashPayload, isoDate } from './common.js';

const dryRun = z.boolean().default(true).describe('Default true: only returns the payload that would be posted. Set false ONLY after the user explicitly confirmed the details.');

const line = z.object({
  item_id: guidField('Item GUID from search_items.'),
  quantity: z.number().positive(),
  unit_price: z.number().min(0).optional().describe('Omit to use the item\'s standard price.'),
  description: z.string().max(240).optional(),
});

const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

async function postOrPreview(ctx: ToolContext, tool: string, resource: string, body: Record<string, unknown>, division: number | undefined, dry: boolean, idField: string, note: string) {
  const div = await ctx.exact.resolveDivision(division);
  if (dry) {
    return { summary: `DRY RUN (nothing was created in division ${div}). ${note} Confirm with the user, then call again with dry_run=false.`, data: { dry_run: true, division: div, resource, payload: body } };
  }
  const payloadHash = hashPayload(body);
  let created: any;
  try {
    created = await ctx.exact.post(resource, body, { division: div });
  } finally {
    // audit regardless of outcome; exact id only known on success
    ctx.audit({ tool, division: div, payloadHash, exactId: created?.[idField] ?? null });
  }
  return { summary: `Created ${tool.replace('create_', '').replace('_', ' ')} in division ${div}.`, data: { dry_run: false, division: div, id: created?.[idField], number: created?.OrderNumber ?? created?.InvoiceNumber ?? created?.QuotationNumber } };
}

const compact = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const createSalesOrder = defineTool({
  name: 'create_sales_order',
  title: 'Create sales order',
  description: 'Creates a sales order for a customer. WRITES to Exact Online. Always show the user the dry-run result and get explicit confirmation before calling with dry_run=false. Requires a Wholesale & Distribution package.',
  inputSchema: { customer_id: guidField('Customer account GUID.'), lines: z.array(line).min(1).max(50), description: z.string().max(240).optional(), your_ref: z.string().max(60).optional(), order_date: isoDate('Order date').optional(), delivery_date: isoDate('Delivery date').optional(), division: divisionField, dry_run: dryRun },
  annotations: writeAnnotations,
  async run(ctx, a) {
    const body = compact({
      OrderedBy: a.customer_id, Description: a.description, YourRef: a.your_ref, OrderDate: a.order_date, DeliveryDate: a.delivery_date,
      SalesOrderLines: a.lines.map((l: any) => compact({ Item: l.item_id, Quantity: l.quantity, UnitPrice: l.unit_price, Description: l.description })),
    });
    return postOrPreview(ctx, 'create_sales_order', 'salesorder/SalesOrders', body, a.division, a.dry_run, 'OrderID', `Sales order with ${a.lines.length} line(s).`);
  },
});

export const createSalesInvoice = defineTool({
  name: 'create_sales_invoice',
  title: 'Create sales invoice (draft)',
  description: 'Creates a DRAFT sales invoice (never sent or processed automatically). WRITES to Exact Online. Show the dry-run result and get explicit user confirmation before calling with dry_run=false.',
  inputSchema: { customer_id: guidField('Customer account GUID.'), journal: z.string().min(1).max(10).describe('Sales journal code, e.g. "70".'), lines: z.array(line.extend({ gl_account_id: guidField('Revenue G/L account GUID (from list_gl_accounts).').optional() })).min(1).max(50), description: z.string().max(240).optional(), your_ref: z.string().max(60).optional(), invoice_date: isoDate('Invoice date').optional(), division: divisionField, dry_run: dryRun },
  annotations: writeAnnotations,
  async run(ctx, a) {
    const body = compact({
      Journal: a.journal, OrderedBy: a.customer_id, Description: a.description, YourRef: a.your_ref, InvoiceDate: a.invoice_date, Status: 10,
      SalesInvoiceLines: a.lines.map((l: any) => compact({ Item: l.item_id, Quantity: l.quantity, UnitPrice: l.unit_price, Description: l.description, GLAccount: l.gl_account_id })),
    });
    return postOrPreview(ctx, 'create_sales_invoice', 'salesinvoice/SalesInvoices', body, a.division, a.dry_run, 'InvoiceID', 'Draft sales invoice (status 10); it will not be sent.');
  },
});

export const createQuotation = defineTool({
  name: 'create_quotation',
  title: 'Create quotation',
  description: 'Creates a quotation for a customer. WRITES to Exact Online. Show the dry-run result and get explicit user confirmation before calling with dry_run=false.',
  inputSchema: { customer_id: guidField('Customer account GUID.'), lines: z.array(line).min(1).max(50), description: z.string().max(240).optional(), quotation_date: isoDate('Quotation date').optional(), valid_until: isoDate('Due/valid-until date').optional(), division: divisionField, dry_run: dryRun },
  annotations: writeAnnotations,
  async run(ctx, a) {
    const body = compact({
      OrderAccount: a.customer_id, Description: a.description, QuotationDate: a.quotation_date, DueDate: a.valid_until,
      QuotationLines: a.lines.map((l: any) => compact({ Item: l.item_id, Quantity: l.quantity, UnitPrice: l.unit_price, Description: l.description })),
    });
    return postOrPreview(ctx, 'create_quotation', 'crm/Quotations', body, a.division, a.dry_run, 'QuotationID', `Quotation with ${a.lines.length} line(s).`);
  },
});
