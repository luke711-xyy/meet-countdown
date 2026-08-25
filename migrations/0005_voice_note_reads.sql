CREATE TABLE IF NOT EXISTS voice_note_reads (
  voice_id TEXT NOT NULL REFERENCES voice_notes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  played_at TEXT NOT NULL,
  PRIMARY KEY (voice_id, user_id)
);

CREATE INDEX IF NOT EXISTS voice_note_reads_user_idx ON voice_note_reads(user_id, played_at DESC);

-- Existing recordings predate unread tracking and should not appear as new.
INSERT OR IGNORE INTO voice_note_reads (voice_id, user_id, played_at)
SELECT voice_notes.id, room_members.user_id, voice_notes.created_at
FROM voice_notes
JOIN room_members ON room_members.room_id = voice_notes.room_id
WHERE voice_notes.author_id <> room_members.user_id;
