-- ============================================================
-- 006_grocery_store.sql
-- Household Inventory — store sections for the grocery list
--
-- Run this in the Supabase SQL Editor (not via the CLI).
-- Idempotent: safe to re-run.
-- ============================================================

-- Which store an item will be bought at. Existing rows default to
-- Whole Foods (the household's primary store), as do new adds.
ALTER TABLE grocery_list_items
  ADD COLUMN IF NOT EXISTS store text NOT NULL DEFAULT 'Whole Foods';

-- Fixed store list, same CHECK-constraint pattern as items.category.
ALTER TABLE grocery_list_items
  DROP CONSTRAINT IF EXISTS grocery_list_items_store_check;
ALTER TABLE grocery_list_items
  ADD CONSTRAINT grocery_list_items_store_check
  CHECK (store IN ('Whole Foods', 'Costco', 'Other'));
