# Digital Wallet Lab

This clean-room system-design practice starts with one question: when two wallet balances and an immutable transfer journal must
change together, what authority and receipts prevent retries, races, freezes, or reversals from creating or destroying value?

The prompt title is “Digital Wallet.” This repository does not copy a source chapter, provider, wallet product, API, diagram,
benchmark, account model, or proprietary system. The initial contract is frozen from the title alone before reading the fixed
secondary chapter.

## Current status

Closed-book and source-reviewed design are frozen. The executable PostgreSQL slice is not implemented yet. No real wallet
compatibility, money movement, accounting approval, compliance, production behavior, or external acceptance is claimed.

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
