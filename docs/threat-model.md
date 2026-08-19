# Threat model

## Protected properties

- fixed synthetic supply and non-negative user balances;
- immutable transfer economics and journal facts;
- one posting/reversal effect per stable identity;
- wallet generation and state fences;
- statement/audit cut, order, count, and digest integrity;
- absence of realistic financial or credential data;
- honest evidence language.

## Trust boundaries

| Boundary | Trusted in v0.1 | Not established |
|---|---|---|
| caller to HTTP adapter | only strict parsing and bounded synthetic fields | identity, ownership, authorization, TLS, rate-limit identity |
| Node process to PostgreSQL | database transaction/constraint result | hostile database admin, compromised driver, network encryption, HA |
| mutable projection to journal | audit can compare them | automatic repair or proof the journal represents real funds |
| repository to CI | pinned workflow/actions/service image and generated fixtures | runner supply chain beyond pins, production equivalence |
| evidence response to reader | stored internal facts and explicit false boundaries | human read/acceptance, accounting sign-off, regulatory outcome |

## Abuse cases and controls

| Abuse or failure | v0.1 control | Residual risk |
|---|---|---|
| duplicate or timed-out POST | stable request/entity identity, canonical intent digest, stored result | retention is permanent only inside the lab database |
| same key with changed amount/accounts | typed intent conflict | no cross-service identity registry |
| concurrent overspend | canonical row locks, balance check, atomic commit | single database hotspot and no distributed authority |
| deadlock via opposite transfers | lexical wallet lock order | schema/admin paths could ignore application order |
| post after freeze/reactivation | expected generation checked under lock | no authenticated owner of the state transition |
| journal leg omitted or changed | deferred balance constraint and immutable triggers | privileged SQL can disable triggers or alter schema |
| forged/cross-publication cursor | structural binding to statement ID/digest | cursor is integrity metadata, not an authorization secret |
| projection corruption | revision-bound audit reports mismatch | no automatic repair, independent replica, or external reconciliation |
| realistic data enters fixtures/logs | bounded synthetic validators and repository/output scans | semantic scanners cannot prove absence of every sensitive value |
| tests are described as money/compliance proof | evidence-language scan and explicit false outcome fields | human documentation can still be misleading outside the checked corpus |

## Security non-claims

The repository is not suitable for custody or transfer of value. It has no authentication, authorization, tenancy, privacy controls,
encryption/KMS, secure deletion, fraud detection, KYC/AML, sanctions screening, compliance certification, penetration test, dependency
response SLA, production hardening, or legal review.
