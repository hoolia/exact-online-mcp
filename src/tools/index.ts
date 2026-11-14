import type { Config } from '../config.js';
import type { ToolDef } from './types.js';
import { listDivisions, whoami } from './identity.js';
import { getAccount, searchAccounts } from './crm.js';
import { getProfitAndLoss, getRevenueByPeriod, listGlAccountRgsMappings, listGlAccounts, listOpenPayables, listOpenReceivables, listTransactions } from './financial.js';
import { getSalesInvoice, listPurchaseEntries, listSalesInvoices, searchItems } from './sales.js';
import { createQuotation, createSalesInvoice, createSalesOrder } from './write.js';
import { getPurchaseEntry, listBankTransactionLines, listDocumentTypes, listJournals, listVatCodes } from './purchase.js';
import { attachDocument, createMatchset, draftGeneralJournalEntry, draftPurchaseEntry, draftSalesEntry, processEntry } from './bookkeeping.js';
import { getBalanceSheet, getTrialBalance, listCostCenters, listFinancialPeriods, listPaymentConditions } from './reports.js';
import { getDocument, getGeneralJournalEntry, getSalesEntry, listDocuments, listGeneralJournalEntries, listSalesEntries, queryExact } from './entries.js';
import { createAccount, updateAccount } from './accounts.js';

export const readTools: ToolDef[] = [
  whoami, listDivisions, searchAccounts, getAccount, listOpenReceivables, listOpenPayables, listSalesInvoices, getSalesInvoice,
  listPurchaseEntries, getPurchaseEntry, searchItems, listGlAccounts, listGlAccountRgsMappings, listVatCodes, listJournals, listDocumentTypes,
  getProfitAndLoss, getRevenueByPeriod, listTransactions, listBankTransactionLines,
  getTrialBalance, getBalanceSheet, listFinancialPeriods, listCostCenters, listPaymentConditions,
  listSalesEntries, getSalesEntry, listGeneralJournalEntries, getGeneralJournalEntry, listDocuments, getDocument, queryExact,
];
/** Write tools that need nothing beyond the Exact connection. */
export const plainWriteTools: ToolDef[] = [createSalesOrder, createSalesInvoice, createQuotation, createAccount, updateAccount];
/** Write tools that need the ledger database, and some an approval key or a feature flag. */
export const ledgerTools: ToolDef[] = [draftPurchaseEntry, draftSalesEntry, draftGeneralJournalEntry, attachDocument, processEntry, createMatchset];
export const writeTools: ToolDef[] = [...plainWriteTools, ...ledgerTools];

type ToolCfg = Pick<Config, 'enableWriteTools'> & Partial<Pick<Config, 'writeTools' | 'approvalSigningKey' | 'enableMatchsets'>>;

/** Why a write tool cannot be registered with this configuration; null when it can. */
function blocker(t: ToolDef, cfg: ToolCfg, hasLedger: boolean): string | null {
  if (!ledgerTools.includes(t)) return null;
  if (!hasLedger) return 'needs DATABASE_URL';
  if ((t === processEntry || t === createMatchset) && !cfg.approvalSigningKey) return 'needs APPROVAL_SIGNING_KEY';
  if (t === createMatchset && !cfg.enableMatchsets) return 'needs ENABLE_MATCHSETS=true';
  return null;
}

/**
 * WRITE_TOOLS names the write tools to register; ENABLE_WRITE_TOOLS alone registers every write tool the
 * configuration supports. A named tool the configuration does not support stops the server at startup.
 */
export function buildTools(cfg: ToolCfg, opts: { hasLedger?: boolean; warn?: (msg: string) => void } = {}): ToolDef[] {
  if (!cfg.enableWriteTools) return readTools;
  const hasLedger = !!opts.hasLedger;
  const wanted = cfg.writeTools ?? [];
  if (!wanted.length) {
    const skipped = writeTools.filter((t) => blocker(t, cfg, hasLedger));
    if (skipped.length) opts.warn?.(`write tools not registered: ${skipped.map((t) => `${t.name} (${blocker(t, cfg, hasLedger)})`).join(', ')}`);
    return [...readTools, ...writeTools.filter((t) => !blocker(t, cfg, hasLedger))];
  }
  const unknown = wanted.filter((n) => !writeTools.some((t) => t.name === n));
  if (unknown.length) throw new Error(`Invalid configuration:\n  - WRITE_TOOLS: unknown write tool(s) ${unknown.join(', ')}`);
  const chosen = writeTools.filter((t) => wanted.includes(t.name));
  const blocked = chosen.filter((t) => blocker(t, cfg, hasLedger));
  if (blocked.length) throw new Error(`Invalid configuration:\n${blocked.map((t) => `  - WRITE_TOOLS: ${t.name} ${blocker(t, cfg, hasLedger)}`).join('\n')}`);
  return [...readTools, ...chosen];
}
