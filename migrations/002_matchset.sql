-- One row per match set upload; the primary key stops a second upload of the same set.
CREATE TABLE matchset (
  -- matchset:<sha256 of division and XML>
  draft_id TEXT PRIMARY KEY,
  division INTEGER NOT NULL,
  -- reserved | unknown | uploaded
  status TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
