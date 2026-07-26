CREATE TABLE IF NOT EXISTS maneuver_memories (
  id STRING PRIMARY KEY,
  home_region STRING NOT NULL,
  vehicle_class STRING NOT NULL,
  title STRING NOT NULL,
  scenario JSONB NOT NULL,
  geometry GEOMETRY(LINESTRING, 4326) NOT NULL,
  constraints JSONB NOT NULL,
  maneuver_id STRING NOT NULL,
  maneuver JSONB NOT NULL,
  alternatives_rejected JSONB NOT NULL,
  outcome STRING NOT NULL,
  provenance JSONB NOT NULL,
  confidence FLOAT8 NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  occurred_at TIMESTAMPTZ NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE VECTOR INDEX IF NOT EXISTS maneuver_memory_vector_idx
  ON maneuver_memories (
    home_region,
    vehicle_class,
    embedding vector_cosine_ops
  )
  WITH (min_partition_size = 16, max_partition_size = 128);

CREATE INDEX IF NOT EXISTS maneuver_memory_geometry_idx
  ON maneuver_memories USING GIST (geometry);

CREATE TABLE IF NOT EXISTS safety_policies (
  id STRING PRIMARY KEY,
  version STRING NOT NULL,
  state STRING NOT NULL,
  rules JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT valid_policy_state CHECK (state IN ('active', 'retired'))
);

CREATE TABLE IF NOT EXISTS airspace_cells (
  id STRING PRIMARY KEY,
  home_region STRING NOT NULL,
  geometry GEOMETRY(POLYGON, 4326) NOT NULL,
  altitude_floor_m FLOAT8 NOT NULL,
  altitude_ceiling_m FLOAT8 NOT NULL,
  governing_policy_id STRING NOT NULL REFERENCES safety_policies (id),
  state STRING NOT NULL DEFAULT 'open'
);

CREATE INDEX IF NOT EXISTS airspace_cell_geometry_idx
  ON airspace_cells USING GIST (geometry);

CREATE TABLE IF NOT EXISTS corridor_capacity (
  scenario_id STRING NOT NULL,
  corridor_id STRING NOT NULL,
  home_region STRING NOT NULL,
  capacity INT NOT NULL CHECK (capacity > 0),
  used INT NOT NULL DEFAULT 0 CHECK (used >= 0),
  revision INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_id, corridor_id),
  CHECK (used <= capacity)
);

CREATE TABLE IF NOT EXISTS route_requests (
  id UUID PRIMARY KEY,
  scenario_id STRING NOT NULL,
  agent_id STRING NOT NULL,
  home_region STRING NOT NULL,
  vehicle_class STRING NOT NULL,
  status STRING NOT NULL,
  idempotency_key STRING NOT NULL UNIQUE,
  input JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT valid_request_status CHECK (status IN ('planned', 'committing', 'committed', 'rejected'))
);

CREATE TABLE IF NOT EXISTS route_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_request_id UUID NOT NULL REFERENCES route_requests (id),
  candidate_rank INT NOT NULL,
  maneuver_id STRING NOT NULL,
  cells JSONB NOT NULL,
  predicted_safety JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (route_request_id, candidate_rank)
);

CREATE TABLE IF NOT EXISTS route_decisions (
  id UUID PRIMARY KEY,
  scenario_id STRING NOT NULL,
  route_request_id UUID NOT NULL REFERENCES route_requests (id),
  agent_id STRING NOT NULL,
  home_region STRING NOT NULL,
  corridor_id STRING NOT NULL,
  state STRING NOT NULL,
  selected_memory_id STRING NULL REFERENCES maneuver_memories (id),
  maneuver_id STRING NOT NULL,
  maneuver JSONB NOT NULL,
  safety_result JSONB NOT NULL,
  retry_count INT NOT NULL DEFAULT 0,
  decision_hlc STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT valid_decision_state CHECK (state IN ('committed', 'rejected', 'expired'))
);

CREATE INDEX IF NOT EXISTS route_decisions_by_scenario
  ON route_decisions (scenario_id, created_at DESC)
  STORING (agent_id, corridor_id, state, selected_memory_id, decision_hlc);

CREATE TABLE IF NOT EXISTS occupancy_claims (
  id UUID PRIMARY KEY,
  scenario_id STRING NOT NULL,
  route_decision_id UUID NOT NULL REFERENCES route_decisions (id),
  cell_id STRING NOT NULL,
  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  exclusion_slot INT NOT NULL,
  home_region STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cell_id, slot_start, exclusion_slot),
  CHECK (slot_end > slot_start)
);

CREATE INDEX IF NOT EXISTS occupancy_by_scenario
  ON occupancy_claims (scenario_id, slot_start)
  STORING (route_decision_id, cell_id, slot_end, home_region);

CREATE TABLE IF NOT EXISTS memory_reads (
  id UUID PRIMARY KEY,
  memory_id STRING NOT NULL REFERENCES maneuver_memories (id),
  route_decision_id UUID NOT NULL REFERENCES route_decisions (id),
  rank INT NOT NULL,
  similarity FLOAT8 NOT NULL,
  causal_weight FLOAT8 NOT NULL,
  exact_match BOOL NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (memory_id, route_decision_id)
);

CREATE TABLE IF NOT EXISTS command_outbox (
  id UUID PRIMARY KEY,
  route_decision_id UUID NOT NULL REFERENCES route_decisions (id),
  command_type STRING NOT NULL,
  payload JSONB NOT NULL,
  state STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ NULL,
  CONSTRAINT valid_command_state CHECK (state IN ('pending', 'delivered', 'failed'))
);

CREATE TABLE IF NOT EXISTS commit_receipts (
  id UUID PRIMARY KEY,
  scenario_id STRING NOT NULL,
  route_decision_id UUID NOT NULL REFERENCES route_decisions (id),
  memory_id STRING NULL REFERENCES maneuver_memories (id),
  decision_hlc STRING NOT NULL,
  evidence JSONB NOT NULL,
  content_hash STRING NOT NULL,
  cdc_confirmed BOOL NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS receipts_by_scenario
  ON commit_receipts (scenario_id, created_at DESC)
  STORING (route_decision_id, memory_id, decision_hlc, content_hash);

CREATE TABLE IF NOT EXISTS stream_clients (
  connection_id STRING PRIMARY KEY,
  region STRING NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS cdc_confirmations (
  source_table STRING NOT NULL,
  source_key STRING NOT NULL,
  mvcc_timestamp STRING NOT NULL,
  event_op STRING NOT NULL,
  payload JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, source_key, mvcc_timestamp)
);
