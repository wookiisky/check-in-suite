-- 迁移器在专用连接上完成表重建并复核外键；已有身份与成交事实原样保留。

CREATE TABLE products_next (
    id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL DEFAULT 1 CHECK(account_id > 0),
    type TEXT NOT NULL CHECK(type IN ('title','reward','island','wearable','character')),
    name TEXT NOT NULL CHECK(length(trim(name)) > 0),
    asset_key TEXT NOT NULL,
    wearable_key TEXT NOT NULL DEFAULT '',
    character_key TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    coin_price INTEGER NOT NULL CHECK(coin_price >= 0),
    diamond_price INTEGER NOT NULL CHECK(diamond_price >= 0),
    stock INTEGER CHECK(stock >= 0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    deleted_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK((type='character' AND character_key!='') OR (type!='character' AND character_key=''))
) STRICT;
INSERT INTO products_next(id,account_id,type,name,asset_key,wearable_key,description,coin_price,diamond_price,stock,enabled,deleted_at,version,created_at,updated_at)
SELECT id,account_id,type,name,asset_key,wearable_key,description,coin_price,diamond_price,stock,enabled,deleted_at,version,created_at,updated_at FROM products;

CREATE TABLE purchases_next (
    id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL DEFAULT 1 CHECK(account_id > 0),
    product_id TEXT NOT NULL REFERENCES products(id),
    repeatable INTEGER NOT NULL DEFAULT 0 CHECK(repeatable IN (0,1)),
    item_key_snapshot TEXT NOT NULL DEFAULT '',
    wearable_key_snapshot TEXT NOT NULL DEFAULT '',
    character_key_snapshot TEXT NOT NULL DEFAULT '',
    type_snapshot TEXT NOT NULL CHECK(type_snapshot IN ('title','reward','island','wearable','character')),
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
    CHECK((type_snapshot='character' AND character_key_snapshot!='') OR (type_snapshot!='character' AND character_key_snapshot='')),
    CHECK((status='redeemed' AND redeemed_at IS NOT NULL) OR (status!='redeemed' AND redeemed_at IS NULL))
) STRICT;
INSERT INTO purchases_next(id,account_id,product_id,repeatable,item_key_snapshot,wearable_key_snapshot,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,redeemed_at,version,created_at)
SELECT id,account_id,product_id,repeatable,item_key_snapshot,wearable_key_snapshot,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,redeemed_at,version,created_at FROM purchases;

DROP TABLE purchases;
DROP TABLE products;
ALTER TABLE products_next RENAME TO products;
ALTER TABLE purchases_next RENAME TO purchases;
CREATE INDEX products_visible ON products(account_id,enabled,deleted_at,type);
CREATE INDEX products_character ON products(account_id,character_key) WHERE character_key!='';
CREATE UNIQUE INDEX purchases_permanent ON purchases(account_id,product_id) WHERE type_snapshot!='reward' AND repeatable=0;
CREATE UNIQUE INDEX purchases_character ON purchases(account_id,character_key_snapshot) WHERE type_snapshot='character';
CREATE INDEX purchases_item ON purchases(item_key_snapshot) WHERE item_key_snapshot!='';
CREATE INDEX purchases_date ON purchases(account_id,created_at,id);

-- 免费初始服装是目录权益，显式保存选择，不伪造购买订单。
ALTER TABLE appearance_state ADD COLUMN face_free_wearable_key TEXT;
ALTER TABLE appearance_state ADD COLUMN head_free_wearable_key TEXT;
ALTER TABLE appearance_state ADD COLUMN upper_free_wearable_key TEXT;
ALTER TABLE appearance_state ADD COLUMN lower_free_wearable_key TEXT;
ALTER TABLE appearance_state ADD COLUMN shoes_free_wearable_key TEXT;

ALTER TABLE appearance_state ADD COLUMN back_free_wearable_key TEXT;
