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
| `list_purchase_entries` | `purchaseentry/PurchaseEntries` | `date_from`, `date_to`, `supplier_id`, `status` (open/processed/rejected), `your_ref` | open = Status 20, not processed |
| `get_purchase_entry` | `PurchaseEntries(guid)` + `PurchaseEntryLines` | `entry_id` or `entry_number` | lines with G/L account and VAT code, linked document |
| `search_items` | `logistics/Items` | `query`, `sales_items_only` | prices, stock |
| `list_gl_accounts` | `financial/GLAccounts` (+ `GLAccountClassificationMappings`) | `query`, `include_rgs`, `rgs_scheme` (default `RGS`) | `include_rgs` adds `rgs_code`, `rgs_description` |
| `list_gl_account_rgs_mappings` | `financial/GLAccountClassificationMappings` | `gl_account_id`, `gl_account_code`, `rgs_code_prefix`, `rgs_scheme` (default `RGS`), `top` (max 2000) | G/L account to RGS code, RGS scheme only |
| `list_vat_codes` | `vat/VATCodes` | `query`, `use` (purchase/sales/any), `include_blocked` | percentage, type, reverse charge |
| `list_journals` | `financial/Journals` | `kind` (purchase/sales/bank/cash/general/any) | journal codes for write tools |
| `list_document_types` | `documents/DocumentTypes` | - | ids for `attach_document` |
| `get_profit_and_loss` | `read/financial/ProfitLossOverview` | – | current vs previous year (YTD and period) |
| `get_revenue_by_period` | `read/financial/RevenueListByYear` | `year` | revenue per period + total |
| `list_transactions` | `financialtransaction/TransactionLines` | `date_from`, `date_to` (required), `gl_account_id` and/or `account_id` (one required), `top` (max 200) | debit positive |
| `list_bank_transaction_lines` | `financialtransaction/BankEntryLines` | `date_from`, `date_to` (required), `account_id`, `gl_account_id`, `description`, `amount_min`, `amount_max`, `top` (max 500) | bank and payment service journals |

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

## Write tools (only when `ENABLE_WRITE_TOOLS=true`, or the ones `WRITE_TOOLS` names)

All are `destructiveHint: true`, default to **`dry_run: true`** (returns the exact payload, posts nothing), and write an audit-log row
when actually posted. Claude is instructed to show the dry-run to the user and obtain confirmation before `dry_run: false`.

| Tool | Resource | Parameters |
|---|---|---|
| `create_sales_order` | `salesorder/SalesOrders` | `customer_id`, `lines[{item_id, quantity, unit_price?, description?}]`, `description`, `your_ref`, `order_date`, `delivery_date` |
| `create_sales_invoice` | `salesinvoice/SalesInvoices` | `customer_id`, `journal`, `lines[... + gl_account_id?]`, `description`, `your_ref`, `invoice_date`. Always a **draft** (Status 10); never sent. |
| `create_quotation` | `crm/Quotations` | `customer_id`, `lines[...]`, `description`, `quotation_date`, `valid_until` |

## Bookkeeping write tools (also need `DATABASE_URL`)

| Tool | Resource | Parameters | Also needs |
|---|---|---|---|
| `draft_purchase_entry` | `purchaseentry/PurchaseEntries` (+ `documents/Documents`, `DocumentAttachments` with `file`) | `supplier_id`, `journal`, `your_ref` (supplier invoice number), `entry_date`, `due_date?`, `description{supplier, period, ref?, short}`, `currency` (default EUR), `totals{net, vat, gross}`, `payment_reference?`, `credit_note`, `lines[{gl_account_id, amount (excl. VAT), vat_code, vat_amount?, description?, cost_center?}]`, `file?{file_name, content_base64 \| file_url, document_type}`, `document_sha256?` | |
| `draft_general_journal_entry` | `generaljournalentry/GeneralJournalEntries` | `journal`, `entry_date`, `reference`, `description{supplier, period, ref?, short}`, `currency`, `financial_year?`, `financial_period?`, `reversal`, `lines[{gl_account_id, debit \| credit, vat_code?, vat_amount?, account_id?, cost_center?, cost_unit?, short?}]`, `file?` | |
| `attach_document` | `documents/Documents`, `DocumentAttachments`, `PUT PurchaseEntries(guid)` | `entry_id`, `file_name`, `content_base64` or `file_url` (https), `subject?`, `document_type` (default 20) | |
| `process_entry` | `GET` entry, with `EXACT_PROCESS_MODE=api` `PUT PurchaseEntries(guid) {Status: 50}` | `draftId` (or `entry_id`), `answer` (text or two texts), `approvalToken` and/or `approval_tokens[]` | `APPROVAL_SIGNING_KEY` |
| `create_matchset` | `docs/XMLUpload.aspx?Topic=MatchSets` | `gl_account_code`, `account_code?`, `lines[{fin_year, fin_period, journal, entry_number, amount_dc}]`, `draftId?`, `answer`, `approvalToken` / `approval_tokens[]` | `APPROVAL_SIGNING_KEY`, `ENABLE_MATCHSETS=true` |

**Drafts stay open.** Both draft tools post the entry for review in Exact (Status 20) and report a warning when Exact answers
with another status. They return the Exact entry GUID, the approval tier with its reasons and, for the auto tier, `hold_until`.

**Approval contract.** A draft (and the `create_matchset` dry run) answers with these fields next to the details:

```json
{"approvalRequired": true, "draftId": "<Exact entry GUID or matchset:<id>>", "summary": "<one line for the approver>", "tier": "auto|approve|two-step"}
```

`approvalRequired` is false for the auto tier. The agent shows `summary` to the approver, and passes `draftId`, the approver's
answer text exactly as given, and the approval token(s) to `process_entry` (or back to `create_matchset`).

**Description.** The caller gives the parts `supplier`, `period` (YYYY-MM, YYYY-Qn or YYYY), `ref` (default: `your_ref` or
`reference`) and `short`; the server renders `DESCRIPTION_TEMPLATE` (default `{supplier}|{period}|{ref}|{short}`). A part that
is empty, contains a separator of the template or a control character is refused. Over `DESCRIPTION_MAX_LENGTH` the server
shortens `short`, then `supplier`, never `ref`.

**Checks before any write.** A failed check refuses the call (`"refused": true`, every check with its message) and writes nothing. Every amount
has at most two decimals; an amount with more is rejected as invalid input, so Exact receives the cents the checks compared.

| Check | Purchase | General journal |
|---|---|---|
| `line_sum_equals_net` | line amounts = `totals.net` | |
| `net_plus_vat_equals_gross` | `net + vat = gross` | |
| `sign_matches_type` | gross positive for an invoice, negative for a credit note (`credit_note: true`) | |
| `vat_code_known` | code exists, not blocked, usable for purchases | code exists, not blocked |
| `vat_matches_lines` | `totals.vat` = line `vat_amount` or amount x code percentage, 1 cent per line tolerance | |
| `one_side_per_line`, `debit_equals_credit` | | one positive debit or credit per line; debit = credit, VAT on the side of its line |
| `gl_account_known` | every G/L account exists | every G/L account exists |
| `no_duplicate` | ledger: same supplier and normalised invoice number, same file SHA-256, or same supplier and gross within `DUPLICATE_WINDOW_DAYS`; Exact: same supplier and `your_ref` | ledger: same journal and normalised reference, or same file SHA-256 |

A duplicate is refused with the Exact GUID of the existing entry. The normalised invoice number is upper case, letters and
digits only, without leading zeros (`inv-2026/0012` and `INV 2026.0012` are one invoice). The ledger key is reserved before the
POST, so two concurrent calls cannot both write. A POST that Exact refuses (4xx) frees the key. A POST without a clear answer
(network error, 5xx, no entry id in the response) leaves the key in status `unknown`: a retry is refused with the ledger row id,
and a person checks Exact and deletes that ledger row when no entry was created.

**Approval tiers** (decided at draft time from the `TIER_*` settings, enforced by `process_entry`):

| Tier | When | `process_entry` needs |
|---|---|---|
| `auto` | purchase entry in EUR, amount below `TIER_AUTO_MAX_EUR`, no lines of opposite sign, every line `vat_amount` within a cent of amount x code percentage, supplier with `TIER_AUTO_MIN_SUPPLIER_ENTRIES` earlier approved or processed ledger entries, all checks green, no duplicate | nothing, after `TIER_AUTO_HOLD_HOURS` |
| `approve` | every other purchase and general journal entry | one approval token |
| `two_step` | match sets, a journal in `TIER_PAYROLL_JOURNALS`, amount above `TIER_TWO_STEP_ABOVE_EUR`, a balance sheet G/L account not in `TIER_BALANCE_ACCOUNT_ALLOWLIST` | two approval tokens from different approvers |

The amount of a purchase entry is the larger of the absolute gross and the sum of the absolute line amounts plus the absolute
VAT, so offsetting lines rate on their volume; the amount of a general journal entry is its total debit including VAT.

An approval token is issued by the approval service that holds `APPROVAL_SIGNING_KEY` (never the agent that drafts the
entry), after the approver answered; its format is below. `process_entry` refuses:

- an answer missing, or one that matches `APPROVAL_ANSWER_REJECT` or does not match `APPROVAL_ANSWER_APPROVE` (defaults: `ja`,
  `yes`, `akkoord`, `ok`, `boek` and similar approve; `nee`, `no`, `stop` and similar reject), one answer per required approval;
- a token that is expired, valid more than 14 days ahead, for another draft, for a lower tier, repeated (approvers compare
  case-insensitively), from the caller that drafted the entry, or issued for a different answer than the one given;
- an entry that is no longer open in Exact.

With `EXACT_PROCESS_MODE=record` it marks the entry released in the ledger and a person processes it in Exact.

**Match sets.** `create_matchset` builds the `MatchSets` XML, refuses lines that do not add up to 0.00, uploads one match set
once (the `matchset` table holds its draftId before the upload; a failed upload frees it) and always needs two answers and two `two-step` tokens for the draftId of the dry run.
Exact answers HTTP 200 also when it refuses: the tool reads every `Message` element and fails on type 0 (error) or 3 (fatal),
or when no type 2 (success) message is present, listing every message. The `MatchSets` XML topic has no delete, so a match is
undone in Exact (*Financial > Matching*, unmatch).

### Approval token format

A token is `<payload>.<mac>`, both parts base64url (RFC 4648 section 5) without `=` padding.

| Field | Type | Value |
|---|---|---|
| `v` | integer | `1` |
| `entry` | string | the draftId, lower case: the Exact entry GUID, or `matchset:<64 hex>` |
| `tier` | string | `approve` or `two-step` (`two_step` is accepted too); a `two-step` token also satisfies `approve` |
| `approver` | string | stable id of the person who approved, trimmed, lower case; two-step needs two different ones |
| `exp` | integer | expiry in epoch seconds; the server refuses an expired token and one valid more than 14 days ahead |
| `ans` | string, optional | lower-case hex SHA-256 of the normalised answer; the call must then carry that answer |

Signing procedure:

1. Normalise the answer text: Unicode NFC, every run of whitespace to one space, trim, lower case. `ans` is the hex SHA-256
   of its UTF-8 bytes.
2. Serialise the payload as JSON in UTF-8, keys in the order of the table, no whitespace, `ans` left out when not used.
3. `payload` = base64url of those bytes.
4. `mac` = base64url of HMAC-SHA256 with key = the UTF-8 bytes of `APPROVAL_SIGNING_KEY` and message = the ASCII bytes of
   `payload`.
5. Token = `payload` + `.` + `mac`.

The server verifies the MAC over `payload` as received and then reads the JSON, so step 2 only has to be exact to reproduce
the test vector. In Python:

```python
import base64, hashlib, hmac, json, re, unicodedata

def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")

def approval_token(key: str, entry: str, tier: str, approver: str, exp: int, answer: str | None = None) -> str:
    payload = {"v": 1, "entry": entry.lower(), "tier": tier, "approver": approver.strip().lower(), "exp": exp}
    if answer is not None:
        norm = re.sub(r"\s+", " ", unicodedata.normalize("NFC", answer)).strip().lower()
        payload["ans"] = hashlib.sha256(norm.encode("utf-8")).hexdigest()
    body = b64url(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    mac = b64url(hmac.new(key.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{mac}"
```

Test vector (also in `test/approval-vector.test.ts`): key `test-vector-approval-key-0123456789abcdef`, entry
`33333333-3333-3333-3333-333333333333`, tier `approve`, approver `alice`, exp `1794132000` (2026-11-08T10:00:00Z), answer
`Boek  33333333-3333-3333-3333-333333333333` (normalised `boek 33333333-3333-3333-3333-333333333333`, `ans`
`c057d277a56085d5e988165be31bdd27ef5534cdd7f3238efabbf78c05d720fa`). Payload JSON:

```
{"v":1,"entry":"33333333-3333-3333-3333-333333333333","tier":"approve","approver":"alice","exp":1794132000,"ans":"c057d277a56085d5e988165be31bdd27ef5534cdd7f3238efabbf78c05d720fa"}
```

Token:

```
eyJ2IjoxLCJlbnRyeSI6IjMzMzMzMzMzLTMzMzMtMzMzMy0zMzMzLTMzMzMzMzMzMzMzMyIsInRpZXIiOiJhcHByb3ZlIiwiYXBwcm92ZXIiOiJhbGljZSIsImV4cCI6MTc5NDEzMjAwMCwiYW5zIjoiYzA1N2QyNzdhNTYwODVkNWU5ODgxNjViZTMxYmRkMjdlZjU1MzRjZGQ3ZjMyMzhlZmFiYmY3OGMwNWQ3MjBmYSJ9.ooZVlE-72yRTjYVSsXW7nINfKV4-9lz8wAovLecvOe4
```

The same entry, tier `two-step`, approver `alice`, exp `1794132000` and no answer give:

```
eyJ2IjoxLCJlbnRyeSI6IjMzMzMzMzMzLTMzMzMtMzMzMy0zMzMzLTMzMzMzMzMzMzMzMyIsInRpZXIiOiJ0d28tc3RlcCIsImFwcHJvdmVyIjoiYWxpY2UiLCJleHAiOjE3OTQxMzIwMDB9.oqam9uIlIuThpUsZbHXmBC7D6mP_Q9HGskHxC66NKg0
```

### Example: `create_sales_order` (dry run)

```
DRY RUN (nothing was created in division 100). Sales order with 1 line(s). Confirm with the user, then call again with dry_run=false.

{"dry_run":true,"division":100,"resource":"salesorder/SalesOrders","payload":{"OrderedBy":"2222…","SalesOrderLines":[{"Item":"3333…","Quantity":2}]}}
```
