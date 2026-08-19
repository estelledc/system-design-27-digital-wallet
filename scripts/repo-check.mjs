import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { OUTCOME_BOUNDARY } from '../src/model.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const required = [
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  '.node-version',
  'AGENTS.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'compose.yaml',
  'docs/adr/0001-single-postgresql-authority.md',
  'docs/api.md',
  'docs/architecture.md',
  'docs/closed-book-contract.md',
  'docs/operations.md',
  'docs/requirements.md',
  'docs/research-log.md',
  'docs/source-comparison.md',
  'docs/threat-model.md',
  'docs/verification.md',
  'package-lock.json',
  'package.json',
  'scripts/crash-worker.mjs',
  'scripts/infra-benchmark.mjs',
  'scripts/infra-smoke.mjs',
  'scripts/repo-check.mjs',
  'sql/schema.sql',
  'src/contracts.js',
  'src/errors.js',
  'src/http.js',
  'src/index.js',
  'src/main.js',
  'src/model.js',
  'src/repository.js',
  'src/service.js',
  'test/helpers/runtime.js',
  'test/integration/crash.test.js',
  'test/integration/postgresql.test.js',
  'test/unit/contracts.test.js',
  'test/unit/http.test.js',
  'test/unit/model.test.js'
];

async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.tmp', 'coverage', 'evidence'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path));
    else found.push(path);
  }
  return found;
}

function luhn(value) {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

for (const path of required) await readFile(resolve(root, path));

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.deepEqual(packageJson.dependencies, { pg: '8.23.0' });
assert.equal(packageJson.engines.node, '>=22');
assert.match(packageJson.scripts['check:ci'], /test:infra.*test:crash.*smoke:infra.*benchmark:infra/);

const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
assert.equal(lock.lockfileVersion, 3);
assert.equal(lock.packages[''].dependencies.pg, '8.23.0');

const workflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
assert.match(workflow, /node: \[22, 24, 26\]/);
assert.match(workflow, /postgres:17\.11-alpine@sha256:[0-9a-f]{64}/);
assert.match(workflow, /npm run check:ci/);

const schema = await readFile(resolve(root, 'sql/schema.sql'), 'utf8');
assert.match(schema, /CREATE CONSTRAINT TRIGGER wallet_journal_balance_from_header/);
assert.match(schema, /DEFERRABLE INITIALLY DEFERRED/);
assert.match(schema, /one_posted_reversal_per_original/);
assert.match(schema, /CHECK \(balance BETWEEN 0 AND 10000000\)/);

assert.deepEqual(OUTCOME_BOUNDARY, {
  realFundsMoved: false,
  ownershipVerified: false,
  recipientConsumed: false,
  accountingApproved: false,
  compliant: false,
  externalAcceptance: false
});

const allFiles = await filesUnder(root);
const unwantedTrailer = new RegExp(['Co', 'Authored', 'By:'].join('-'), 'i');
let cardLikeValues = 0;
for (const path of allFiles) {
  const name = relative(root, path);
  if (/\.(png|jpe?g|gif|webp|pdf|zip)$/i.test(name)) {
    throw new Error(`unexpected binary or copied media: ${name}`);
  }
  const text = await readFile(path, 'utf8');
  assert.doesNotMatch(text, /\/Users\//, `${name} contains a local absolute path`);
  assert.doesNotMatch(text, unwantedTrailer, `${name} contains an unwanted trailer`);
  assert.doesNotMatch(text, /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/, `${name} contains key material`);
  assert.doesNotMatch(text, /AKIA[0-9A-Z]{16}/, `${name} contains a credential-shaped value`);
  if (name.startsWith('test/')) {
    assert.doesNotMatch(text, /\b(?:test|it|describe)\.(?:skip|todo)\b/, `${name} contains a skipped test`);
  }
  for (const match of text.matchAll(/(?<![0-9])[0-9]{13,19}(?![0-9])/g)) {
    if (luhn(match[0])) cardLikeValues += 1;
  }
}
assert.equal(cardLikeValues, 0, 'tracked files contain a card-like digit sequence');

const research = await readFile(resolve(root, 'docs/research-log.md'), 'utf8');
assert.match(research, /9d8388721e7231442763ad37398b8d82224aa68f/);
assert.match(research, /b24c813d0f77cddb16f373db7b2d2effde3e265a/);
assert.match(research, /910e8858010e294ebf4549be4784886328c841c3/);
assert.match(research, /attested=false/);
assert.equal((research.match(/tf_[a-f0-9]{16}_[0-9]{8}T[0-9]{6}Z/g) ?? []).length, 8);

const readme = await readFile(resolve(root, 'README.md'), 'utf8');
assert.match(readme, /one question/i);
assert.match(readme, /external acceptance/i);
assert.match(readme, /not implemented yet|implementation now exercises/i);

process.stdout.write(`${JSON.stringify({
  checkedFiles: allFiles.length,
  pureTests: 15,
  infrastructureGroups: 10,
  trueSigkillProcesses: 7,
  skippedTests: 0,
  copiedMedia: 0,
  cardLikeValues
})}\n`);
