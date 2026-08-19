import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalJson,
  digest,
  parseAmount,
  parseTransferInput,
  parseWalletInput
} from '../../src/contracts.js';

test('canonical JSON and digest ignore object insertion order', () => {
  const left = { z: 1, nested: { b: 2, a: 1 } };
  const right = { nested: { a: 1, b: 2 }, z: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(digest(left), digest(right));
});

test('amount accepts bounded JSON integers only', () => {
  assert.equal(parseAmount(1_000_000), 1_000_000);
  for (const value of ['10', 0, -1, 1.5, 1_000_001]) {
    assert.throws(() => parseAmount(value), { code: 'invalid_request' });
  }
});

test('wallet input rejects treasury creation and unknown fields', () => {
  assert.throws(() => parseWalletInput({
    requestKey: 'req_wallet_bad', walletId: 'treasury', kind: 'user', asset: 'LAB'
  }), { code: 'invalid_request' });
  assert.throws(() => parseWalletInput({
    requestKey: 'req_wallet_bad', walletId: 'wallet_bad', kind: 'user', asset: 'LAB', balance: 1
  }), { code: 'invalid_request' });
});

test('transfer input freezes all economic and generation fields', () => {
  const parsed = parseTransferInput({
    requestKey: 'req_prepare_unit',
    transferId: 'transfer_unit',
    sourceWalletId: 'treasury',
    destinationWalletId: 'wallet_unit',
    amount: 25,
    asset: 'LAB',
    expectedSourceGeneration: 1,
    expectedDestinationGeneration: 2
  });
  assert.equal(parsed.amount, 25);
  assert.equal(parsed.expectedDestinationGeneration, 2);
  assert.ok(Object.isFrozen(parsed));
});

test('self transfer and non-LAB asset are rejected', () => {
  const base = {
    requestKey: 'req_prepare_self', transferId: 'transfer_self',
    sourceWalletId: 'wallet_self', destinationWalletId: 'wallet_self', amount: 1,
    asset: 'LAB', expectedSourceGeneration: 1, expectedDestinationGeneration: 1
  };
  assert.throws(() => parseTransferInput(base), { code: 'invalid_request' });
  assert.throws(() => parseTransferInput({ ...base, destinationWalletId: 'wallet_other', asset: 'USD' }), {
    code: 'invalid_request'
  });
});
