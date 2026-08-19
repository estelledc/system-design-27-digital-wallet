# Research log

## Frozen sequence

1. Closed-book contract written from the title only.
2. Closed-book commit: `b24c813d0f77cddb16f373db7b2d2effde3e265a`.
3. Fixed secondary chapter fetched and read completely.
4. Primary documentation fetched, locally verified, and used only for narrow corrections.
5. Source comparison and single-authority ADR commit: `910e8858010e294ebf4549be4784886328c841c3`.

The design commit hash above must be checked against Git before release; this log never substitutes a local abbreviated hash or an
unverified remote branch.

## Secondary source

- repository commit: `9d8388721e7231442763ad37398b8d82224aa68f`;
- path: `27.  Digital Wallet/README.md`;
- blob: `f6209d737d3eb76b385f07985ea63939aab3c9a4`;
- raw SHA-256: `f9b2d781d62959f157b33caa933153b79d7be8d2b83c768288e852c96e68da62`;
- receipt: `tf_f9b2d781d62959f1_20260819T041633Z`;
- verification: `valid=true`, `attested=false`, `trusted_clock=false`.

## Primary-source receipts

| Subject | Receipt | Verification boundary |
|---|---|---|
| PostgreSQL row locking and deadlock order | `tf_dc13a9df72216e8b_20260819T041746Z` | direct HTML fetch; valid bundle |
| PostgreSQL isolation and whole-transaction retry | `tf_70cf332f46ff2d05_20260819T041746Z` | direct HTML fetch; valid bundle |
| PostgreSQL deferred constraint triggers | `tf_f92bf506d2262212_20260819T041748Z` | direct HTML fetch; valid bundle |
| TigerBeetle accounting model | `tf_75405748193df829_20260819T041747Z` | vendor semantics; valid bundle, not a universal standard |
| TigerBeetle transfer identity/result model | `tf_b4f36fb04969100f_20260819T041746Z` | vendor semantics; valid bundle, not copied compatibility |
| Fowler Event Sourcing caveats | `tf_8c266ad1f81881de_20260819T041746Z` | author article; valid bundle |
| RFC 9110 HTTP method idempotence | `tf_e2c84373d2069287_20260819T041746Z` | IETF HTML; valid bundle |

All eight receipts are unsigned self-reported acquisition diagnostics. No receipt proves implementation correctness, source license,
production behavior, or external acceptance.

## Decisions caused by research

- discard the chapter's unmeasured per-node and one-million-TPS arithmetic as requirements;
- use JSON integers with one synthetic asset instead of an underspecified amount string;
- bind exact request identity to immutable intent and stored terminal result;
- use one PostgreSQL authority instead of diagram-only TCC/Saga/Raft;
- use canonical wallet lock order and a locked revision row;
- keep reversal as a new compensating transfer;
- make replay evidence include genesis, wallet generations, balance versions, code/schema contract, statements, and audits;
- label balanced wallet entries as a narrow journal invariant, not complete accounting.
