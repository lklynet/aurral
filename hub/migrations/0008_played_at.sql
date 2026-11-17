ALTER TABLE listening ADD COLUMN played_at INTEGER;

UPDATE listening SET played_at = playing_until WHERE now_playing IS NOT NULL;
