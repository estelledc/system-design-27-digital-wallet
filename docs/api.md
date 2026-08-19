# API contract

All request keys and entity IDs are bounded synthetic strings. Amounts are JSON integers, never decimal strings or floating-point
values. The only asset is `LAB`.

## Wallets

### `POST /v1/wallets`

```json
{"requestKey":"req-wallet-a","walletId":"wallet-a","kind":"user","asset":"LAB"}
```

Creates a zero-balance wallet and returns its generation and authority revision. Treasury creation is not exposed.

### `POST /v1/wallets/:walletId/freeze|activate|close`

```json
{"requestKey":"req-freeze-a","expectedState":"active","expectedGeneration":1}
```

Each successful transition increments generation. Close additionally requires `frozen`, zero balance, and no prepared transfer.

## Transfers

### `POST /v1/transfers`

```json
{
  "requestKey":"req-transfer-1",
  "transferId":"transfer-1",
  "sourceWalletId":"treasury",
  "destinationWalletId":"wallet-a",
  "amount":400,
  "asset":"LAB",
  "expectedSourceGeneration":1,
  "expectedDestinationGeneration":1
}
```

Returns a prepared intent. No balance changes.

### `POST /v1/transfers/:transferId/post`

```json
{"requestKey":"req-post-1"}
```

Returns one of:

- `posted`: revision, journal transaction, two entry identities, and resulting balances;
- `rejected`: stable code such as `insufficient_balance`, `wallet_not_active`, or `stale_wallet_generation`;
- `intent_conflict`: same request/entity identity was reused with changed immutable intent.

### `POST /v1/transfers/:transferId/reverse`

```json
{
  "requestKey":"req-reverse-1",
  "reversalTransferId":"reversal-1",
  "expectedCurrentHolderGeneration":1,
  "expectedOriginalSourceGeneration":1
}
```

On success appends a full compensating transfer. It does not edit the original. A recipient that already spent the units can cause a
stable `insufficient_balance` rejection. A different request may try again; only one reversal can ever post.

## Statements and audits

### `POST /v1/statements`

```json
{"requestKey":"req-statement-a","statementId":"statement-a","walletId":"wallet-a","asOfRevision":null}
```

`null` selects the current authority revision inside the publication transaction. The response includes count, opening/closing
balance, digest, and first cursor.

### `GET /v1/statements/:statementId/pages?limit=2&cursor=...`

Returns immutable copied items and a cursor bound to statement ID and digest. Limits are `1..50`. A cursor from another statement or
publication is rejected.

### `POST /v1/audits`

```json
{"requestKey":"req-audit-1","auditId":"audit-1","asOfRevision":null}
```

Returns `internalConsistency`, mismatch counts, fixed supply, recomputed totals, and a digest. It never returns a financial-audit,
compliance, settlement, or external-acceptance verdict.

## Evidence reads

- `GET /v1/wallets/:walletId/evidence`
- `GET /v1/state`
- `GET /healthz`

Evidence responses distinguish stored authority facts from external outcomes. External outcome fields are always false in v0.1.

## Error envelope

```json
{"error":{"code":"intent_conflict","message":"request identity is bound to different immutable intent"}}
```

Validation uses `400`, absent entities `404`, state/identity conflicts `409`, bounded-capacity rejection `429`, and unexpected local
failures `500`. Messages never include database URLs, SQL, credentials, or raw driver errors.
