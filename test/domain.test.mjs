import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../src/source.mjs';
import { preview } from '../src/preview.mjs';
import { Inbox } from '../src/store.mjs';

test('candidate preview leaves both response bodies available for review', async () => {
  const source = await fixture(); const store = new Inbox();
  try {
    const result = await preview(source, store);
    assert.equal(result.candidate, 'C-101'); assert.equal(result.next, '/search?page=2');
    assert.equal(store.evidence().length, 2); assert.equal(result.detail.revision, 'r1');
  } finally { store.close(); await source.close(); }
});
test('a stale revision cannot obtain a new appendix silently', async () => {
  const source = await fixture('revision');
  try {
    await fetch(source.url + '/certificate/C-101');
    assert.equal((await fetch(source.url + '/appendix/C-101/a?revision=r1')).status, 409);
  } finally { await source.close(); }
});
