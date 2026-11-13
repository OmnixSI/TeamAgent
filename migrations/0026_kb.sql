-- F7-10 群知识库：按群隔离的文档与切块，FTS5 trigram 稀疏检索（向量留到后续版本）。
CREATE TABLE IF NOT EXISTS kb_docs(
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS kb_docs_group ON kb_docs(group_id, created_at);

CREATE TABLE IF NOT EXISTS kb_chunks(
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS kb_chunks_group_doc ON kb_chunks(group_id, doc_id, idx);
CREATE INDEX IF NOT EXISTS kb_chunks_doc ON kb_chunks(doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
  text,
  title,
  chunk_id UNINDEXED,
  doc_id UNINDEXED,
  group_id UNINDEXED,
  tokenize='trigram');
