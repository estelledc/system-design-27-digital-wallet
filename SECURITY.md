# Security policy

## Supported scope

Only the current `main` branch is maintained. This repository is a bounded local experiment, not a hosted wallet, bank, payment
service, or accounting system.

## Reporting

Open a private GitHub security advisory for a vulnerability. Do not include real wallet/account/customer/payment identities,
balances, transfers, tokens, credentials, database URLs, internal endpoints, production topology, or company data in an issue,
fixture, log, or reproduction.

## Deliberate limits

The lab accepts only generated synthetic identities and integer `LAB` units. It does not implement authentication, account
ownership, cash-in/out, card/bank/PSP integration, KYC/AML, fraud/risk, fees, tax, FX, disputes, chargebacks, settlement, payouts,
encryption/KMS, tenant isolation, legal/compliance controls, multi-region failover, or production operations. Passing tests does
not establish those properties.
