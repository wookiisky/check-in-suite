-- 装扮报价只保存稳定身份和商业条款，目录指纹用于刷新购买确认版本。
ALTER TABLE products ADD COLUMN catalog_revision TEXT
CHECK(type NOT IN ('character','wearable') OR (asset_key='' AND (type!='wearable' OR wearable_key!='')));

CREATE UNIQUE INDEX products_dress_up_character ON products(account_id,character_key) WHERE type='character';
CREATE UNIQUE INDEX products_dress_up_wearable ON products(account_id,wearable_key) WHERE type='wearable';
CREATE UNIQUE INDEX purchases_wearable ON purchases(account_id,wearable_key_snapshot) WHERE type_snapshot='wearable';
