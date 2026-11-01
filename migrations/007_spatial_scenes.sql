-- 场景资格保存为成交快照；表重建保留既有商品、订单与外键身份。
CREATE TABLE products_next (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('title','reward','island','wearable','character','scene')),
    name TEXT NOT NULL CHECK(length(trim(name)) > 0),
    asset_key TEXT NOT NULL,
    wearable_key TEXT NOT NULL DEFAULT '',
    character_key TEXT NOT NULL DEFAULT '',
    scene_key TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    coin_price INTEGER NOT NULL CHECK(coin_price >= 0),
    diamond_price INTEGER NOT NULL CHECK(diamond_price >= 0),
    stock INTEGER CHECK(stock >= 0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    deleted_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK((type='character' AND character_key!='') OR (type!='character' AND character_key='')),
    CHECK((type='scene' AND scene_key!='') OR (type!='scene' AND scene_key=''))
) STRICT;
INSERT INTO products_next(id,type,name,asset_key,wearable_key,character_key,description,coin_price,diamond_price,stock,enabled,deleted_at,version,created_at,updated_at)
SELECT id,type,name,asset_key,wearable_key,character_key,description,coin_price,diamond_price,stock,enabled,deleted_at,version,created_at,updated_at FROM products;

CREATE TABLE purchases_next (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    repeatable INTEGER NOT NULL DEFAULT 0 CHECK(repeatable IN (0,1)),
    item_key_snapshot TEXT NOT NULL DEFAULT '',
    wearable_key_snapshot TEXT NOT NULL DEFAULT '',
    character_key_snapshot TEXT NOT NULL DEFAULT '',
    scene_key_snapshot TEXT NOT NULL DEFAULT '',
    type_snapshot TEXT NOT NULL CHECK(type_snapshot IN ('title','reward','island','wearable','character','scene')),
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
    CHECK((type_snapshot='scene' AND scene_key_snapshot!='') OR (type_snapshot!='scene' AND scene_key_snapshot='')),
    CHECK((status='redeemed' AND redeemed_at IS NOT NULL) OR (status!='redeemed' AND redeemed_at IS NULL))
) STRICT;
INSERT INTO purchases_next(id,product_id,repeatable,item_key_snapshot,wearable_key_snapshot,character_key_snapshot,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,redeemed_at,version,created_at)
SELECT id,product_id,repeatable,item_key_snapshot,wearable_key_snapshot,character_key_snapshot,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,redeemed_at,version,created_at FROM purchases;

DROP TABLE purchases;
DROP TABLE products;
ALTER TABLE products_next RENAME TO products;
ALTER TABLE purchases_next RENAME TO purchases;
CREATE INDEX products_visible ON products(enabled,deleted_at,type);
CREATE INDEX products_character ON products(character_key) WHERE character_key!='';
CREATE INDEX products_scene ON products(scene_key) WHERE scene_key!='';
CREATE UNIQUE INDEX purchases_permanent ON purchases(product_id) WHERE type_snapshot!='reward' AND repeatable=0;
CREATE UNIQUE INDEX purchases_character ON purchases(character_key_snapshot) WHERE type_snapshot='character';
CREATE UNIQUE INDEX purchases_scene ON purchases(scene_key_snapshot) WHERE type_snapshot='scene';
CREATE INDEX purchases_item ON purchases(item_key_snapshot) WHERE item_key_snapshot!='';
CREATE INDEX purchases_date ON purchases(created_at,id);

-- 布局版本与光照属于独立场景，实例主键保证同一物件不能跨景重复摆放。
CREATE TABLE island_scene_states (
    scene_key TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK(version > 0),
    environment_key TEXT NOT NULL
) STRICT;
CREATE TABLE island_scene_placements (
    instance_id TEXT PRIMARY KEY,
    scene_key TEXT NOT NULL REFERENCES island_scene_states(scene_key),
    position_index INTEGER NOT NULL DEFAULT 0 CHECK(position_index >= 0),
    item_key TEXT NOT NULL,
    space TEXT NOT NULL CHECK(space IN ('outdoor','indoor')),
    x_cm INTEGER NOT NULL,
    z_cm INTEGER NOT NULL,
    rotation INTEGER NOT NULL CHECK(rotation BETWEEN 0 AND 3)
) STRICT;
CREATE INDEX island_scene_placements_scene ON island_scene_placements(scene_key);

-- 只迁移真实保存的布局；未保存的免费海边默认布局仍由配置与服务解释。
INSERT INTO island_scene_states(scene_key,version,environment_key)
SELECT scene_key,version,environment_key FROM island_spatial_state;
INSERT INTO island_scene_placements(instance_id,scene_key,position_index,item_key,space,x_cm,z_cm,rotation)
SELECT json_extract(placement.value,'$.instance_id'),state.scene_key,CAST(placement.key AS INTEGER),
       json_extract(placement.value,'$.item_key'),json_extract(placement.value,'$.space'),
       json_extract(placement.value,'$.x_cm'),json_extract(placement.value,'$.z_cm'),json_extract(placement.value,'$.rotation')
FROM island_spatial_state AS state,json_each(state.placements) AS placement;
