-- Idempotency ledger: one row per entry the server drafted in Exact Online.
CREATE TABLE ledger (
  id BIGSERIAL PRIMARY KEY,
  division INTEGER NOT NULL,
  -- purchase | general_journal
  kind TEXT NOT NULL,
  supplier_id UUID,
  -- normalised supplier invoice number (purchase) or reference (general journal)
  ref_norm TEXT NOT NULL,
  journal TEXT NOT NULL,
  entry_date DATE NOT NULL,
  currency TEXT NOT NULL,
  -- gross amount (purchase) or total debit (general journal), in cents
  amount_cents BIGINT NOT NULL,
  pdf_sha256 TEXT,
  -- kind|supplier|ref_norm or kind|journal|ref_norm: one live row per key and division
  dedupe_key TEXT NOT NULL,
  exact_entry_id UUID,
  exact_entry_number INTEGER,
  -- reserved | unknown | drafted | approved | processed
  status TEXT NOT NULL,
  -- auto | approve | two_step
  tier TEXT NOT NULL,
  tier_reasons TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  hold_until TIMESTAMPTZ,
  approved_by TEXT,
  processed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX ledger_dedupe ON ledger (division, dedupe_key);
CREATE UNIQUE INDEX ledger_exact_entry ON ledger (exact_entry_id);
CREATE INDEX ledger_supplier ON ledger (division, supplier_id);
CREATE INDEX ledger_pdf ON ledger (division, pdf_sha256);

-- One row per tool call. Never the arguments or tokens, only their SHA-256.
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  caller_kind TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  caller_name TEXT,
  client_id TEXT,
  exact_user_id TEXT,
  division INTEGER,
  tool TEXT NOT NULL,
  args_sha256 TEXT NOT NULL,
  -- ok | refused | error
  outcome TEXT NOT NULL,
  exact_status INTEGER,
  exact_id TEXT,
  model_version TEXT
);
CREATE INDEX audit_log_ts ON audit_log (ts);
CREATE INDEX audit_log_exact_id ON audit_log (exact_id);
