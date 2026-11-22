-- 003: preloaded reference data (consolidated price list + Excel template) and the report margin.
-- The files live in the database, NOT in the (public) Git repo; signed-in users get them through the API,
-- admins replace them on /admin. Additive only; safe to re-run. Run as the schema owner.

CREATE TABLE IF NOT EXISTS bom.reference_files (
  kind        text PRIMARY KEY CHECK (kind IN ('price_list', 'template')),
  filename    text NOT NULL,
  content     bytea NOT NULL,
  sha256      text NOT NULL,           -- also the catalog version the worker sends to Claude
  size        integer NOT NULL,
  uploaded_by text,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bom.settings
  ADD COLUMN IF NOT EXISTS margin numeric NOT NULL DEFAULT 0.125;  -- applied to every report line (column L)

GRANT SELECT, INSERT, UPDATE, DELETE ON bom.reference_files TO bom_app;
