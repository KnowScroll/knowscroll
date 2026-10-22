-- #377 Social owns current public roster indexes and latest invitation state (account lifetime).
-- Index: owner/filter/person UUID keyset, public deadline minimum; no pair-history scan.
-- Heads describe durable caller-visible index writes. Pure reads fence time expiry separately.
-- Pair sides remain authoritative; triggers commit projection/head changes with existing receipts.
-- Growth: <=one entry per pair side, <=four heads/account, one latest hash-only invite/account.
-- Clear preserves these stores. Full deletion must remove them under Identity maintenance barriers.
-- Rollout: stop incompatible old writers, apply full0001..0040 prefix; no downgrade/old writer.
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create table social.roster_heads (
  owner_account_id uuid not null references identity.accounts(id) on delete restrict,
  kind text not null check(kind in('friends','incoming','outgoing','blocked')),
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  primary key(owner_account_id,kind)
);
create table social.roster_entries (
  owner_account_id uuid not null references identity.accounts(id) on delete restrict,
  peer_account_id uuid not null references identity.accounts(id) on delete restrict,
  peer_person_id uuid not null references social.profiles(person_id) on delete restrict,
  pair_id uuid not null references social.pairs(pair_id) on delete restrict,
  kind text not null check(kind in('friends','incoming','outgoing','blocked')),
  public_revision bigint not null check(public_revision between 1 and 9007199254740991),
  request_id uuid,
  expires_at timestamptz,
  primary key(owner_account_id,peer_account_id),
  foreign key(pair_id,owner_account_id) references social.pair_sides(pair_id,account_id) on delete restrict,
  foreign key(pair_id,request_id) references social.requests(pair_id,request_id) on delete restrict,
  check(owner_account_id<>peer_account_id),
  check((kind in('incoming','outgoing'))=(request_id is not null and expires_at is not null)),
  check(kind in('incoming','outgoing') or (request_id is null and expires_at is null))
);
create index roster_page on social.roster_entries(owner_account_id,kind,peer_person_id);
create index roster_deadline on social.roster_entries(owner_account_id,kind,expires_at) where expires_at is not null;
create index roster_peer on social.roster_entries(peer_account_id,owner_account_id,kind);
create table social.invites (
  account_id uuid primary key references identity.accounts(id) on delete restrict,
  link_id uuid not null unique,
  token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
  revision bigint not null check(revision between 1 and 9007199254740991),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  revoked boolean not null default false,
  check(extract(epoch from expires_at-created_at)=604800)
);
-- Updates of these heads ALWAYS use canonical owner UUID then kind order, before entry writes.
create function social.bump_roster_head(owner_id uuid, filter_kind text) returns void
language plpgsql set search_path=pg_catalog as $$
begin
  insert into social.roster_heads(owner_account_id,kind) values(owner_id,filter_kind) on conflict do nothing;
  perform 1 from social.roster_heads where owner_account_id=owner_id and kind=filter_kind for update;
  if exists(select 1 from social.roster_heads where owner_account_id=owner_id and kind=filter_kind and revision>=9007199254740991)
    then raise exception 'SOCIAL_COUNTER_EXHAUSTED'; end if;
  update social.roster_heads set revision=revision+1 where owner_account_id=owner_id and kind=filter_kind;
end $$;
create function social.project_roster_side() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare peer_id uuid; person_id uuid; req uuid; deadline timestamptz; filter_kind text;
begin
  if tg_op='UPDATE' and (new.public_state,new.public_revision) is not distinct from (old.public_state,old.public_revision) then return new; end if;
  for filter_kind in select distinct k from unnest(array[
    case when tg_op='UPDATE' and old.public_state<>'none' then old.public_state end,
    case when new.public_state<>'none' then new.public_state end]) k where k is not null order by k
  loop perform social.bump_roster_head(new.account_id,filter_kind); end loop;
  if new.public_state='none' then
    delete from social.roster_entries where owner_account_id=new.account_id and pair_id=new.pair_id;
    return new;
  end if;
  select case when p.low_account_id=new.account_id then p.high_account_id else p.low_account_id end,
    case when new.public_state in('incoming','outgoing') then p.current_request_id end
    into strict peer_id,req from social.pairs p where p.pair_id=new.pair_id;
  select p.person_id into strict person_id from social.profiles p where p.account_id=peer_id;
  if req is not null then select expires_at into strict deadline from social.requests where request_id=req; end if;
  insert into social.roster_entries(owner_account_id,peer_account_id,peer_person_id,pair_id,kind,public_revision,request_id,expires_at)
    values(new.account_id,peer_id,person_id,new.pair_id,new.public_state,new.public_revision,req,deadline)
    on conflict(owner_account_id,peer_account_id) do update set
      kind=excluded.kind,public_revision=excluded.public_revision,request_id=excluded.request_id,expires_at=excluded.expires_at;
  return new;
end $$;
create trigger social_roster_side after insert or update on social.pair_sides for each row execute function social.project_roster_side();
-- Backfill existing explicit public sides only, preserving private pending-sender semantics.
insert into social.roster_entries(owner_account_id,peer_account_id,peer_person_id,pair_id,kind,public_revision,request_id,expires_at)
select s.account_id,peer.account_id,peer.person_id,s.pair_id,s.public_state,s.public_revision,
  case when s.public_state in('incoming','outgoing') then p.current_request_id end,
  case when s.public_state in('incoming','outgoing') then r.expires_at end
from social.pair_sides s join social.pairs p on p.pair_id=s.pair_id
join social.profiles peer on peer.account_id=case when p.low_account_id=s.account_id then p.high_account_id else p.low_account_id end
left join social.requests r on r.request_id=p.current_request_id where s.public_state<>'none';
insert into social.roster_heads(owner_account_id,kind) select distinct owner_account_id,kind from social.roster_entries;

-- Derived identities cannot be redirected even by a malformed direct adapter write.
create function social.check_roster_binding() returns trigger language plpgsql set search_path=pg_catalog as $$
declare expected_peer uuid; expected_person uuid; side_state text; side_revision bigint; expected_request uuid; expected_expiry timestamptz;
begin
  select case when p.low_account_id=new.owner_account_id then p.high_account_id when p.high_account_id=new.owner_account_id then p.low_account_id end,
    s.public_state,s.public_revision,p.current_request_id into strict expected_peer,side_state,side_revision,expected_request
    from social.pairs p join social.pair_sides s on s.pair_id=p.pair_id and s.account_id=new.owner_account_id where p.pair_id=new.pair_id;
  select person_id into strict expected_person from social.profiles where account_id=expected_peer;
  if new.peer_account_id is distinct from expected_peer or new.peer_person_id is distinct from expected_person or new.kind is distinct from side_state or new.public_revision is distinct from side_revision then raise exception 'SOCIAL_ROSTER_BINDING'; end if;
  if new.kind in('incoming','outgoing') then
    select expires_at into strict expected_expiry from social.requests where request_id=expected_request;
    if new.request_id is distinct from expected_request or new.expires_at is distinct from expected_expiry then raise exception 'SOCIAL_ROSTER_BINDING'; end if;
  end if;
  return new;
end $$;
create trigger social_roster_binding before insert or update on social.roster_entries for each row execute function social.check_roster_binding();
