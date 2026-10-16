#!/usr/bin/env bash
# order-control.db.sh - THE LOCAL DATABASE FOR order-control.test.mjs (run 17).
#
# The database is the console repository's access grid, loaded exactly as the
# grid loads it (supabase/tests/access-grid/run-grid.sh --load-only), served by
# a local PostgREST. Never production: everything is a Docker container on this
# machine, the passwords and the JWT secret are generated here and never printed.
#
#   bash order-control.db.sh start   # PostgreSQL + template + PostgREST
#   bash order-control.db.sh reset   # a fresh copy of the template (between scenarios)
#   bash order-control.db.sh stop    # removes the two containers
#
# Containers: $OC_PG (default mav-run17-pg, port $OC_PG_PORT 55450) and
# $OC_REST (default mav-run17-rest, port $OC_REST_PORT 55451). The console repo
# is $OC_CONSOLE (default C:/maveloper-os-current). OC_EXCLUDE=<migration file>
# builds the template without that migration (the database before it). The secret the test needs is
# written to $OC_SECRET_FILE (default $TMPDIR/order-control.secret, outside
# the repository), mode 600, so the test can sign dummy JWTs for local users only.
set -u
PG="${OC_PG:-mav-run17-pg}"
PG_PORT="${OC_PG_PORT:-55450}"
REST="${OC_REST:-mav-run17-rest}"
REST_PORT="${OC_REST_PORT:-55451}"
CONSOLE="${OC_CONSOLE:-C:/maveloper-os-current}"
TPL="${OC_TEMPLATE:-grid_oc_tpl}"
DB="${OC_DB:-oc_cur}"
SECRET_FILE="${OC_SECRET_FILE:-${TMPDIR:-/tmp}/order-control.secret}"
PSQL="docker exec -i $PG psql -U postgres -X -q -v ON_ERROR_STOP=1"

rand() { node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }

start_rest() {
  local secret pw
  secret="$(cat "$SECRET_FILE")"
  pw="$(rand)"
  $PSQL -v pw="$pw" <<'SQL' || exit 2
select 'create role authenticator login noinherit' where not exists (select 1 from pg_roles where rolname = 'authenticator') \gexec
alter role authenticator password :'pw';
grant anon, authenticated, service_role to authenticator;
SQL
  docker rm -f "$REST" >/dev/null 2>&1
  PGRST_DB_URI="postgres://authenticator:${pw}@host.docker.internal:${PG_PORT}/${DB}" \
  PGRST_JWT_SECRET="$secret" \
  docker run -d --name "$REST" -p "$REST_PORT:3000" \
    -e PGRST_DB_URI -e PGRST_JWT_SECRET \
    -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon \
    postgrest/postgrest:v12.2.3 >/dev/null || exit 2
  for i in $(seq 1 40); do
    curl -sf -o /dev/null "http://127.0.0.1:${REST_PORT}/" && break
    sleep 0.5
  done
}

fresh_db() {
  docker exec "$PG" psql -U postgres -q \
    -c "drop database if exists $DB with (force)" \
    -c "create database $DB template $TPL" >/dev/null || exit 2
}

case "${1:-}" in
  start)
    docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 || {
      echo "container $PG is not running postgres:15 on $PG_PORT (start it first, see the test header)"; exit 2; }
    [ -s "$SECRET_FILE" ] || { umask 077; rand > "$SECRET_FILE"; }
    GRID_CONTAINER="$PG" bash "$CONSOLE/supabase/tests/access-grid/run-grid.sh" --load-only --label oc_tpl ${OC_EXCLUDE:+--exclude "$OC_EXCLUDE"} >/dev/null || {
      echo "grid load failed"; exit 2; }
    fresh_db
    start_rest
    echo "ready: postgres $PG:$PG_PORT db $DB, postgrest $REST:$REST_PORT"
    ;;
  reset)
    fresh_db
    start_rest
    echo "reset: $DB from $TPL"
    ;;
  stop)
    docker rm -f "$REST" >/dev/null 2>&1
    echo "removed $REST (the postgres container $PG is left to its owner)"
    ;;
  *) echo "usage: order-control.db.sh start|reset|stop"; exit 2 ;;
esac
