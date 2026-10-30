-- Preserve the first expansion marker so later dimensions can be applied exactly once.
ALTER TABLE island_housing_upgrade ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
