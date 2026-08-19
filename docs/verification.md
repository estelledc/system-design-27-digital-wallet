# Verification

## Current status

The full local gate passes. Public GitHub CI is pending, so the result is local implementation evidence rather than public
reproducibility evidence.

| Boundary | Required receipt | Current state |
|---|---|---|
| pure contracts and properties | exact test count, zero failed/skipped/todo | 15 passed; 0 failed/skipped/todo |
| real PostgreSQL authority | exact integration group count and database version | 10 groups passed on PostgreSQL 17.11; 0 failed/skipped/todo |
| commit-before-response recovery | true child-process `SIGKILL` count | 7 processes observed exiting by `SIGKILL`; replay assertions passed |
| smoke | exact wallet/transfer/journal/statement/page/audit counts | 3 / 3 / 3+6 / 1 / 2 / 1; audit passed |
| benchmark | exact fixture, runtime/database versions, whole-batch timings, exclusions | completed; receipt below |
| dependency risk | high/critical production audit result | `npm audit --audit-level=high`: 0 findings |
| public reproducibility | implementation commit and Node 22/24/26 job/run IDs | pending |

## Local commands

```bash
npm ci --ignore-scripts
npm run check
DATABASE_URL=postgres://127.0.0.1:55427/digital_wallet npm run test:infra
DATABASE_URL=postgres://127.0.0.1:55427/digital_wallet npm run test:crash
DATABASE_URL=postgres://127.0.0.1:55427/digital_wallet npm run smoke:infra
DATABASE_URL=postgres://127.0.0.1:55427/digital_wallet npm run benchmark:infra
```

The first container command could not run because Docker is absent on this machine; no business test had started. The replacement
used an isolated local PostgreSQL 17.11 cluster under ignored runtime storage. Public CI remains responsible for reproducing the same
gate with the pinned PostgreSQL image.

## What the database tests establish

1. exact wallet/request replay and changed-intent conflict;
2. preparation without value effect and one posted balanced effect;
3. two concurrent final-unit spends allow only the affordable subset;
4. opposite-direction transfers share one canonical lock order;
5. freeze/post race has one authority order and a fenced stale intent;
6. a one-legged journal fails at deferred commit and rolls back its allocated revision;
7. reversal remains append-only, can fail after spend, and posts at most once;
8. statement pages remain on one revision after later transfers;
9. audit detects controlled materialized-balance tamper and a fresh process reads the same authority;
10. the real HTTP adapter returns internal facts with external outcomes false.

The crash process separately covers wallet create, wallet state, transfer prepare, transfer post, reversal post, statement publish,
and audit commit after the database acknowledged but before a response could be returned.

## Local smoke receipt

```json
{"walletCount":3,"transferCount":3,"journalTransactionCount":3,"journalEntryCount":6,"statementEntryCount":2,"statementPageCount":2,"auditInternalConsistency":true,"realFundsMoved":false,"accountingApproved":false,"externalAcceptance":false}
```

## Bounded benchmark receipt

Runtime: Node `v26.7.0`, PostgreSQL `17.11 (Homebrew)`.

| Whole batch | Fixture | Observed ms |
|---|---:|---:|
| create user wallets | 31 | 104.392 |
| fund wallets | 31 prepare + post pairs | 240.365 |
| ring transfers | 62 prepare + post pairs | 433.852 |
| reversals | 8 | 46.937 |
| statements and first pages | 16 + 16 | 109.142 |
| audits | 4 | 21.217 |
| wallet evidence reads | 16 | 49.569 |

Final state: 32 wallets including treasury, 101 posted transfers, 101 journal transactions / 202 entries, 16 statements,
16 page receipts, 4 audits, zero prepared transfers, zero unbalanced transactions, and materialized total equal to genesis supply.

These are sequential whole-batch observations on one laptop and one local database. They are not QPS, money throughput, latency
percentiles, comparative runtime results, production capacity, durability, availability, or SLA.

## Public CI receipt

Pending creation of the public repository and the implementation commit run. A local green command is not substituted for this row.

No future green result may be described as real funds, ownership, accounting approval, compliance, high availability, power-loss
durability, production capacity, SLA, recipient consumption, or external acceptance.
