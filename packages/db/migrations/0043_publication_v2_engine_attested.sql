-- #199: publication-v2. The same seven required gates as publication-v1, but its witness_alignment
-- is computed from Cutroom's own per-shot checks (apps/worker/src/publication/gates.ts,
-- evaluateEngineAttestedWitness) and is never better than pass_with_label: "engine-attested, not
-- independent". The owner chose this on 2026-10-05, knowingly, over Claude's objection that Cutroom
-- sees shot criteria but never the Scroll's claims or truth state. publication-v1 and every verdict
-- recorded under it stay exactly as they are (policies and gate results are immutable, 0014); an
-- independent witness can later replace this one through a new policy version.
INSERT INTO publication_policy(version, required_gates) VALUES (
 'publication-v2',
 ARRAY['lineage_complete','source_support','engine_record','media_conformance','truth_label','repetition','witness_alignment']
);
