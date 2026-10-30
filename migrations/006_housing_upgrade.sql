-- The content upgrade is applied once before serving; a layout save acknowledges its notice.
CREATE TABLE island_housing_upgrade (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    moved INTEGER NOT NULL DEFAULT 0 CHECK(moved >= 0),
    stored INTEGER NOT NULL DEFAULT 0 CHECK(stored >= 0)
) STRICT;
