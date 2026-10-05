# Tools

All tools return a one-line summary followed by compact JSON. Every tool accepts an optional `division` (number); omitted =
the user's current division, otherwise it must be in the user's accessible divisions (`list_divisions`). Amounts are numbers,
never silently rounded; totals are grouped per currency. Dates are ISO 8601. All read tools set `readOnlyHint: true`.
`top` defaults to 50 (max 500 unless noted).

## Read tools

| Tool | Exact resource | Parameters | Notes |
|---|---|---|---|
| `whoami` | `current/Me` | – | name, email, region, current division |
| `list_divisions` | `system/Divisions` | `include_inactive` | code, name, status, currency |
| `search_accounts` | `crm/Accounts` | `query`, `code`, `city`, `vat_number`, `kind` (customer/supplier/any), `top` | criteria are ANDed |
| `get_account` | `crm/Accounts(guid)` + `crm/Contacts` | `account_id` | main contact first |
| `list_open_receivables` | `read/financial/ReceivablesList` | `account_id`, `overdue_only`, `min_days_overdue`, `top` (max 200) | ageing buckets, per-account totals |
| `list_open_payables` | `read/financial/PayablesList` | same | same shape |
| `list_sales_invoices` | `salesinvoice/SalesInvoices` | `date_from`, `date_to`, `status`, `account_id` | newest first |
| `get_sales_invoice` | `SalesInvoices(guid)` + `SalesInvoiceLines` | `invoice_id` or `invoice_number` | with lines |
| `list_purchase_entries` | `purchaseentry/PurchaseEntries` | `date_from`, `date_to`, `supplier_id` | |
| `search_items` | `logistics/Items` | `query`, `sales_items_only` | prices, stock |
| `list_gl_accounts` | `financial/GLAccounts` | `query` | |
| `get_profit_and_loss` | `read/financial/ProfitLossOverview` | – | current vs previous year (YTD and period) |
| `get_revenue_by_period` | `read/financial/RevenueListByYear` | `year` | revenue per period + total |
| `list_transactions` | `financialtransaction/TransactionLines` | `date_from`, `date_to` (required), `gl_account_id` and/or `account_id` (one required), `top` (max 200) | debit positive |

### Example: `list_open_receivables { "min_days_overdue": 30 }`

```
Found 2 open receivable item(s) totalling EUR 1.200,50 + USD 50,00.

{"totals":{"EUR":1200.5,"USD":50},
 "ageing":{"not_due":{"EUR":200},"overdue_1_30":{},"overdue_31_60":{"EUR":1000.5},"overdue_61_90":{},"overdue_90_plus":{"USD":50}},
 "by_account":[{"account_id":"…","account_name":"Acme","open_items":2,"totals":{"EUR":1200.5},"max_days_overdue":45}],
 "items":[{"account_name":"Beta","invoice_number":3,"due_date":"2026-06-27","amount":50,"currency":"USD","days_overdue":100,"bucket":"overdue_90_plus"}],
 "truncated":false}
```

### Example: `get_profit_and_loss`

```
2026 YTD result EUR 40,00 vs 2025: 10,00 (revenue 120,00 vs 100,00).

{"currency":"EUR","current_year":2026,"previous_year":2025,"current_period":9,
 "year_to_date":{"revenue":{"current":120,"previous":100,"difference":20,"difference_pct":20},"costs":{…},"result":{…}},
 "period":{…}}
```

### Example: `search_accounts { "query": "Acme", "kind": "customer" }`

```
Found 1 account(s).

[{"id":"6f1c…","code":"1001","name":"Acme BV","city":"Utrecht","country":"NL","vat_number":"NL123456789B01","is_customer":true,"is_supplier":false,"blocked":false}]
```

## Write tools (only when `ENABLE_WRITE_TOOLS=true`)

All are `destructiveHint: true`, default to **`dry_run: true`** (returns the exact payload, posts nothing), and write an audit-log row
(user, division, tool, payload SHA-256, Exact id, timestamp) when actually posted. Claude is instructed to show the dry-run to the user
and obtain confirmation before `dry_run: false`.

| Tool | Resource | Parameters |
|---|---|---|
| `create_sales_order` | `salesorder/SalesOrders` | `customer_id`, `lines[{item_id, quantity, unit_price?, description?}]`, `description`, `your_ref`, `order_date`, `delivery_date` |
| `create_sales_invoice` | `salesinvoice/SalesInvoices` | `customer_id`, `journal`, `lines[… + gl_account_id?]`, `description`, `your_ref`, `invoice_date`. Always a **draft** (Status 10); never sent. |
| `create_quotation` | `crm/Quotations` | `customer_id`, `lines[…]`, `description`, `quotation_date`, `valid_until` |

### Example: `create_sales_order` (dry run)

```
DRY RUN (nothing was created in division 100). Sales order with 1 line(s). Confirm with the user, then call again with dry_run=false.

{"dry_run":true,"division":100,"resource":"salesorder/SalesOrders","payload":{"OrderedBy":"2222…","SalesOrderLines":[{"Item":"3333…","Quantity":2}]}}
```
