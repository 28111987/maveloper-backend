-- ===========================================================================
-- org_figma_credentials_run2.sql
-- THE COMPANION TO org_figma_credentials.sql. RUN 2 — THE WRITE PATH.
--
-- ★★ RUN org_figma_credentials.sql FIRST. This file only ADDS to that table.
-- It is written so it is safe to run twice, and safe to run before or after a
-- deploy, because a migration is run by a human and a deploy is run by a robot
-- and the two will be out of order at least once.
--
-- ★★ NOT APPLIED BY THIS RUN. This session has NO service-role key, NO psql and
-- NO Supabase CLI. The owner runs this in the Supabase SQL editor. Nothing in
-- code creates it, and the backend degrades rather than breaks if it is absent
-- (see figma-credential-routes.js — a 42703 on token_last4 retries without it).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE MASKED HINT COLUMN.
--
-- ★ WHY A COLUMN AND NOT A COMPUTATION. The read endpoint must show the client
-- the last four characters of their own token so they can tell the credential
-- they are looking at from the one they pasted last month. The token is SEALED
-- in `token`, so computing the hint at read time would mean DECRYPTING ON EVERY
-- READ — putting the plaintext into backend memory on a route that has no
-- business ever holding it, purely to display four characters.
--
-- Stored at write time instead. The hint is computed once, in the one place the
-- plaintext legitimately exists, and the read path never touches the cipher.
--
-- ★ FOUR CHARACTERS, AND THE COLUMN IS CONSTRAINED TO FOUR. A `text` column with
-- no check is one careless UPDATE away from holding the whole token, and it
-- would look exactly like a hint until somebody read it. The constraint makes
-- "the hint accidentally became the secret" a DATABASE ERROR rather than a
-- silent disclosure.
-- ---------------------------------------------------------------------------
alter table public.org_figma_credentials
  add column if not exists token_last4 text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'org_figma_credentials_last4_len'
  ) then
    alter table public.org_figma_credentials
      add constraint org_figma_credentials_last4_len
      check (token_last4 is null or char_length(token_last4) = 4);
  end if;
end $$;

comment on column public.org_figma_credentials.token_last4 is
  'The last four characters of the credential, and the ONLY fragment of it that '
  'may ever leave the database. Constrained to exactly four so this column '
  'cannot quietly grow into a copy of the secret. NEVER the first four: every '
  'Figma token begins figd_, so a prefix hint identifies nothing.';


-- ---------------------------------------------------------------------------
-- 2. THE TEST-BUTTON RECORD.
--
-- ★ A CREDENTIAL THAT HAS NEVER BEEN TESTED AND ONE THAT FAILED ITS LAST TEST
-- ARE DIFFERENT, AND THE PRODUCT MUST NOT RENDER THEM THE SAME. Without these
-- columns the console can only say "untested" forever, which is the
-- absence-rendered-as-zero failure this codebase has shipped before.
--
-- `last_test_ok` is NULLABLE ON PURPOSE and the three states are meant:
--     null   never tested        -> the console says so, in those words
--     true   passed at last_test_at
--     false  FAILED at last_test_at -> amber, with the reason
-- ---------------------------------------------------------------------------
alter table public.org_figma_credentials
  add column if not exists last_test_at  timestamptz;

alter table public.org_figma_credentials
  add column if not exists last_test_ok  boolean;

alter table public.org_figma_credentials
  add column if not exists last_test_note text;

comment on column public.org_figma_credentials.last_test_ok is
  'NULL = never tested, true = passed, false = failed. Three states, because '
  '"never tested" and "failed" are different facts and rendering them alike '
  'would tell a client their token is fine when nothing ever asked Figma.';

comment on column public.org_figma_credentials.last_test_note is
  'A HUMAN SENTENCE about the last test — never a response body and never a '
  'header. The token cannot appear here: the route writes a fixed message '
  'chosen from the HTTP status, not the text Figma returned.';


-- ---------------------------------------------------------------------------
-- 3. THE SEAL IS NOT A COLUMN, AND THAT IS DELIBERATE.
--
-- There is no `token_sealed boolean` here. The sealed form is SELF-DESCRIBING —
-- it begins `figseal.v1.` — so a row states what it is without a flag that could
-- disagree with it. A flag would also make the reader's correctness depend on
-- THIS FILE having been run, and the whole point of the prefix is that the code
-- is correct whether it was run or not.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 4. ★★ STILL NO POLICIES. DO NOT ADD ONE.
--
-- org_figma_credentials.sql enabled RLS and created ZERO policies, and this file
-- does not create one either. The temptation, when the console screen appears,
-- is to add "a client may read their own org's row" so the browser can fetch it
-- directly and skip the backend. THAT POLICY WOULD MAKE A CLIENT'S FIGMA TOKEN
-- REACHABLE FROM A BROWSER SESSION, which is the single outcome this table
-- exists to prevent.
--
-- The console reads this table through the backend, which selects an EXPLICIT
-- column list that omits `token`. That is the only read path, and it is the
-- reason a policy is unnecessary as well as unsafe.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 5. VERIFICATION. RUN THESE TWO AND READ THEM — THEY ARE NOT CEREMONY.
--
-- The failure mode if RLS silently did not take is severe and silent: client
-- Figma tokens readable from a browser. Nothing else in the product will tell
-- you. Expect  relrowsecurity = t  and  policies = 0.
-- ---------------------------------------------------------------------------

-- select relname, relrowsecurity
--   from pg_class where relname = 'org_figma_credentials';

-- select count(*) as policies
--   from pg_policies where tablename = 'org_figma_credentials';

-- And the new columns, all five:
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_name = 'org_figma_credentials'
--    and column_name in ('token_last4','last_test_at','last_test_ok','last_test_note')
--  order by column_name;


-- ---------------------------------------------------------------------------
-- 6. ★★ AND THE ONE THING THIS FILE CANNOT DO FOR YOU.
--
-- Run 2 could not determine whether `log_statement` is enabled on this project:
-- no psql, no CLI, no service-role key, and PostgREST cannot read pg_settings.
-- Under log_statement = 'mod' or 'all', Postgres logs an INSERT's BOUND
-- PARAMETERS in full (log_parameter_max_length defaults to -1), so a
-- parameterised insert of a secret is logged verbatim on two of the four
-- settings.
--
-- The write path therefore SEALS the token before it is bound, so the logged
-- parameter is ciphertext under every setting and the question stops mattering.
-- You may still want to know the answer:
--
--   show log_statement;
--
-- ---------------------------------------------------------------------------
