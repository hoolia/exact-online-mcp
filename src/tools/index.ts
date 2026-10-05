import type { Config } from '../config.js';
import type { ToolDef } from './types.js';
import { listDivisions, whoami } from './identity.js';
import { getAccount, searchAccounts } from './crm.js';
import { getProfitAndLoss, getRevenueByPeriod, listGlAccounts, listOpenPayables, listOpenReceivables, listTransactions } from './financial.js';
import { getSalesInvoice, listPurchaseEntries, listSalesInvoices, searchItems } from './sales.js';
import { createQuotation, createSalesInvoice, createSalesOrder } from './write.js';

export const readTools: ToolDef[] = [
  whoami, listDivisions, searchAccounts, getAccount, listOpenReceivables, listOpenPayables, listSalesInvoices, getSalesInvoice,
  listPurchaseEntries, searchItems, listGlAccounts, getProfitAndLoss, getRevenueByPeriod, listTransactions,
];
export const writeTools: ToolDef[] = [createSalesOrder, createSalesInvoice, createQuotation];

export function buildTools(cfg: Pick<Config, 'enableWriteTools'>): ToolDef[] {
  return cfg.enableWriteTools ? [...readTools, ...writeTools] : readTools;
}
