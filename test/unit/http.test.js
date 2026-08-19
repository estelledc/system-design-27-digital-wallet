import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createWalletServer } from '../../src/http.js';

function fakeService() {
  return {
    health: async () => ({ status: 'ok', schemaVersion: 1, currentRevision: '1' }),
    createWallet: async (body) => ({ state: 'active', walletId: body.walletId })
  };
}

test('HTTP adapter exposes bounded JSON health and wallet creation', async () => {
  const server = await createWalletServer(fakeService());
  const { port } = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).schemaVersion, 1);
    const created = await fetch(`http://127.0.0.1:${port}/v1/wallets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletId: 'wallet_http' })
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).walletId, 'wallet_http');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('HTTP adapter sanitizes malformed JSON and missing routes', async () => {
  const server = await createWalletServer(fakeService());
  const { port } = server.address();
  try {
    const malformed = await fetch(`http://127.0.0.1:${port}/v1/wallets`, { method: 'POST', body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'invalid_request');
    const missing = await fetch(`http://127.0.0.1:${port}/unknown`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'not_found');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
