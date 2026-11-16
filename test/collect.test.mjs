import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../src/source.mjs';
import { collect } from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

async function run(scenario, check, mutate) {
  const source = await fixture(scenario);
  if (mutate) mutate(source);
  const store = new Inbox();
  try {
    const result = await collect(source, store);
    await check(result, source, store);
  } finally { store.close(); await source.close(); }
}

test('excluded configuration is not coverage and suspended scope stays evidence-only', async () => {
  await run('normal', async (result, source, store) => {
    const l1 = result.records.find(record => record.line === 'L1');
    const l2 = result.records.find(record => record.line === 'L2');
    assert.equal(l1.coverage, 'not-covered');
    assert.equal(l2.coverage, 'covered');
    assert.deepEqual(l2.revisions, ['r1']);
    assert.ok(l1.trail.some(entry => entry.verdict === 'excluded'));
    assert.ok(l1.trail.some(entry => entry.verdict === 'inactive-status'));
    assert.ok(result.diagnostics.some(entry => entry.issue === 'candidate-inactive' && entry.candidate === 'C-102'));
    const known = new Set(store.evidence().map(row => row.id));
    for (const record of result.records) {
      assert.ok(record.evidence.length > 0);
      for (const id of record.evidence) assert.ok(known.has(id), `evidence ${id} is in the inbox`);
    }
  });
});

test('alias mapping is exact after trim and keeps original line identity', async () => {
  await run('normal', async result => {
    const l3 = result.records.find(record => record.line === 'L3');
    assert.equal(l3.canonicalModel, 'E-9');
    assert.equal(l3.coverage, 'covered');
    const l4 = result.records.find(record => record.line === 'L4');
    assert.equal(l4.coverage, 'unknown');
    assert.equal(l4.reason, 'alias-unmapped');
    assert.ok(result.pending.some(entry => entry.line === 'L4'));
    assert.ok(!result.records.some(record => record.line === 'L3' && record.model === 'City Nine'));
  }, source => {
    source.orders = [...source.orders,
      { line: 'L3', model: ' City Nine ', battery: 'B-60' },
      { line: 'L4', model: 'City', battery: 'B-48' }];
  });
});

test('an empty exclusion entry is not a wildcard', async () => {
  await run('wildcard', async result => {
    const l1 = result.records.find(record => record.line === 'L1');
    assert.equal(l1.coverage, 'covered');
    assert.deepEqual(l1.revisions, ['r1']);
  });
});

test('a missing appendix leaves the line unknown instead of not-covered', async () => {
  await run('missing', async result => {
    const l2 = result.records.find(record => record.line === 'L2');
    assert.equal(l2.coverage, 'unknown');
    assert.equal(l2.reason, 'candidate-open');
    assert.ok(result.diagnostics.some(entry => entry.issue === 'appendix-unavailable' && entry.candidate === 'C-101'));
    assert.ok(result.pending.some(entry => entry.line === 'L2'));
  });
});

test('revision churn restarts the certificate and never mixes revisions', async () => {
  await run('revision', async (result, source, store) => {
    const l2 = result.records.find(record => record.line === 'L2');
    assert.equal(l2.coverage, 'covered');
    assert.deepEqual(l2.revisions, ['r2']);
    assert.ok(result.diagnostics.some(entry => entry.issue === 'revision-changed' && entry.candidate === 'C-101'));
    const appendixMeta = store.evidence()
      .filter(row => row.kind === 'appendix' && row.metadata.candidate === 'C-101')
      .map(row => row.metadata);
    assert.ok(appendixMeta.some(meta => meta.revision === 'r1'), 'rejected r1 attempt stays as evidence');
    assert.ok(appendixMeta.some(meta => meta.revision === 'r2'), 'r2 appendices are fetched');
  });
});

test('no candidates is reported separately from closed-without-coverage', async () => {
  await run('empty', async result => {
    assert.equal(result.records.length, 2);
    for (const record of result.records) {
      assert.equal(record.coverage, 'unknown');
      assert.equal(record.reason, 'no-candidates');
      assert.ok(record.evidence.length > 0);
    }
    assert.ok(result.diagnostics.some(entry => entry.issue === 'no-candidates'));
    assert.equal(result.pending.length, 2);
  });
});

test('records are persisted as receipts in the inbox', async () => {
  await run('normal', async (result, source, store) => {
    const stored = store.list('collect-records');
    assert.equal(stored.length, result.records.length);
    assert.ok(stored.every(row => row.coverage && row.evidence.length > 0));
    assert.equal(store.list('collect-runs').length, 1);
  });
});
