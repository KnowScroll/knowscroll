-- #45: immutable settlement interpretation survives private graph erasure/config changes.
-- Existing #44 fixture/storage rows remain legacy-unbound and cannot authorize dispatch.
ALTER TABLE reasoning_accounting ADD COLUMN binding_hash text CHECK(binding_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE reasoning_accounting ADD COLUMN review_required boolean NOT NULL DEFAULT false;
ALTER TABLE reasoning_reservation ADD COLUMN usage_basis text NOT NULL DEFAULT 'unknown'
 CHECK(usage_basis IN ('unknown','input_tokens','output_tokens','total_tokens','cost_micro_usd','requests','remote_slots'));
ALTER TABLE reasoning_reservation ADD COLUMN handling text NOT NULL DEFAULT 'unknown' CHECK(handling IN ('unknown','budget','rate','remote'));
ALTER TABLE reasoning_reservation ADD COLUMN recognized reasoning_count NOT NULL DEFAULT 0;
ALTER TABLE reasoning_reservation ADD COLUMN usage_known boolean NOT NULL DEFAULT false;
ALTER TABLE reasoning_reservation ADD CONSTRAINT reasoning_reservation_interpretation CHECK(
 (usage_basis='unknown' AND handling='unknown') OR
 (usage_basis='remote_slots' AND handling='remote' AND unit='slots' AND dimension='remote_concurrency') OR
 (usage_basis IN ('input_tokens','output_tokens','total_tokens') AND handling IN ('budget','rate') AND unit='tokens') OR
 (usage_basis='requests' AND handling IN ('budget','rate') AND unit='requests') OR
 (usage_basis='cost_micro_usd' AND handling='budget' AND unit='micro_usd'));
CREATE FUNCTION reasoning_runtime_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='reasoning_accounting' THEN
  IF NEW.binding_hash IS DISTINCT FROM OLD.binding_hash THEN RAISE EXCEPTION 'Reasoning policy binding is immutable'; END IF;
 ELSE
  IF (NEW.usage_basis,NEW.handling) IS DISTINCT FROM (OLD.usage_basis,OLD.handling) THEN RAISE EXCEPTION 'Reasoning settlement interpretation is immutable'; END IF;
  IF OLD.usage_known AND NOT NEW.usage_known THEN RAISE EXCEPTION 'Known usage cannot become unknown'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reasoning_runtime_binding_guard BEFORE UPDATE ON reasoning_accounting FOR EACH ROW EXECUTE FUNCTION reasoning_runtime_binding_guard();
CREATE TRIGGER reasoning_runtime_reservation_guard BEFORE UPDATE ON reasoning_reservation FOR EACH ROW EXECUTE FUNCTION reasoning_runtime_binding_guard();
