-- ============================================================
-- 004_grocery_list.sql
-- Household Inventory — Grocery List feature
--
-- Run this in the Supabase SQL Editor (not via the CLI).
-- Idempotent: safe to re-run.
-- ============================================================

-- Grocery list items.
-- id is client-generated (crypto.randomUUID) so offline-created rows
-- already hold their final id — no temp-id remapping on sync.
-- deleted_at: soft-delete marker set on check-off so deletions sync
-- through the same path as edits. Purged client-side after 1 day.
CREATE TABLE IF NOT EXISTS grocery_list_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name          text NOT NULL,
  quantity      integer NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  item_id       uuid REFERENCES items(id) ON DELETE SET NULL,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Composite index covers the common query (a household's rows sorted by
-- created_at) and, with household_id as the leading column, also serves
-- plain household_id lookups — so no separate household_id index is needed.
CREATE INDEX IF NOT EXISTS grocery_list_items_household_created_idx
  ON grocery_list_items(household_id, created_at);

-- Reuse the shared trigger function defined in 001_initial_schema.sql.
DROP TRIGGER IF EXISTS grocery_list_items_updated_at ON grocery_list_items;
CREATE TRIGGER grocery_list_items_updated_at
  BEFORE UPDATE ON grocery_list_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security: household-scoped CRUD, same pattern as items.
ALTER TABLE grocery_list_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view their household grocery list" ON grocery_list_items;
CREATE POLICY "Members can view their household grocery list"
  ON grocery_list_items FOR SELECT TO authenticated
  USING (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Members can insert grocery list items" ON grocery_list_items;
CREATE POLICY "Members can insert grocery list items"
  ON grocery_list_items FOR INSERT TO authenticated
  WITH CHECK (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Members can update their household grocery list" ON grocery_list_items;
CREATE POLICY "Members can update their household grocery list"
  ON grocery_list_items FOR UPDATE TO authenticated
  USING (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  )
  WITH CHECK (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Members can delete their household grocery list" ON grocery_list_items;
CREATE POLICY "Members can delete their household grocery list"
  ON grocery_list_items FOR DELETE TO authenticated
  USING (
    household_id IN (SELECT household_id FROM household_members WHERE user_id = auth.uid())
  );

-- Realtime: full row image (so RLS row filtering works on changes) and
-- add the table to the realtime publication. Guarded so re-runs don't error.
ALTER TABLE grocery_list_items REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'grocery_list_items'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE grocery_list_items;
  END IF;
END $$;
