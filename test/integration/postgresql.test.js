import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, beforeEach, test } from 'node:test';
import { createWalletServer } from '../../src/http.js';
import {
  createRuntime,
  createWallet,
  prepareAndPost,
  transferFixture,
  walletFixture
} from '../helpers/runtime.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; PostgreSQL tests never skip infrastructure');

let runtime;

before(async () => {
  runtime = await createRuntime(databaseUrl, { reset: true });
});

beforeEach(async () => {
  await runtime.repository.reset();
});

after(async () => {
  await runtime?.close();
});

test('wallet creation and lifecycle replay exact results and fence changed intent', async () => {
  const input = walletFixture('life01');
  const created = await runtime.service.createWallet(input);
  assert.equal(created.balance, '0');
  assert.deepEqual(await runtime.service.createWallet(input), created);
  await assert.rejects(
    runtime.service.createWallet({ ...input, walletId: 'wallet_life02' }),
    { code: 'intent_conflict' }
  );

  const frozenInput = { requestKey: 'req_freeze_life01', expectedState: 'active', expectedGeneration: 1 };
  const frozen = await runtime.service.transitionWallet(input.walletId, 'freeze', frozenInput);
  assert.equal(frozen.state, 'frozen');
  assert.equal(frozen.generation, 2);
  assert.deepEqual(await runtime.service.transitionWallet(input.walletId, 'freeze', frozenInput), frozen);

  const active = await runtime.service.transitionWallet(input.walletId, 'activate', {
    requestKey: 'req_activate_life01', expectedState: 'frozen', expectedGeneration: 2
  });
  assert.equal(active.state, 'active');
  assert.equal(active.generation, 3);
  const refrozen = await runtime.service.transitionWallet(input.walletId, 'freeze', {
    requestKey: 'req_refreeze_life01', expectedState: 'active', expectedGeneration: 3
  });
  const closed = await runtime.service.transitionWallet(input.walletId, 'close', {
    requestKey: 'req_close_life01', expectedState: 'frozen', expectedGeneration: refrozen.generation
  });
  assert.equal(closed.state, 'closed');
  assert.equal(closed.balance, '0');
});

test('prepare has no value effect and post commits one replayable balanced effect', async () => {
  const wallet = await createWallet(runtime.service, 'post01');
  const transfer = transferFixture('post01', 'treasury', wallet.walletId, 250);
  const prepared = await runtime.service.prepareTransfer(transfer);
  assert.equal(prepared.state, 'prepared');
  const beforePost = await runtime.service.getState();
  assert.equal(beforePost.journalTransactionCount, 0);
  assert.equal(beforePost.materializedTotal, '10000000');

  const postInput = { requestKey: 'req_post_post01' };
  const posted = await runtime.service.postTransfer(transfer.transferId, postInput);
  assert.equal(posted.state, 'posted');
  assert.equal(posted.journalEntryIds.length, 2);
  assert.deepEqual(await runtime.service.postTransfer(transfer.transferId, postInput), posted);
  const evidence = await runtime.service.getWalletEvidence(wallet.walletId);
  assert.equal(evidence.wallet.balance, '250');
  assert.equal(evidence.journalEntries.length, 1);
  const state = await runtime.service.getState();
  assert.equal(state.materializedTotal, state.genesisSupply);
  assert.equal(state.unbalancedTransactionCount, 0);

  await assert.rejects(runtime.service.prepareTransfer({ ...transfer, amount: 251 }), { code: 'intent_conflict' });
});

test('concurrent outgoing transfers cannot overspend the final source units', async () => {
  const source = await createWallet(runtime.service, 'race_src');
  const left = await createWallet(runtime.service, 'race_left');
  const right = await createWallet(runtime.service, 'race_right');
  await prepareAndPost(runtime.service, 'fund_race', 'treasury', source.walletId, 100);
  const first = transferFixture('race_one', source.walletId, left.walletId, 80);
  const second = transferFixture('race_two', source.walletId, right.walletId, 80);
  await Promise.all([runtime.service.prepareTransfer(first), runtime.service.prepareTransfer(second)]);
  const [one, two] = await Promise.all([
    runtime.service.postTransfer(first.transferId, { requestKey: 'req_post_race_one' }),
    runtime.service.postTransfer(second.transferId, { requestKey: 'req_post_race_two' })
  ]);
  assert.equal([one, two].filter((result) => result.state === 'posted').length, 1);
  assert.equal([one, two].filter((result) => result.code === 'insufficient_balance').length, 1);
  const evidence = await runtime.service.getWalletEvidence(source.walletId);
  assert.equal(evidence.wallet.balance, '20');
  assert.equal((await runtime.service.getState()).materializedTotal, '10000000');
});

test('opposite-direction transfers use one lock order and both commit without deadlock', async () => {
  const left = await createWallet(runtime.service, 'opp_left');
  const right = await createWallet(runtime.service, 'opp_right');
  await prepareAndPost(runtime.service, 'fund_opp_left', 'treasury', left.walletId, 100);
  await prepareAndPost(runtime.service, 'fund_opp_right', 'treasury', right.walletId, 100);
  const leftToRight = transferFixture('opp_lr', left.walletId, right.walletId, 10);
  const rightToLeft = transferFixture('opp_rl', right.walletId, left.walletId, 20);
  await Promise.all([
    runtime.service.prepareTransfer(leftToRight), runtime.service.prepareTransfer(rightToLeft)
  ]);
  const [first, second] = await Promise.all([
    runtime.service.postTransfer(leftToRight.transferId, { requestKey: 'req_post_opp_lr' }),
    runtime.service.postTransfer(rightToLeft.transferId, { requestKey: 'req_post_opp_rl' })
  ]);
  assert.equal(first.state, 'posted');
  assert.equal(second.state, 'posted');
  assert.equal((await runtime.service.getWalletEvidence(left.walletId)).wallet.balance, '110');
  assert.equal((await runtime.service.getWalletEvidence(right.walletId)).wallet.balance, '90');
});

test('freeze racing post has one authority order and stale intent never posts afterward', async () => {
  const source = await createWallet(runtime.service, 'freeze_src');
  const destination = await createWallet(runtime.service, 'freeze_dst');
  await prepareAndPost(runtime.service, 'fund_freeze', 'treasury', source.walletId, 50);
  const transfer = transferFixture('freeze_race', source.walletId, destination.walletId, 10);
  await runtime.service.prepareTransfer(transfer);
  const [frozen, posted] = await Promise.all([
    runtime.service.transitionWallet(source.walletId, 'freeze', {
      requestKey: 'req_freeze_race', expectedState: 'active', expectedGeneration: 1
    }),
    runtime.service.postTransfer(transfer.transferId, { requestKey: 'req_post_freeze_race' })
  ]);
  assert.equal(frozen.state, 'frozen');
  if (posted.state === 'posted') {
    assert.ok(BigInt(posted.authorityRevision) < BigInt(frozen.authorityRevision));
  } else {
    assert.ok(['wallet_not_active', 'stale_wallet_generation'].includes(posted.code));
  }
  const retry = await runtime.service.postTransfer(transfer.transferId, { requestKey: 'req_post_freeze_after' });
  if (posted.state === 'posted') assert.equal(retry.state, 'posted');
  else assert.ok(['wallet_not_active', 'stale_wallet_generation'].includes(retry.code));
});

test('deferred balance trigger rejects a one-legged journal and rolls back its revision', async () => {
  const wallet = await createWallet(runtime.service, 'defer01');
  const transfer = transferFixture('defer01', 'treasury', wallet.walletId, 10);
  await runtime.service.prepareTransfer(transfer);
  const before = await runtime.service.getState();
  const client = await runtime.pool.connect();
  try {
    await client.query('BEGIN');
    const revision = await client.query(
      `UPDATE authority_state SET current_revision = current_revision + 1
       WHERE singleton = true RETURNING current_revision::text`
    );
    await client.query(
      `INSERT INTO authority_events(revision, event_kind, entity_id)
       VALUES ($1, 'transfer_posted', $2)`,
      [revision.rows[0].current_revision, transfer.transferId]
    );
    await client.query(
      `INSERT INTO journal_transactions(journal_tx_id, transfer_id, revision, kind, asset, amount)
       VALUES ('jtx_incomplete', $1, $2, 'transfer', 'LAB', 10)`,
      [transfer.transferId, revision.rows[0].current_revision]
    );
    await client.query(
      `INSERT INTO journal_entries(
         journal_entry_id, journal_tx_id, ordinal, revision, wallet_id, side, delta, amount
       ) VALUES ('entry_incomplete', 'jtx_incomplete', 1, $1, 'treasury', 'debit', -10, 10)`,
      [revision.rows[0].current_revision]
    );
    await assert.rejects(client.query('COMMIT'), (error) => error.code === '23514');
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  const afterFailure = await runtime.service.getState();
  assert.equal(afterFailure.currentRevision, before.currentRevision);
  assert.equal(afterFailure.journalTransactionCount, 0);
  assert.equal(afterFailure.journalEntryCount, 0);
});

test('reversal is append-only, fails after spend, and at most one later reversal posts', async () => {
  const originalSource = await createWallet(runtime.service, 'rev_src');
  const holder = await createWallet(runtime.service, 'rev_hold');
  const spender = await createWallet(runtime.service, 'rev_spend');
  await prepareAndPost(runtime.service, 'fund_rev_src', 'treasury', originalSource.walletId, 100);
  const original = await prepareAndPost(
    runtime.service, 'rev_original', originalSource.walletId, holder.walletId, 100
  );
  await prepareAndPost(runtime.service, 'rev_spent', holder.walletId, spender.walletId, 100);
  const failedInput = {
    requestKey: 'req_reverse_spent', reversalTransferId: 'reversal_spent',
    expectedCurrentHolderGeneration: 1, expectedOriginalSourceGeneration: 1
  };
  const failed = await runtime.service.reverseTransfer(original.transfer.transferId, failedInput);
  assert.equal(failed.code, 'insufficient_balance');
  assert.deepEqual(await runtime.service.reverseTransfer(original.transfer.transferId, failedInput), failed);

  await prepareAndPost(runtime.service, 'refill_holder', 'treasury', holder.walletId, 100);
  const attempts = await Promise.allSettled([
    runtime.service.reverseTransfer(original.transfer.transferId, {
      requestKey: 'req_reverse_again_a', reversalTransferId: 'reversal_again_a',
      expectedCurrentHolderGeneration: 1, expectedOriginalSourceGeneration: 1
    }),
    runtime.service.reverseTransfer(original.transfer.transferId, {
      requestKey: 'req_reverse_again_b', reversalTransferId: 'reversal_again_b',
      expectedCurrentHolderGeneration: 1, expectedOriginalSourceGeneration: 1
    })
  ]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled' && item.value.state === 'posted').length, 1);
  assert.equal(attempts.filter((item) => item.status === 'rejected' && item.reason.code === 'already_reversed').length, 1);
  const evidence = await runtime.service.getWalletEvidence(originalSource.walletId);
  assert.equal(evidence.transfers.filter((item) => item.kind === 'reversal').length, 1);
  assert.equal(evidence.transfers.find((item) => item.transfer_id === original.transfer.transferId).state, 'posted');
});

test('statement pages remain bound to one revision after later transfers', async () => {
  const wallet = await createWallet(runtime.service, 'stmt_wallet');
  const destination = await createWallet(runtime.service, 'stmt_dest');
  await prepareAndPost(runtime.service, 'stmt_fund', 'treasury', wallet.walletId, 10);
  await prepareAndPost(runtime.service, 'stmt_spend_one', wallet.walletId, destination.walletId, 1);
  const statementInput = {
    requestKey: 'req_statement_stable', statementId: 'statement_stable',
    walletId: wallet.walletId, asOfRevision: null
  };
  const statement = await runtime.service.publishStatement(statementInput);
  assert.equal(statement.entryCount, 2);
  const first = await runtime.service.getStatementPage(statement.statementId, statement.firstCursor, 1);
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);

  await prepareAndPost(runtime.service, 'stmt_spend_later', wallet.walletId, destination.walletId, 1);
  const second = await runtime.service.getStatementPage(statement.statementId, first.nextCursor, 1);
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(second.asOfRevision, statement.asOfRevision);
  assert.equal(second.orderedDigest, statement.orderedDigest);
  assert.deepEqual(await runtime.service.publishStatement(statementInput), statement);
});

test('audit detects projection tamper and a fresh process reads the same authority', async () => {
  const wallet = await createWallet(runtime.service, 'audit_wallet');
  await prepareAndPost(runtime.service, 'audit_fund', 'treasury', wallet.walletId, 77);
  const first = await runtime.service.runAudit({
    requestKey: 'req_audit_clean', auditId: 'audit_clean', asOfRevision: null
  });
  assert.equal(first.internalConsistency, true);
  assert.equal(first.financialAudit, false);

  await runtime.pool.query('UPDATE wallets SET balance = balance + 1 WHERE wallet_id = $1', [wallet.walletId]);
  const failed = await runtime.service.runAudit({
    requestKey: 'req_audit_tamper', auditId: 'audit_tamper', asOfRevision: null
  });
  assert.equal(failed.internalConsistency, false);
  assert.equal(failed.balanceMismatchCount, 1);
  assert.equal(failed.externalAcceptance, false);

  const restarted = await createRuntime(databaseUrl);
  try {
    const state = await restarted.service.getState();
    assert.equal(state.currentRevision, failed.asOfRevision);
    assert.equal(state.materializedTotal, '10000001');
  } finally {
    await restarted.close();
  }
});

test('real HTTP slice returns stored authority evidence without external outcome claims', async () => {
  const server = await createWalletServer(runtime.service);
  const { port } = server.address();
  try {
    const createdResponse = await fetch(`http://127.0.0.1:${port}/v1/wallets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(walletFixture('http_real'))
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.externalAcceptance, false);
    const stateResponse = await fetch(`http://127.0.0.1:${port}/v1/state`);
    assert.equal(stateResponse.status, 200);
    assert.equal((await stateResponse.json()).walletCount, 2);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
