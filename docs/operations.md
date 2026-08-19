# Operations

## Local lifecycle

The implementation will require Node.js 22+ and PostgreSQL 17.

```bash
npm ci
DATABASE_URL=postgres://... npm run migrate
DATABASE_URL=postgres://... npm run smoke
DATABASE_URL=postgres://... npm run benchmark
```

`npm run check` is the infrastructure-free gate. `npm run check:integration` additionally requires a disposable PostgreSQL database
and runs migration, real integration, true-process crash, smoke, and benchmark checks.

## Startup

1. refuse a missing or non-PostgreSQL `DATABASE_URL`;
2. apply the idempotent schema migration;
3. verify the singleton genesis contract (`LAB`, treasury identity, fixed supply, schema version);
4. open a bounded connection pool;
5. expose `/healthz` only after a database round trip.

A running process is not evidence that migration, genesis, or audit passed. Health reports connectivity and schema identity only.

## Retry policy

- application request retry reuses the same request/entity identity and expects stored replay;
- changed intent never receives a fresh hidden identity;
- deadlock or serialization retry, if observed, restarts the complete database transaction with a small bounded retry count;
- validation, insufficient balance, state conflict, and capacity rejection are not infrastructure retries;
- the service has no background infinite retry loop.

## Observability

Allowed ordinary fields: operation class, typed status, low-cardinality error code, duration bucket, pool counts, and aggregate object
counts. Forbidden fields: request, wallet, transfer, journal, statement, audit, cursor, or digest identities; amounts/balances; database
URLs; credentials; endpoints; SQL; raw errors; or request/response bodies.

Test and benchmark commands may print explicitly generated aggregate fixture counts and whole-batch durations. They must not print a
per-wallet or per-transfer trace.

## Integrity response

If an audit reports a mismatch:

1. stop calling the projection conserved;
2. retain the failed audit receipt and database snapshot if safely possible;
3. do not auto-repair or overwrite journal facts;
4. identify whether journal, balance version, materialized balance, genesis, or code version differs;
5. repair only through a separately reviewed migration or append-only compensating fact;
6. rerun a new audit identity and keep both receipts.

This is an experiment procedure, not a regulated incident-response or accounting policy.

## Unproved operational work

There is no load admission design beyond small lab caps, no online migration plan, backup/restore drill, WAL archive, point-in-time
recovery, failover, replica read policy, connection proxy, KMS, secret rotation, tenant isolation, alerting service, SLO, or on-call
runbook. Public CI proves only its disposable database and process boundaries.
