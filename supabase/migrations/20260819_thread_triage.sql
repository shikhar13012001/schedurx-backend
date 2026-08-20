-- AI triage classification for inbound WhatsApp threads (POST /api/v1/ai/triage
-- already existed but had no column to persist its result onto — the frontend
-- has been defaulting every thread's triage to "routine" until now).
ALTER TABLE "Thread" ADD COLUMN IF NOT EXISTS "triage" text;
ALTER TABLE "Thread" ADD COLUMN IF NOT EXISTS "aiSummary" text;
