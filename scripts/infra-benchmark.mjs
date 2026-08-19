import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { WalletRepository } from '../src/repository.js';
import { WalletService } from '../src/service.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; benchmark never skips PostgreSQL');

const pool = new Pool({ connectionString: databaseUrl, max: 20 });
const repository = await new WalletRepository(pool).init();
const service = new WalletService(repository);

function elapsed(start) {
  return Number((performance.now() - start).toFixed(3));
}

try {
  await repository.reset();
  const version = await pool.query('SHOW server_version');
  const wallets = Array.from({ length: 31 }, (_, index) => `wallet_bm_${String(index).padStart(2, '0')}`);
  let started = performance.now();
  for (const [index, walletId] of wallets.entries()) {
    await service.createWallet({
      requestKey: `req_wallet_bm_${String(index).padStart(2, '0')}`,
      walletId, kind: 'user', asset: 'LAB'
    });
  }
  const createWalletMs = elapsed(started);

  const post = async (suffix, sourceWalletId, destinationWalletId, amount) => {
    const transfer = {
      requestKey: `req_prepare_${suffix}`, transferId: `transfer_${suffix}`,
      sourceWalletId, destinationWalletId, amount, asset: 'LAB',
      expectedSourceGeneration: 1, expectedDestinationGeneration: 1
    };
    await service.prepareTransfer(transfer);
    return service.postTransfer(transfer.transferId, { requestKey: `req_post_${suffix}` });
  };

  started = performance.now();
  for (const [index, walletId] of wallets.entries()) {
    await post(`fund_bm_${String(index).padStart(2, '0')}`, 'treasury', walletId, 1_000);
  }
  const fundMs = elapsed(started);

  started = performance.now();
  const ordinaryIds = [];
  for (let round = 0; round < 2; round += 1) {
    for (let index = 0; index < wallets.length; index += 1) {
      const suffix = `ring_${round}_${String(index).padStart(2, '0')}`;
      const destination = wallets[(index + 1) % wallets.length];
      const result = await post(suffix, wallets[index], destination, 1);
      assert.equal(result.state, 'posted');
      ordinaryIds.push(`transfer_${suffix}`);
    }
  }
  const ringTransferMs = elapsed(started);

  started = performance.now();
  for (let index = 0; index < 8; index += 1) {
    const result = await service.reverseTransfer(ordinaryIds[index], {
      requestKey: `req_reverse_bm_${String(index).padStart(2, '0')}`,
      reversalTransferId: `reversal_bm_${String(index).padStart(2, '0')}`,
      expectedCurrentHolderGeneration: 1,
      expectedOriginalSourceGeneration: 1
    });
    assert.equal(result.state, 'posted');
  }
  const reversalMs = elapsed(started);

  started = performance.now();
  for (let index = 0; index < 16; index += 1) {
    const statement = await service.publishStatement({
      requestKey: `req_statement_bm_${String(index).padStart(2, '0')}`,
      statementId: `statement_bm_${String(index).padStart(2, '0')}`,
      walletId: wallets[index],
      asOfRevision: null
    });
    await service.getStatementPage(statement.statementId, statement.firstCursor, 5);
  }
  const statementMs = elapsed(started);

  started = performance.now();
  for (let index = 0; index < 4; index += 1) {
    const audit = await service.runAudit({
      requestKey: `req_audit_bm_${String(index).padStart(2, '0')}`,
      auditId: `audit_bm_${String(index).padStart(2, '0')}`,
      asOfRevision: null
    });
    assert.equal(audit.internalConsistency, true);
  }
  const auditMs = elapsed(started);

  started = performance.now();
  for (let index = 0; index < 16; index += 1) {
    await service.getWalletEvidence(wallets[index]);
  }
  const evidenceMs = elapsed(started);
  const state = await service.getState();
  assert.equal(state.walletCount, 32);
  assert.equal(state.transferCount, 101);
  assert.equal(state.journalTransactionCount, 101);
  assert.equal(state.journalEntryCount, 202);
  assert.equal(state.statementCount, 16);
  assert.equal(state.pageReceiptCount, 16);
  assert.equal(state.auditCount, 4);
  assert.equal(state.preparedTransferCount, 0);
  assert.equal(state.materializedTotal, state.genesisSupply);
  assert.equal(state.unbalancedTransactionCount, 0);
  process.stdout.write(`${JSON.stringify({
    fixture: {
      wallets: state.walletCount,
      preparedAndPostedTransfers: state.transferCount,
      journalTransactions: state.journalTransactionCount,
      journalEntries: state.journalEntryCount,
      reversals: 8,
      statements: state.statementCount,
      pageReceipts: state.pageReceiptCount,
      audits: state.auditCount,
      evidenceQueries: 16
    },
    runtime: { node: process.version, postgresql: version.rows[0].server_version },
    wholeBatchMilliseconds: {
      createWallets: createWalletMs,
      fundWallets: fundMs,
      ringTransfers: ringTransferMs,
      reversals: reversalMs,
      statementsAndFirstPages: statementMs,
      audits: auditMs,
      evidenceQueries: evidenceMs
    },
    exclusions: {
      realFunds: true,
      externalRails: true,
      completeAccounting: true,
      highAvailability: true,
      powerLoss: true,
      productionSla: true,
      externalAcceptance: true
    }
  })}\n`);
} finally {
  await repository.close();
}
