ALTER TABLE users ADD COLUMN brush_color TEXT NOT NULL DEFAULT '#8be9fd';
ALTER TABLE users ADD COLUMN brush_style TEXT NOT NULL DEFAULT 'neon';

CREATE TABLE IF NOT EXISTS doodles (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  style TEXT NOT NULL,
  color TEXT NOT NULL,
  points_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS doodles_room_created_idx ON doodles(room_id, created_at ASC);
