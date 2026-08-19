import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { digest, LIMITS } from './contracts.js';
import { fail } from './errors.js';
import {
  assertBalanced,
  canonicalWalletOrder,
  decodeCursor,
  encodeCursor,
  journalEntries,
  journalTransactionId,
  publicResult,
  statementDigest,
  transitionTarget
} from './model.js';

const SCHEMA_URL = new URL('../sql/schema.sql', import.meta.url);

function walletView(row, authorityRevision = null) {
  return publicResult({
    walletId: row.wallet_id,
    kind: row.kind,
    asset: row.asset,
    state: row.state,
    generation: row.generation,
    balance: row.balance,
    balanceRevision: row.balance_revision,
    authorityRevision
  });
}

function transferView(row) {
  return publicResult({
    transferId: row.transfer_id,
    kind: row.kind,
    originalTransferId: row.original_transfer_id,
    sourceWalletId: row.source_wallet_id,
    destinationWalletId: row.destination_wallet_id,
    amount: row.amount,
    asset: row.asset,
    expectedSourceGeneration: row.expected_source_generation,
    expectedDestinationGeneration: row.expected_destination_generation,
    state: row.state,
    authorityRevision: row.posted_revision,
    journalTransactionId: row.journal_tx_id,
    journalPosted: row.state === 'posted'
  });
}

async function afterCommit(hook, result) {
  if (hook) await hook(result);
  return result;
}

export class WalletRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async init() {
    const sql = await readFile(fileURLToPath(SCHEMA_URL), 'utf8');
    await this.pool.query(sql);
    await this.bootstrap();
    return this;
  }

  async close() {
    await this.pool.end();
  }

  async tx(callback, { isolation = 'READ COMMITTED', retries = 3 } = {}) {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        if (isolation !== 'READ COMMITTED') {
          await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
        }
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (attempt < retries && (error?.code === '40001' || error?.code === '40P01')) continue;
        throw error;
      } finally {
        client.release();
      }
    }
    fail('internal_error', 'transaction retry bound was exhausted', 500);
  }

  async bootstrap() {
    return this.tx(async (client) => {
      const configQuery = await client.query('SELECT * FROM lab_config WHERE singleton = true FOR SHARE');
      if (configQuery.rows.length !== 1) fail('invariant_violation', 'genesis contract is missing', 500);
      const config = configQuery.rows[0];
      if (config.schema_version !== 1 || config.asset !== 'LAB' || config.treasury_wallet_id !== 'treasury' ||
          config.genesis_supply !== '10000000') {
        fail('invariant_violation', 'genesis contract changed', 500);
      }
      const existing = await client.query('SELECT * FROM wallets WHERE wallet_id = $1 FOR UPDATE', ['treasury']);
      if (existing.rows.length === 1) {
        const row = existing.rows[0];
        if (row.kind !== 'treasury' || row.asset !== 'LAB' || row.initial_balance !== config.genesis_supply) {
          fail('invariant_violation', 'treasury does not match genesis contract', 500);
        }
        return walletView(row);
      }
      const revision = await this.allocateRevision(client, 'wallet_created', 'treasury');
      const intentDigest = digest({ operation: 'genesis', walletId: 'treasury', asset: 'LAB', supply: config.genesis_supply });
      const inserted = await client.query(
        `INSERT INTO wallets(
           wallet_id, kind, asset, state, generation, initial_balance, balance, balance_revision, create_intent_digest
         ) VALUES ('treasury', 'treasury', 'LAB', 'active', 1, $1, $1, $2, $3)
         RETURNING *`,
        [config.genesis_supply, revision, intentDigest]
      );
      await client.query(
        `INSERT INTO wallet_events(wallet_event_id, wallet_id, revision, event_kind, state, generation)
         VALUES ($1, 'treasury', $2, 'created', 'active', 1)`,
        [`wev_${digest({ walletId: 'treasury', revision }).slice(0, 24)}`, revision]
      );
      await client.query(
        `INSERT INTO wallet_balance_versions(wallet_id, revision, balance, cause)
         VALUES ('treasury', $1, $2, 'genesis')`,
        [revision, config.genesis_supply]
      );
      return walletView(inserted.rows[0], revision);
    });
  }

  async reset() {
    await this.pool.query(`
      TRUNCATE statement_page_receipts, statement_items, statements, audits, journal_entries,
        journal_transactions, transfer_intents, wallet_balance_versions, wallet_events, wallets,
        operation_receipts, authority_events RESTART IDENTITY CASCADE;
      UPDATE authority_state SET current_revision = 0 WHERE singleton = true;
    `);
    await this.bootstrap();
  }

  async identityLock(client, identity) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [identity]);
  }

  async allocateRevision(client, eventKind, entityId) {
    const revisionQuery = await client.query(
      `UPDATE authority_state SET current_revision = current_revision + 1
       WHERE singleton = true RETURNING current_revision::text`
    );
    if (revisionQuery.rows.length !== 1) fail('invariant_violation', 'authority revision row is missing', 500);
    const revision = revisionQuery.rows[0].current_revision;
    await client.query(
      'INSERT INTO authority_events(revision, event_kind, entity_id) VALUES ($1, $2, $3)',
      [revision, eventKind, entityId]
    );
    return revision;
  }

  async claimReceipt(client, operation, requestKey, intentDigest) {
    await client.query(
      `INSERT INTO operation_receipts(operation, request_key, intent_digest)
       VALUES ($1, $2, $3) ON CONFLICT (operation, request_key) DO NOTHING`,
      [operation, requestKey, intentDigest]
    );
    const receiptQuery = await client.query(
      `SELECT intent_digest, completed, result FROM operation_receipts
       WHERE operation = $1 AND request_key = $2 FOR UPDATE`,
      [operation, requestKey]
    );
    const receipt = receiptQuery.rows[0];
    if (!receipt || receipt.intent_digest !== intentDigest) {
      fail('intent_conflict', 'request identity is bound to different immutable intent', 409);
    }
    return receipt.completed ? receipt.result : null;
  }

  async completeReceipt(client, operation, requestKey, result) {
    await client.query(
      `UPDATE operation_receipts SET completed = true, result = $3, completed_at = clock_timestamp()
       WHERE operation = $1 AND request_key = $2 AND completed = false`,
      [operation, requestKey, result]
    );
    return result;
  }

  async lockWallets(client, walletIds) {
    const ordered = canonicalWalletOrder(walletIds);
    const rows = [];
    for (const walletId of ordered) {
      const query = await client.query('SELECT * FROM wallets WHERE wallet_id = $1 FOR UPDATE', [walletId]);
      if (query.rows.length === 0) fail('not_found', 'wallet is not retained', 404);
      rows.push(query.rows[0]);
    }
    return new Map(rows.map((row) => [row.wallet_id, row]));
  }

  async createWallet(input, { afterCommit: hook } = {}) {
    const intent = { operation: 'create_wallet', walletId: input.walletId, kind: input.kind, asset: input.asset };
    const intentDigest = digest(intent);
    const result = await this.tx(async (client) => {
      const replay = await this.claimReceipt(client, 'create_wallet', input.requestKey, intentDigest);
      if (replay) return replay;
      await this.identityLock(client, `wallet:${input.walletId}`);
      const existing = await client.query('SELECT * FROM wallets WHERE wallet_id = $1 FOR UPDATE', [input.walletId]);
      let output;
      if (existing.rows.length === 1) {
        if (existing.rows[0].create_intent_digest !== intentDigest) {
          fail('intent_conflict', 'wallet identity is bound to changed creation intent', 409);
        }
        output = walletView(existing.rows[0]);
      } else {
        const count = await client.query('SELECT count(*)::integer AS count FROM wallets');
        if (count.rows[0].count >= LIMITS.wallets) {
          output = publicResult({ state: 'rejected', code: 'wallet_capacity_reached' });
          return this.completeReceipt(client, 'create_wallet', input.requestKey, output);
        }
        const revision = await this.allocateRevision(client, 'wallet_created', input.walletId);
        const inserted = await client.query(
          `INSERT INTO wallets(
             wallet_id, kind, asset, state, generation, initial_balance, balance, balance_revision, create_intent_digest
           ) VALUES ($1, 'user', 'LAB', 'active', 1, 0, 0, $2, $3) RETURNING *`,
          [input.walletId, revision, intentDigest]
        );
        await client.query(
          `INSERT INTO wallet_events(wallet_event_id, wallet_id, revision, event_kind, state, generation)
           VALUES ($1, $2, $3, 'created', 'active', 1)`,
          [`wev_${digest({ walletId: input.walletId, revision }).slice(0, 24)}`, input.walletId, revision]
        );
        await client.query(
          `INSERT INTO wallet_balance_versions(wallet_id, revision, balance, cause)
           VALUES ($1, $2, 0, 'wallet_created')`,
          [input.walletId, revision]
        );
        output = walletView(inserted.rows[0], revision);
      }
      return this.completeReceipt(client, 'create_wallet', input.requestKey, output);
    });
    return afterCommit(hook, result);
  }

  async transitionWallet(input, { afterCommit: hook } = {}) {
    const operation = `${input.action}_wallet`;
    const intentDigest = digest({ operation, ...input, requestKey: undefined });
    const result = await this.tx(async (client) => {
      const replay = await this.claimReceipt(client, operation, input.requestKey, intentDigest);
      if (replay) return replay;
      if (input.walletId === 'treasury') fail('invalid_state', 'treasury lifecycle is not exposed', 409);
      const wallets = await this.lockWallets(client, [input.walletId]);
      const wallet = wallets.get(input.walletId);
      if (wallet.state !== input.expectedState || wallet.generation !== input.expectedGeneration) {
        const output = publicResult({
          walletId: input.walletId,
          state: 'rejected',
          code: wallet.generation !== input.expectedGeneration ? 'stale_wallet_generation' : 'wallet_state_conflict',
          currentState: wallet.state,
          currentGeneration: wallet.generation
        });
        return this.completeReceipt(client, operation, input.requestKey, output);
      }
      if (input.action === 'close') {
        const prepared = await client.query(
          `SELECT count(*)::integer AS count FROM transfer_intents
           WHERE state = 'prepared' AND (source_wallet_id = $1 OR destination_wallet_id = $1)`,
          [input.walletId]
        );
        if (wallet.balance !== '0' || prepared.rows[0].count !== 0) {
          const output = publicResult({
            walletId: input.walletId,
            state: 'rejected',
            code: wallet.balance !== '0' ? 'nonzero_balance' : 'prepared_transfer_exists'
          });
          return this.completeReceipt(client, operation, input.requestKey, output);
        }
      }
      const target = transitionTarget(input.action);
      const generation = wallet.generation + 1;
      const revision = await this.allocateRevision(client, 'wallet_state_changed', input.walletId);
      const updated = await client.query(
        `UPDATE wallets SET state = $2, generation = $3, updated_at = clock_timestamp()
         WHERE wallet_id = $1 RETURNING *`,
        [input.walletId, target, generation]
      );
      const eventKind = input.action === 'freeze' ? 'frozen' : input.action === 'activate' ? 'activated' : 'closed';
      await client.query(
        `INSERT INTO wallet_events(wallet_event_id, wallet_id, revision, event_kind, state, generation)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [`wev_${digest({ walletId: input.walletId, revision, eventKind }).slice(0, 24)}`,
          input.walletId, revision, eventKind, target, generation]
      );
      const output = walletView(updated.rows[0], revision);
      return this.completeReceipt(client, operation, input.requestKey, output);
    });
    return afterCommit(hook, result);
  }

  async prepareTransfer(input, { afterCommit: hook } = {}) {
    const intent = {
      operation: 'prepare_transfer', transferId: input.transferId, sourceWalletId: input.sourceWalletId,
      destinationWalletId: input.destinationWalletId, amount: input.amount, asset: input.asset,
      expectedSourceGeneration: input.expectedSourceGeneration,
      expectedDestinationGeneration: input.expectedDestinationGeneration
    };
    const intentDigest = digest(intent);
    const result = await this.tx(async (client) => {
      const replay = await this.claimReceipt(client, 'prepare_transfer', input.requestKey, intentDigest);
      if (replay) return replay;
      await this.identityLock(client, `transfer:${input.transferId}`);
      const existing = await client.query(
        'SELECT * FROM transfer_intents WHERE transfer_id = $1 FOR UPDATE', [input.transferId]
      );
      let output;
      if (existing.rows.length === 1) {
        if (existing.rows[0].intent_digest !== intentDigest || existing.rows[0].kind !== 'transfer') {
          fail('intent_conflict', 'transfer identity is bound to changed immutable intent', 409);
        }
        output = transferView(existing.rows[0]);
      } else {
        const count = await client.query('SELECT count(*)::integer AS count FROM transfer_intents');
        if (count.rows[0].count >= LIMITS.transfers) {
          output = publicResult({ state: 'rejected', code: 'transfer_capacity_reached' });
          return this.completeReceipt(client, 'prepare_transfer', input.requestKey, output);
        }
        const wallets = await this.lockWallets(client, [input.sourceWalletId, input.destinationWalletId]);
        const source = wallets.get(input.sourceWalletId);
        const destination = wallets.get(input.destinationWalletId);
        if (source.asset !== input.asset || destination.asset !== input.asset) {
          fail('asset_conflict', 'wallet asset differs from transfer asset', 409);
        }
        if (source.state !== 'active' || destination.state !== 'active') {
          output = publicResult({ transferId: input.transferId, state: 'rejected', code: 'wallet_not_active' });
          return this.completeReceipt(client, 'prepare_transfer', input.requestKey, output);
        }
        if (source.generation !== input.expectedSourceGeneration ||
            destination.generation !== input.expectedDestinationGeneration) {
          output = publicResult({ transferId: input.transferId, state: 'rejected', code: 'stale_wallet_generation' });
          return this.completeReceipt(client, 'prepare_transfer', input.requestKey, output);
        }
        const inserted = await client.query(
          `INSERT INTO transfer_intents(
             transfer_id, kind, source_wallet_id, destination_wallet_id, amount, asset,
             expected_source_generation, expected_destination_generation, intent_digest, state
           ) VALUES ($1, 'transfer', $2, $3, $4, $5, $6, $7, $8, 'prepared') RETURNING *`,
          [input.transferId, input.sourceWalletId, input.destinationWalletId, input.amount, input.asset,
            input.expectedSourceGeneration, input.expectedDestinationGeneration, intentDigest]
        );
        output = transferView(inserted.rows[0]);
      }
      return this.completeReceipt(client, 'prepare_transfer', input.requestKey, output);
    });
    return afterCommit(hook, result);
  }

  async commitJournal(client, transfer, wallets, eventKind) {
    const source = wallets.get(transfer.source_wallet_id);
    const destination = wallets.get(transfer.destination_wallet_id);
    const entryCount = await client.query('SELECT count(*)::integer AS count FROM journal_entries');
    if (entryCount.rows[0].count + 2 > LIMITS.journalEntries) {
      return { rejection: publicResult({
        transferId: transfer.transfer_id, state: 'rejected', code: 'journal_capacity_reached'
      }) };
    }
    const revision = await this.allocateRevision(client, eventKind, transfer.transfer_id);
    const journalTxId = journalTransactionId(transfer.transfer_id);
    const entries = journalEntries({
      transferId: transfer.transfer_id,
      sourceWalletId: transfer.source_wallet_id,
      destinationWalletId: transfer.destination_wallet_id,
      amount: Number(transfer.amount)
    });
    assertBalanced(entries);
    await client.query(
      `INSERT INTO journal_transactions(journal_tx_id, transfer_id, revision, kind, asset, amount)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [journalTxId, transfer.transfer_id, revision, transfer.kind, transfer.asset, transfer.amount]
    );
    for (const entry of entries) {
      await client.query(
        `INSERT INTO journal_entries(
           journal_entry_id, journal_tx_id, ordinal, revision, wallet_id, side, delta, amount
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [entry.entryId, journalTxId, entry.ordinal, revision, entry.walletId, entry.side, entry.delta, entry.amount]
      );
    }
    const sourceUpdate = await client.query(
      `UPDATE wallets SET balance = balance - $2, balance_revision = $3, updated_at = clock_timestamp()
       WHERE wallet_id = $1 RETURNING balance::text`,
      [source.wallet_id, transfer.amount, revision]
    );
    const destinationUpdate = await client.query(
      `UPDATE wallets SET balance = balance + $2, balance_revision = $3, updated_at = clock_timestamp()
       WHERE wallet_id = $1 RETURNING balance::text`,
      [destination.wallet_id, transfer.amount, revision]
    );
    const cause = transfer.kind === 'reversal' ? 'reversal' : 'transfer';
    await client.query(
      `INSERT INTO wallet_balance_versions(wallet_id, revision, balance, cause)
       VALUES ($1, $3, $4, $5), ($2, $3, $6, $5)`,
      [source.wallet_id, destination.wallet_id, revision, sourceUpdate.rows[0].balance, cause,
        destinationUpdate.rows[0].balance]
    );
    return {
      revision,
      journalTxId,
      entries,
      sourceBalance: sourceUpdate.rows[0].balance,
      destinationBalance: destinationUpdate.rows[0].balance
    };
  }

  validateLockedTransfer(transfer, wallets) {
    const source = wallets.get(transfer.source_wallet_id);
    const destination = wallets.get(transfer.destination_wallet_id);
    if (source.state !== 'active' || destination.state !== 'active') return 'wallet_not_active';
    if (source.generation !== transfer.expected_source_generation ||
        destination.generation !== transfer.expected_destination_generation) return 'stale_wallet_generation';
    if (BigInt(source.balance) < BigInt(transfer.amount)) return 'insufficient_balance';
    return null;
  }

  async postTransfer(input, { afterCommit: hook } = {}) {
    const intentDigest = digest({ operation: 'post_transfer', transferId: input.transferId });
    const result = await this.tx(async (client) => {
      const replay = await this.claimReceipt(client, 'post_transfer', input.requestKey, intentDigest);
      if (replay) return replay;
      const transferQuery = await client.query(
        'SELECT * FROM transfer_intents WHERE transfer_id = $1 FOR UPDATE', [input.transferId]
      );
      if (transferQuery.rows.length === 0) fail('not_found', 'transfer is not retained', 404);
      const transfer = transferQuery.rows[0];
      if (transfer.state === 'posted') {
        return this.completeReceipt(client, 'post_transfer', input.requestKey, transfer.posted_result);
      }
      const wallets = await this.lockWallets(client, [transfer.source_wallet_id, transfer.destination_wallet_id]);
      const rejectionCode = this.validateLockedTransfer(transfer, wallets);
      if (rejectionCode) {
        const output = publicResult({ transferId: transfer.transfer_id, state: 'rejected', code: rejectionCode });
        return this.completeReceipt(client, 'post_transfer', input.requestKey, output);
      }
      const committed = await this.commitJournal(client, transfer, wallets, 'transfer_posted');
      if (committed.rejection) {
        return this.completeReceipt(client, 'post_transfer', input.requestKey, committed.rejection);
      }
      const output = publicResult({
        transferId: transfer.transfer_id,
        kind: transfer.kind,
        state: 'posted',
        authorityRevision: committed.revision,
        journalTransactionId: committed.journalTxId,
        journalEntryIds: committed.entries.map((entry) => entry.entryId),
        sourceBalance: committed.sourceBalance,
        destinationBalance: committed.destinationBalance,
        journalPosted: true
      });
      await client.query(
        `UPDATE transfer_intents SET state = 'posted', posted_revision = $2, journal_tx_id = $3,
           posted_result = $4, posted_at = clock_timestamp() WHERE transfer_id = $1`,
        [transfer.transfer_id, committed.revision, committed.journalTxId, output]
      );
      return this.completeReceipt(client, 'post_transfer', input.requestKey, output);
    });
    return afterCommit(hook, result);
  }

  async reverseTransfer(input, { afterCommit: hook } = {}) {
    const intent = {
      operation: 'reverse_transfer', originalTransferId: input.originalTransferId,
      reversalTransferId: input.reversalTransferId,
      expectedCurrentHolderGeneration: input.expectedCurrentHolderGeneration,
      expectedOriginalSourceGeneration: input.expectedOriginalSourceGeneration
    };
    const intentDigest = digest(intent);
    const result = await this.tx(async (client) => {
      const replay = await this.claimReceipt(client, 'reverse_transfer', input.requestKey, intentDigest);
      if (replay) return replay;
      const originalQuery = await client.query(
        'SELECT * FROM transfer_intents WHERE transfer_id = $1 FOR UPDATE', [input.originalTransferId]
      );
      if (originalQuery.rows.length === 0) fail('not_found', 'original transfer is not retained', 404);
      const original = originalQuery.rows[0];
      if (original.kind !== 'transfer' || original.state !== 'posted') {
        fail('invalid_state', 'only a posted ordinary transfer can be reversed', 409);
      }
      await this.identityLock(client, `transfer:${input.reversalTransferId}`);
      const existingById = await client.query(
        'SELECT * FROM transfer_intents WHERE transfer_id = $1 FOR UPDATE', [input.reversalTransferId]
      );
      const existingByOriginal = await client.query(
        `SELECT * FROM transfer_intents WHERE original_transfer_id = $1 FOR UPDATE`, [input.originalTransferId]
      );
      const existing = existingById.rows[0] ?? existingByOriginal.rows[0];
      if (existing) {
        if (existing.transfer_id !== input.reversalTransferId || existing.intent_digest !== intentDigest ||
            existing.original_transfer_id !== input.originalTransferId) {
          fail('already_reversed', 'original transfer already has a different reversal', 409);
        }
        return this.completeReceipt(client, 'reverse_transfer', input.requestKey, existing.posted_result);
      }
      const count = await client.query('SELECT count(*)::integer AS count FROM transfer_intents');
      if (count.rows[0].count >= LIMITS.transfers) {
        const output = publicResult({
          transferId: input.reversalTransferId, state: 'rejected', code: 'transfer_capacity_reached'
        });
        return this.completeReceipt(client, 'reverse_transfer', input.requestKey, output);
      }
      const reversal = {
        transfer_id: input.reversalTransferId,
        kind: 'reversal',
        original_transfer_id: input.originalTransferId,
        source_wallet_id: original.destination_wallet_id,
        destination_wallet_id: original.source_wallet_id,
        amount: original.amount,
        asset: original.asset,
        expected_source_generation: input.expectedCurrentHolderGeneration,
        expected_destination_generation: input.expectedOriginalSourceGeneration,
        intent_digest: intentDigest
      };
      const wallets = await this.lockWallets(client, [reversal.source_wallet_id, reversal.destination_wallet_id]);
      const rejectionCode = this.validateLockedTransfer(reversal, wallets);
      if (rejectionCode) {
        const output = publicResult({
          transferId: input.reversalTransferId,
          originalTransferId: input.originalTransferId,
          state: 'rejected',
          code: rejectionCode
        });
        return this.completeReceipt(client, 'reverse_transfer', input.requestKey, output);
      }
      const committed = await this.commitJournal(client, reversal, wallets, 'reversal_posted');
      if (committed.rejection) {
        return this.completeReceipt(client, 'reverse_transfer', input.requestKey, committed.rejection);
      }
      const output = publicResult({
        transferId: reversal.transfer_id,
        originalTransferId: reversal.original_transfer_id,
        kind: 'reversal',
        state: 'posted',
        authorityRevision: committed.revision,
        journalTransactionId: committed.journalTxId,
        journalEntryIds: committed.entries.map((entry) => entry.entryId),
        sourceBalance: committed.sourceBalance,
        destinationBalance: committed.destinationBalance,
        journalPosted: true
      });
      await client.query(
        `INSERT INTO transfer_intents(
           transfer_id, kind, original_transfer_id, source_wallet_id, destination_wallet_id, amount, asset,
           expected_source_generation, expected_destination_generation, intent_digest, state,
           posted_revision, journal_tx_id, posted_result, posted_at
         ) VALUES ($1, 'reversal', $2, $3, $4, $5, $6, $7, $8, $9, 'posted', $10, $11, $12, clock_timestamp())`,
        [reversal.transfer_id, reversal.original_transfer_id, reversal.source_wallet_id,
          reversal.destination_wallet_id, reversal.amount, reversal.asset,
          reversal.expected_source_generation, reversal.expected_destination_generation, reversal.intent_digest,
          committed.revision, committed.journalTxId, output]
      );
      return this.completeReceipt(client, 'reverse_transfer', input.requestKey, output);
    });
    return afterCommit(hook, result);
  }

  async publishStatement(input, { afterCommit: hook } = {}) {
    const intent = {
      operation: 'publish_statement', statementId: input.statementId,
      walletId: input.walletId, asOfRevision: input.asOfRevision
    };
    const intentDigest = digest(intent);
    const result = await this.tx(async (client) => {
      const replay = await this.claimReceipt(client, 'publish_statement', input.requestKey, intentDigest);
      if (replay) return replay;
      await this.identityLock(client, `statement:${input.statementId}`);
      const existing = await client.query(
        'SELECT * FROM statements WHERE statement_id = $1 OR request_key = $2 FOR UPDATE',
        [input.statementId, input.requestKey]
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.statement_id !== input.statementId || row.intent_digest !== intentDigest) {
          fail('intent_conflict', 'statement identity is bound to changed immutable intent', 409);
        }
        return this.completeReceipt(client, 'publish_statement', input.requestKey, row.result);
      }
      const count = await client.query('SELECT count(*)::integer AS count FROM statements');
      if (count.rows[0].count >= LIMITS.statements) {
        const output = publicResult({ state: 'rejected', code: 'statement_capacity_reached' });
        return this.completeReceipt(client, 'publish_statement', input.requestKey, output);
      }
      const authority = await client.query(
        'SELECT current_revision::text FROM authority_state WHERE singleton = true'
      );
      const currentRevision = authority.rows[0].current_revision;
      const asOfRevision = input.asOfRevision === null ? currentRevision : String(input.asOfRevision);
      if (BigInt(asOfRevision) > BigInt(currentRevision)) {
        fail('invalid_revision', 'statement revision is beyond current authority', 409);
      }
      const walletQuery = await client.query(
        `SELECT w.*, e.state AS snapshot_state, e.generation AS snapshot_generation
         FROM wallets w
         JOIN LATERAL (
           SELECT state, generation FROM wallet_events
           WHERE wallet_id = w.wallet_id AND revision <= $2
           ORDER BY revision DESC LIMIT 1
         ) e ON true
         WHERE w.wallet_id = $1`,
        [input.walletId, asOfRevision]
      );
      if (walletQuery.rows.length === 0) fail('not_found', 'wallet did not exist at statement revision', 404);
      const wallet = walletQuery.rows[0];
      const entriesQuery = await client.query(
        `SELECT journal_entry_id, revision::text AS authority_revision, side, delta::text
         FROM journal_entries WHERE wallet_id = $1 AND revision <= $2
         ORDER BY revision, journal_entry_id`,
        [input.walletId, asOfRevision]
      );
      let running = BigInt(wallet.initial_balance);
      const items = entriesQuery.rows.map((row, index) => {
        running += BigInt(row.delta);
        if (running < 0n) fail('invariant_violation', 'statement replay produced a negative balance', 500);
        return {
          ordinal: index + 1,
          journalEntryId: row.journal_entry_id,
          authorityRevision: row.authority_revision,
          side: row.side,
          delta: row.delta,
          resultingBalance: running.toString()
        };
      });
      const metadata = {
        statementId: input.statementId,
        walletId: input.walletId,
        walletGeneration: wallet.snapshot_generation,
        asOfRevision,
        openingBalance: wallet.initial_balance,
        closingBalance: running.toString(),
        entryCount: items.length
      };
      const orderedDigest = statementDigest(metadata, items);
      const output = publicResult({
        ...metadata,
        orderedDigest,
        firstCursor: encodeCursor({ statementId: input.statementId, orderedDigest, nextOrdinal: 0 }),
        statementPublished: true,
        readerAcknowledged: false
      });
      await client.query(
        `INSERT INTO statements(
           statement_id, request_key, intent_digest, wallet_id, wallet_generation, as_of_revision,
           opening_balance, closing_balance, entry_count, ordered_digest, result
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [input.statementId, input.requestKey, intentDigest, input.walletId, wallet.snapshot_generation,
          asOfRevision, wallet.initial_balance, running.toString(), items.length, orderedDigest, output]
      );
      for (const item of items) {
        await client.query(
          `INSERT INTO statement_items(
             statement_id, ordinal, journal_entry_id, authority_revision, side, delta, resulting_balance
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [input.statementId, item.ordinal, item.journalEntryId, item.authorityRevision,
            item.side, item.delta, item.resultingBalance]
        );
      }
      return this.completeReceipt(client, 'publish_statement', input.requestKey, output);
    }, { isolation: 'REPEATABLE READ' });
    return afterCommit(hook, result);
  }

  async getStatementPage(statementId, cursor, pageLimit) {
    return this.tx(async (client) => {
      const statementQuery = await client.query('SELECT * FROM statements WHERE statement_id = $1', [statementId]);
      if (statementQuery.rows.length === 0) fail('not_found', 'statement is not retained', 404);
      const statement = statementQuery.rows[0];
      let nextOrdinal = 0;
      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (decoded.statementId !== statementId || decoded.orderedDigest !== statement.ordered_digest) {
          fail('invalid_cursor', 'cursor is bound to a different statement publication', 409);
        }
        nextOrdinal = decoded.nextOrdinal;
      }
      const cursorKey = cursor ?? 'start';
      const prior = await client.query(
        `SELECT result FROM statement_page_receipts
         WHERE statement_id = $1 AND cursor_key = $2 AND page_limit = $3`,
        [statementId, cursorKey, pageLimit]
      );
      if (prior.rows.length === 1) return prior.rows[0].result;
      const pageCount = await client.query('SELECT count(*)::integer AS count FROM statement_page_receipts');
      if (pageCount.rows[0].count >= LIMITS.pageReceipts) {
        fail('page_capacity_reached', 'statement page receipt bound is exhausted', 429);
      }
      const itemsQuery = await client.query(
        `SELECT ordinal, journal_entry_id, authority_revision::text, side, delta::text, resulting_balance::text
         FROM statement_items WHERE statement_id = $1 AND ordinal > $2
         ORDER BY ordinal LIMIT $3`,
        [statementId, nextOrdinal, pageLimit + 1]
      );
      const hasMore = itemsQuery.rows.length > pageLimit;
      const selected = itemsQuery.rows.slice(0, pageLimit).map((row) => ({
        ordinal: row.ordinal,
        journalEntryId: row.journal_entry_id,
        authorityRevision: row.authority_revision,
        side: row.side,
        delta: row.delta,
        resultingBalance: row.resulting_balance
      }));
      const lastOrdinal = selected.length > 0 ? selected.at(-1).ordinal : nextOrdinal;
      const nextCursor = hasMore
        ? encodeCursor({ statementId, orderedDigest: statement.ordered_digest, nextOrdinal: lastOrdinal })
        : null;
      const body = {
        statementId,
        asOfRevision: statement.as_of_revision,
        orderedDigest: statement.ordered_digest,
        items: selected,
        nextCursor,
        readerAcknowledged: false,
        externalAcceptance: false
      };
      const resultDigest = digest(body);
      const result = { ...body, pageDigest: resultDigest };
      const inserted = await client.query(
        `INSERT INTO statement_page_receipts(statement_id, cursor_key, page_limit, result_digest, result)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (statement_id, cursor_key, page_limit) DO NOTHING RETURNING result`,
        [statementId, cursorKey, pageLimit, resultDigest, result]
      );
      if (inserted.rows.length === 1) return inserted.rows[0].result;
      const raced = await client.query(
        `SELECT result FROM statement_page_receipts
         WHERE statement_id = $1 AND cursor_key = $2 AND page_limit = $3`,
        [statementId, cursorKey, pageLimit]
      );
      return raced.rows[0].result;
    });
  }

  async runAudit(input, { afterCommit: hook } = {}) {
    const intent = { operation: 'run_audit', auditId: input.auditId, asOfRevision: input.asOfRevision };
    const intentDigest = digest(intent);
    const result = await this.tx(async (client) => {
      const replay = await this.claimReceipt(client, 'run_audit', input.requestKey, intentDigest);
      if (replay) return replay;
      await this.identityLock(client, `audit:${input.auditId}`);
      const existing = await client.query(
        'SELECT * FROM audits WHERE audit_id = $1 OR request_key = $2 FOR UPDATE',
        [input.auditId, input.requestKey]
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.audit_id !== input.auditId || row.intent_digest !== intentDigest) {
          fail('intent_conflict', 'audit identity is bound to changed immutable intent', 409);
        }
        return this.completeReceipt(client, 'run_audit', input.requestKey, row.result);
      }
      const count = await client.query('SELECT count(*)::integer AS count FROM audits');
      if (count.rows[0].count >= LIMITS.audits) {
        const output = publicResult({ state: 'rejected', code: 'audit_capacity_reached' });
        return this.completeReceipt(client, 'run_audit', input.requestKey, output);
      }
      const authority = await client.query(
        `SELECT a.current_revision::text, c.genesis_supply::text
         FROM authority_state a CROSS JOIN lab_config c
         WHERE a.singleton = true AND c.singleton = true`
      );
      const currentRevision = authority.rows[0].current_revision;
      const genesisSupply = authority.rows[0].genesis_supply;
      const asOfRevision = input.asOfRevision === null ? currentRevision : String(input.asOfRevision);
      if (BigInt(asOfRevision) > BigInt(currentRevision)) {
        fail('invalid_revision', 'audit revision is beyond current authority', 409);
      }
      const balances = await client.query(
        `WITH existing AS (
           SELECT w.* FROM wallets w
           WHERE EXISTS (
             SELECT 1 FROM wallet_events e
             WHERE e.wallet_id = w.wallet_id AND e.event_kind = 'created' AND e.revision <= $1
           )
         ), journal AS (
           SELECT wallet_id, COALESCE(sum(delta), 0)::text AS delta
           FROM journal_entries WHERE revision <= $1 GROUP BY wallet_id
         ), versions AS (
           SELECT DISTINCT ON (wallet_id) wallet_id, balance::text AS version_balance
           FROM wallet_balance_versions WHERE revision <= $1
           ORDER BY wallet_id, revision DESC
         )
         SELECT e.wallet_id, e.initial_balance::text, e.balance::text AS materialized_balance,
                COALESCE(j.delta, '0') AS journal_delta, v.version_balance
         FROM existing e LEFT JOIN journal j USING (wallet_id) LEFT JOIN versions v USING (wallet_id)
         ORDER BY e.wallet_id`,
        [asOfRevision]
      );
      let recomputedTotal = 0n;
      let versionTotal = 0n;
      let materializedTotal = 0n;
      let balanceMismatchCount = 0;
      for (const row of balances.rows) {
        const recomputed = BigInt(row.initial_balance) + BigInt(row.journal_delta);
        const versionBalance = row.version_balance === null ? -1n : BigInt(row.version_balance);
        recomputedTotal += recomputed;
        versionTotal += versionBalance;
        materializedTotal += BigInt(row.materialized_balance);
        if (recomputed !== versionBalance ||
            (asOfRevision === currentRevision && recomputed !== BigInt(row.materialized_balance))) {
          balanceMismatchCount += 1;
        }
      }
      const journalSummary = await client.query(
        `SELECT count(*)::integer AS transaction_count,
                COALESCE(sum(entry_count) FILTER (WHERE entry_count IS NOT NULL), 0)::integer AS entry_count,
                count(*) FILTER (
                  WHERE entry_count <> 2 OR signed_total <> 0 OR debit_count <> 1 OR credit_count <> 1
                )::integer AS mismatch_count
         FROM (
           SELECT jt.journal_tx_id, count(je.*)::integer AS entry_count,
                  COALESCE(sum(je.delta), 0) AS signed_total,
                  count(*) FILTER (WHERE je.side = 'debit') AS debit_count,
                  count(*) FILTER (WHERE je.side = 'credit') AS credit_count
           FROM journal_transactions jt LEFT JOIN journal_entries je USING (journal_tx_id)
           WHERE jt.revision <= $1 GROUP BY jt.journal_tx_id
         ) grouped`,
        [asOfRevision]
      );
      const summary = journalSummary.rows[0];
      const internalConsistency = balanceMismatchCount === 0 && summary.mismatch_count === 0 &&
        recomputedTotal === BigInt(genesisSupply) && versionTotal === BigInt(genesisSupply) &&
        (asOfRevision !== currentRevision || materializedTotal === BigInt(genesisSupply));
      const digestInput = {
        auditId: input.auditId,
        asOfRevision,
        walletCount: balances.rows.length,
        journalTransactionCount: summary.transaction_count,
        journalEntryCount: summary.entry_count,
        balanceMismatchCount,
        journalMismatchCount: summary.mismatch_count,
        genesisSupply,
        recomputedTotal: recomputedTotal.toString(),
        versionTotal: versionTotal.toString(),
        materializedTotal: asOfRevision === currentRevision ? materializedTotal.toString() : null,
        internalConsistency
      };
      const auditDigest = digest(digestInput);
      const output = publicResult({
        ...digestInput,
        auditDigest,
        externalReconciliation: false,
        financialAudit: false
      });
      await client.query(
        `INSERT INTO audits(
           audit_id, request_key, intent_digest, as_of_revision, internal_consistency, wallet_count,
           journal_transaction_count, journal_entry_count, balance_mismatch_count, journal_mismatch_count,
           genesis_supply, recomputed_total, version_total, materialized_total, audit_digest, result
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [input.auditId, input.requestKey, intentDigest, asOfRevision, internalConsistency, balances.rows.length,
          summary.transaction_count, summary.entry_count, balanceMismatchCount, summary.mismatch_count,
          genesisSupply, recomputedTotal.toString(), versionTotal.toString(),
          asOfRevision === currentRevision ? materializedTotal.toString() : null, auditDigest, output]
      );
      return this.completeReceipt(client, 'run_audit', input.requestKey, output);
    }, { isolation: 'REPEATABLE READ' });
    return afterCommit(hook, result);
  }

  async getWalletEvidence(walletId) {
    const walletQuery = await this.pool.query('SELECT * FROM wallets WHERE wallet_id = $1', [walletId]);
    if (walletQuery.rows.length === 0) fail('not_found', 'wallet is not retained', 404);
    const [events, transfers, entries, statements] = await Promise.all([
      this.pool.query(
        `SELECT revision::text, event_kind, state, generation FROM wallet_events
         WHERE wallet_id = $1 ORDER BY revision`, [walletId]
      ),
      this.pool.query(
        `SELECT transfer_id, kind, original_transfer_id, source_wallet_id, destination_wallet_id,
                amount::text, state, posted_revision::text
         FROM transfer_intents WHERE source_wallet_id = $1 OR destination_wallet_id = $1
         ORDER BY created_at, transfer_id`, [walletId]
      ),
      this.pool.query(
        `SELECT journal_entry_id, journal_tx_id, revision::text, side, delta::text
         FROM journal_entries WHERE wallet_id = $1 ORDER BY revision, journal_entry_id`, [walletId]
      ),
      this.pool.query(
        `SELECT statement_id, as_of_revision::text, entry_count, ordered_digest
         FROM statements WHERE wallet_id = $1 ORDER BY created_at`, [walletId]
      )
    ]);
    return publicResult({
      wallet: walletView(walletQuery.rows[0]),
      walletEvents: events.rows,
      transfers: transfers.rows,
      journalEntries: entries.rows,
      statements: statements.rows,
      internalAuthority: 'postgresql',
      externalReconciliation: false
    });
  }

  async health() {
    const { rows } = await this.pool.query(
      `SELECT c.schema_version, a.current_revision::text
       FROM lab_config c CROSS JOIN authority_state a
       WHERE c.singleton = true AND a.singleton = true`
    );
    if (rows.length !== 1 || rows[0].schema_version !== 1) {
      fail('invariant_violation', 'wallet authority schema is unavailable', 500);
    }
    return { status: 'ok', schemaVersion: 1, currentRevision: rows[0].current_revision };
  }

  async getState() {
    const { rows } = await this.pool.query(`
      SELECT
        (SELECT current_revision::text FROM authority_state WHERE singleton = true) AS current_revision,
        (SELECT genesis_supply::text FROM lab_config WHERE singleton = true) AS genesis_supply,
        (SELECT count(*)::integer FROM wallets) AS wallet_count,
        (SELECT count(*)::integer FROM transfer_intents) AS transfer_count,
        (SELECT count(*)::integer FROM transfer_intents WHERE state = 'prepared') AS prepared_transfer_count,
        (SELECT count(*)::integer FROM journal_transactions) AS journal_transaction_count,
        (SELECT count(*)::integer FROM journal_entries) AS journal_entry_count,
        (SELECT count(*)::integer FROM statements) AS statement_count,
        (SELECT count(*)::integer FROM statement_page_receipts) AS page_receipt_count,
        (SELECT count(*)::integer FROM audits) AS audit_count,
        (SELECT COALESCE(sum(balance), 0)::text FROM wallets) AS materialized_total,
        (SELECT count(*)::integer FROM (
           SELECT jt.journal_tx_id FROM journal_transactions jt
           LEFT JOIN journal_entries je USING (journal_tx_id)
           GROUP BY jt.journal_tx_id
           HAVING count(je.*) <> 2 OR COALESCE(sum(je.delta), 0) <> 0
         ) bad) AS unbalanced_transaction_count
    `);
    return publicResult({
      currentRevision: rows[0].current_revision,
      genesisSupply: rows[0].genesis_supply,
      walletCount: rows[0].wallet_count,
      transferCount: rows[0].transfer_count,
      preparedTransferCount: rows[0].prepared_transfer_count,
      journalTransactionCount: rows[0].journal_transaction_count,
      journalEntryCount: rows[0].journal_entry_count,
      statementCount: rows[0].statement_count,
      pageReceiptCount: rows[0].page_receipt_count,
      auditCount: rows[0].audit_count,
      materializedTotal: rows[0].materialized_total,
      unbalancedTransactionCount: rows[0].unbalanced_transaction_count,
      externalReconciliation: false
    });
  }
}
