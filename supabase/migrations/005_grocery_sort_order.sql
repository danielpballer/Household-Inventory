-- ============================================================
-- 005_grocery_sort_order.sql
-- Household Inventory — drag-to-reorder for the grocery list
--
-- Run this in the Supabase SQL Editor (not via the CLI).
-- Idempotent: safe to re-run.
-- ============================================================

-- Manual sort position. Fractional ordering: dragging a row between two
-- neighbors sets its sort_order to their midpoint, so a reorder only
-- writes one row (LWW-sync friendly). New rows append with the current
-- epoch seconds, which always exceeds backfilled values.
ALTER TABLE grocery_list_items
  ADD COLUMN IF NOT EXISTS sort_order double precision;

-- Backfill existing rows from their creation time so the current
-- (chronological) order is preserved exactly.
UPDATE grocery_list_items
  SET sort_order = EXTRACT(EPOCH FROM created_at)
  WHERE sort_order IS NULL;
