import { Buffer } from 'node:buffer';
import { digest } from './contracts.js';
import { fail } from './errors.js';

export const OUTCOME_BOUNDARY = Object.freeze({
  realFundsMoved: false,
  ownershipVerified: false,
  recipientConsumed: false,
  accountingApproved: false,
  compliant: false,
  externalAcceptance: false
});

export function publicResult(value = {}) {
  return Object.freeze({ ...value, ...OUTCOME_BOUNDARY });
}

export function canonicalWalletOrder(walletIds) {
  return Object.freeze([...new Set(walletIds)].sort());
}

export function journalTransactionId(transferId) {
  return `jtx_${digest({ transferId }).slice(0, 24)}`;
}

export function journalEntries({ transferId, sourceWalletId, destinationWalletId, amount }) {
  return Object.freeze([
    Object.freeze({
      entryId: `entry_${digest({ transferId, walletId: sourceWalletId, side: 'debit' }).slice(0, 24)}`,
      ordinal: 1,
      walletId: sourceWalletId,
      side: 'debit',
      delta: String(-amount),
      amount: String(amount)
    }),
    Object.freeze({
      entryId: `entry_${digest({ transferId, walletId: destinationWalletId, side: 'credit' }).slice(0, 24)}`,
      ordinal: 2,
      walletId: destinationWalletId,
      side: 'credit',
      delta: String(amount),
      amount: String(amount)
    })
  ]);
}

export function assertBalanced(entries) {
  const total = entries.reduce((sum, entry) => sum + BigInt(entry.delta), 0n);
  const sides = new Set(entries.map((entry) => entry.side));
  if (entries.length !== 2 || total !== 0n || !sides.has('debit') || !sides.has('credit')) {
    fail('invariant_violation', 'journal transaction must contain one balanced debit and credit', 500);
  }
  return true;
}

export function transitionTarget(action) {
  if (action === 'freeze') return 'frozen';
  if (action === 'activate') return 'active';
  if (action === 'close') return 'closed';
  fail('invalid_request', 'wallet action is unsupported');
}

export function encodeCursor({ statementId, orderedDigest, nextOrdinal }) {
  return Buffer.from(JSON.stringify({ statementId, orderedDigest, nextOrdinal }), 'utf8').toString('base64url');
}

export function decodeCursor(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 512) {
    fail('invalid_cursor', 'statement cursor is malformed', 409);
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed.statementId !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.orderedDigest) ||
        !Number.isSafeInteger(parsed.nextOrdinal) || parsed.nextOrdinal < 0) {
      fail('invalid_cursor', 'statement cursor is malformed', 409);
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'invalid_cursor') throw error;
    fail('invalid_cursor', 'statement cursor is malformed', 409);
  }
}

export function statementDigest(metadata, items) {
  return digest({
    metadata,
    items: items.map((item) => ({
      ordinal: item.ordinal,
      journalEntryId: item.journalEntryId,
      authorityRevision: item.authorityRevision,
      side: item.side,
      delta: item.delta,
      resultingBalance: item.resultingBalance
    }))
  });
}
