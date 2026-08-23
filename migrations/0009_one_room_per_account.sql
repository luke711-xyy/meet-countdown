-- Keep the most established room for each account: prefer rooms with both
-- members, then the most recently joined room. Detach older duplicate
-- memberships without deleting their room content.
DELETE FROM room_members
WHERE rowid NOT IN (
  SELECT selected.rowid
  FROM room_members AS selected
  WHERE selected.rowid = (
    SELECT candidate.rowid
    FROM room_members AS candidate
    WHERE candidate.user_id = selected.user_id
    ORDER BY (
      SELECT COUNT(*)
      FROM room_members AS members
      WHERE members.room_id = candidate.room_id
    ) DESC, candidate.joined_at DESC, candidate.room_id DESC
    LIMIT 1
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS room_members_one_room_per_user
  ON room_members(user_id);
