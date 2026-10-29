-- Completion is committed with the demo account and every associated business fact.
CREATE TABLE demo_seeds (
    version INTEGER PRIMARY KEY CHECK(version > 0),
    completed_at INTEGER NOT NULL
) STRICT;
