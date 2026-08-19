import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Pool } from 'pg';
import { WalletRepository } from '../src/repository.js';
import { WalletService } from '../src/service.js';

async function stopAfterCommit() {
  const markerPath = process.env.FAILPOINT_MARKER_PATH;
  if (!markerPath) throw new Error('FAILPOINT_MARKER_PATH is required');
  await mkdir(dirname(markerPath), { recursive: true });
  const handle = await open(markerPath, 'w', 0o600);
  try {
    await handle.writeFile('committed\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await new Promise(() => {});
}

async function main() {
  const operation = process.argv[2];
  const payload = JSON.parse(process.env.CRASH_PAYLOAD);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const repository = await new WalletRepository(pool).init();
  const service = new WalletService(repository);
  const options = { afterCommit: stopAfterCommit };

  if (operation === 'wallet-create-after-commit') {
    await service.createWallet(payload.wallet, options);
  } else if (operation === 'wallet-state-after-commit') {
    await service.transitionWallet(payload.walletId, payload.action, payload.input, options);
  } else if (operation === 'transfer-prepare-after-commit') {
    await service.prepareTransfer(payload.transfer, options);
  } else if (operation === 'transfer-post-after-commit') {
    await service.postTransfer(payload.transferId, payload.input, options);
  } else if (operation === 'reversal-after-commit') {
    await service.reverseTransfer(payload.transferId, payload.input, options);
  } else if (operation === 'statement-after-commit') {
    await service.publishStatement(payload.statement, options);
  } else if (operation === 'audit-after-commit') {
    await service.runAudit(payload.audit, options);
  } else {
    throw new Error('unsupported crash operation');
  }
}

main().catch((error) => {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
});
