-- Drop the unused code-index objects.
--
-- match_codebase_chunks and pos_codebase_index have 0 rows locally and on
-- the customer, nothing under src/ or supabase/functions/** calls either
-- object, and pos_codebase_index.embedding is the only column anywhere in
-- the schema using the vector type. The extension is dropped without
-- CASCADE, so this fails safe if anything unexpected still depends on it.

DROP FUNCTION IF EXISTS public.match_codebase_chunks(vector, integer, double precision);
DROP TABLE IF EXISTS public.pos_codebase_index;
DROP EXTENSION IF EXISTS vector;

NOTIFY pgrst, 'reload schema';
