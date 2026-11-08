ALTER TABLE accounts ADD COLUMN achievement_title_id TEXT REFERENCES achievements(id);
