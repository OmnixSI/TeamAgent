-- ds-balance: the last real DeepSeek balance read, one row per currency.
-- scope is 'global' (account-wide) so any group's question compares with the
-- previous read anywhere. Balance amounts stay TEXT to keep provider decimals.
CREATE TABLE IF NOT EXISTS ds_balance_snapshots(
  scope TEXT NOT NULL,
  currency TEXT NOT NULL,
  total_balance TEXT NOT NULL,
  granted_balance TEXT NOT NULL,
  topped_up_balance TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(scope, currency));
