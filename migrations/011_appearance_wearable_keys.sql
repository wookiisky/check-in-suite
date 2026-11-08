-- 装扮契约变更只用于空外观库。出现旧选择时回滚迁移，由开发者显式重建开发库。
CREATE TEMP TABLE appearance_upgrade_guard (
    previous_rows INTEGER NOT NULL CONSTRAINT appearance_requires_empty_database CHECK(previous_rows=0)
);
INSERT INTO appearance_upgrade_guard SELECT count(*) FROM appearance_state;
DROP TABLE appearance_upgrade_guard;

DROP TABLE appearance_state;
CREATE TABLE appearance_state (
    id INTEGER PRIMARY KEY CHECK(id > 0),
    version INTEGER NOT NULL CHECK(version > 0),
    character_key TEXT NOT NULL,
    face_wearable_key TEXT,
    head_wearable_key TEXT,
    upper_wearable_key TEXT,
    lower_wearable_key TEXT,
    shoes_wearable_key TEXT,
    back_wearable_key TEXT,
    head_color_key TEXT,
    upper_color_key TEXT,
    lower_color_key TEXT,
    shoes_color_key TEXT,
    back_color_key TEXT
) STRICT;
