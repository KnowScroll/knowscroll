-- #171: additive public declarative representation. Existing Scroll body remains the Android and
-- invalid-artifact fallback. The writer admits this JSON with the checked Scroll in one transaction;
-- the API validates identity, body binding and integrity before returning it to web readers.
ALTER TABLE asset ADD COLUMN web_artifact jsonb;
ALTER TABLE asset ADD CONSTRAINT asset_web_artifact_scroll_only CHECK (
  web_artifact IS NULL OR (kind = 'Scroll' AND jsonb_typeof(web_artifact) = 'object')
);
