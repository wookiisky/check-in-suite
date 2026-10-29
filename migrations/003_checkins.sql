-- All business tables are created together so cross-module references remain real foreign keys.
CREATE TABLE media_files (
    id TEXT PRIMARY KEY,
    storage_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('photo','audio')),
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
    duration_ms INTEGER,
    width INTEGER,
    height INTEGER,
    sha256 TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('ready','attached','deleting','deleted')),
    created_at INTEGER NOT NULL,
    unreferenced_at INTEGER
) STRICT;
CREATE INDEX media_cleanup ON media_files(state,unreferenced_at);

CREATE TABLE products (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('title','avatar','accessory','background','effect','reward','island')),
    name TEXT NOT NULL CHECK(length(trim(name)) > 0),
    asset_key TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    coin_price INTEGER NOT NULL CHECK(coin_price >= 0),
    diamond_price INTEGER NOT NULL CHECK(diamond_price >= 0),
    stock INTEGER CHECK(stock >= 0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    deleted_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX products_visible ON products(enabled,deleted_at,type);

CREATE TABLE purchases (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    repeatable INTEGER NOT NULL DEFAULT 0 CHECK(repeatable IN (0,1)),
    item_key_snapshot TEXT NOT NULL DEFAULT '',
    type_snapshot TEXT NOT NULL CHECK(type_snapshot IN ('title','avatar','accessory','background','effect','reward','island')),
    name_snapshot TEXT NOT NULL,
    description_snapshot TEXT NOT NULL,
    asset_key_snapshot TEXT NOT NULL,
    coin_price INTEGER NOT NULL CHECK(coin_price >= 0),
    diamond_price INTEGER NOT NULL CHECK(diamond_price >= 0),
    status TEXT NOT NULL CHECK(status IN ('owned','pending','redeemed')),
    redeemed_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
    created_at INTEGER NOT NULL,
    CHECK((type_snapshot='reward' AND status IN ('pending','redeemed')) OR (type_snapshot!='reward' AND status='owned')),
    CHECK((status='redeemed' AND redeemed_at IS NOT NULL) OR (status!='redeemed' AND redeemed_at IS NULL))
) STRICT;
CREATE UNIQUE INDEX purchases_permanent ON purchases(product_id) WHERE type_snapshot!='reward' AND repeatable=0;
CREATE INDEX purchases_date ON purchases(created_at,id);

CREATE TABLE equipped_accessories (
    purchase_id TEXT PRIMARY KEY REFERENCES purchases(id),
    equipped_at INTEGER NOT NULL
) STRICT;

-- Placement belongs to the owned accessory and survives unequipping.
CREATE TABLE accessory_layouts (
    purchase_id TEXT PRIMARY KEY REFERENCES purchases(id),
    x REAL NOT NULL,
    y REAL NOT NULL,
    size REAL NOT NULL CHECK(size BETWEEN 0.05 AND 1.0),
    layer INTEGER NOT NULL CHECK(layer != 0),
    CHECK(x BETWEEN size/2.0 AND 1.0-size/2.0),
    CHECK(y BETWEEN size/2.0 AND 1.0-size/2.0)
) STRICT;

-- Fixed effects are independently equipped and do not consume accessory slots.
CREATE TABLE equipped_effects (
    purchase_id TEXT PRIMARY KEY REFERENCES purchases(id),
    equipped_at INTEGER NOT NULL
) STRICT;

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL CHECK(length(trim(text)) > 0),
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX messages_date ON messages(created_at,id);

CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK(length(trim(name)) > 0),
    sort_order INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    category_id TEXT REFERENCES categories(id),
    name TEXT NOT NULL CHECK(length(trim(name)) > 0),
    icon_key TEXT NOT NULL,
    coin_reward INTEGER NOT NULL CHECK(coin_reward >= 0),
    diamond_reward INTEGER NOT NULL CHECK(diamond_reward >= 0),
    daily_limit INTEGER NOT NULL CHECK(daily_limit > 0),
    weekday_mask INTEGER NOT NULL CHECK(weekday_mask BETWEEN 1 AND 127),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    deleted_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX tasks_category ON tasks(category_id);

CREATE TABLE task_schedule_history (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    start_date TEXT NOT NULL,
    weekday_mask INTEGER NOT NULL CHECK(weekday_mask BETWEEN 1 AND 127),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    PRIMARY KEY(task_id,start_date)
) STRICT;

CREATE TABLE achievements (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK(length(trim(name)) > 0),
    asset_key TEXT NOT NULL,
    metric TEXT NOT NULL CHECK(metric IN ('count','days','streak','coins','diamonds')),
    scope TEXT NOT NULL CHECK(scope IN ('all','category','tasks')),
    category_id TEXT REFERENCES categories(id),
    target INTEGER NOT NULL CHECK(target > 0),
    window_days INTEGER CHECK(window_days > 0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    deleted_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
    progress INTEGER NOT NULL DEFAULT 0 CHECK(progress >= 0),
    qualified INTEGER NOT NULL DEFAULT 0 CHECK(qualified IN (0,1)),
    equipped INTEGER NOT NULL DEFAULT 0 CHECK(equipped IN (0,1)),
    earned_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK((scope='category' AND category_id IS NOT NULL) OR (scope!='category' AND category_id IS NULL)),
    CHECK(equipped=0 OR qualified=1),
    CHECK(qualified=0 OR earned_at IS NOT NULL)
) STRICT;
CREATE TABLE achievement_tasks (
    achievement_id TEXT NOT NULL REFERENCES achievements(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    PRIMARY KEY(achievement_id,task_id)
) STRICT;

CREATE TABLE checkins (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    business_date TEXT NOT NULL,
    task_name_snapshot TEXT NOT NULL,
    task_icon_snapshot TEXT NOT NULL,
    coin_reward_snapshot INTEGER NOT NULL CHECK(coin_reward_snapshot >= 0),
    diamond_reward_snapshot INTEGER NOT NULL CHECK(diamond_reward_snapshot >= 0),
    text TEXT NOT NULL DEFAULT '',
    photo_media_id TEXT REFERENCES media_files(id),
    audio_media_id TEXT REFERENCES media_files(id),
    source TEXT NOT NULL CHECK(source IN ('today','backfill')),
    deleted_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX checkins_task_date ON checkins(task_id,business_date) WHERE deleted_at IS NULL;
CREATE INDEX checkins_date ON checkins(business_date,created_at,id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX checkins_photo ON checkins(photo_media_id) WHERE photo_media_id IS NOT NULL;
CREATE UNIQUE INDEX checkins_audio ON checkins(audio_media_id) WHERE audio_media_id IS NOT NULL;

CREATE TABLE wallet_entries (
    id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    event_type TEXT NOT NULL CHECK(event_type IN ('checkin_grant','checkin_revoke','purchase_debit')),
    checkin_id TEXT REFERENCES checkins(id),
    purchase_id TEXT REFERENCES purchases(id),
    coin_delta INTEGER NOT NULL,
    diamond_delta INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK((event_type='checkin_grant' AND checkin_id IS NOT NULL AND purchase_id IS NULL AND coin_delta>=0 AND diamond_delta>=0)
       OR (event_type='checkin_revoke' AND checkin_id IS NOT NULL AND purchase_id IS NULL AND coin_delta<=0 AND diamond_delta<=0)
       OR (event_type='purchase_debit' AND checkin_id IS NULL AND purchase_id IS NOT NULL AND coin_delta<=0 AND diamond_delta<=0))
) STRICT;
CREATE UNIQUE INDEX wallet_checkin_event ON wallet_entries(checkin_id,event_type) WHERE checkin_id IS NOT NULL;
CREATE UNIQUE INDEX wallet_purchase_event ON wallet_entries(purchase_id,event_type) WHERE purchase_id IS NOT NULL;
CREATE TRIGGER wallet_entries_no_update BEFORE UPDATE ON wallet_entries BEGIN SELECT RAISE(ABORT,'immutable wallet entry'); END;
CREATE TRIGGER wallet_entries_no_delete BEFORE DELETE ON wallet_entries BEGIN SELECT RAISE(ABORT,'immutable wallet entry'); END;

CREATE TABLE idempotency_requests (
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    operation TEXT NOT NULL,
    key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    http_status INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(account_id,operation,key)
) STRICT;

-- Layout is independent from portrait equipment; version protects concurrent edits.
CREATE TABLE island_state (
    id INTEGER PRIMARY KEY CHECK(id=1),
    version INTEGER NOT NULL CHECK(version>0),
    placements TEXT NOT NULL CHECK(json_valid(placements))
) STRICT;
