import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../src/source.mjs';
import * as intake from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

async function run(scenario, check) {
  assert.equal(typeof intake.collect, 'function', 'collection entry is not available yet');
  const source = await fixture(scenario); const store = new Inbox();
  try {
    const result = await intake.collect(source, store);
    await check(result, source, store);
  } finally { store.close(); await source.close(); }
}

test('model configuration and certificate activity are separate facts', async () => {
  await run('normal', async result => {
    assert.equal(result.records.find(row => row.line === 'L1').coverage, 'not-covered');
    assert.equal(result.records.find(row => row.line === 'L2').coverage, 'covered');
    assert.ok(result.records.every(row => row.evidence.length > 0));
  });
});
test('missing appendix is not negative coverage', async () => {
  await run('missing', async result => {
    assert.equal(result.records.find(row => row.line === 'L2').coverage, 'unknown');
  });
});
test('a revision change cannot publish a cross-revision proof', async () => {
  await run('revision', async result => {
    for (const record of result.records) {
      if (record.coverage === 'covered') assert.equal(new Set(record.revisions).size, 1);
    }
    assert.ok(result.records.length === 2);
  });
});
