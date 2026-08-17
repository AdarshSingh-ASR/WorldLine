-- Episodic recall filters on the verified outcome as well as the region and
-- vehicle class prefix:
--
--   WHERE home_region = $1 AND vehicle_class = $2 AND outcome = 'verified-safe'
--   ORDER BY embedding <=> $3
--
-- A vector index can only serve that query if every equality predicate sits in
-- its prefix. With `outcome` outside the index CockroachDB refuses it outright
-- ("index cannot be used for this query", SQLSTATE 42809), because an
-- approximate top-k followed by a residual filter cannot guarantee k results.
-- Recall then silently degrades to a full table scan.
--
-- Adding `outcome` to the prefix makes the whole predicate index-covered, so
-- the distributed vector index is genuinely in the runtime path.
CREATE VECTOR INDEX IF NOT EXISTS maneuver_memory_recall_idx
  ON maneuver_memories (
    home_region,
    vehicle_class,
    outcome,
    embedding vector_cosine_ops
  )
  WITH (min_partition_size = 16, max_partition_size = 128);

-- The original index is a strict prefix of the new one and can no longer serve
-- the recall query, so it is redundant maintenance cost on every write.
DROP INDEX IF EXISTS maneuver_memory_vector_idx
