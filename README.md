# Digital Wallet Lab

This clean-room system-design practice starts with one question: when two wallet balances and an immutable transfer journal must
change together, what authority and receipts prevent retries, races, freezes, or reversals from creating or destroying value?

The prompt title is “Digital Wallet.” This repository does not copy a source chapter, provider, wallet product, API, diagram,
benchmark, account model, or proprietary system. The initial contract is frozen from the title alone before reading the fixed
secondary chapter.

## Current status

The implementation now exercises one PostgreSQL 17 authority, stable request/transfer identity, canonical two-wallet locking,
balanced immutable journal entries, append-only full reversal, revision-bound statements, and consistency audits. Local gates pass,
and [implementation CI run 32216945261](https://github.com/estelledc/system-design-27-digital-wallet/actions/runs/32216945261)
reproduced the full gate on Node 22, 24, and 26.

## Runnable slice

```text
stable request
    -> immutable transfer intent (no value effect)
    -> source + destination locked by wallet ID
    -> one authority revision
    -> source debit + destination credit
    -> two materialized balances + two balance versions
    -> stored result for response-loss replay
```

- Genesis creates one explicit treasury with a fixed `10,000,000 LAB` supply; user wallets start at zero.
- Wallet freeze/reactivation increments generation and permanently fences an older prepared transfer.
- Reversal adds a new full compensating transfer. It never edits the original and can fail after the recipient spends the units.
- A statement copies one total-ordered authority cut; later transfers cannot drift its pages.
- An audit recomputes balances from genesis plus journal entries and reports projection/supply mismatch without auto-repair.

## Local evidence

Against Node `v26.7.0` and PostgreSQL `17.11 (Homebrew)`:

- 15 pure tests and 10 real PostgreSQL integration groups: 0 failed, skipped, or todo;
- 7 independent child processes killed with `SIGKILL` after commit and before response;
- smoke: 3 wallets, 3 posted transfers, 3 journal transactions / 6 entries, 1 two-page statement, 1 passing audit;
- bounded benchmark: 32 wallets, 101 posted transfers including 8 reversals, 202 entries, 16 statements/pages, 4 audits, and
  16 evidence reads;
- production dependency audit: 0 high/critical findings.

See [verification](docs/verification.md) for commands, timings, and exclusions.

Public implementation jobs:

Implementation commit: [`39ed82b9d8d800cacc456ca1f5a39120f512fafa`](https://github.com/estelledc/system-design-27-digital-wallet/commit/39ed82b9d8d800cacc456ca1f5a39120f512fafa).

- [Node 22 + PostgreSQL 17](https://github.com/estelledc/system-design-27-digital-wallet/actions/runs/32216945261/job/95960132355)
- [Node 24 + PostgreSQL 17](https://github.com/estelledc/system-design-27-digital-wallet/actions/runs/32216945261/job/95960132229)
- [Node 26 + PostgreSQL 17](https://github.com/estelledc/system-design-27-digital-wallet/actions/runs/32216945261/job/95960132218)

## Run locally

```bash
npm ci --ignore-scripts
npm run check
DATABASE_URL=postgres://... npm run check:ci
```

`check:ci` requires a disposable PostgreSQL 17 database and resets the lab schema. It must never point at a shared or production
database.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Source comparison](docs/source-comparison.md)
- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [API contract](docs/api.md)
- [Operations](docs/operations.md)
- [Threat model](docs/threat-model.md)
- [ADR 0001: one PostgreSQL authority](docs/adr/0001-single-postgresql-authority.md)
- [Security policy](SECURITY.md)

## Evidence boundary

Request received, transfer intent committed, journal transaction posted, materialized balances updated, statement snapshot served,
reversal posted, real funds moved, recipient consumed value, accounting approved, and external acceptance are different facts. The
executable phase must name and test only the boundaries it reaches.

## License

MIT. Third-party study material and real wallet, account, customer, transfer, credential, endpoint, or internal data are not
included.
