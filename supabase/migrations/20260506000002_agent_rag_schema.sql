-- Sprint B: Supabase RAG Schema
-- Enables pgvector and creates codebase index table + cosine search RPC

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS pos_codebase_index (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  file_path   text        NOT NULL,
  chunk_text  text        NOT NULL,
  embedding   vector(1536),
  metadata    jsonb,
  indexed_at  timestamptz NOT NULL DEFAULT now()
);

-- HNSW index for fast cosine similarity search
CREATE INDEX ON pos_codebase_index USING hnsw (embedding vector_cosine_ops);

-- Index for re-indexing: find chunks by file path
CREATE INDEX ON pos_codebase_index (file_path);

ALTER TABLE pos_codebase_index ENABLE ROW LEVEL SECURITY;

-- Only authenticated users (staff) can read the index
CREATE POLICY "authenticated_select" ON pos_codebase_index
  FOR SELECT TO authenticated USING (true);

-- Service role only for inserts (indexer script uses service key)
CREATE POLICY "service_insert" ON pos_codebase_index
  FOR INSERT TO service_role WITH CHECK (true);

CREATE POLICY "service_delete" ON pos_codebase_index
  FOR DELETE TO service_role USING (true);

-- ============================================================
-- RPC: match_codebase_chunks
-- Cosine similarity search over pos_codebase_index.
-- Returns top K chunks above similarity_threshold.
-- ============================================================
CREATE OR REPLACE FUNCTION match_codebase_chunks(
  query_embedding   vector(1536),
  match_count       int     DEFAULT 5,
  similarity_threshold float DEFAULT 0.7
)
RETURNS TABLE (
  id          uuid,
  file_path   text,
  chunk_text  text,
  metadata    jsonb,
  similarity  float
)
LANGUAGE sql STABLE
SECURITY DEFINER
AS $$
  SELECT
    id,
    file_path,
    chunk_text,
    metadata,
    1 - (embedding <=> query_embedding) AS similarity
  FROM pos_codebase_index
  WHERE embedding IS NOT NULL
    AND 1 - (embedding <=> query_embedding) > similarity_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Grant execute to authenticated users (rag.ts calls this from renderer)
GRANT EXECUTE ON FUNCTION match_codebase_chunks TO authenticated;
