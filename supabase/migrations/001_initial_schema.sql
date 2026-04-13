-- ============================================================
-- 001_initial_schema.sql
-- Household Inventory — Phase 1 schema
--
-- Run this in the Supabase SQL Editor (not via the CLI).
-- It is idempotent: safe to re-run if something partially failed.
-- ============================================================


-- ============================================================
-- Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS households (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Join table linking auth.users to households.
-- Composite PK prevents duplicate membership rows.
CREATE TABLE IF NOT EXISTS household_members (
  household_id  uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, user_id)
);

-- Inventory items.
-- quantity >= 0: items stay at 0 rather than being deleted (Running Low view).
-- category enforced via CHECK — easier to extend than a Postgres enum.
CREATE TABLE IF NOT EXISTS items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name          text NOT NULL,
  category      text NOT NULL CHECK (category IN (
                  'Produce', 'Dairy', 'Pantry', 'Frozen',
                  'Meat', 'Beverages', 'Household', 'Other'
                )),
  quantity      integer NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Activity log. Append-only — no UPDATE or DELETE RLS policies are created.
-- item_id is nullable (SET NULL on item delete) so deletions don't orphan rows.
-- item_name_snapshot preserves the name for display after an item is deleted.
CREATE TABLE IF NOT EXISTS activity_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id        uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  item_id             uuid REFERENCES items(id) ON DELETE SET NULL,
  item_name_snapshot  text NOT NULL,
  user_id             uuid NOT NULL REFERENCES auth.users(id),
  action              text NOT NULL CHECK (action IN (
                        'added', 'decremented', 'marked_out',
                        'edited', 'deleted', 'audited'
                      )),
  quantity_delta      integer,  -- signed: negative for decrements
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Pending hauls (photo parse jobs).
-- photo_urls: Storage object paths (not signed URLs — resolved at read time).
-- parsed_items: [{name, category, quantity, confidence}] — set by the Worker.
CREATE TABLE IF NOT EXISTS pending_hauls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id),
  source        text NOT NULL CHECK (source IN ('receipt', 'counter_photo')),
  status        text NOT NULL DEFAULT 'parsing' CHECK (status IN (
                  'parsing', 'ready', 'committed', 'failed'
                )),
  photo_urls    text[] NOT NULL DEFAULT '{}',
  parsed_items  jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  committed_at  timestamptz
);

-- Usage meter. One row per user per day.
-- UNIQUE (user_id, date) lets the Worker use INSERT ... ON CONFLICT DO UPDATE
-- to increment counts atomically.
-- Frontend can SELECT (to show usage in Settings). All writes go via the
-- Worker's service_role key which bypasses RLS.
CREATE TABLE IF NOT EXISTS usage_meter (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id),
  date                date NOT NULL DEFAULT CURRENT_DATE,
  parse_count         integer NOT NULL DEFAULT 0,
  estimated_cost_usd  numeric(10, 6) NOT NULL DEFAULT 0,
  UNIQUE (user_id, date)
);


-- ============================================================
-- Indexes
-- Postgres does not auto-index foreign keys. These cover the
-- WHERE clauses used in every screen.
-- ============================================================

CREATE INDEX IF NOT EXISTS items_household_id_idx
  ON items(household_id);

CREATE INDEX IF NOT EXISTS activity_log_household_id_idx
  ON activity_log(household_id);

CREATE INDEX IF NOT EXISTS activity_log_created_at_idx
  ON activity_log(created_at DESC);

CREATE INDEX IF NOT EXISTS pending_hauls_household_id_idx
  ON pending_hauls(household_id);

CREATE INDEX IF NOT EXISTS pending_hauls_status_idx
  ON pending_hauls(status);


-- ============================================================
-- Triggers
-- ============================================================

-- Auto-updates items.updated_at on every UPDATE.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS items_updated_at ON items;
CREATE TRIGGER items_updated_at
  BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ============================================================
-- Row Level Security
-- ============================================================

ALTER TABLE households        ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE items              ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_hauls      ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_meter        ENABLE ROW LEVEL SECURITY;

-- Reusable subquery pattern for all household-scoped policies:
--   household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
-- This is intentionally inlined (not a function) so Supabase's query planner
-- can see through it and use the household_id index.

-- households: read-only from frontend (seeded manually, not created by users)
CREATE POLICY "Members can view their household"
  ON households FOR SELECT TO authenticated
  USING (
    id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

-- household_members: read-only (no frontend writes).
-- Uses a direct column check (not a subquery back into household_members) to
-- avoid infinite recursion when other policies use this table as a subquery.
CREATE POLICY "Members can view household membership"
  ON household_members FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- items: full CRUD for household members
CREATE POLICY "Members can view their household items"
  ON items FOR SELECT TO authenticated
  USING (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Members can insert items into their household"
  ON items FOR INSERT TO authenticated
  WITH CHECK (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Members can update their household items"
  ON items FOR UPDATE TO authenticated
  USING (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Members can delete their household items"
  ON items FOR DELETE TO authenticated
  USING (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

-- activity_log: SELECT + INSERT only (no UPDATE/DELETE — append-only log)
CREATE POLICY "Members can view their household activity"
  ON activity_log FOR SELECT TO authenticated
  USING (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Members can insert activity for their household"
  ON activity_log FOR INSERT TO authenticated
  WITH CHECK (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

-- pending_hauls: SELECT + INSERT + UPDATE (keep committed hauls for history)
CREATE POLICY "Members can view their household hauls"
  ON pending_hauls FOR SELECT TO authenticated
  USING (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Members can create hauls for their household"
  ON pending_hauls FOR INSERT TO authenticated
  WITH CHECK (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Members can update their household hauls"
  ON pending_hauls FOR UPDATE TO authenticated
  USING (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

-- usage_meter: SELECT own rows only (all writes go via Worker service_role key)
CREATE POLICY "Users can view their own usage"
  ON usage_meter FOR SELECT TO authenticated
  USING (user_id = auth.uid());


-- ============================================================
-- Storage — haul-photos bucket
-- ============================================================

-- Create the private bucket. ON CONFLICT DO NOTHING makes this idempotent.
-- file_size_limit: 10 MB. HEIC included for iPhone photos.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'haul-photos',
  'haul-photos',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
ON CONFLICT (id) DO NOTHING;

-- Upload: users can only write to their own folder ({user_id}/filename.jpg).
-- The Worker reads photos via service_role key (bypasses RLS entirely).
CREATE POLICY "Users can upload haul photos to their folder"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'haul-photos'
    AND split_part(name, '/', 1) = auth.uid()::text
  );

-- Read: any authenticated user can read any photo in the bucket.
-- Both household members are trusted; scoping to household would require
-- joining pending_hauls which is unnecessary complexity for two users.
CREATE POLICY "Authenticated users can read haul photos"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'haul-photos');

-- Delete: users can only delete their own photos.
CREATE POLICY "Users can delete their own haul photos"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'haul-photos'
    AND split_part(name, '/', 1) = auth.uid()::text
  );
