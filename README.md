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
