CREATE TABLE accounts (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL UNIQUE CHECK (length(trim(username)) > 0),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
    login_password_hash TEXT NOT NULL,
    management_password_hash TEXT NOT NULL,
    credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
    music_enabled INTEGER NOT NULL DEFAULT 0 CHECK (music_enabled IN (0,1)),
    effects_enabled INTEGER NOT NULL DEFAULT 1 CHECK (effects_enabled IN (0,1)),
    reduce_motion INTEGER NOT NULL DEFAULT 0 CHECK (reduce_motion IN (0,1)),
    title_purchase_id TEXT REFERENCES purchases(id),
    avatar_purchase_id TEXT REFERENCES purchases(id),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    management_expires_at INTEGER,
    management_version INTEGER NOT NULL DEFAULT 1 CHECK (management_version > 0),
    credential_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_expires_at ON sessions(expires_at);

CREATE TABLE wallets (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
    coins INTEGER NOT NULL DEFAULT 0 CHECK (coins BETWEEN -9007199254740991 AND 9007199254740991),
    diamonds INTEGER NOT NULL DEFAULT 0 CHECK (diamonds BETWEEN -9007199254740991 AND 9007199254740991),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
) STRICT;
