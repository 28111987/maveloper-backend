# maveloper-backend

## Tests

Every `*.test.mjs` file runs on its own with `node <file>` and exits 0 when every case passes. Two need live credentials and skip without them (`approve-schema.test.mjs`, `drafts-roundtrip.test.mjs`).

**Order control (run 17)**: `order-control.test.mjs` boots the real `server.js` against the console repository's access-grid database (local Docker, never production), a fake engine and a fake Figma, and checks scenarios S1 to S7 (engine start-up, a dead engine, a late result, a restart, every order action for every role and state, two spaces, a Figma refusal):

```
docker run -d --name mav-run17-pg -e POSTGRES_PASSWORD=<any local value> -p 55450:5432 postgres:15
bash order-control.db.sh start
node order-control.test.mjs S1 S2 S3 S4 S5 S6 S7
bash order-control.db.sh stop ; docker rm -f mav-run17-pg
```

The old arm (the code before run 17): `OC_ARM=old OC_BACKEND_DIR=<a checkout of a3aeea0 with node_modules> node order-control.test.mjs ...`.

**The engine choice (run 18)**: on the same database (with the console's `20261103_0001_engine_choice.sql`) and fake engine, which now records every request body it receives: `node order-control.test.mjs E123 E4 E5` checks that a row's 'TOPAZ' or 'DIAMOND' reaches the engine as `payload.engine`, a row with no choice sends no field and a body byte for byte the reference arm's (`OC_E3_REF=<that arm's E3 body>`, `OC_BODIES=<dir>` to keep the bodies, secrets masked), the async route sends only the exact names, and a retried order keeps its own engine. `R1` runs against a template built with `OC_EXCLUDE=20261103_0001_engine_choice.sql` (the queue keeps running without the column). `node engine-release.test.mjs` checks that the order confirmation names the release that ran (E8).

**An order that meets an engine update (run 19)**: the fake engine also speaks the TOPAZ-3 engine's two drain signals (S-DRAIN: 503, `Retry-After`, `{"status":"draining",...,"engineDraining":true}`, nothing built; S-STOP: one callback with `engineStopped: true`) and builds one job per bridgeJobId. `node order-control.test.mjs X1 X2 X3 X4 X5 X6 X7 X7B X8 X9 X10` (split it in two, it runs about 9 minutes) checks that a drained dispatch is sent again with the same id and delivers, a stopped build is sent again with a new id (in process, or by the runner after a restart) and delivers once, both are bounded (`DRAIN_RESEND_MAX`, `STOP_REDISPATCH_MAX`) and fail in plain words, a person's stop is never undone, and any other 503, 500 or HTML answer keeps today's behaviour. `OC_CAPTURE=<dir>` makes S1, S3 and E123 write their log lines and rows for an old-against-new comparison. `node engine-update.test.mjs` checks the bounds, the signal readers and the words.

**Rotating the shared secret, and one stop handled once (run 20)**: the fake engine also handles the secret as the engine does during a rotation (it accepts `BRIDGE_SECRET` or `BRIDGE_SECRET_NEXT`; its callbacks carry `BRIDGE_SECRET` only) and can send copies of its stop callback. `node order-control.test.mjs ROT0 ROT1 ROT2 ROT3 ROT3X ROT4 ROT5 ROT6 ROTSKIP` walks the six rotation steps (two engine revisions at once in ROT2, ROT3X and ROT4, behind a splitter), the deliberate red of step 3 while a revision without `BRIDGE_SECRET_NEXT` still serves, and the skipped-step control; `A23` checks the callback's secret check and the boot words case by case; `A4` writes what the backend sends the engine and how it answers callbacks to `$OC_A4_DIR/<arm>.json` and compares it with `OC_A4_REF`; `B1` sends copies of one stop callback (together, overlapping with a held database write, a third after the first, and a late database read). `OC_DUMP=<dir>` keeps the server's lines of each ROT step. `node bridge-secret.test.mjs` checks `MAC_BRIDGE_SECRET_NEXT`, `MAC_BRIDGE_SECRET_SEND` and the constant-time check.
