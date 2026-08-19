# Closed-book contract: conserved internal transfers with immutable statements

## Reading boundary

This contract was written from the case title alone, before reading the fixed `system-design-notes` chapter. “Digital Wallet” names
a problem family, not an asset, custody model, account hierarchy, cash-in/out rail, transfer state machine, fee policy, compliance
regime, scale, or availability target. Wallets, a synthetic treasury, prepared transfers, immutable journals, materialized balances,
reversals, statement publications, and audits are hypotheses for this lab—not facts about any real wallet. Later research must
record confirmations, conflicts, omissions, and changes instead of silently rewriting this baseline.

## Users and core behavior

### Synthetic wallet operator

1. The bounded lab starts one explicit genesis treasury with a fixed positive `LAB` supply. User wallets begin at zero; value enters
   them only through the same transfer path used by every other wallet.
2. A stable create request binds wallet identity, kind, asset, and generation. Exact retry returns the original result; changed
   identity or kind conflicts.
3. A wallet is `active`, `frozen`, then `closed`, with a monotone generation. Closing requires zero balance and no prepared transfer.
4. Freeze/close is an authority state transition, not proof that a person, regulator, bank, or provider accepted the action.

### Synthetic transfer caller

1. The caller prepares one transfer with stable request/transfer/source/destination identity, positive integer amount, `LAB` asset,
   and expected source/destination generations.
2. Preparation stores immutable intent but changes no balance. Exact retry replays; changed accounts, amount, asset, or generation
   conflicts.
3. Posting locks both wallets in canonical wallet-ID order, rechecks active state/generation and sufficient source balance, allocates
   one authority revision, inserts one balanced journal transaction, updates both materialized balances/revisions, stores the
   result, and marks the transfer posted in one PostgreSQL transaction.
4. Losing the response after posting replays the same revision, journal identity, and balances. It cannot debit or credit twice.
5. Two concurrent transfers cannot spend the same final unit. A rejected transfer has no journal entry or partial balance effect.
6. Transfer posted means only internal synthetic ledger state changed. It does not mean real money moved, the recipient owns a real
   account, value is withdrawable, or anyone consumed/accepted it.

### Reversal caller

1. A reversal is a new stable transfer linked to one posted original; it never edits or deletes the original journal transaction.
2. v0.1 permits one full reversal only. Source/destination are swapped, amount/asset are inherited, and the current holder must still
   have sufficient balance. Spending after receipt can therefore make automatic reversal fail.
3. Concurrent reversal requests serialize and at most one posts. Exact retry returns the original reversal result.
4. Reversal posted is an internal compensating fact, not a real refund, chargeback, dispute outcome, or customer receipt.

### Statement reader and audit operator

1. A stable statement request selects one wallet and authority `asOfRevision`, then publishes an immutable ordered manifest of that
   wallet's entries through the selected revision.
2. Pages/cursors remain bound to that publication. Later transfers cannot appear between its pages or change opening/closing sums.
3. A statement digest covers wallet identity/generation, as-of revision, ordered entry identities, amounts/sides, count, and computed
   closing balance. A successful query does not prove a real user read or accepted it.
4. A bounded audit recomputes every wallet balance from genesis plus immutable journal entries at one authority revision and compares
   it with materialized balances and the fixed total supply.
5. Audit pass is internal consistency evidence only. It is not external reconciliation, financial audit, regulatory approval, or
   proof that the genesis supply represents money.

## Non-goals for v0.1

- real customers, accounts, wallets, balances, transfers, deposits, withdrawals, cards, banks, payment tokens, credentials,
  endpoints, notifications, statements, disputes, support cases, or operational data;
- cash-in/out, authorization/capture, PSP orchestration, response-loss ambiguity across an external processor, refunds, payout,
  settlement, clearing, chargebacks, interchange, fees, tax, FX, interest, lending, rewards, or marketplace splitting;
- account ownership/authentication, KYC/AML, sanctions, fraud/risk, device trust, limits by identity, age/geography, privacy rights,
  legal advice, financial reporting, audit certification, custody, safeguarding, or regulatory compliance;
- arbitrary assets/currencies, decimal/floating-point money, rounding, negative user balances, overdraft, credit, multi-asset
  transfer, exchange, token mint/burn, crypto keys/chains, or offline value;
- partial reversal, multiple reversal, transfer amendment/deletion, scheduled/recurring/batch transfer, escrow/hold, approval chains,
  beneficiary lists, messages, webhooks, or recipient acknowledgement;
- public ingress, TLS/PKI, multi-tenant authorization, encryption/KMS, secret management, quota/billing, deletion compliance, or
  regulated-data handling;
- unbounded wallets/transfers/entries/statements/pages/audits/receipts or retention;
- distributed transaction across shards, consensus, PostgreSQL HA, multi-region authority, clock synchronization, disaster recovery,
  backup/restore, production deployment, SLA, real-world value, user consumption, or external acceptance.

## Hypothetical scale envelope

These numbers select failure modes; they are not sourced requirements:

- 10 million internal transfers/day is about 116/s average and about 5,787/s at a 50× burst;
- two journal entries per transfer means at least 20 million entries/day before reversals, statements, indexes, and audit metadata;
- a 0.05% commit-response-loss rate would still create 5,000 replay decisions/day;
- one payroll, creator, treasury, or marketplace wallet can be a serialization hotspot even when global average traffic is low;
- offset statement pagination can scan/drift under concurrent appends unless the read is bound to one revision;
- retention must outlive every supported transfer/reversal retry and statement page horizon.

The runnable lab will use at most 64 wallets, 512 prepared transfers, 1,024 journal entries, 64 statement publications, 256 pages,
and 32 audits in one PostgreSQL database. Amounts are positive integers no greater than 1,000,000 `LAB`; fixed genesis supply is no
greater than 10,000,000 `LAB`. It will never extrapolate that fixture into real money, throughput, or latency.

## Candidate data and state model

```text
wallet_id -> kind + state + generation + materialized_balance + balance_revision
request_key + operation -> immutable intent_digest + original result
transfer_id -> source/destination + amount + asset + expected generations + state
authority_revision -> monotone committed journal order
journal_tx_id -> transfer/reversal link + immutable two-entry manifest
journal_entry_id -> wallet + revision + debit/credit + amount
original_transfer_id -> at most one reversal_transfer_id
statement_id -> wallet/generation + as_of_revision + entry_count + ordered_digest + closing_balance
statement_page_receipt -> statement_id + cursor/limit + immutable result digest
audit_id -> as_of_revision + supply/balance/entry digest + mismatch counts
```

Wallet and transfer IDs are bounded opaque synthetic identities, not secrets or authorization grants. Revision is database authority
order, not wall-clock or real settlement order.

## Core invariants

1. **Stable wallet intent.** One request/wallet identity binds kind, `LAB`, and initial generation. Exact retry replays; changed
   intent conflicts.
2. **Fixed synthetic supply.** Genesis creates one declared supply. Every later posted journal transaction sums to zero, so the sum
   of all materialized wallet balances remains exactly that supply.
3. **Integer single-asset arithmetic.** Amount/balance uses bounded integer minor units. No binary float, decimal parsing, implicit
   rounding, cross-asset addition, or real-currency claim exists.
4. **Transfer economics are immutable.** Source, destination, amount, asset, generations, transfer kind, and original link cannot be
   edited after preparation.
5. **Preparation has no value effect.** A prepared transfer is durable retry intent only; neither balance nor journal changes until
   the posting transaction commits.
6. **Canonical account locking.** Posting locks distinct source/destination wallets by wallet ID, independent of transfer direction,
   preventing opposite-direction deadlocks from becoming an implicit ordering rule.
7. **State/generation fences posting.** Both wallets must still be active at their expected generations while locked. Freeze/close
   racing with transfer has one authority winner.
8. **No overdraft.** Locked source materialized balance must cover the positive amount. Rejection commits no entry, destination
   credit, or partial projection change.
9. **One balanced journal effect.** A posted transfer has exactly two immutable entries in one asset: source debit and destination
   credit of the same amount; signed sum is zero.
10. **Journal and balances commit atomically.** Transfer state/result, authority revision, journal header/entries, both wallet
    balances/revisions, and audit link visibility commit together or none is called posted.
11. **Exactly one posting per transfer identity.** Unique transfer/journal/request bindings plus stored result make concurrent post,
    retry, and commit-before-response recovery converge on one revision/effect.
12. **Materialized balance is accountable.** Each wallet balance revision equals the latest applied entry revision. Bounded audit can
    recompute it from genesis and immutable entries; mismatch is typed and not auto-hidden.
13. **Reversal is append-only compensation.** One original can link at most one full reversal; the original never changes. Reversal
    rechecks current state, generation, and available balance like any other transfer.
14. **Response loss is replayable.** Wallet create/state, transfer prepare/post, reversal post, statement publish/page, and audit
    commit-before-response return stored results rather than repeat effects.
15. **Statements bind one authority cut.** Every entry/page/opening/closing balance belongs to one wallet/generation/as-of revision;
    later transfers do not drift an existing statement.
16. **Statement order is total.** Entries order by `(authority_revision, journal_entry_id)`; cursor identity names that cut and order,
    not a mutable offset into live rows.
17. **Statement readback is complete.** Count, ordered digest, and computed closing balance must match canonical publication metadata
    before pages are served.
18. **Audit is revision-bound.** Supply, recomputed wallet balances, materialized balances, entry count, and digest come from one
    consistent authority view; a later transfer is outside that audit rather than “missing.”
19. **Retention outlives retries/pages.** Requests, transfers, entries, reversals, statements, page receipts, and audits survive every
    supported horizon. Pruning returns explicit beyond-horizon status.
20. **Backpressure is visible.** Wallet/transfer/entry/statement/page/audit/body limits reject with typed receipts; timeout/drop is
    never called posted, reversed, published, balanced, or accepted.
21. **Ordinary telemetry is value-data bounded.** Logs/metrics omit wallet/account/request/transfer/journal/statement/page/audit IDs,
    balances, amounts, asset, digests, credentials, endpoints, and raw errors.
22. **Self-consistency is not outcome proof.** A conserved synthetic ledger does not prove real funds, ownership, withdrawability,
    recipient consumption, accounting approval, compliance, production behavior, or external acceptance.

## Initial API sketch

Wallet and transfer routes:

- `POST /v1/wallets` with stable request/wallet identity, kind, asset, and expected genesis contract;
- `POST /v1/wallets/{id}/freeze`, `/activate`, and `/close` with stable request and expected state/generation;
- `POST /v1/transfers` to prepare immutable source/destination/amount/generation intent;
- `POST /v1/transfers/{id}/post` to execute one canonical-lock-order authority transaction;
- `POST /v1/transfers/{id}/reverse` with stable request/reversal identity and current wallet generations;
- `GET /v1/operation-receipts/{id}` for response-loss recovery.

Read and operator routes:

- `POST /v1/statements` with stable statement identity, wallet/generation, and explicit/current as-of revision;
- `GET /v1/statements/{id}/pages?...` bound to immutable cursor/limit receipts;
- `POST /v1/audits` with stable request/audit identity and an explicit/current authority revision;
- `GET /v1/wallets/{id}/evidence` for balance, latest revision, transfers, entries, statements, and outcome boundary;
- `GET /v1/state` for low-cardinality wallet/transfer/entry/supply/statement/audit/invariant counts.

Exact schema, genesis procedure, lock query, revision allocator, state vocabulary, reversal policy, statement manifest/page format,
audit snapshot, retention, authentication, error vocabulary, and limits remain hypotheses until primary sources are reviewed.

## Failure matrix

| Failure window | Required result |
|---|---|
| caller loses response after wallet creation/state commit | exact request returns the one wallet/generation transition |
| same request/transfer arrives with changed accounts/amount | typed conflict; no new intent or value effect |
| process dies after transfer preparation | one prepared intent; balances/journal unchanged |
| two posts race for one transfer | one journal revision/effect; loser replays it |
| two outgoing transfers race for final source units | locked authority order posts at most the affordable subset |
| opposite-direction transfers race | canonical lock order; no direction-dependent deadlock contract |
| freeze races transfer post | one lock order winner; no post under stale wallet generation |
| transfer commits then response is lost | exact post returns original revision, entries, and balances |
| reversal races duplicate reversal | at most one linked compensating transfer |
| recipient spent value before reversal | typed insufficient balance; original remains posted and immutable |
| transfer commits between statement pages | existing statement remains bound to old as-of revision |
| audit runs while transfer commits | audit reflects one complete authority cut, never half a journal transaction |
| materialized balance is tampered/corrupt | audit reports mismatch; service does not call it conserved |

## Required executable evidence before v0.1 completion

1. A clean-room README, source comparison, requirements, architecture, API, operations, threat model, and at least one ADR.
2. Exact wallet/transfer/reversal/statement/page/audit validation, canonical digests, typed errors, and value-data scans.
3. Generated/property tests for fixed supply, balanced entries, no overdraft, lock-order symmetry, state transitions, reversal links,
   statement ordering/pages, retention, and audit decisions.
4. Real PostgreSQL tests for replay/conflict, concurrent final-unit/opposite transfers, freeze race, deferred journal balance,
   atomic balances, reversal, stable statements, tamper detection, and restart.
5. True-process crashes covering wallet create/state, transfer prepare/post, reversal post, statement publish, and audit commit.
6. A bounded benchmark with exact wallets/transfers/entries/statements/pages/audits, runtime/database versions, exclusions, and raw
   observations—without money, accounting, SLA, or production extrapolation.
7. Public multi-runtime CI with pinned actions/services, dependency audit, zero skipped infrastructure tests, and exact commit/run
   receipts.
8. Evidence scans that reject realistic wallet/account/customer/payment/credential data and money/compliance/external claims without
   matching receipt classes.

## Initial design choices to challenge after source review

- Is the case a stored-value wallet, a ledger service, P2P transfer product, cash-in/out orchestrator, or several systems?
- Which store is authoritative: mutable balance, immutable journal, provider account, or reconciliation result?
- How is initial supply introduced without hiding minting or a one-sided opening balance?
- Can one SQL transaction own both wallets, and what changes when accounts are sharded across authorities?
- What order locks opposite-direction transfers, and how are deadlock/serialization retries kept separate from duplicate effects?
- Does “double entry” mean balanced transaction entries, or is a complete accounting chart/timing policy also required?
- Are reversals append-only compensations, and what happens when the recipient already spent the credited value?
- Can statement pagination remain revision-stable while transfers append concurrently?
- Are internal conservation, real funds, ownership, settlement, user receipt, accounting approval, and external acceptance separated?
