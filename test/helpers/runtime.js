import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { WalletRepository } from '../../src/repository.js';
import { WalletService } from '../../src/service.js';

export async function createRuntime(databaseUrl, { reset = false } = {}) {
  const pool = new Pool({ connectionString: databaseUrl, max: 20 });
  const repository = await new WalletRepository(pool).init();
  if (reset) await repository.reset();
  const service = new WalletService(repository);
  return { pool, repository, service, close: () => repository.close() };
}

export function walletFixture(suffix) {
  return {
    requestKey: `req_wallet_${suffix}`,
    walletId: `wallet_${suffix}`,
    kind: 'user',
    asset: 'LAB'
  };
}

export function transferFixture(suffix, sourceWalletId, destinationWalletId, amount, {
  sourceGeneration = 1,
  destinationGeneration = 1
} = {}) {
  return {
    requestKey: `req_prepare_${suffix}`,
    transferId: `transfer_${suffix}`,
    sourceWalletId,
    destinationWalletId,
    amount,
    asset: 'LAB',
    expectedSourceGeneration: sourceGeneration,
    expectedDestinationGeneration: destinationGeneration
  };
}

export async function createWallet(service, suffix) {
  return service.createWallet(walletFixture(suffix));
}

export async function prepareAndPost(service, suffix, sourceWalletId, destinationWalletId, amount, generations) {
  const transfer = transferFixture(suffix, sourceWalletId, destinationWalletId, amount, generations);
  const prepared = await service.prepareTransfer(transfer);
  if (prepared.state !== 'prepared') return { transfer, prepared, posted: null };
  const posted = await service.postTransfer(transfer.transferId, { requestKey: `req_post_${suffix}` });
  return { transfer, prepared, posted };
}

export async function waitForMarker(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(20);
  }
  throw new Error('failpoint marker timed out');
}

export async function killWorkerAt({ databaseUrl, directory, counter, operation, payload }) {
  const marker = `${directory}/marker-${counter}`;
  const child = spawn(process.execPath, ['scripts/crash-worker.mjs', operation], {
    cwd: new URL('../..', import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      FAILPOINT_MARKER_PATH: marker,
      CRASH_PAYLOAD: JSON.stringify(payload)
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let rejectEarly;
  const prematureExit = new Promise((_, reject) => { rejectEarly = reject; });
  const onEarlyExit = (code, signal) => {
    rejectEarly(new Error(`crash worker exited before marker (${code}/${signal}): ${stderr}`));
  };
  child.once('exit', onEarlyExit);
  await Promise.race([waitForMarker(marker), prematureExit]);
  child.removeListener('exit', onEarlyExit);
  child.kill('SIGKILL');
  const [code, signal] = await once(child, 'exit');
  return { code, signal };
}
