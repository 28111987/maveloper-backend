-- ===========================================================================
-- org_figma_credentials — ONE FIGMA CREDENTIAL PER SPACE.
--
-- >>> THE OWNER RUNS THIS IN THE SUPABASE SQL EDITOR. <<<
-- Neither repo has a migration runner — `find -name "*.sql"` returns zero files
-- in maveloper-backend and zero in maveloper-bridge. Schema here has always been
-- applied by hand; MAVELOPER_SERVER_RUNNER_SPEC.md:250 is the precedent
-- ("The CREATE TABLE + RLS SQL for runner_status (I will run it in Supabase)").
-- NOTHING IN THE CODE CREATES THIS TABLE, and figma-credential.js is written to
-- survive its absence: a missing table returns an error, which the resolver
-- treats as "no per-space credential" and falls back to the global token.
--
-- ---------------------------------------------------------------------------
-- WHY RLS ON WITH ZERO POLICIES
-- ---------------------------------------------------------------------------
-- This is maveloper_jobs' posture, deliberately copied. RLS enabled with no
-- policies means EVERY role that RLS applies to is denied — anon and
-- authenticated read nothing and write nothing — while the service role, which
-- bypasses RLS, works normally. For a table whose every row is a client's
-- credential, "no browser can reach this under any circumstances" is the
-- correct wall, and a zero-policy table is the only way to say it that cannot
-- be loosened by a policy someone adds later without noticing.
--
-- The KB lists maveloper_jobs' zero-policy RLS as an open risk. THAT ENTRY IS
-- WRONG: it is the intended design, not a missing policy, and this table follows
-- it on purpose.
--
-- ---------------------------------------------------------------------------
-- AT REST: THIS COLUMN IS PLAINTEXT. SAYING SO PLAINLY.
-- ---------------------------------------------------------------------------
-- `token` is a plain `text` column. It is NOT encrypted by this schema, and no
-- application-level encryption exists anywhere in this backend to inherit. What
-- protects it is:
--   * Supabase encrypts the underlying volume and backups at rest (AES-256),
--     so it is not readable off stolen disk;
--   * RLS ON / zero policies, so no browser-reachable role can select it;
--   * the service-role key, which lives only in Railway env vars.
-- Anyone holding the service-role key can read every token in this table in
-- plaintext. That is the same blast radius the service-role key already has over
-- maveloper_jobs, os_queue and email_allowlist — it is not a NEW exposure, but
-- it IS the ceiling of this design, and it should be stated to a client rather
-- than implying an encryption that does not exist.
-- If that ceiling is not acceptable, the upgrade is pgsodium/Vault
-- (`vault.create_secret`) storing an id here instead of the value. That is a
-- decision for the owner, not a default this run should take.
-- ===========================================================================

create table if not exists public.org_figma_credentials (
  -- ORG_ID IS THE PRIMARY KEY, not a surrogate id with a unique index on it.
  -- "One credential per space" is then structural: a second insert for the same
  -- space is a constraint violation, not a duplicate row a resolver has to pick
  -- between. ON DELETE CASCADE so closing a space destroys its credential —
  -- spaces are never recycled between clients (owner's rule, 28 Aug), so a
  -- surviving token could only ever be an orphan holding live account access.
  org_id        uuid        primary key
                            references public.orgs (id) on delete cascade,

  -- THE PASTED CREDENTIAL. Plaintext; see the header. figma-credential.js
  -- rejects anything not beginning `figd_` before it is ever sent to Figma.
  token         text        not null,

  -- THE LABEL EXISTS SO A SPACE OWNER CAN IDENTIFY A CREDENTIAL WITHOUT SEEING
  -- IT. The token is write-only from the console's point of view, so without a
  -- human-set name ("Acme design account — shared login") the console can show
  -- nothing at all about what is stored and the owner cannot tell a stale
  -- credential from a current one. NOT NULL: an unlabelled secret is
  -- unmanageable.
  label         text        not null,

  -- personal | plan. Both are `figd_` and both use the same X-Figma-Token
  -- header, so this drives NO code path today — it is recorded because the two
  -- have different revocation stories and the owner will need to tell them
  -- apart: a personal access token dies with the person who made it, a plan
  -- access token is issued and revoked by an Org/Enterprise plan admin and
  -- carries a resource allowlist.
  token_kind    text        not null default 'personal'
                            check (token_kind in ('personal', 'plan')),

  -- ★ THE EXPIRY FIELD. NOTHING IN THIS PRODUCT SURFACES A CREDENTIAL EXPIRY
  -- TODAY — no column, no check, no date anywhere. This design has to CREATE
  -- that, not move it. Without it, a client's token silently expires and the
  -- failure arrives as a 403 that is indistinguishable from a revoked share, a
  -- malformed paste or a BOM.
  -- NULLABLE ON PURPOSE: NULL means NO EXPIRY WAS DECLARED, not "expired".
  -- Figma personal access tokens created before the expiry option genuinely
  -- have none; plan access tokens can be set up to one year. The resolver
  -- treats NULL as usable and only a past timestamp as expired.
  expires_at    timestamptz,

  -- Revoke without deleting. Mirrors the spaces rule that a row is retired by a
  -- flag and kept for the audit trail rather than removed. Lets the owner kill a
  -- credential instantly while the history of it having existed survives.
  is_active     boolean     not null default true,

  -- WHO PASTED IT AND WHEN. An email, matching os_space_views.viewer_email.
  -- This is the only record of who introduced a credential into the platform.
  created_at    timestamptz not null default now(),
  created_by    text,
  updated_at    timestamptz not null default now(),

  -- THE ONLY NON-SECRET SIGNAL THAT A TOKEN STILL WORKS. A credential that has
  -- gone cold, or one that stopped being reached after a rename, is invisible
  -- otherwise — you cannot test a token by looking at it, and you must not
  -- return it to anyone to check. Written by the caller, in run 3.
  last_used_at  timestamptz
);

comment on table  public.org_figma_credentials is
  'One client-supplied Figma access token per space. Service-role only (RLS ON, zero policies). Token column is PLAINTEXT — see file header. Never returned to any browser.';
comment on column public.org_figma_credentials.token is
  'PLAINTEXT Figma access token (figd_...). Write-only from the console: no API shape returns this column.';
comment on column public.org_figma_credentials.expires_at is
  'NULL = no expiry declared (usable), NOT expired. A past timestamp = expired; the resolver falls back to the global token and reports reason=expired.';

-- ---------------------------------------------------------------------------
-- THE WALL. ENABLE, AND ADD NOTHING.
-- Every role RLS applies to is denied by the absence of policies. The service
-- role bypasses RLS and is the only thing that ever reads this table.
-- DO NOT ADD A POLICY HERE. Not even a read-your-own-org SELECT policy: that
-- would make a client's Figma token reachable from a browser session, which is
-- the single outcome this table exists to prevent.
-- ---------------------------------------------------------------------------
alter table public.org_figma_credentials enable row level security;

-- Belt and braces: revoke the grants PostgREST's roles get by default, so the
-- table is unreachable for anon/authenticated even if RLS is ever disabled by
-- accident. RLS alone would be enough today; this survives that mistake.
revoke all on public.org_figma_credentials from anon, authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY (run after creating; both should be true / zero)
-- ---------------------------------------------------------------------------
-- select relrowsecurity from pg_class
--   where oid = 'public.org_figma_credentials'::regclass;              -- expect t
-- select count(*) from pg_policies
--   where schemaname = 'public' and tablename = 'org_figma_credentials'; -- expect 0
