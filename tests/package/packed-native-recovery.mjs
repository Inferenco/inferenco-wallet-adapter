// Execute the real registered-provider and connection cases through an installed
// archive. The isolated consumer supplies Vitest/jsdom/fake-indexeddb; no source
// aliases are permitted. The native host responses are fixtures, not device tests.
// node tests/package/packed-native-recovery.mjs /absolute/consumer
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const consumer = realpathSync(resolve(process.argv[2] || '.'));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(consumer, 'package.json'));
const adapter = realpathSync(require.resolve('@inferenco/infer-wallet-adapter'));
assert.ok(adapter.startsWith(join(consumer, 'node_modules') + '/'), 'Must load an installed archive');
assert.ok(!adapter.startsWith(join(repository, 'src')), 'Source aliases are forbidden');
const directory = join(consumer, 'packed-native-recovery');
mkdirSync(directory, { recursive: true });
for (const name of ['nativeRegisteredWallet.conformance.test.ts', 'connectionSettlement.test.ts']) {
  let test = readFileSync(join(repository, 'tests', name), 'utf8');
  test = test
    .replaceAll('"../src/aip62"', '"@inferenco/infer-wallet-adapter/aip62"')
    .replaceAll('"../src/integrationContract"', '"@inferenco/infer-wallet-adapter"')
    .replaceAll('"../src/recovery"', '"@inferenco/infer-wallet-adapter"')
    .replaceAll('"../src/InferClient"', '"@inferenco/infer-wallet-adapter"')
    .replaceAll('"../src/InferWallet"', '"@inferenco/infer-wallet-adapter"');
  assert.ok(!test.includes('../src/'), 'Unmapped private source import in ' + name);
  writeFileSync(join(directory, name), test);
}
writeFileSync(join(directory, 'setup.ts'), readFileSync(join(repository, 'tests/setupIndexedDb.ts')));
writeFileSync(join(directory, 'vitest.config.mjs'), [
  "import { defineConfig } from 'vitest/config';",
  'export default defineConfig({ test: {',
  "environment: 'jsdom', globals: true, maxWorkers: 2,",
  'include: ' + JSON.stringify([relative(consumer, directory) + '/*.test.ts']) + ',',
  'setupFiles: ' + JSON.stringify([join(directory, 'setup.ts')]),
  '} });',
  ''
].join(String.fromCharCode(10)));
const result = spawnSync(process.execPath, [
  require.resolve('vitest/vitest.mjs'), 'run', '--config',
  join(directory, 'vitest.config.mjs'), '--reporter=json',
  '--outputFile=' + join(directory, 'results.json')
], { cwd: consumer, encoding: 'utf8', env: process.env });
assert.ifError(result.error);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
assert.equal(result.status, 0, 'Installed native/connection conformance failed');
const report = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8'));
assert.equal(report.numPendingTests, 0, 'Actual registered provider suite must run, not skip');
console.log(JSON.stringify({ installedAdapter: adapter, passed: report.numPassedTests,
  report: join(directory, 'results.json'), nativeHost: 'fixture', walletProvider: 'real template and generated codec' }, null, 2));
