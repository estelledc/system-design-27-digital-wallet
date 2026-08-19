import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  createRuntime,
  killWorkerAt,
  transferFixture,
  walletFixture
} from '../helpers/runtime.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; crash tests never skip PostgreSQL');

let directory;
let runtime;
let crashCount = 0;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wallet-crash-'));
  runtime = await createRuntime(databaseUrl, { reset: true });
});

after(async () => {
  await runtime?.close();
  await rm(directory, { recursive: true, force: true });
});

async function killAt(operation, payload) {
  crashCount += 1;
  const result = await killWorkerAt({
    databaseUrl, directory, counter: crashCount, operation, payload
  });
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGKILL');
}

test('seven true SIGKILL commit-before-response windows replay one authority effect each', async () => {
  const wallet = walletFixture('crash_main');
  await killAt('wallet-create-after-commit', { wallet });
  const created = await runtime.service.createWallet(wallet);
  assert.equal(created.state, 'active');

  const stateWallet = walletFixture('crash_state');
  await runtime.service.createWallet(stateWallet);
  const stateInput = {
    requestKey: 'req_freeze_crash_state', expectedState: 'active', expectedGeneration: 1
  };
  await killAt('wallet-state-after-commit', {
    walletId: stateWallet.walletId, action: 'freeze', input: stateInput
  });
  const frozen = await runtime.service.transitionWallet(stateWallet.walletId, 'freeze', stateInput);
  assert.equal(frozen.state, 'frozen');

  const transfer = transferFixture('crash_transfer', 'treasury', wallet.walletId, 300);
  await killAt('transfer-prepare-after-commit', { transfer });
  const prepared = await runtime.service.prepareTransfer(transfer);
  assert.equal(prepared.state, 'prepared');

  const postInput = { requestKey: 'req_post_crash_transfer' };
  await killAt('transfer-post-after-commit', { transferId: transfer.transferId, input: postInput });
  const posted = await runtime.service.postTransfer(transfer.transferId, postInput);
  assert.equal(posted.state, 'posted');

  const reversalInput = {
    requestKey: 'req_reverse_crash_transfer', reversalTransferId: 'reversal_crash_transfer',
    expectedCurrentHolderGeneration: 1, expectedOriginalSourceGeneration: 1
  };
  await killAt('reversal-after-commit', { transferId: transfer.transferId, input: reversalInput });
  const reversed = await runtime.service.reverseTransfer(transfer.transferId, reversalInput);
  assert.equal(reversed.state, 'posted');

  const statementInput = {
    requestKey: 'req_statement_crash', statementId: 'statement_crash',
    walletId: wallet.walletId, asOfRevision: null
  };
  await killAt('statement-after-commit', { statement: statementInput });
  const statement = await runtime.service.publishStatement(statementInput);
  assert.equal(statement.entryCount, 2);
  assert.equal(statement.closingBalance, '0');

  const auditInput = {
    requestKey: 'req_audit_crash', auditId: 'audit_crash', asOfRevision: null
  };
  await killAt('audit-after-commit', { audit: auditInput });
  const audit = await runtime.service.runAudit(auditInput);
  assert.equal(audit.internalConsistency, true);

  const state = await runtime.service.getState();
  assert.equal(state.walletCount, 3);
  assert.equal(state.transferCount, 2);
  assert.equal(state.journalTransactionCount, 2);
  assert.equal(state.journalEntryCount, 4);
  assert.equal(state.statementCount, 1);
  assert.equal(state.auditCount, 1);
  assert.equal(state.materializedTotal, state.genesisSupply);
  assert.equal(state.unbalancedTransactionCount, 0);
  assert.equal(state.externalAcceptance, false);
  assert.equal(crashCount, 7);
});
