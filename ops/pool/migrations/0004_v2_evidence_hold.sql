-- #354 / #240. SOURCE ONLY until separately reviewed/applied by the pool owner.
-- Exact pending accounting evidence only: no order/grant mutation or capacity release.
-- Existing 0001–0003 and every claim/settle/release interface remain unchanged.
CREATE FUNCTION public.pool_v2_record_evidence(p_grant text,i public.pool_v2_identity,
 p_outcome text,p_spent bigint,p_final text,p_evidence_sha256 text,p_evidence_ref text)
 RETURNS TABLE(status text,evidence_id text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b public.pool_v2_order; e public.pool_v2_settlement_evidence; eid text; ih text;
BEGIN
 -- Same global -> grant -> exact own order -> binding -> evidence lock order as 0003.
 PERFORM public.pool_v2_lock();
 PERFORM public.pool_v2_exact(p_grant,i);
 PERFORM 1 FROM public.pool_order WHERE request_id=i.request_id FOR UPDATE;
 SELECT * INTO b FROM public.pool_v2_order WHERE request_id=i.request_id FOR UPDATE;
 -- Identical to settle's report domain. Unknown/incomplete actuals stay uncertain locally;
 -- neither zero nor a terminal outcome may be invented to fit this append-only report.
 IF p_outcome IS NULL OR p_outcome NOT IN ('completed','refused','stopped','failed','cancelled')
  OR p_spent IS NULL OR p_spent NOT BETWEEN 0 AND 9007199254740991
  OR (p_final IS NOT NULL AND length(p_final) NOT BETWEEN 1 AND 1024)
  OR (p_outcome='completed' AND p_final IS NULL)
  OR p_evidence_sha256 IS NULL OR p_evidence_sha256 !~ '^[0-9a-f]{64}$'
  OR p_evidence_ref IS NULL OR p_evidence_ref !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$'
 THEN RAISE EXCEPTION 'pool_v2_invalid_report'; END IF;
 -- EXACT canonical v1 identity/ID from immutable 0003, so later unchanged settlement
 -- may satisfy this same report and cannot clear a different report's evidence.
 ih:=encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex');
 eid:=encode(sha256(convert_to(jsonb_build_array('v1',b.binding_id,ih,p_outcome,p_spent,p_final,p_evidence_sha256,p_evidence_ref)::text,'UTF8')),'hex');
 SELECT * INTO e FROM public.pool_v2_settlement_evidence x WHERE x.evidence_id=eid FOR UPDATE;
 IF FOUND THEN
  IF (e.request_id,e.binding_id,e.identity_sha256,e.reported_outcome,e.reported_cents,
      e.final_run_id,e.evidence_sha256,e.evidence_ref)
   IS DISTINCT FROM (i.request_id,b.binding_id,ih,p_outcome,p_spent,p_final,p_evidence_sha256,p_evidence_ref)
  THEN RAISE EXCEPTION 'pool_v2_evidence_identity_mismatch'; END IF;
  -- A historical satisfied report is not an active hold. Never return a pending-success
  -- status or rewrite/reopen it, including after grant disable/retire or order completion.
  IF e.satisfied THEN RAISE EXCEPTION 'pool_v2_evidence_satisfied'; END IF;
  RETURN QUERY SELECT 'evidence_replayed'::text,eid; RETURN;
 END IF;
 INSERT INTO public.pool_v2_settlement_evidence(evidence_id,request_id,binding_id,identity_sha256,
  reported_outcome,reported_cents,final_run_id,evidence_sha256,evidence_ref,reporter)
 VALUES(eid,i.request_id,b.binding_id,ih,p_outcome,p_spent,p_final,p_evidence_sha256,p_evidence_ref,session_user);
 RETURN QUERY SELECT 'evidence_recorded'::text,eid;
END $$;
-- Installation admits nobody. Dedicated-principal mapping, function provenance review and
-- separately authorized EXECUTE provisioning remain prerequisites; no client release right.
REVOKE ALL ON FUNCTION public.pool_v2_record_evidence(text,public.pool_v2_identity,text,bigint,text,text,text)
 FROM PUBLIC;
-- Inherited owner DEFAULT PRIVILEGES must not silently provision a client capability.
-- Fail installation rather than rewriting any role/default privilege or accepting that ACL.
DO $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p,
   LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
  WHERE p.oid='public.pool_v2_record_evidence(text,public.pool_v2_identity,text,bigint,text,text,text)'::pg_catalog.regprocedure
   AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner
 ) THEN RAISE EXCEPTION 'pool_v2_evidence_acl_refused'; END IF;
END $$;
