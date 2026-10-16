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
