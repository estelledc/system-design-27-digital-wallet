import { Pool } from 'pg';
import { createWalletServer } from './http.js';
import { WalletRepository } from './repository.js';
import { WalletService } from './service.js';

function databaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value || !/^postgres(?:ql)?:\/\//.test(value)) {
    throw new Error('DATABASE_URL must be an explicit PostgreSQL URL');
  }
  return value;
}

async function main() {
  const command = process.argv[2] ?? 'serve';
  const pool = new Pool({ connectionString: databaseUrl(), max: 12 });
  const repository = await new WalletRepository(pool).init();
  if (command === 'migrate') {
    const health = await repository.health();
    process.stdout.write(`${JSON.stringify(health)}\n`);
    await repository.close();
    return;
  }
  if (command !== 'serve') throw new Error('command must be serve or migrate');
  const service = new WalletService(repository);
  const port = Number(process.env.PORT ?? 3000);
  const server = await createWalletServer(service, { host: '127.0.0.1', port });
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ status: 'ready', port: address.port })}\n`);
  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
}

main().catch((error) => {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
});
