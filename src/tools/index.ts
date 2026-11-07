import type { Config } from '../config.js';
import type { ToolDef } from './types.js';
import { listDivisions, whoami } from './identity.js';
import { getAccount, searchAccounts } from './crm.js';
import { getProfitAndLoss, getRevenueByPeriod, listGlAccounts, listOpenPayables, listOpenReceivables, listTransactions } from './financial.js';
import { getSalesInvoice, listPurchaseEntries, listSalesInvoices, searchItems } from './sales.js';
import { createQuotation, createSalesInvoice, createSalesOrder } from './write.js';
import { attachDocument, draftPurchaseEntry, getPurchaseEntry, listBankTransactionLines, listDocumentTypes, listJournals, listVatCodes } from './purchase.js';

export const readTools: ToolDef[] = [
  whoami, listDivisions, searchAccounts, getAccount, listOpenReceivables, listOpenPayables, listSalesInvoices, getSalesInvoice,
  listPurchaseEntries, getPurchaseEntry, searchItems, listGlAccounts, listVatCodes, listJournals, listDocumentTypes, getProfitAndLoss,
  getRevenueByPeriod, listTransactions, listBankTransactionLines,
];
export const writeTools: ToolDef[] = [createSalesOrder, createSalesInvoice, createQuotation, draftPurchaseEntry, attachDocument];

/** WRITE_TOOLS names the write tools to register; ENABLE_WRITE_TOOLS alone registers all of them. */
export function buildTools(cfg: Pick<Config, 'enableWriteTools'> & Partial<Pick<Config, 'writeTools'>>): ToolDef[] {
  if (!cfg.enableWriteTools) return readTools;
  const wanted = cfg.writeTools ?? [];
  if (!wanted.length) return [...readTools, ...writeTools];
  const unknown = wanted.filter((n) => !writeTools.some((t) => t.name === n));
  if (unknown.length) throw new Error(`Invalid configuration:\n  - WRITE_TOOLS: unknown write tool(s) ${unknown.join(', ')}`);
  return [...readTools, ...writeTools.filter((t) => wanted.includes(t.name))];
}
