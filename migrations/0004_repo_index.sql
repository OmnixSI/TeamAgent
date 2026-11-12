CREATE TABLE IF NOT EXISTS repo_commits(
  repo TEXT NOT NULL, sha TEXT NOT NULL, at INTEGER NOT NULL, author TEXT NOT NULL,
  subject TEXT NOT NULL, body TEXT, files TEXT NOT NULL, patch TEXT, truncated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(repo, sha));
CREATE INDEX IF NOT EXISTS repo_commits_at ON repo_commits(repo, at DESC);
CREATE TABLE IF NOT EXISTS repo_state(
  repo TEXT PRIMARY KEY, json TEXT NOT NULL, fingerprint TEXT NOT NULL,
  updated_at INTEGER NOT NULL, checked_at INTEGER NOT NULL);
