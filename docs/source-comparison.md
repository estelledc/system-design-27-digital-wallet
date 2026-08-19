# Source comparison

## Evidence identity

The secondary chapter is fixed to upstream commit `9d8388721e7231442763ad37398b8d82224aa68f`, path
`27.  Digital Wallet/README.md`, Git blob `f6209d737d3eb76b385f07985ea63939aab3c9a4`, and raw SHA-256
`f9b2d781d62959f157b33caa933153b79d7be8d2b83c768288e852c96e68da62`. The direct-fetch receipt is
`tf_f9b2d781d62959f1_20260819T041633Z`; bundle verification passed.

The upstream tree has no detected license file. This repository therefore uses only abstract problem prompts and independently
written analysis. It does not copy upstream prose, diagrams, code, fixtures, or benchmark numbers.

## What the chapter contributes

The chapter is useful as a map of the problem space:

- wallet-to-wallet transfer is a stronger state problem than a generic CRUD endpoint;
- a cross-shard debit and credit require an explicit coordination protocol;
- an immutable history can support reconstruction and audit questions;
- derived read state and authoritative history should not be confused;
- a single replicated log eventually becomes a capacity boundary and partitioning changes the transaction model.

These are prompts for design work, not executable proof.

## Corrections and deliberate changes

| Chapter claim or omission | Evidence-bounded reading | v0.1 decision |
|---|---|---|
| Assumes one million transfers per second and about one thousand relational transactions per second per node | Neither number is tied to hardware, schema, durability, contention, query mix, or a benchmark. Two journal entries also do not mechanically mean two independent database transactions. | Treat all scale numbers as hypothetical. Publish only the exact bounded fixture and wall-clock observations. |
| Uses a string amount to avoid precision loss | A string prevents one transport parsing failure but does not define asset, scale, rounding, range, sign, overflow, or cross-asset rules. | Accept a positive bounded integer in synthetic minor units of one asset, `LAB`; reject decimals and floats. |
| Uses `transaction_id` as an idempotency key | RFC 9110 does not make POST idempotent. Safe retry needs application semantics that bind a stable identity to immutable intent and a stored result. TigerBeetle's current transfer API also distinguishes exact reuse from same-ID/different-field conflicts; that is vendor evidence, not a universal standard. | Bind operation + request key to a canonical intent digest and terminal result. Exact retry replays; changed intent conflicts. |
| Begins with Redis balances, then adds cross-shard 2PC, TC/C, or Saga | This mixes several authority models. Compensation is a new business action, not rollback of an already observed external fact. Stuck/out-of-order/retried phases need durable identities and state. | Keep both wallets inside one PostgreSQL transaction. Distributed transfer protocols remain an explicit non-goal rather than an untested diagram. |
| Requires a global FIFO order for commands and events | Correctness needs a deterministic authority order for conflicting wallet mutations; an application-wide queue can create unnecessary serialization and still does not define retry or account fencing. | Canonically lock the two wallet rows and allocate one database authority revision. No claim of global multi-region order. |
| Says immutable events guarantee replay of intermediate states | Replay also depends on retained event schemas, deterministic code/version rules, recorded external inputs, and suppression or deduplication of external writes. Fowler explicitly calls out code changes, external queries, and external updates as complications. | The lab has no external side effects. Audit replays a deliberately small, versioned journal model and reports mismatches; it does not claim arbitrary future-code equivalence. |
| Moves logs to local disk and presents `mmap` as disk plus cache | A memory mapping is an access mechanism, not a commit, flush, power-loss, replication, or recovery contract. | PostgreSQL 17 owns commit acknowledgment. Filesystem and power-loss guarantees remain unproved. |
| Says only the event list needs high reliability | Code/schema versions, identity bindings, configuration, account genesis, and snapshot provenance can also determine replay meaning. | Store genesis contract, wallet state history, transfer intent, journal, balance versions, statements, and audit receipts in the same authority. |
| Presents Raft as no-data-loss replication that runs whenever a majority is up | Consensus guarantees are conditional on the algorithm, membership, persistence, network, implementation, and committed-index semantics. A majority being alive is not itself proof of service availability. | No Raft implementation or availability percentage. PostgreSQL HA, failover, backup/restore, RPO, and RTO remain unproved. |
| Treats recalculation as proof that balances are correct | Internal replay can show agreement with the retained journal. It cannot prove genesis represented funds, account ownership, legal finality, external settlement, or accounting approval. | Audit receipts say `internal_consistency` and enumerate mismatches. Every external-outcome field remains false. |
| Does not define reversals or stable statements | Editing history destroys the evidence needed for reconstruction; live offset pagination can drift as transfers append. | A successful reversal is a new full compensating transfer. Statements materialize one revision-bound immutable item list and cursor lineage. |

## Primary-source anchors

| Source | Narrow fact used | Direct-fetch receipt |
|---|---|---|
| [PostgreSQL 17 explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html) | Row locks block conflicting writers/lockers; consistent acquisition order is the main deadlock defense. | `tf_dc13a9df72216e8b_20260819T041746Z` |
| [PostgreSQL 17 transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html) | Repeatable Read gives a stable database view; Serializable failures require whole-transaction retry. | `tf_70cf332f46ff2d05_20260819T041746Z` |
| [PostgreSQL 17 constraint triggers](https://www.postgresql.org/docs/17/sql-createtrigger.html) | A constraint trigger may be deferred until transaction end and raise on an invariant violation. | `tf_f92bf506d2262212_20260819T041748Z` |
| [TigerBeetle financial accounting](https://docs.tigerbeetle.com/coding/financial-accounting/) | Debit/credit meaning depends on account type; balanced entries account for both sides. This does not make the lab a complete accounting system. | `tf_75405748193df829_20260819T041747Z` |
| [TigerBeetle create transfers](https://docs.tigerbeetle.com/reference/requests/create_transfers/) | A current production ledger API demonstrates exact-ID replay, changed-field conflicts, account limits, and pending/post/void distinctions. Its semantics are not copied as a standard. | `tf_b4f36fb04969100f_20260819T041746Z` |
| [Martin Fowler, Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) | External reads/writes and code changes complicate replay; event history alone is not a blanket guarantee. | `tf_8c266ad1f81881de_20260819T041746Z` |
| [RFC 9110](https://datatracker.ietf.org/doc/html/rfc9110) | POST is not idempotent by method semantics; automatic retry needs known idempotent application behavior or proof the first request was not applied. | `tf_e2c84373d2069287_20260819T041746Z` |

All receipts are unsigned local acquisition diagnostics with an untrusted clock. Successful fetch and bundle verification prove the
bytes acquired for this design review, not that every source claim is universally applicable or that this implementation is correct.

## Closed-book delta

The source review confirms the closed-book focus on transfer atomicity, immutable history, reconstruction, and explicit reversal.
It changes three details:

1. “Double entry” is narrowed to a balanced two-sided journal invariant; the repository must not claim a complete chart of accounts.
2. Authority revision comes from a locked PostgreSQL row, not a sequence, because sequence allocation does not establish commit order.
3. Replay evidence includes versioned genesis, wallet events, balance versions, and canonical digests; an event list alone is not enough.
