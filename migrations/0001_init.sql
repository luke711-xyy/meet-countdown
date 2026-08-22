CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  target_at TEXT NOT NULL,
  blur_px INTEGER NOT NULL DEFAULT 0,
  background_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  author_id TEXT NOT NULL,
  completed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_notes (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_room_updated_idx ON tasks(room_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS voice_notes_room_created_idx ON voice_notes(room_id, created_at DESC);
