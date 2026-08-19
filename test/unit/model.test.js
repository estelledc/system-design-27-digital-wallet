import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertBalanced,
  canonicalWalletOrder,
  decodeCursor,
  encodeCursor,
  journalEntries,
  publicResult,
  statementDigest,
  transitionTarget
} from '../../src/model.js';

test('journal entries preserve integer value with one debit and credit', () => {
  const entries = journalEntries({
    transferId: 'transfer_model', sourceWalletId: 'wallet_source',
    destinationWalletId: 'wallet_destination', amount: 40
  });
  assert.equal(assertBalanced(entries), true);
  assert.deepEqual(entries.map((entry) => entry.delta), ['-40', '40']);
  assert.equal(new Set(entries.map((entry) => entry.entryId)).size, 2);
});

test('unbalanced journal is rejected', () => {
  assert.throws(() => assertBalanced([
    { side: 'debit', delta: '-4' }, { side: 'credit', delta: '3' }
  ]), { code: 'invariant_violation' });
});

test('statement cursor is bound to identity, digest, and ordinal', () => {
  const cursor = encodeCursor({ statementId: 'statement_model', orderedDigest: 'a'.repeat(64), nextOrdinal: 7 });
  assert.deepEqual(decodeCursor(cursor), {
    statementId: 'statement_model', orderedDigest: 'a'.repeat(64), nextOrdinal: 7
  });
  assert.throws(() => decodeCursor('not-json'), { code: 'invalid_cursor' });
});

test('statement digest changes when total order changes', () => {
  const metadata = { statementId: 'statement_model', walletId: 'wallet_model', asOfRevision: '3' };
  const first = [
    { ordinal: 1, journalEntryId: 'entry_a', authorityRevision: '2', side: 'credit', delta: '5', resultingBalance: '5' },
    { ordinal: 2, journalEntryId: 'entry_b', authorityRevision: '3', side: 'debit', delta: '-1', resultingBalance: '4' }
  ];
  assert.notEqual(statementDigest(metadata, first), statementDigest(metadata, [...first].reverse()));
});

test('public results keep external outcomes false', () => {
  const result = publicResult({ state: 'posted', externalAcceptance: true, accountingApproved: true });
  assert.equal(result.state, 'posted');
  assert.equal(result.externalAcceptance, false);
  assert.equal(result.accountingApproved, false);
});

test('wallet lifecycle target is explicit', () => {
  assert.equal(transitionTarget('freeze'), 'frozen');
  assert.equal(transitionTarget('activate'), 'active');
  assert.equal(transitionTarget('close'), 'closed');
  assert.throws(() => transitionTarget('delete'), { code: 'invalid_request' });
});

test('opposite transfer directions acquire the same canonical wallet order', () => {
  assert.deepEqual(
    canonicalWalletOrder(['wallet_zed', 'wallet_alpha']),
    canonicalWalletOrder(['wallet_alpha', 'wallet_zed'])
  );
  assert.deepEqual(canonicalWalletOrder(['wallet_zed', 'wallet_alpha']), ['wallet_alpha', 'wallet_zed']);
});

test('generated balanced transfers conserve a fixed synthetic supply', () => {
  const balances = Array.from({ length: 16 }, (_, index) => index === 0 ? 10_000n : 0n);
  let seed = 0x5eed;
  const next = () => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) & 0x7fffffff;
    return seed;
  };
  for (let index = 0; index < 2_000; index += 1) {
    const source = next() % balances.length;
    let destination = next() % balances.length;
    if (destination === source) destination = (destination + 1) % balances.length;
    const amount = BigInt((next() % 25) + 1);
    if (balances[source] < amount) continue;
    const entries = journalEntries({
      transferId: `transfer_property_${index}`,
      sourceWalletId: `wallet_${source}`,
      destinationWalletId: `wallet_${destination}`,
      amount: Number(amount)
    });
    assertBalanced(entries);
    balances[source] += BigInt(entries[0].delta);
    balances[destination] += BigInt(entries[1].delta);
    assert.ok(balances[source] >= 0n);
  }
  assert.equal(balances.reduce((sum, balance) => sum + balance, 0n), 10_000n);
});
