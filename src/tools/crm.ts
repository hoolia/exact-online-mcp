import { z } from 'zod';
import { defineTool } from './types.js';
import { divisionField, guidField, readOnly, topField, trimCode } from './common.js';
import { and, guid, str } from '../exact/odata.js';
import { ExactError } from '../exact/errors.js';

const ACCOUNT_SELECT = ['ID', 'Code', 'Name', 'City', 'Postcode', 'Country', 'Email', 'Phone', 'VATNumber', 'Status', 'IsSupplier', 'IsSales', 'Blocked'];

const shape = (a: any) => ({
  id: a.ID, code: trimCode(a.Code), name: a.Name, city: a.City, postcode: a.Postcode, country: a.Country,
  email: a.Email, phone: a.Phone, vat_number: a.VATNumber, status: a.Status, is_customer: !!a.IsSales, is_supplier: !!a.IsSupplier, blocked: !!a.Blocked,
});

export const searchAccounts = defineTool({
  name: 'search_accounts',
  title: 'Search accounts',
  description: 'Searches CRM accounts (customers/suppliers) by name, account code, city or VAT number. All given criteria must match. Returns id (GUID, needed by get_account and invoice tools), code, name, address basics. Use this to find an account before asking about its invoices.',
  inputSchema: {
    query: z.string().min(1).max(100).optional().describe('Text contained in the account name.'),
    code: z.string().min(1).max(18).optional().describe('Exact account code.'),
    city: z.string().min(1).max(100).optional().describe('Text contained in the city.'),
    vat_number: z.string().min(1).max(30).optional().describe('Exact VAT number.'),
    kind: z.enum(['customer', 'supplier', 'any']).default('any').describe('Restrict to customers or suppliers.'),
    division: divisionField, top: topField(),
  },
  annotations: readOnly,
  async run(ctx, a) {
    const filter = and([
      a.query && `substringof(${str(a.query)}, Name) eq true`,
      a.code && `Code eq ${str(a.code.padStart(18, ' '))}`,
      a.city && `substringof(${str(a.city)}, City) eq true`,
      a.vat_number && `VATNumber eq ${str(a.vat_number)}`,
      a.kind === 'customer' && 'IsSales eq true',
      a.kind === 'supplier' && 'IsSupplier eq true',
    ]);
    const { rows, truncated } = await ctx.exact.list('crm/Accounts', { select: ACCOUNT_SELECT, filter, orderby: 'Name' }, { division: a.division, maxRows: a.top });
    return { summary: `Found ${rows.length} account(s)${truncated ? ' (more exist; refine the search)' : ''}.`, data: rows.map(shape) };
  },
});

export const getAccount = defineTool({
  name: 'get_account',
  title: 'Get account',
  description: 'Returns full basic details of one CRM account by GUID, including credit lines and its contacts (main contact first). Use after search_accounts.',
  inputSchema: { account_id: guidField('Account GUID from search_accounts.'), division: divisionField },
  annotations: readOnly,
  async run(ctx, a) {
    const select = [...ACCOUNT_SELECT, 'AddressLine1', 'AddressLine2', 'ChamberOfCommerce', 'CreditLineSales', 'CreditLinePurchase', 'Website'];
    const acc = await ctx.exact.getOne(`crm/Accounts(${guid(a.account_id)})`, { select }, { division: a.division });
    if (!acc) throw new ExactError('invalid_input', 'No account found with that id in this division.');
    const { rows: contacts } = await ctx.exact.list('crm/Contacts', {
      select: ['ID', 'FullName', 'Email', 'Phone', 'JobTitleDescription', 'IsMainContact'], filter: `Account eq ${guid(a.account_id)}`,
    }, { division: a.division, maxRows: 25, maxPages: 1 });
    contacts.sort((x: any, y: any) => Number(!!y.IsMainContact) - Number(!!x.IsMainContact));
    const data = {
      ...shape(acc), address: [acc.AddressLine1, acc.AddressLine2].filter(Boolean), chamber_of_commerce: acc.ChamberOfCommerce, website: acc.Website,
      credit_line_sales: acc.CreditLineSales, credit_line_purchase: acc.CreditLinePurchase,
      contacts: contacts.map((c: any) => ({ id: c.ID, name: c.FullName, email: c.Email, phone: c.Phone, job_title: c.JobTitleDescription, is_main_contact: !!c.IsMainContact })),
    };
    return { summary: `${acc.Name}: ${contacts.length} contact(s).`, data };
  },
});
