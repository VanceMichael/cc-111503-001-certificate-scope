import { fixture } from './source.mjs';
import { preview, collect } from './intake.mjs';
import { Inbox } from './store.mjs';

const source = await fixture();
const store = new Inbox();
try {
  const previewResult = await preview(source, store);
  const collectResult = await collect(source, store);
  console.log(JSON.stringify({ preview: previewResult, collect: collectResult, evidence: store.evidence() }, null, 2));
} finally { store.close(); await source.close(); }
