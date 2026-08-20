-- Digital Rx / Rx-photo attachments. Array of {path, type: "photo"|"digital",
-- uploadedAt} — `path` is a Supabase Storage object path (private bucket,
-- read back via short-lived signed URLs, never a public URL). rxAttached/
-- rxDigital are derived client-side from this array, not separate columns.

ALTER TABLE IF EXISTS "Visit"
  ADD COLUMN IF NOT EXISTS "rxAttachments" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE IF EXISTS "Visit"
  DROP CONSTRAINT IF EXISTS visit_rx_attachments_is_array;

ALTER TABLE IF EXISTS "Visit"
  ADD CONSTRAINT visit_rx_attachments_is_array
    CHECK (jsonb_typeof("rxAttachments") = 'array');
