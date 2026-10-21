-- #240 / D-018. SOURCE ONLY until separately applied by the pool owner.
-- No principal, client EXECUTE grant, transport, or not-sent capability is installed.
-- Lock order for EVERY public mutator: global table -> fixed grant -> order -> evidence.
ALTER TABLE public.pool_budget
 DROP CONSTRAINT pool_budget_cap_cents_check,
 ADD CONSTRAINT pool_budget_cap_cents_check CHECK (cap_cents BETWEEN 0 AND 900);
UPDATE public.pool_budget SET cap_cents = 900,
 set_by = 'D-018: owner permits $7 historical + at most $2 new v2, shared dev/stage',
 set_at = clock_timestamp();

CREATE TYPE public.pool_v2_identity AS (
 request_id text, script_digest text, take integer, until text, body_sha256 text,
 ordered_by text, ceiling_cents integer, approval_ref text
);
CREATE TABLE public.pool_v2_grant (
 grant_id text PRIMARY KEY CHECK (grant_id = 'knowscroll-v2-d018'),
 cap_cents integer NOT NULL CHECK (cap_cents BETWEEN 1 AND 200),
 authority_ref text NOT NULL CHECK (authority_ref = 'D-018'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 enabled boolean NOT NULL DEFAULT false,
 retired boolean NOT NULL DEFAULT false,
 CHECK (NOT (enabled AND retired))
);
INSERT INTO public.pool_v2_grant (grant_id, cap_cents, authority_ref)
 VALUES ('knowscroll-v2-d018', 200, 'D-018');
-- Empty at installation. Future operations must map dedicated, unmixed login roles
-- by BOTH immutable OID and name. SQL body text/current_user is never world authority.
CREATE TABLE public.pool_v2_principal (
 role_oid oid PRIMARY KEY,
 role_name name NOT NULL UNIQUE,
 world text NOT NULL CHECK (world IN ('dev', 'stage'))
);
CREATE TABLE public.pool_v2_order (
 request_id text PRIMARY KEY REFERENCES public.pool_order(request_id),
 grant_id text NOT NULL REFERENCES public.pool_v2_grant(grant_id),
 binding_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.pool_v2_settlement_evidence (
 evidence_id text PRIMARY KEY CHECK (evidence_id ~ '^[0-9a-f]{64}$'),
 request_id text NOT NULL REFERENCES public.pool_v2_order(request_id),
 binding_id uuid NOT NULL REFERENCES public.pool_v2_order(binding_id),
 identity_sha256 text NOT NULL CHECK (identity_sha256 ~ '^[0-9a-f]{64}$'),
 reported_outcome text NOT NULL CHECK (reported_outcome IN ('completed','refused','stopped','failed','cancelled')),
 reported_cents bigint NOT NULL CHECK (reported_cents BETWEEN 0 AND 9007199254740991),
 final_run_id text CHECK (final_run_id IS NULL OR length(final_run_id) BETWEEN 1 AND 1024),
 evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
 evidence_ref text NOT NULL CHECK (evidence_ref ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$'),
 reporter name NOT NULL,
 reported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 satisfied boolean NOT NULL DEFAULT false,
 CHECK (reported_outcome <> 'completed' OR final_run_id IS NOT NULL)
);
CREATE FUNCTION public.pool_v2_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN RAISE EXCEPTION 'pool_v2_immutable'; END $$;
CREATE TRIGGER pool_v2_order_immutable BEFORE UPDATE OR DELETE ON public.pool_v2_order
 FOR EACH ROW EXECUTE FUNCTION public.pool_v2_immutable();
CREATE TRIGGER pool_v2_principal_immutable BEFORE UPDATE OR DELETE ON public.pool_v2_principal
 FOR EACH ROW EXECUTE FUNCTION public.pool_v2_immutable();
CREATE TRIGGER pool_v2_grant_no_delete BEFORE DELETE ON public.pool_v2_grant
 FOR EACH ROW EXECUTE FUNCTION public.pool_v2_immutable();
CREATE FUNCTION public.pool_v2_grant_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF (NEW.grant_id, NEW.cap_cents, NEW.authority_ref, NEW.created_at)
  IS DISTINCT FROM (OLD.grant_id, OLD.cap_cents, OLD.authority_ref, OLD.created_at)
  OR (OLD.retired AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'pool_v2_grant_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pool_v2_grant_guard BEFORE UPDATE ON public.pool_v2_grant
 FOR EACH ROW EXECUTE FUNCTION public.pool_v2_grant_guard();
CREATE FUNCTION public.pool_v2_evidence_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF (to_jsonb(NEW) - 'satisfied') IS DISTINCT FROM (to_jsonb(OLD) - 'satisfied')
  OR OLD.satisfied OR NOT NEW.satisfied
 THEN RAISE EXCEPTION 'pool_v2_evidence_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pool_v2_evidence_guard BEFORE UPDATE ON public.pool_v2_settlement_evidence
 FOR EACH ROW EXECUTE FUNCTION public.pool_v2_evidence_guard();
CREATE TRIGGER pool_v2_evidence_no_delete BEFORE DELETE ON public.pool_v2_settlement_evidence
 FOR EACH ROW EXECUTE FUNCTION public.pool_v2_immutable();

-- Private cores: no wrapper recursion and no ACL inherited through helper renaming.
CREATE FUNCTION public.pool_v2_lock() RETURNS void LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 LOCK TABLE public.pool_order IN SHARE ROW EXCLUSIVE MODE;
 PERFORM 1 FROM public.pool_v2_grant ORDER BY grant_id FOR UPDATE;
END $$;
CREATE FUNCTION public.pool_v2_world() RETURNS text LANGUAGE plpgsql STABLE
 SET search_path = pg_catalog, pg_temp AS $$
DECLARE w text;
BEGIN
 SELECT p.world INTO w FROM public.pool_v2_principal p JOIN pg_catalog.pg_roles r
  ON r.oid = p.role_oid AND r.rolname = p.role_name
 WHERE r.rolname = session_user AND r.rolcanlogin AND NOT r.rolinherit
  AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb
  AND NOT r.rolreplication AND NOT r.rolbypassrls
  -- No membership at all: NOINHERIT alone still permits SET ROLE escapes.
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid);
 IF w IS NULL THEN RAISE EXCEPTION 'pool_v2_principal_refused'; END IF;
 RETURN w;
END $$;
CREATE FUNCTION public.pool_v2_validate(i public.pool_v2_identity) RETURNS void LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF i.request_id IS NULL OR i.script_digest IS NULL OR i.take IS NULL OR i.until IS NULL
  OR i.body_sha256 IS NULL OR i.ordered_by IS NULL OR i.ceiling_cents IS NULL OR i.approval_ref IS NULL
  OR i.script_digest !~ '^[0-9a-f]{64}$' OR i.body_sha256 !~ '^[0-9a-f]{64}$'
  OR i.take NOT BETWEEN 1 AND 999 OR i.until <> 'video'
  OR i.ceiling_cents NOT BETWEEN 1 AND 75 OR i.ordered_by NOT IN ('dev','stage')
  OR length(btrim(i.approval_ref)) NOT BETWEEN 1 AND 500
  OR i.request_id <> 'ks-reel-' || left(i.script_digest,32) || '-' || i.take::text
 THEN RAISE EXCEPTION 'pool_v2_invalid_identity'; END IF;
END $$;
CREATE FUNCTION public.pool_v2_matches(o public.pool_order, i public.pool_v2_identity) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT (o.request_id,o.script_digest,o.take,o.until,o.body_sha256,o.ordered_by,o.ceiling_cents,o.approval_ref)
 IS NOT DISTINCT FROM (i.request_id,i.script_digest,i.take,i.until,i.body_sha256,i.ordered_by,i.ceiling_cents,i.approval_ref)
$$;
CREATE FUNCTION public.pool_v2_totals()
 RETURNS TABLE(request_id text, grant_id text, base_cents bigint, effective_cents bigint)
 LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT o.request_id, b.grant_id,
  CASE o.state WHEN 'settled' THEN o.spent_cents::bigint WHEN 'claimed' THEN o.ceiling_cents::bigint ELSE 0::bigint END,
  greatest(CASE o.state WHEN 'settled' THEN o.spent_cents::bigint WHEN 'claimed' THEN o.ceiling_cents::bigint ELSE 0::bigint END,
   coalesce((SELECT max(e.reported_cents) FROM public.pool_v2_settlement_evidence e
    WHERE e.request_id=o.request_id AND NOT e.satisfied),0::bigint))
 FROM public.pool_order o LEFT JOIN public.pool_v2_order b USING(request_id)
$$;
-- Bigint arithmetic for admission, even when the legacy integer status cannot represent totals.
CREATE OR REPLACE FUNCTION public.pool_order_cap_guard() RETURNS trigger LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM public.pool_v2_settlement_evidence WHERE NOT satisfied)
  OR (SELECT coalesce(sum(t.effective_cents),0) FROM public.pool_v2_totals() t) + NEW.ceiling_cents
    > coalesce((SELECT cap_cents FROM public.pool_budget),0)
 THEN RAISE EXCEPTION 'pool_cap_or_accounting_hold'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.pool_v2_settle_core(p_request text, p_world text, p_outcome text, p_spent integer, p_final text)
 RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.pool_order;
BEGIN
 SELECT * INTO o FROM public.pool_order WHERE request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'pool_order_unknown'; END IF;
 IF o.ordered_by <> p_world THEN RAISE EXCEPTION 'pool_order_not_yours'; END IF;
 IF o.state='settled' THEN
  IF (o.outcome,o.spent_cents,o.final_run_id) IS NOT DISTINCT FROM (p_outcome,p_spent,p_final)
   THEN RETURN 'already_settled'; END IF;
  RAISE EXCEPTION 'pool_order_settled_differently';
 END IF;
 IF o.state<>'claimed' THEN RAISE EXCEPTION 'pool_order_not_open'; END IF;
 UPDATE public.pool_order SET state='settled',outcome=p_outcome,spent_cents=p_spent,
  final_run_id=p_final,settled_at=clock_timestamp() WHERE request_id=p_request;
 RETURN 'settled';
END $$;
CREATE FUNCTION public.pool_v2_release_core(p_request text,p_world text) RETURNS text LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.pool_order;
BEGIN
 SELECT * INTO o FROM public.pool_order WHERE request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'pool_order_unknown'; END IF;
 IF o.ordered_by<>p_world THEN RAISE EXCEPTION 'pool_order_not_yours'; END IF;
 IF o.state='released' THEN RETURN 'already_released'; END IF;
 IF o.state<>'claimed' THEN RAISE EXCEPTION 'pool_order_not_open'; END IF;
 UPDATE public.pool_order SET state='released' WHERE request_id=p_request;
 RETURN 'released';
END $$;

-- Compatibility wrappers retain signatures/ordinary unbound outcomes; no legacy v2 adoption.
CREATE OR REPLACE FUNCTION public.pool_claim(
 p_request_id text,p_digest text,p_take integer,p_until text,p_body_sha256 text,
 p_world text,p_ceiling_cents integer,p_approval_ref text
) RETURNS TABLE(status text,request_id text,ordered_by text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE existing public.pool_order;
BEGIN
 PERFORM public.pool_v2_lock();
 IF EXISTS (SELECT 1 FROM public.pool_v2_principal WHERE role_name=session_user)
 THEN RAISE EXCEPTION 'pool_v2_use_grant_api'; END IF;
 IF EXISTS (SELECT 1 FROM public.pool_v2_settlement_evidence WHERE NOT satisfied) THEN
  RETURN QUERY SELECT 'accounting_hold'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF EXISTS (SELECT 1 FROM public.pool_v2_order b JOIN public.pool_order o USING(request_id)
  WHERE o.request_id=p_request_id OR (o.script_digest=p_digest AND
   (o.state='claimed' OR (o.state='settled' AND o.outcome='completed')))) THEN
  RETURN QUERY SELECT 'grant_api_required'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT o.* INTO existing FROM public.pool_order o WHERE o.script_digest=p_digest
  AND (o.state='claimed' OR (o.state='settled' AND o.outcome='completed')) ORDER BY o.take DESC LIMIT 1;
 IF FOUND THEN RETURN QUERY SELECT 'already_ordered'::text,existing.request_id,existing.ordered_by; RETURN; END IF;
 IF EXISTS (SELECT 1 FROM public.pool_order o WHERE o.request_id=p_request_id OR (o.script_digest=p_digest AND o.take=p_take)) THEN
  RETURN QUERY SELECT 'take_taken'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF (SELECT coalesce(sum(t.effective_cents),0) FROM public.pool_v2_totals() t)+p_ceiling_cents
  > coalesce((SELECT cap_cents FROM public.pool_budget),0) THEN
  RETURN QUERY SELECT 'cap_exceeded'::text,NULL::text,NULL::text; RETURN;
 END IF;
 INSERT INTO public.pool_order(request_id,script_digest,take,until,body_sha256,ordered_by,ceiling_cents,approval_ref)
 VALUES(p_request_id,p_digest,p_take,p_until,p_body_sha256,p_world,p_ceiling_cents,p_approval_ref);
 RETURN QUERY SELECT 'claimed'::text,p_request_id,p_world;
END $$;
CREATE OR REPLACE FUNCTION public.pool_settle(p_request_id text,p_world text,p_outcome text,p_spent_cents integer,p_final_run_id text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.pool_v2_lock();
 IF EXISTS (SELECT 1 FROM public.pool_v2_principal WHERE role_name=session_user)
 THEN RAISE EXCEPTION 'pool_v2_use_grant_api'; END IF;
 IF EXISTS (SELECT 1 FROM public.pool_v2_order WHERE request_id=p_request_id)
 THEN RAISE EXCEPTION 'grant_api_required'; END IF;
 RETURN public.pool_v2_settle_core(p_request_id,p_world,p_outcome,p_spent_cents,p_final_run_id);
END $$;
CREATE OR REPLACE FUNCTION public.pool_release(p_request_id text,p_world text) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.pool_v2_lock();
 IF EXISTS (SELECT 1 FROM public.pool_v2_principal WHERE role_name=session_user)
 THEN RAISE EXCEPTION 'pool_v2_use_grant_api'; END IF;
 IF EXISTS (SELECT 1 FROM public.pool_v2_order WHERE request_id=p_request_id)
 THEN RAISE EXCEPTION 'grant_api_required'; END IF;
 RETURN public.pool_v2_release_core(p_request_id,p_world);
END $$;

CREATE FUNCTION public.pool_v2_claim(p_grant text,i public.pool_v2_identity)
 RETURNS TABLE(status text,order_row public.pool_order,binding_id uuid)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE g public.pool_v2_grant; o public.pool_order; b public.pool_v2_order; w text;
BEGIN
 PERFORM public.pool_v2_lock();
 w:=public.pool_v2_world(); PERFORM public.pool_v2_validate(i);
 IF i.ordered_by<>w THEN RAISE EXCEPTION 'pool_v2_world_mismatch'; END IF;
 SELECT * INTO g FROM public.pool_v2_grant WHERE grant_id=p_grant;
 IF NOT FOUND THEN RETURN QUERY SELECT 'grant_unknown'::text,NULL::public.pool_order,NULL::uuid; RETURN; END IF;
 IF EXISTS (SELECT 1 FROM public.pool_v2_settlement_evidence WHERE NOT satisfied) THEN
  RETURN QUERY SELECT 'accounting_hold'::text,NULL::public.pool_order,NULL::uuid; RETURN;
 END IF;
 SELECT * INTO o FROM public.pool_order WHERE request_id=i.request_id FOR UPDATE;
 IF FOUND THEN
  SELECT * INTO b FROM public.pool_v2_order WHERE request_id=i.request_id;
  IF NOT FOUND OR b.grant_id<>p_grant OR NOT public.pool_v2_matches(o,i) THEN
   RETURN QUERY SELECT 'identity_conflict'::text,NULL::public.pool_order,NULL::uuid; RETURN;
  END IF;
  IF o.state='claimed' AND (NOT g.enabled OR g.retired) THEN
   RETURN QUERY SELECT 'grant_disabled'::text,NULL::public.pool_order,NULL::uuid; RETURN;
  END IF;
  RETURN QUERY SELECT CASE o.state WHEN 'claimed' THEN 'already_claimed' WHEN 'settled' THEN 'settled' ELSE 'released' END,o,b.binding_id; RETURN;
 END IF;
 IF NOT g.enabled OR g.retired THEN RETURN QUERY SELECT 'grant_disabled'::text,NULL::public.pool_order,NULL::uuid; RETURN; END IF;
 IF EXISTS (SELECT 1 FROM public.pool_order x WHERE x.script_digest=i.script_digest AND
  (x.take=i.take OR x.state='claimed' OR (x.state='settled' AND x.outcome='completed'))) THEN
  RETURN QUERY SELECT 'script_conflict'::text,NULL::public.pool_order,NULL::uuid; RETURN;
 END IF;
 IF (SELECT coalesce(sum(t.effective_cents),0) FROM public.pool_v2_totals() t)
   + i.ceiling_cents > (SELECT cap_cents FROM public.pool_budget) THEN
  RETURN QUERY SELECT 'cap_exceeded'::text,NULL::public.pool_order,NULL::uuid; RETURN;
 END IF;
 IF (SELECT coalesce(sum(t.effective_cents),0) FROM public.pool_v2_totals() t WHERE t.grant_id=p_grant)
   + i.ceiling_cents > g.cap_cents THEN
  RETURN QUERY SELECT 'grant_exceeded'::text,NULL::public.pool_order,NULL::uuid; RETURN;
 END IF;
 INSERT INTO public.pool_order(request_id,script_digest,take,until,body_sha256,ordered_by,ceiling_cents,approval_ref)
 VALUES(i.request_id,i.script_digest,i.take,i.until,i.body_sha256,i.ordered_by,i.ceiling_cents,i.approval_ref) RETURNING * INTO o;
 INSERT INTO public.pool_v2_order(request_id,grant_id) VALUES(i.request_id,p_grant) RETURNING * INTO b;
 RETURN QUERY SELECT 'claimed'::text,o,b.binding_id;
END $$;
-- Read/identity validation core has no row lock; mutators already hold global/grant before order.
CREATE FUNCTION public.pool_v2_exact(p_grant text,i public.pool_v2_identity) RETURNS public.pool_order
 LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.pool_order; w text;
BEGIN
 w:=public.pool_v2_world(); PERFORM public.pool_v2_validate(i);
 IF i.ordered_by<>w THEN RAISE EXCEPTION 'pool_v2_world_mismatch'; END IF;
 SELECT x.* INTO o FROM public.pool_order x JOIN public.pool_v2_order b USING(request_id)
 WHERE x.request_id=i.request_id AND b.grant_id=p_grant;
 IF NOT FOUND OR NOT public.pool_v2_matches(o,i) THEN RAISE EXCEPTION 'pool_v2_identity_mismatch'; END IF;
 RETURN o;
END $$;
CREATE FUNCTION public.pool_v2_read_order(p_grant text,i public.pool_v2_identity)
 RETURNS TABLE(order_row public.pool_order,binding_id uuid,bound_at timestamptz,pending_evidence text[])
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT o,b.binding_id,b.bound_at,ARRAY(SELECT e.evidence_id FROM public.pool_v2_settlement_evidence e
  WHERE e.request_id=b.request_id AND NOT e.satisfied ORDER BY e.evidence_id LIMIT 32)
 FROM public.pool_v2_exact(p_grant,i) o JOIN public.pool_v2_order b USING(request_id)
$$;
CREATE FUNCTION public.pool_v2_grant_status(p_grant text)
 RETURNS TABLE(cap_cents bigint,base_cents bigint,effective_cents bigint,grant_cap_cents bigint,
 grant_base_cents bigint,grant_effective_cents bigint,enabled boolean,retired boolean,
 accounting_hold boolean,pending_count bigint,pending_evidence text[])
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.pool_v2_world();
 RETURN QUERY SELECT b.cap_cents::bigint,
  (SELECT coalesce(sum(t.base_cents),0)::bigint FROM public.pool_v2_totals() t),
  (SELECT coalesce(sum(t.effective_cents),0)::bigint FROM public.pool_v2_totals() t),g.cap_cents::bigint,
  (SELECT coalesce(sum(t.base_cents),0)::bigint FROM public.pool_v2_totals() t WHERE t.grant_id=p_grant),
  (SELECT coalesce(sum(t.effective_cents),0)::bigint FROM public.pool_v2_totals() t WHERE t.grant_id=p_grant),
  g.enabled,g.retired,EXISTS(SELECT 1 FROM public.pool_v2_settlement_evidence WHERE NOT satisfied),
  (SELECT count(*) FROM public.pool_v2_settlement_evidence WHERE NOT satisfied),
  ARRAY(SELECT evidence_id FROM public.pool_v2_settlement_evidence WHERE NOT satisfied ORDER BY evidence_id LIMIT 32)
 FROM public.pool_budget b CROSS JOIN public.pool_v2_grant g WHERE g.grant_id=p_grant;
END $$;
CREATE FUNCTION public.pool_v2_settle(p_grant text,i public.pool_v2_identity,
 p_outcome text,p_spent bigint,p_final text,p_evidence_sha256 text,p_evidence_ref text)
 RETURNS TABLE(status text,evidence_id text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.pool_order; b public.pool_v2_order; eid text; result text; ih text;
BEGIN
 PERFORM public.pool_v2_lock();
 o:=public.pool_v2_exact(p_grant,i);
 PERFORM 1 FROM public.pool_order WHERE request_id=i.request_id FOR UPDATE;
 SELECT * INTO b FROM public.pool_v2_order WHERE request_id=i.request_id;
 -- Validate before evidence insertion, never convert/truncate bigint to the old integer setter.
 IF p_outcome IS NULL OR p_outcome NOT IN ('completed','refused','stopped','failed','cancelled')
  OR p_spent IS NULL OR p_spent NOT BETWEEN 0 AND 9007199254740991
  OR (p_final IS NOT NULL AND length(p_final) NOT BETWEEN 1 AND 1024)
  OR (p_outcome='completed' AND p_final IS NULL)
  OR p_evidence_sha256 IS NULL OR p_evidence_sha256 !~ '^[0-9a-f]{64}$'
  OR p_evidence_ref IS NULL OR p_evidence_ref !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$'
 THEN RAISE EXCEPTION 'pool_v2_invalid_report'; END IF;
 ih:=encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex');
 eid:=encode(sha256(convert_to(jsonb_build_array('v1',b.binding_id,ih,p_outcome,p_spent,p_final,p_evidence_sha256,p_evidence_ref)::text,'UTF8')),'hex');
 INSERT INTO public.pool_v2_settlement_evidence(evidence_id,request_id,binding_id,identity_sha256,
  reported_outcome,reported_cents,final_run_id,evidence_sha256,evidence_ref,reporter)
 VALUES(eid,i.request_id,b.binding_id,ih,p_outcome,p_spent,p_final,p_evidence_sha256,p_evidence_ref,session_user)
 ON CONFLICT DO NOTHING;
 -- This inner subtransaction alone rolls back on known immutable/range conflicts.
 -- Evidence remains in the outer transaction, which returns normally and must COMMIT.
 BEGIN
  result:=public.pool_v2_settle_core(i.request_id,i.ordered_by,p_outcome,p_spent::integer,p_final);
  UPDATE public.pool_v2_settlement_evidence SET satisfied=true WHERE pool_v2_settlement_evidence.evidence_id=eid AND NOT satisfied;
  RETURN QUERY SELECT result,eid;
 EXCEPTION WHEN numeric_value_out_of_range THEN
  RETURN QUERY SELECT 'held_needs_operator'::text,eid;
 WHEN raise_exception THEN
  IF SQLERRM NOT IN ('pool_order_settled_differently','pool_order_not_open') THEN RAISE; END IF;
  RETURN QUERY SELECT 'held_needs_operator'::text,eid;
 END;
END $$;
-- NO client grant. The future closed Reasoning not_sent capability is a prerequisite;
-- a world/reason string, HTTP404, expiry or unknown outcome is NOT that capability.
CREATE FUNCTION public.pool_v2_release_not_sent(p_grant text,i public.pool_v2_identity)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.pool_v2_lock();
 PERFORM public.pool_v2_exact(p_grant,i);
 PERFORM 1 FROM public.pool_order WHERE request_id=i.request_id FOR UPDATE;
 IF EXISTS (SELECT 1 FROM public.pool_v2_settlement_evidence WHERE request_id=i.request_id AND NOT satisfied)
 THEN RAISE EXCEPTION 'pool_v2_accounting_hold'; END IF;
 RETURN public.pool_v2_release_core(i.request_id,i.ordered_by);
END $$;
CREATE FUNCTION public.pool_v2_admin_gate(p_enabled boolean,p_retire boolean) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.pool_v2_lock();
 IF session_user<>current_user THEN RAISE EXCEPTION 'pool_v2_owner_required'; END IF;
 IF p_enabled IS NULL OR p_retire IS NULL OR (p_enabled AND p_retire) THEN RAISE EXCEPTION 'pool_v2_invalid_gate'; END IF;
 UPDATE public.pool_v2_grant SET enabled=p_enabled,retired=p_retire;
END $$;

REVOKE ALL ON public.pool_v2_grant,public.pool_v2_principal,public.pool_v2_order,
 public.pool_v2_settlement_evidence FROM PUBLIC;
REVOKE ALL ON TYPE public.pool_v2_identity FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pool_v2_immutable(),public.pool_v2_grant_guard(),public.pool_v2_evidence_guard(),
 public.pool_v2_lock(),public.pool_v2_world(),public.pool_v2_validate(public.pool_v2_identity),
 public.pool_v2_matches(public.pool_order,public.pool_v2_identity),public.pool_v2_totals(),
 public.pool_v2_settle_core(text,text,text,integer,text),public.pool_v2_release_core(text,text),
 public.pool_v2_exact(text,public.pool_v2_identity),public.pool_v2_claim(text,public.pool_v2_identity),
 public.pool_v2_read_order(text,public.pool_v2_identity),public.pool_v2_grant_status(text),
 public.pool_v2_settle(text,public.pool_v2_identity,text,bigint,text,text,text),
 public.pool_v2_release_not_sent(text,public.pool_v2_identity),public.pool_v2_admin_gate(boolean,boolean)
 FROM PUBLIC;
-- Replaced wrappers keep pre-existing explicit legacy ACLs; reassert no PUBLIC execute.
REVOKE ALL ON FUNCTION public.pool_claim(text,text,integer,text,text,text,integer,text),
 public.pool_settle(text,text,text,integer,text),public.pool_release(text,text),public.pool_order_cap_guard()
 FROM PUBLIC;

-- Preserve legacy read signatures but remove caller-writable/temp name resolution.
CREATE OR REPLACE FUNCTION public.pool_committed_cents() RETURNS integer LANGUAGE sql STABLE
 SET search_path = pg_catalog, pg_temp AS $$
 SELECT coalesce(sum(CASE state WHEN 'settled' THEN spent_cents WHEN 'claimed' THEN ceiling_cents ELSE 0 END),0)::integer
 FROM public.pool_order
$$;
CREATE OR REPLACE FUNCTION public.pool_next_take(p_digest text) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp AS $$
 SELECT coalesce(max(take),0)+1 FROM public.pool_order WHERE script_digest=p_digest
$$;
CREATE OR REPLACE FUNCTION public.pool_orders() RETURNS SETOF public.pool_order LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp AS $$
 SELECT * FROM public.pool_order ORDER BY claimed_at,request_id
$$;
CREATE OR REPLACE FUNCTION public.pool_budget_status() RETURNS TABLE(cap_cents integer,committed_cents integer,left_cents integer)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT b.cap_cents,public.pool_committed_cents(),greatest(b.cap_cents-public.pool_committed_cents(),0) FROM public.pool_budget b
$$;
REVOKE ALL ON FUNCTION public.pool_committed_cents(),public.pool_next_take(text),public.pool_orders(),public.pool_budget_status()
 FROM PUBLIC;
