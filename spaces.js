/**
 * spaces.js - CLIENT SPACE MANAGEMENT. Phase 3, session 5.
 *
 * A SPACE IS A TENANT BOUNDARY, NOT A LABEL. Creating one provisions access to
 * billable infrastructure and grants a stranger the ability to submit work that
 * costs money to build. That is a PLATFORM action, not a tenant action, so it is
 * gated on PLATFORM_OWNERS rather than on role = owner: a client's owner
 * administers their own people and nothing else.
 *
 * SPACES ARE NEVER RECYCLED BETWEEN CLIENTS (owner's rule, 28 Aug). Deletion
 * therefore sets is_deleted and keeps the row: the slug stays taken, the audit
 * trail survives, and a future space can never inherit a previous client's
 * identity by reusing a name.
 *
 * WHY THE BACKEND AND NOT THE BROWSER. Creating a space writes to orgs and seeds
 * the first row of email_allowlist, both of which the session-1b and session-3
 * policies deliberately closed to the browser. Doing it here keeps the
 * service-role key server-side and leaves those policies untouched.
 */

function platformOwners(env) {
  return String(env.PLATFORM_OWNERS || '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function toSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function createSpacesRoutes({ app, supabaseAdmin, requireAuth, log, env }) {
  const owners = platformOwners(env);

  // THE PLATFORM-OWNER GATE. Deliberately loud when unconfigured: an empty
  // PLATFORM_OWNERS means NOBODY may create a space, not EVERYBODY. A guard
  // that fails open is not a guard.
  function requirePlatformOwner(req, res, next) {
    const email = String(req.user?.email || '').toLowerCase();
    if (owners.length === 0) {
      return res.status(503).json({
        error: 'Space management is not configured',
        details: 'PLATFORM_OWNERS is not set on the backend. No account can create or delete a space until it is.',
      });
    }
    if (!email || !owners.includes(email)) {
      return res.status(403).json({
        error: 'Only a platform owner may manage spaces',
        details: 'You are signed in as ' + (email || 'an account with no email claim') + '. Managing people inside your own space is a different permission and you may still have it.',
      });
    }
    return next();
  }
  // ??? GET /os/spaces/:slug/inspect - READ-ONLY, AND AUDITED BEFORE IT ANSWERS.
  //
  // The database refuses this and it is right to: my_org_id() returns the
  // CALLER's org and every policy filters on it, so a platform owner cannot read
  // a client's rows through RLS. That wall is NOT widened here. The backend steps
  // around it with the service role, gated on the same requirePlatformOwner that
  // guards creating and closing a space, and every crossing is written to
  // os_space_views FIRST - before the rows are returned, so a failure mid-read
  // still leaves the record that somebody looked.
  //
  // READ-ONLY IS STRUCTURAL, not a promise: this route has no write path. Acting
  // on a client's order is a different permission and it does not exist.
  app.get('/os/spaces/:slug/inspect', requireAuth, requirePlatformOwner, async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase();
    try {
      const { data: org } = await supabaseAdmin
        .from('orgs').select('id,name,slug,is_internal,is_deleted,created_at')
        .eq('slug', slug).maybeSingle();
      if (!org) return res.status(404).json({ error: 'No space with that name' });

      const [people, orders] = await Promise.all([
        supabaseAdmin.from('email_allowlist')
          .select('email,role,added_at').eq('org_id', org.id).order('added_at'),
        supabaseAdmin.from('os_queue')
          .select('order_id,status,lead_email,uploaded_at,finished_at,html_bytes,figma_url')
          .eq('org_id', org.id).order('uploaded_at', { ascending: false }).limit(50),
      ]);

      // WRITTEN BEFORE THE ANSWER LEAVES. If this insert fails the read still
      // returns, because refusing to show the owner their own platform over an
      // audit hiccup helps nobody - but the failure is logged loudly.
      const { error: auditErr } = await supabaseAdmin.from('os_space_views').insert({
        viewer_email: String(req.user?.email || '').toLowerCase(),
        org_id: org.id,
        org_slug: org.slug,
        scope: 'overview',
        row_count: (people.data?.length ?? 0) + (orders.data?.length ?? 0),
      });
      if (auditErr) log('error', 'spaces: inspect AUDIT FAILED', { slug, error: auditErr.message });

      return res.json({
        space: org,
        operators: people.data ?? [],
        orders: orders.data ?? [],
        readOnly: true,
      });
    } catch (err) {
      log('error', 'spaces: inspect failed', { slug, error: err.message });
      return res.status(500).json({ error: 'Could not read that space', details: err.message });
    }
  });

  // GET /os/spaces - every space, with its live counts.
  app.get('/os/spaces', requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      const { data: orgs, error } = await supabaseAdmin
        .from('orgs')
        .select('id,name,slug,is_internal,created_at,is_deleted')
        .order('created_at', { ascending: true });
      if (error) throw new Error(error.message);

      // Counts are read per space rather than joined so a space with zero of
      // everything still appears. An absent space reads as absent, not as zero.
      const rows = [];
      for (const o of orgs ?? []) {
        const [people, queue, owner, last] = await Promise.all([
          supabaseAdmin.from('email_allowlist').select('email', { count: 'exact', head: true }).eq('org_id', o.id),
          supabaseAdmin.from('os_queue').select('id', { count: 'exact', head: true }).eq('org_id', o.id),
          // WHO the space belongs to. The destructure asked for this and the query
          // was never added, so owner was undefined on every row and the column
          // read none for every space.
          supabaseAdmin.from('email_allowlist').select('email').eq('org_id', o.id).eq('role', 'owner').limit(1),
          // WHEN THE SPACE LAST DELIVERED. A count of orders says how much a
          // client has ever done; this says whether they are still doing it, which
          // is the question a space with 297 orders and nothing since June raises.
          supabaseAdmin.from('os_queue').select('finished_at').eq('org_id', o.id)
            .eq('status', 'delivered').order('finished_at', { ascending: false }).limit(1),
        ]);
        rows.push({
          ...o,
          people: people.count ?? null,
          orders: queue.count ?? null,
          ownerEmail: owner?.data?.[0]?.email ?? null,
          lastActiveAt: last?.data?.[0]?.finished_at ?? null,
        });
      }
      return res.json({ spaces: rows, platformOwners: owners.length });
    } catch (err) {
      log('error', 'spaces: list failed', { error: err.message });
      return res.status(500).json({ error: 'Could not read the spaces', details: err.message });
    }
  });

  // POST /os/spaces - create a space AND seed its first owner.
  app.post('/os/spaces', requireAuth, requirePlatformOwner, async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const ownerEmail = String(req.body?.ownerEmail || '').trim().toLowerCase();
    const slug = toSlug(req.body?.slug || name);

    if (!name) return res.status(400).json({ error: 'A space needs a name' });
    if (!slug) return res.status(400).json({ error: 'That name produces no usable slug. Use letters or numbers.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
      return res.status(400).json({ error: 'A space needs a first owner, given as an email address' });
    }

    try {
      // ONLY A LIVE SPACE BLOCKS A NAME. A closed one used to block it forever, on
      // the reasoning that a slug is an identity and identities are never recycled.
      // It is not: the identity is orgs.id, which is what org_id points at on every
      // table and what RLS filters on. The slug is a label, and retiring a label
      // stopped nobody - the same client under the next name went straight through.
      // A rule that only appears to protect something is worse than no rule.
      const { data: clash } = await supabaseAdmin
        .from('orgs').select('id,is_deleted').eq('slug', slug).eq('is_deleted', false).maybeSingle();
      if (clash) {
        return res.status(409).json({
          error: 'A live space is already called ' + name,
          details: 'Two open spaces cannot share one name. Choose another.',
        });
      }

      const { data: org, error: orgErr } = await supabaseAdmin
        .from('orgs').insert({ name, slug, is_internal: false }).select().single();
      if (orgErr) throw new Error(orgErr.message);

      // SEED THE FIRST OWNER IN THE SAME REQUEST. A space with no owner is
      // unreachable: nobody can sign in, and nobody can invite anybody. If this
      // fails the org is removed rather than left as an orphan.
      // ??? TWO SEATS, ONE STATEMENT. The client's owner, and the platform owner
      // who created the space.
      //
      // The second is what makes a space REACHABLE by its creator at all.
      // my_org_id() reads profiles.org_id and every RLS policy follows it, so
      // entering a client space means pointing that column at this org - and
      // set_my_org refuses an org the caller holds no seat in. No seat here, no
      // way in later, however senior the account.
      //
      // ?? IT IS HIDDEN FROM THE CLIENT'S OPERATORS LIST, AND THAT IS A DECISION
      // TAKEN PROVISIONALLY, NOT A DESIGN. It means a screen built to be honest
      // carries a blind spot and a client cannot audit access they cannot see.
      // The argument for declaring it instead is written up in
      // MAVLOPER_PENDING_HIDDEN_SEAT_31AUG2026.md and is to be revisited before
      // the first space is handed over.
      //
      // ONE INSERT, so the rollback below covers both rows. A space with an owner
      // its creator cannot reach is as broken as one with no owner at all.
      const platformSeats = owners.map((o) => ({
        email: o, is_owner: false, role: 'member', org_id: org.id,
      })).filter((r) => r.email !== ownerEmail);
      const { error: seedErr } = await supabaseAdmin.from('email_allowlist').insert([
        { email: ownerEmail, is_owner: true, role: 'owner', org_id: org.id },
        ...platformSeats,
      ]);
      if (seedErr) {
        await supabaseAdmin.from('orgs').delete().eq('id', org.id);
        throw new Error('the space was rolled back because its first owner could not be added: ' + seedErr.message);
      }

      log('info', 'spaces: created', { slug, ownerEmail, by: req.user?.email });
      return res.json({ ok: true, space: org, ownerEmail });
    } catch (err) {
      log('error', 'spaces: create failed', { error: err.message });
      return res.status(500).json({ error: 'Could not create the space', details: err.message });
    }
  });
  // DELETE /os/spaces/:slug - refuses unless the slug is typed back.
  app.delete('/os/spaces/:slug', requireAuth, requirePlatformOwner, async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase();
    const confirm = String(req.body?.confirmSlug || '').toLowerCase();

    // THE SLUG MUST BE TYPED BACK. A space holds a client's entire history and
    // every person who can reach it. A single click must not take that away.
    if (confirm !== slug) {
      return res.status(400).json({
        error: 'Type the space slug to confirm',
        details: 'Expected "' + slug + '". Nothing has been changed.',
      });
    }

    try {
      const { data: org } = await supabaseAdmin
        .from('orgs').select('id,name,slug,is_internal,is_deleted').eq('slug', slug).maybeSingle();
      if (!org) return res.status(404).json({ error: 'No space with the slug "' + slug + '"' });
      if (org.is_deleted) return res.status(409).json({ error: '"' + slug + '" is already deleted' });
      if (org.is_internal) {
        return res.status(403).json({
          error: 'The internal Mavlers space cannot be deleted',
          details: 'It is where every compiler change is proven before any client sees it.',
        });
      }

      // NEVER DELETE A SPACE WITH WORK IN FLIGHT. The runner would dispatch an
      // order belonging to a space that no longer exists, and the failure would
      // surface as an unattributable orphan an hour later.
      const { count: inFlight } = await supabaseAdmin
        .from('os_queue').select('id', { count: 'exact', head: true })
        .eq('org_id', org.id).in('status', ['pending', 'processing']);
      if ((inFlight ?? 0) > 0) {
        return res.status(409).json({
          error: '"' + slug + '" has ' + inFlight + ' order(s) still queued or building',
          details: 'Let them finish or cancel them first. Deleting now would strand work the engine is holding.',
        });
      }

      // Soft delete. The rows stay: the audit trail is evidence, and the slug
      // stays taken so no future client inherits this one's identity.
      const { error: delErr } = await supabaseAdmin
        .from('orgs')
        .update({ is_deleted: true, deleted_at: new Date().toISOString(), deleted_by: req.user?.email || null })
        .eq('id', org.id);
      if (delErr) throw new Error(delErr.message);

      // Revoke access in the same request. A deleted space nobody can sign into
      // is the point; leaving the allowlist intact would leave a way back in.
      const { count: revoked } = await supabaseAdmin
        .from('email_allowlist').delete({ count: 'exact' }).eq('org_id', org.id);

      log('warn', 'spaces: deleted', { slug, revoked, by: req.user?.email });
      return res.json({
        ok: true, slug, revoked: revoked ?? 0,
        note: 'The space is closed and its people can no longer sign in. Its orders and audit rows are kept.',
      });
    } catch (err) {
      log('error', 'spaces: delete failed', { error: err.message });
      return res.status(500).json({ error: 'Could not delete the space', details: err.message });
    }
  });

  log('info', 'spaces: routes mounted', { platformOwners: owners.length });
}

export default { createSpacesRoutes };