import { createHash } from 'node:crypto';
import { fail } from './errors.js';

export const LIMITS = Object.freeze({
  amount: 1_000_000,
  audits: 32,
  bodyBytes: 16_384,
  idLength: 72,
  journalEntries: 1_024,
  pageLimit: 50,
  pageReceipts: 256,
  statements: 64,
  supply: 10_000_000,
  transfers: 512,
  wallets: 64
});

const PREFIXES = Object.freeze({
  requestKey: 'req',
  walletId: 'wallet',
  transferId: 'transfer',
  reversalTransferId: 'reversal',
  statementId: 'statement',
  auditId: 'audit'
});

export function assertPlainObject(value, label = 'request') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_request', `${label} must be a JSON object`);
  }
  return value;
}

export function exactKeys(value, required, optional = [], label = 'request') {
  assertPlainObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('invalid_request', `${label} contains unknown field`);
  }
  for (const key of required) {
    if (!(key in value)) fail('invalid_request', `${label} is missing required field`);
  }
}

export function parseId(value, field) {
  if (typeof value !== 'string' || value.length > LIMITS.idLength) {
    fail('invalid_request', `${field} has invalid identity grammar`);
  }
  if (field === 'walletId' && value === 'treasury') return value;
  const prefix = PREFIXES[field];
  if (!prefix || !new RegExp(`^${prefix}_[a-z0-9][a-z0-9_-]{2,63}$`).test(value)) {
    fail('invalid_request', `${field} has invalid identity grammar`);
  }
  return value;
}

export function parseAsset(value) {
  if (value !== 'LAB') fail('invalid_request', 'asset must be the synthetic LAB unit');
  return value;
}

export function parseAmount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS.amount) {
    fail('invalid_request', 'amount must be a bounded positive JSON integer');
  }
  return value;
}

export function parseGeneration(value, field = 'expectedGeneration') {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    fail('invalid_request', `${field} must be a bounded positive integer`);
  }
  return value;
}

export function parseAsOfRevision(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) {
    fail('invalid_request', 'asOfRevision must be null or a bounded positive integer');
  }
  return value;
}

export function parsePageLimit(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > LIMITS.pageLimit) {
    fail('invalid_request', 'page limit is outside the supported bound');
  }
  return parsed;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function parseWalletInput(value) {
  exactKeys(value, ['requestKey', 'walletId', 'kind', 'asset']);
  if (value.kind !== 'user') fail('invalid_request', 'only synthetic user wallets can be created');
  const walletId = parseId(value.walletId, 'walletId');
  if (walletId === 'treasury') fail('invalid_request', 'treasury creation is not exposed');
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    walletId,
    kind: value.kind,
    asset: parseAsset(value.asset)
  });
}

export function parseStateInput(value, walletId, action) {
  exactKeys(value, ['requestKey', 'expectedState', 'expectedGeneration']);
  const allowed = action === 'freeze' ? ['active'] : action === 'activate' ? ['frozen'] : ['frozen'];
  if (!allowed.includes(value.expectedState)) {
    fail('invalid_request', `expectedState is invalid for ${action}`);
  }
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    walletId: parseId(walletId, 'walletId'),
    action,
    expectedState: value.expectedState,
    expectedGeneration: parseGeneration(value.expectedGeneration)
  });
}

export function parseTransferInput(value) {
  exactKeys(value, [
    'requestKey', 'transferId', 'sourceWalletId', 'destinationWalletId', 'amount', 'asset',
    'expectedSourceGeneration', 'expectedDestinationGeneration'
  ]);
  const sourceWalletId = parseId(value.sourceWalletId, 'walletId');
  const destinationWalletId = parseId(value.destinationWalletId, 'walletId');
  if (sourceWalletId === destinationWalletId) fail('invalid_request', 'wallets must be distinct');
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    transferId: parseId(value.transferId, 'transferId'),
    sourceWalletId,
    destinationWalletId,
    amount: parseAmount(value.amount),
    asset: parseAsset(value.asset),
    expectedSourceGeneration: parseGeneration(value.expectedSourceGeneration, 'expectedSourceGeneration'),
    expectedDestinationGeneration: parseGeneration(
      value.expectedDestinationGeneration, 'expectedDestinationGeneration'
    )
  });
}

export function parsePostInput(value, transferId) {
  exactKeys(value, ['requestKey']);
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    transferId: parseId(transferId, 'transferId')
  });
}

export function parseReversalInput(value, transferId) {
  exactKeys(value, [
    'requestKey', 'reversalTransferId', 'expectedCurrentHolderGeneration', 'expectedOriginalSourceGeneration'
  ]);
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    originalTransferId: parseId(transferId, 'transferId'),
    reversalTransferId: parseId(value.reversalTransferId, 'reversalTransferId'),
    expectedCurrentHolderGeneration: parseGeneration(
      value.expectedCurrentHolderGeneration, 'expectedCurrentHolderGeneration'
    ),
    expectedOriginalSourceGeneration: parseGeneration(
      value.expectedOriginalSourceGeneration, 'expectedOriginalSourceGeneration'
    )
  });
}

export function parseStatementInput(value) {
  exactKeys(value, ['requestKey', 'statementId', 'walletId', 'asOfRevision']);
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    statementId: parseId(value.statementId, 'statementId'),
    walletId: parseId(value.walletId, 'walletId'),
    asOfRevision: parseAsOfRevision(value.asOfRevision)
  });
}

export function parseAuditInput(value) {
  exactKeys(value, ['requestKey', 'auditId', 'asOfRevision']);
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    auditId: parseId(value.auditId, 'auditId'),
    asOfRevision: parseAsOfRevision(value.asOfRevision)
  });
}
