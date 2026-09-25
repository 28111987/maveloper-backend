-- ===========================================================================
-- org_figma_oauth — ONE FIGMA OAUTH CONNECTION PER SPACE.
--
-- >>> THE OWNER RUNS THIS IN THE SUPABASE SQL EDITOR. <<<
-- Same posture as org_figma_credentials.sql, copied on purpose (see that file's
-- header for the full reasoning). This is a SEPARATE table, not a column added
-- to org_figma_credentials, because an OAuth access token is not a figd_ token
-- and validatePastedToken() (figma-credential.js:107) is written to reject it.
-- Storing an OAuth token in org_figma_credentials.token would make the resolver
-- treat a working credential as "malformed" and fall back to the global Mavlers
-- token SILENTLY — see figma-oauth.js header for the full incident this avoids.
--
-- NOTHING IN THE CODE CREATES THIS TABLE. figma-oauth.js's resolveFigmaOAuth is
-- written to survive its absence: a missing table returns an error, which is
-- treated as "no OAuth connection for this space", and the caller falls through
-- to resolveFigmaToken untouched — exactly today's behaviour.
--
-- ---------------------------------------------------------------------------
-- WHY RLS ON WITH ZERO POLICIES
-- ---------------------------------------------------------------------------
-- Identical reasoning to org_figma_credentials: every role RLS applies to is
-- denied, anon and authenticated read and write nothing, and the service role
-- (Railway env only) is the only thing that ever reads this table.
--
-- ---------------------------------------------------------------------------
-- AT REST: access_token AND refresh_token ARE SEALED, NEVER PLAINTEXT.
-- ---------------------------------------------------------------------------
-- Unlike org_figma_credentials.token (plaintext, documented ceiling), both
-- token columns here are written through figma-credential-crypto.js's
-- sealToken() before the INSERT, for the identical statement-logging reason
-- documented in that file's header: log_statement cannot be read from this
-- machine, so the value bound into the statement must be ciphertext regardless
-- of what that setting turns out to be. The write path (figma-oauth-routes.js)
-- refuses with a 503 rather than storing either value unsealed.
-- ===========================================================================

create table if not exists public.org_figma_oauth (
  -- ORG_ID IS THE PRIMARY KEY, same structural reasoning as
  -- org_figma_credentials: "one OAuth connection per space" becomes a
  -- constraint violation rather than a duplicate row a resolver picks between.
  org_id            uuid        primary key
                                references public.orgs (id) on delete cascade,

  -- SEALED. figseal.v1.<iv>.<tag>.<ct> — see figma-credential-crypto.js.
  access_token      text        not null,

  -- SEALED. Figma does not rotate this on every refresh; it is re-sealed and
  -- rewritten only when Figma's refresh response includes a new one.
  refresh_token     text        not null,

  -- When access_token expires. NOT NULL, unlike org_figma_credentials — Figma
  -- always returns expires_in on both the initial exchange and a refresh, so
  -- there is no "no expiry declared" case for an OAuth token the way a
  -- hand-pasted personal access token can predate the expiry option.
  expires_at        timestamptz not null,

  -- WHO THIS CONNECTS TO, ON FIGMA'S SIDE. Recorded from one GET /v1/me call
  -- made at connect time, so the console can show which Figma account is
  -- connected without ever displaying a token.
  figma_user_id     text,
  figma_email       text,
  figma_handle      text,

  -- THE SCOPES GRANTED, comma-joined, exactly as sent to the authorize URL.
  -- Recorded rather than assumed, so a future scope change is visible per row.
  scopes            text,

  -- Revoke without deleting. Same audit-trail rule as org_figma_credentials.
  is_active         boolean     not null default true,

  -- WHO CONNECTED IT. A Supabase auth user id (req.user.id), not an email —
  -- this table sits behind requireAuth, which always resolves a uuid.
  connected_by      uuid,
  connected_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- THE REFRESH RECORD. A refresh happens silently, inside a generation
  -- request, with no human watching — these three columns are the only way to
  -- tell "still connecting fine" from "quietly broken" after the fact.
  last_refresh_at   timestamptz,
  last_refresh_ok   boolean,
  last_refresh_note text
);

comment on table  public.org_figma_oauth is
  'One Figma OAuth connection per space. Service-role only (RLS ON, zero policies). access_token and refresh_token are SEALED (figseal.v1...) via figma-credential-crypto.js, never plaintext. Never returned to any browser.';
comment on column public.org_figma_oauth.access_token is
  'SEALED Figma OAuth access token. Write-only from the console: no API shape returns this column.';
comment on column public.org_figma_oauth.refresh_token is
  'SEALED Figma OAuth refresh token. Write-only from the console: no API shape returns this column.';
comment on column public.org_figma_oauth.expires_at is
  'When access_token expires. Always set — Figma always returns expires_in. A refresh is attempted when this is within 10 minutes of now.';

-- ---------------------------------------------------------------------------
-- THE WALL. ENABLE, AND ADD NOTHING. See org_figma_credentials.sql for why.
-- DO NOT ADD A POLICY HERE.
-- ---------------------------------------------------------------------------
alter table public.org_figma_oauth enable row level security;

revoke all on public.org_figma_oauth from anon, authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY (run after creating; both should be true / zero)
-- ---------------------------------------------------------------------------
-- select relrowsecurity from pg_class
--   where oid = 'public.org_figma_oauth'::regclass;              -- expect t
-- select count(*) from pg_policies
--   where schemaname = 'public' and tablename = 'org_figma_oauth'; -- expect 0
