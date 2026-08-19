import { createServer } from 'node:http';
import { LIMITS } from './contracts.js';
import { asDomainError, DomainError, fail } from './errors.js';

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > LIMITS.bodyBytes) fail('invalid_request', 'request body exceeds bound', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) fail('invalid_request', 'request body is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('invalid_request', 'request body must be valid JSON');
  }
}

function send(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store'
  });
  response.end(encoded);
}

function segment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail('invalid_request', 'route identity is malformed');
  }
}

export function createRequestHandler(service) {
  return async (request, response) => {
    try {
      const url = new URL(request.url, 'http://wallet.invalid');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return send(response, 200, await service.health());
      }
      if (request.method === 'GET' && url.pathname === '/v1/state') {
        return send(response, 200, await service.getState());
      }
      if (request.method === 'POST' && url.pathname === '/v1/wallets') {
        return send(response, 201, await service.createWallet(await readBody(request)));
      }
      let match = url.pathname.match(/^\/v1\/wallets\/([^/]+)\/(freeze|activate|close)$/);
      if (request.method === 'POST' && match) {
        return send(response, 200, await service.transitionWallet(segment(match[1]), match[2], await readBody(request)));
      }
      match = url.pathname.match(/^\/v1\/wallets\/([^/]+)\/evidence$/);
      if (request.method === 'GET' && match) {
        return send(response, 200, await service.getWalletEvidence(segment(match[1])));
      }
      if (request.method === 'POST' && url.pathname === '/v1/transfers') {
        return send(response, 201, await service.prepareTransfer(await readBody(request)));
      }
      match = url.pathname.match(/^\/v1\/transfers\/([^/]+)\/post$/);
      if (request.method === 'POST' && match) {
        return send(response, 200, await service.postTransfer(segment(match[1]), await readBody(request)));
      }
      match = url.pathname.match(/^\/v1\/transfers\/([^/]+)\/reverse$/);
      if (request.method === 'POST' && match) {
        return send(response, 200, await service.reverseTransfer(segment(match[1]), await readBody(request)));
      }
      if (request.method === 'POST' && url.pathname === '/v1/statements') {
        return send(response, 201, await service.publishStatement(await readBody(request)));
      }
      match = url.pathname.match(/^\/v1\/statements\/([^/]+)\/pages$/);
      if (request.method === 'GET' && match) {
        return send(response, 200, await service.getStatementPage(
          segment(match[1]), url.searchParams.get('cursor'), url.searchParams.get('limit') ?? '50'
        ));
      }
      if (request.method === 'POST' && url.pathname === '/v1/audits') {
        return send(response, 201, await service.runAudit(await readBody(request)));
      }
      return send(response, 404, { error: { code: 'not_found', message: 'route is not available' } });
    } catch (error) {
      const mapped = error instanceof DomainError ? error : asDomainError(error);
      return send(response, mapped.status, { error: { code: mapped.code, message: mapped.message } });
    }
  };
}

export async function createWalletServer(service, { host = '127.0.0.1', port = 0 } = {}) {
  const server = createServer(createRequestHandler(service));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}
