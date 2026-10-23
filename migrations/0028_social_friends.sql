-- #241 backend-only Friends foundation. No HTTP, defaults, list index, invitations or publication.
-- Account-lifetime records; exploration clear retains them. Account deletion needs the future
-- Identity maintenance/receipt-purge capability; this migration does not implement deletion.
-- Reads/writes are bounded exact keys under own root -> sorted existing account gates -> pair.
-- Growth: account profiles, unordered pairs, request windows and command receipts; no private activity.
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create schema social;
create table social.profiles (
  account_id uuid primary key references identity.accounts(id) on delete restrict,
  person_id uuid not null unique,
  handle text collate "C" not null unique,
  display_name text not null,
  profile_revision bigint not null check (profile_revision between 1 and 9007199254740991),
  constraint social_handle check (length(handle) between 3 and 24 and handle ~ '^[a-z0-9]+([._][a-z0-9]+)*$'),
  constraint social_display_name check (length(display_name) between 1 and 80 and
    display_name = btrim(display_name) and display_name !~ '[\x01-\x1f\x7f-\x9f]')
);
create table social.pairs (
  pair_id uuid primary key,
  low_account_id uuid not null references identity.accounts(id) on delete restrict,
  high_account_id uuid not null references identity.accounts(id) on delete restrict,
  private_revision bigint not null default 0 check (private_revision between 0 and 9007199254740991),
  current_request_id uuid,
  accepted_lineage uuid,
  unique(low_account_id, high_account_id),
  check(low_account_id < high_account_id)
);
create table social.pair_sides (
  pair_id uuid not null references social.pairs(pair_id) on delete restrict,
  account_id uuid not null references identity.accounts(id) on delete restrict,
  own_blocked boolean not null default false,
  public_revision bigint not null default 0 check(public_revision between 0 and 9007199254740991),
  public_state text not null default 'none' check(public_state in('none','incoming','outgoing','friends','blocked')),
  primary key(pair_id, account_id),
  check(own_blocked = (public_state = 'blocked')),
  check(public_state = 'none' or public_revision > 0)
);
create table social.requests (
  request_id uuid primary key,
  pair_id uuid not null references social.pairs(pair_id) on delete restrict,
  sender_account_id uuid not null references identity.accounts(id) on delete restrict,
  recipient_account_id uuid not null references identity.accounts(id) on delete restrict,
  expires_at timestamptz not null,
  disposition text not null check(disposition in('pending','declined','cancelled','accepted','expired','blocked')),
  unique(pair_id,request_id),
  check(sender_account_id <> recipient_account_id)
);
alter table social.pairs add constraint social_current_request foreign key(pair_id,current_request_id)
  references social.requests(pair_id,request_id) on delete restrict deferrable initially deferred;
alter table social.pairs add constraint social_accepted_lineage foreign key(pair_id,accepted_lineage)
  references social.requests(pair_id,request_id) on delete restrict deferrable initially deferred;
create table social.command_bindings (
  pair_id uuid not null references social.pairs(pair_id) on delete restrict,
  actor_account_id uuid not null references identity.accounts(id) on delete restrict,
  operation text not null check(operation in('request','accept','decline','cancel','remove','block','unblock')),
  command_id uuid not null,
  actor_epoch integer not null check(actor_epoch > 0),
  lineage uuid,
  primary key(pair_id,actor_account_id,operation,command_id),
  foreign key(pair_id,lineage) references social.requests(pair_id,request_id) on delete restrict
);
-- Enforce subordinate account membership even for direct malformed writes.
create function social.check_pair_binding() returns trigger language plpgsql set search_path=pg_catalog as $$
declare lo uuid; hi uuid;
begin
  select low_account_id,high_account_id into strict lo,hi from social.pairs where pair_id=new.pair_id;
  if tg_table_name='pair_sides' then
    if new.account_id <> lo and new.account_id <> hi then raise exception 'social_pair_binding'; end if;
  elsif tg_table_name='requests' then
    if not ((new.sender_account_id=lo and new.recipient_account_id=hi) or
      (new.sender_account_id=hi and new.recipient_account_id=lo)) then raise exception 'social_pair_binding'; end if;
    if tg_op='UPDATE' and (new.request_id,new.pair_id,new.sender_account_id,new.recipient_account_id,new.expires_at)
      is distinct from (old.request_id,old.pair_id,old.sender_account_id,old.recipient_account_id,old.expires_at)
      then raise exception 'social_request_identity'; end if;
  elsif tg_table_name='command_bindings' then
    if new.actor_account_id <> lo and new.actor_account_id <> hi then raise exception 'social_pair_binding'; end if;
  end if;
  return new;
end $$;
create trigger social_side_binding before insert or update on social.pair_sides for each row execute function social.check_pair_binding();
create trigger social_request_binding before insert or update on social.requests for each row execute function social.check_pair_binding();
create trigger social_command_binding before insert or update on social.command_bindings for each row execute function social.check_pair_binding();
