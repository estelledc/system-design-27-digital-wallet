# ADR 0001: use one PostgreSQL authority before distributed transfer protocols

- Status: accepted for v0.1
- Date: 2026-08-19

## Context

The fixed secondary chapter targets a hypothetical one million transfers per second and evolves toward sharded Raft groups plus
TCC/Saga coordination. None of those scale numbers is benchmark-bound, and a correct distributed wallet would require durable phase
identity, retry, fencing, compensation, recovery, membership, and failure-model evidence far beyond one practice slice.

The smallest unproved question is earlier: can one authority atomically bind intent, lock both wallets, preserve supply, append a
balanced journal, materialize balances, survive response loss, and publish stable read evidence?

## Decision

Use PostgreSQL 17 as the sole authority. Both wallet rows, the revision allocator, journal, balance versions, request receipt, and
transfer result commit in one transaction. Acquire wallet locks in lexical ID order. Use a locked singleton revision row instead of a
sequence. Use Repeatable Read for statement/audit publications and typed whole-transaction retry only for database concurrency errors.

## Consequences

Positive:

- the central conservation invariant is executable against a real database;
- response-loss recovery has one durable lookup point;
- journal and projection atomicity can be tested without mocks;
- freeze, reversal, statement, and audit semantics stay inspectable.

Negative:

- the authority row and hot wallets serialize work;
- no sharded throughput, availability, failover, or regional claim is possible;
- the design cannot demonstrate TCC, Saga, Raft, or cross-authority compensation;
- PostgreSQL/database-administrator trust remains inside the boundary.

## Rejected alternatives

- **Redis balances:** fast lookup is not an atomic durable journal authority for this proof.
- **PostgreSQL sequence as revision:** allocation order can contain gaps and is not commit order.
- **Two independent database shards with mock TCC/Saga:** adds protocol states without a credible failure/recovery environment.
- **Custom mmap/RocksDB/Raft log:** recreates storage and consensus before proving the domain invariant and would need substantially
  stronger crash, corruption, membership, and power-loss evidence.
- **TigerBeetle dependency:** its current transfer model is useful primary product evidence, but adopting it would test that product's
  semantics rather than make the PostgreSQL transaction and statement/audit invariants explicit.

## Revisit trigger

Revisit only after the single-authority slice is green and a new requirement supplies at least two independently placed wallet
authorities plus an executable crash/recovery environment. A throughput target without a measured workload is not sufficient.
