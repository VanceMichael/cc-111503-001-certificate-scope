import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../src/source.mjs';
import { serve, json } from '../src/http.mjs';
import { collect } from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

async function withFixture(scenario, check) {
  const source = await fixture(scenario);
  const store = new Inbox();
  try {
    await check(await collect(source, store), source, store);
  } finally { store.close(); await source.close(); }
}

// A source with a chosen candidate list, certificate set, order list and alias
// table, so each data convention can be exercised without another scenario.
async function withSource({ candidates = ['C-1'], certificates = {}, orders, aliases, search }, check) {
  const requests = [];
  const source = await serve((request, response) => {
    const url = new URL(request.url, 'http://source');
    requests.push(url.pathname + url.search);
    if (url.pathname === '/search') {
      if (search) return search(url, response);
      return json(response, 200, { candidates, next: null });
    }
    const detail = url.pathname.match(/^\/certificate\/([^/]+)$/);
    if (detail && certificates[detail[1]]) {
      const certificate = certificates[detail[1]];
      return json(response, 200, {
        id: detail[1],
        revision: certificate.revision ?? 'r1',
        status: certificate.status ?? 'active',
        appendices: certificate.appendices.map((_, index) => `/appendix/${detail[1]}/${index}`),
      });
    }
    const appendix = url.pathname.match(/^\/appendix\/([^/]+)\/(\d+)$/);
    if (appendix && certificates[appendix[1]]) {
      const entry = certificates[appendix[1]].appendices[Number(appendix[2])];
      const revision = url.searchParams.get('revision');
      if (typeof entry === 'function') return entry(revision, response);
      return json(response, 200, { revision, scope: entry });
    }
    return json(response, 404, { error: 'not found' });
  });
  const store = new Inbox();
  try {
    const result = await collect({
      ...source,
      orders: orders ?? [{ line: 'L1', model: 'M-1', battery: 'B-1' }],
      modelAliases: aliases ?? { 'M-1': 'M-1' },
    }, store);
    await check(result, { store, requests });
  } finally { store.close(); await source.close(); }
}

test('an excluded configuration is not covered even when the certificate is active', async () => {
  await withFixture('normal', async result => {
    const line = result.records.find(record => record.line === 'L1');
    assert.equal(line.coverage, 'not-covered');
    assert.equal(line.reason, 'configuration-excluded');
    assert.equal(line.certificates.find(item => item.candidate === 'C-101').status, 'active');
    assert.equal(line.model, 'E-9');
    assert.equal(line.status, 'complete');
  });
});

test('an inactive candidate and an applicable candidate coexist on one line', async () => {
  await withFixture('normal', async result => {
    const line = result.records.find(record => record.line === 'L2');
    assert.equal(line.coverage, 'covered');
    assert.equal(line.revisions.length, 1);
    const suspended = line.certificates.find(item => item.candidate === 'C-102');
    assert.equal(suspended.status, 'suspended');
    assert.equal(suspended.outcome, 'not-applicable');
    assert.ok(suspended.evidence.length > 0);
  });
});

test('an alias row and a canonical row keep separate identities in one list', async () => {
  const source = await fixture('normal');
  const store = new Inbox();
  source.orders = [
    { line: 'A1', model: 'City Nine', battery: 'B-48' },
    { line: 'A2', model: 'E-9', battery: 'B-48' },
  ];
  try {
    const result = await collect(source, store);
    const first = result.records.find(record => record.line === 'A1');
    const second = result.records.find(record => record.line === 'A2');
    assert.equal(first.model, 'E-9');
    assert.equal(second.model, 'E-9');
    assert.equal(first.coverage, second.coverage);
    assert.deepEqual(result.records.map(record => record.line), ['A1', 'A2']);
    assert.equal(first.order.model, 'City Nine');
    assert.equal(second.order.model, 'E-9');
  } finally { store.close(); await source.close(); }
});

test('a missing appendix leaves coverage unknown instead of negative', async () => {
  await withFixture('missing', async result => {
    for (const line of result.records) assert.equal(line.coverage, 'unknown');
    assert.ok(result.records.every(line => line.status === 'incomplete'));
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.pending.map(item => item.line), ['L1', 'L2']);
  });
});

test('a changed revision is re-read rather than stitched into a proof', async () => {
  await withFixture('revision', async result => {
    assert.equal(result.records.length, 2);
    const changed = result.records
      .flatMap(record => record.certificates)
      .filter(item => item.candidate === 'C-101' && item.attempts.length > 1);
    assert.ok(changed.length > 0, 'the revision change was observed');
    for (const record of result.records) {
      if (record.coverage !== 'covered') continue;
      const covering = record.certificates.filter(item => item.outcome === 'covered');
      assert.ok(covering.length > 0);
      for (const item of covering) {
        assert.equal(new Set(record.revisions).size, 1);
        assert.deepEqual(record.revisions, [item.revision]);
        for (const check of item.appendixChecks) assert.equal(check.valid, true);
      }
    }
    assert.equal(result.records.find(record => record.line === 'L2').coverage, 'covered');
  });
});

test('a revision change that never settles leaves the line unknown', async () => {
  let revision = 'r1';
  await withSource({
    certificates: {
      'C-1': {
        get revision() { return revision; },
        appendices: [
          (held, response) => {
            revision = held === 'r1' ? 'r2' : 'r1';
            return json(response, held === revision ? 200 : 409, { revision });
          },
        ],
      },
    },
  }, async result => {
    const [line] = result.records;
    assert.equal(line.coverage, 'unknown');
    assert.equal(line.reason, 'candidate-unresolved');
    assert.equal(line.revisions.length, 0);
    const certificate = line.certificates[0];
    assert.equal(certificate.outcome, 'unresolved');
    assert.equal(certificate.reason, 'revision-changed');
    assert.ok(certificate.attempts.length > 1);
    assert.ok(certificate.evidence.length > certificate.attempts.length);
  });
});

test('the search page alone never proves or disproves coverage', async () => {
  await withSource({ candidates: [] }, async result => {
    const [line] = result.records;
    assert.equal(line.coverage, 'unknown');
    assert.equal(line.reason, 'no-candidates');
    assert.equal(line.status, 'incomplete');
  });
});

test('an incomplete search cannot be reported as negative coverage', async () => {
  await withSource({
    certificates: { 'C-1': { appendices: [{ models: ['M-2'], excludeConfigurations: [] }] } },
    search: (url, response) => (url.searchParams.get('page') === '2'
      ? json(response, 500, { error: 'unavailable' })
      : json(response, 200, { candidates: ['C-1'], next: '/search?page=2' })),
  }, async result => {
    const [line] = result.records;
    assert.equal(line.coverage, 'unknown');
    assert.equal(line.reason, 'search-incomplete');
    assert.equal(result.diagnostics.search.complete, false);
    assert.ok(result.diagnostics.search.errors.length > 0);
  });
});

test('an incomplete search does not erase a closed positive proof', async () => {
  await withSource({
    certificates: { 'C-1': { appendices: [{ models: ['M-1'], excludeConfigurations: [] }] } },
    search: (url, response) => {
      const page = Number(url.searchParams.get('page') ?? '1');
      if (page > 2) return json(response, 500, { error: 'unavailable' });
      return json(response, 200, { candidates: page === 1 ? ['C-1'] : [], next: `/search?page=${page + 1}` });
    },
  }, async result => {
    const [line] = result.records;
    assert.equal(line.coverage, 'covered');
    assert.equal(result.diagnostics.search.complete, false);
  });
});

test('every formal record cites evidence the inbox actually holds', async () => {
  await withFixture('normal', async (result, source, store) => {
    const stored = new Set(store.evidence().map(row => row.id));
    for (const record of result.records) {
      assert.ok(record.evidence.length > 0);
      for (const id of record.evidence) assert.ok(stored.has(id), `missing evidence ${id}`);
      for (const citation of record.citations) {
        assert.ok(record.evidence.includes(citation.evidence));
        assert.match(citation.url, /^http:\/\/127\.0\.0\.1:/);
        assert.ok(Number.isInteger(citation.status));
      }
      for (const certificate of record.certificates) {
        for (const id of certificate.evidence) assert.ok(record.evidence.includes(id));
      }
    }
    assert.equal(result.records.length, 2);
  });
});

test('an empty exclusion battery is not a wildcard', async () => {
  await withSource({
    certificates: { 'C-1': { appendices: [{ models: ['M-1'], excludeConfigurations: [{ battery: '' }] }] } },
    orders: [{ line: 'L1', model: 'M-1', battery: 'B-1' }],
  }, async result => {
    // The empty value cannot match the concrete B-1 configuration, so it
    // excludes nothing.
    assert.equal(result.records[0].coverage, 'covered');
  });
});

test('an order with an empty battery cannot resolve a concrete exclusion', async () => {
  await withSource({
    certificates: { 'C-1': { appendices: [{ models: ['M-1'], excludeConfigurations: [{ battery: 'B-1' }] }] } },
    orders: [{ line: 'L1', model: 'M-1', battery: '' }],
  }, async result => {
    const [line] = result.records;
    assert.equal(line.coverage, 'unknown');
    assert.equal(line.certificates[0].reason, 'exclusion-unresolved');
  });
});

test('an exclusion key absent from the order is left for manual review', async () => {
  await withSource({
    certificates: { 'C-1': { appendices: [{ models: ['M-1'], excludeConfigurations: [{ battery: 'B-9' }] }] } },
    orders: [{ line: 'L1', model: 'M-1' }],
  }, async result => {
    const [line] = result.records;
    // The order does not state the battery, so the concrete exclusion cannot be
    // shown to match or not to match.  Do not silently read that as coverage.
    assert.equal(line.coverage, 'unknown');
    assert.equal(line.order.battery, null);
    const certificate = line.certificates[0];
    assert.equal(certificate.reason, 'exclusion-unresolved');
    assert.equal(certificate.appendixChecks[0].exclusionUnresolved, true);
  });
});

test('a model not in the alias table is not matched by similar title', async () => {
  await withSource({
    certificates: { 'C-1': { appendices: [{ models: ['M-1'], excludeConfigurations: [] }] } },
    orders: [{ line: 'L1', model: 'M-10', battery: 'B-1' }],
    aliases: { 'M-1': 'M-1' },
  }, async result => {
    const [line] = result.records;
    assert.equal(line.coverage, 'unknown');
    assert.equal(line.reason, 'model-unmapped');
    assert.equal(line.model, null);
    assert.ok(result.pending.some(item => item.line === 'L1'));
  });
});

test('an appendix declaring another model does not cover the row', async () => {
  await withSource({
    certificates: { 'C-1': { appendices: [{ models: ['M-2'], excludeConfigurations: [] }] } },
  }, async result => {
    const [line] = result.records;
    assert.equal(line.coverage, 'not-covered');
    assert.equal(line.reason, 'all-candidates-inapplicable');
  });
});

test('an unrecognised status is left for manual review', async () => {
  await withSource({
    certificates: { 'C-1': { status: 'pending-review', appendices: [{ models: ['M-1'], excludeConfigurations: [] }] } },
  }, async result => {
    const [line] = result.records;
    assert.equal(line.coverage, 'unknown');
    assert.equal(line.reason, 'candidate-unresolved');
    assert.equal(line.needsReview, true);
  });
});

test('an appendix body carrying another revision is not accepted', async () => {
  await withSource({
    certificates: {
      'C-1': {
        revision: 'r3',
        appendices: [(held, response) => json(response, 200,
          { revision: 'r2', scope: { models: ['M-1'], excludeConfigurations: [] } })],
      },
    },
  }, async result => {
    const [line] = result.records;
    assert.notEqual(line.coverage, 'covered');
    assert.equal(line.coverage, 'unknown');
  });
});

test('a detail with no appendices is missing material, not an inapplicable model', async () => {
  await withSource({
    certificates: { 'C-1': { appendices: [] } },
  }, async result => {
    const [line] = result.records;
    assert.equal(line.coverage, 'unknown');
    assert.equal(line.certificates[0].reason, 'no-appendices');
  });
});

test('a suspended certificate is never coverage, even when its appendix is unavailable', async () => {
  await withSource({
    certificates: {
      'C-1': { status: 'suspended', appendices: [(held, response) => json(response, 503, { retry: true })] },
    },
  }, async result => {
    const [line] = result.records;
    // The negative rests on the status, not on the missing appendix: an inactive
    // certificate cannot supply coverage whatever its scope says.
    assert.equal(line.coverage, 'not-covered');
    assert.equal(line.reason, 'no-active-covering-certificate');
    const certificate = line.certificates[0];
    assert.equal(certificate.status, 'suspended');
    assert.equal(certificate.complete, false);
    assert.ok(certificate.evidence.length > 0);
  });
});

test('a missing appendix on the only applicable certificate is not negative coverage', async () => {
  await withSource({
    certificates: {
      'C-1': { status: 'active', appendices: [(held, response) => json(response, 503, { retry: true })] },
    },
  }, async result => {
    const [line] = result.records;
    assert.equal(line.coverage, 'unknown');
    assert.equal(line.reason, 'candidate-unresolved');
  });
});
