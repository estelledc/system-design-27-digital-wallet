# Requirements

## Goal

Build one bounded executable proof that a synthetic `LAB` transfer can atomically debit one wallet, credit another, preserve a fixed
genesis supply, survive duplicate requests and response loss, and later produce stable statement and audit receipts.

## Functional requirements

1. Bootstrap exactly one treasury wallet with a fixed positive integer `LAB` supply.
2. Create zero-balance user wallets through a stable request identity.
3. Freeze, reactivate, and close a wallet with expected-state and generation checks. Close requires frozen state, zero balance, and no
   unposted transfer involving the wallet.
4. Prepare an immutable transfer without changing balances.
5. Post a prepared transfer only while both wallets are active at the generations named by the intent and the source has sufficient
   balance.
6. Commit transfer state, one authority revision, one two-entry balanced journal transaction, both materialized balances, both
   balance versions, and the stored response atomically.
7. Replay an exact request result and reject same-key changed intent.
8. Reverse a posted ordinary transfer by appending one full compensating transfer. Never edit the original. At most one reversal may
   post; insufficient current recipient balance is a stable rejection for that request.
9. Publish a statement for one wallet at one authority revision, with a total entry order, count, opening/closing balance, and digest.
10. Serve pages only from that immutable publication and bind cursors to its identity and digest.
11. Run a revision-bound audit that recomputes journal balances, compares stored balance versions, checks current materialized state
    when applicable, and checks total synthetic supply.
12. Expose bounded evidence and state summaries without claiming user receipt or external outcome.

## Correctness requirements

- amounts are integers in `[1, 1_000_000]`; fixed supply is at most `10_000_000 LAB`;
- a wallet cannot transfer to itself, go below zero, or transact across assets;
- every posted transaction has exactly two entries with equal magnitude and zero signed sum;
- wallet locks are acquired by lexical wallet ID, not debit/credit direction;
- authority revisions are unique and monotone under one locked database row;
- wallet state generation changes fence older prepared transfers;
- journal, wallet event, balance version, statement item, and audit evidence rows are append-only through the service contract;
- canonical JSON digests do not depend on object insertion order, process time, locale, or random iteration;
- ordinary telemetry contains only low-cardinality operation/status/count/duration fields.

## Bounded runtime envelope

The implementation rejects a fixture beyond 64 wallets, 512 transfers, 1,024 journal entries, 64 statements, 256 page receipts, or
32 audits per database. These are test limits, not product capacity. The benchmark must print exact counts, runtime/database versions,
whole-batch durations, and exclusions. It must not derive money throughput, SLA, availability, or durability.

## Acceptance evidence

### Pure tests

- canonical digest and changed-intent detection;
- state transition and amount validation;
- total statement ordering/cursor binding;
- fixed-supply and balanced-entry property generation;
- evidence-language and value-data scans.

### Real PostgreSQL tests

- exact replay and changed-intent conflict;
- two concurrent outgoing transfers racing for final units;
- opposite-direction transfer lock symmetry;
- freeze/post race and stale generation rejection;
- deferred journal-balance failure with no partial effect;
- response-loss recovery for wallet, state, prepare, post, reversal, statement, and audit;
- reversal uniqueness and spent-recipient rejection;
- statement pages unchanged after later transfers;
- audit mismatch after controlled materialized/balance-version tampering;
- service restart with the same authority state.

### Public execution

- Linux CI on current Node 22, 24, and 26 lines against pinned PostgreSQL 17;
- zero skipped infrastructure tests and zero failed/todo tests;
- a high/critical production dependency audit;
- exact implementation commit and final-document commit CI receipts.

## Explicit non-requirements

The lab does not implement real customers or funds, account ownership, cash-in/out, payment rails, custody, safeguarding, complete
accounting, FX, fees, tax, credit, disputes, KYC/AML, sanctions, fraud, privacy workflows, authentication, public deployment,
PostgreSQL HA, power-loss testing, backup/restore, multi-region consensus, sharding, TCC/Saga, notifications, recipient read receipts,
or any external acceptance.
