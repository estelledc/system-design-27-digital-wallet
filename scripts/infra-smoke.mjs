import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { WalletRepository } from '../src/repository.js';
import { WalletService } from '../src/service.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; smoke never skips PostgreSQL');

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const repository = await new WalletRepository(pool).init();
const service = new WalletService(repository);

try {
  await repository.reset();
  for (const suffix of ['smoke_a', 'smoke_b']) {
    await service.createWallet({
      requestKey: `req_wallet_${suffix}`, walletId: `wallet_${suffix}`, kind: 'user', asset: 'LAB'
    });
  }
  const post = async (suffix, sourceWalletId, destinationWalletId, amount) => {
    const transfer = {
      requestKey: `req_prepare_${suffix}`, transferId: `transfer_${suffix}`,
      sourceWalletId, destinationWalletId, amount, asset: 'LAB',
      expectedSourceGeneration: 1, expectedDestinationGeneration: 1
    };
    await service.prepareTransfer(transfer);
    return service.postTransfer(transfer.transferId, { requestKey: `req_post_${suffix}` });
  };
  await post('smoke_fund', 'treasury', 'wallet_smoke_a', 400);
  const sent = await post('smoke_send', 'wallet_smoke_a', 'wallet_smoke_b', 125);
  assert.equal(sent.state, 'posted');
  const reversed = await service.reverseTransfer('transfer_smoke_send', {
    requestKey: 'req_reverse_smoke', reversalTransferId: 'reversal_smoke',
    expectedCurrentHolderGeneration: 1, expectedOriginalSourceGeneration: 1
  });
  assert.equal(reversed.state, 'posted');
  const statement = await service.publishStatement({
    requestKey: 'req_statement_smoke', statementId: 'statement_smoke',
    walletId: 'wallet_smoke_b', asOfRevision: null
  });
  const firstPage = await service.getStatementPage(statement.statementId, statement.firstCursor, 1);
  const secondPage = await service.getStatementPage(statement.statementId, firstPage.nextCursor, 1);
  assert.equal(firstPage.items.length + secondPage.items.length, statement.entryCount);
  const audit = await service.runAudit({
    requestKey: 'req_audit_smoke', auditId: 'audit_smoke', asOfRevision: null
  });
  assert.equal(audit.internalConsistency, true);
  const state = await service.getState();
  assert.equal(state.walletCount, 3);
  assert.equal(state.transferCount, 3);
  assert.equal(state.journalTransactionCount, 3);
  assert.equal(state.journalEntryCount, 6);
  assert.equal(state.statementCount, 1);
  assert.equal(state.pageReceiptCount, 2);
  assert.equal(state.auditCount, 1);
  assert.equal(state.materializedTotal, state.genesisSupply);
  assert.equal(state.unbalancedTransactionCount, 0);
  process.stdout.write(`${JSON.stringify({
    walletCount: state.walletCount,
    transferCount: state.transferCount,
    journalTransactionCount: state.journalTransactionCount,
    journalEntryCount: state.journalEntryCount,
    statementEntryCount: statement.entryCount,
    statementPageCount: 2,
    auditInternalConsistency: audit.internalConsistency,
    realFundsMoved: audit.realFundsMoved,
    accountingApproved: audit.accountingApproved,
    externalAcceptance: audit.externalAcceptance
  })}\n`);
} finally {
  await repository.close();
}
