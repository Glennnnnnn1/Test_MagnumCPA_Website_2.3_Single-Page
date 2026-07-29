-- =====================================================================
--  Magnum CPA Portal — Canopy Tax integration readiness
--  Run once in Supabase → SQL Editor. Safe to re-run.
--
--  This does NOT talk to Canopy yet — it just prepares the database so
--  the Edge Functions in supabase/functions/canopy-* have somewhere to
--  read/write once you have real Canopy API credentials. See
--  SETUP-CANOPY.md for what to do when you're ready to go live.
-- =====================================================================

-- 1. Link a portal account to its Canopy client record.
alter table public.profiles add column if not exists canopy_client_id text;

-- 2. Document requests Canopy has asked the client for (synced in via webhook
--    or a pull sync) — shown read-only in the client's portal.
create table if not exists public.canopy_document_requests (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  canopy_request_id text,                 -- Canopy's own id for this request, for de-dup
  title             text not null,
  description       text,
  status            text not null default 'pending',   -- pending | received | closed
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists canopy_document_requests_canopy_id_uq
  on public.canopy_document_requests (canopy_request_id) where canopy_request_id is not null;

alter table public.canopy_document_requests enable row level security;

-- Client sees their own requests; admin sees all. Only the service role
-- (used by the Edge Functions) writes here — no insert/update policy for
-- regular users, so the browser can never fake a Canopy request.
drop policy if exists cdr_select on public.canopy_document_requests;
create policy cdr_select on public.canopy_document_requests for select
  using (user_id = auth.uid() or public.is_admin());

-- 3. Track which shared_files rows have been pushed to Canopy as documents,
--    and which side the file's copy originated from.
alter table public.shared_files add column if not exists canopy_document_id text;
alter table public.shared_files add column if not exists synced_to_canopy boolean not null default false;

-- 4. OAuth token storage for the Canopy API connection itself.
--    RLS is on with NO policies — this table is invisible to every browser
--    session (client or admin) and can only be read/written by the Edge
--    Functions, which use the service_role key.
create table if not exists public.canopy_oauth_tokens (
  id            text primary key default 'default',
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  updated_at    timestamptz not null default now()
);
alter table public.canopy_oauth_tokens enable row level security;

-- 5. Realtime for document requests, so the client dashboard updates live
--    once a real sync/webhook starts inserting rows.
do $$
begin
  begin
    alter publication supabase_realtime add table public.canopy_document_requests;
  exception when others then null;
  end;
end $$;
