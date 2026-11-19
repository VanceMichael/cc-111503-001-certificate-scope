import { fixture } from './source.mjs';
import { preview, collect } from './intake.mjs';
import { Inbox } from './store.mjs';

const source = await fixture();
const store = new Inbox();
try {
  const previewResult = await preview(source, store);
  const collected = await collect(source, store);
  console.log(JSON.stringify({
    preview: previewResult,
    collection: {
      mode: collected.mode,
      status: collected.status,
      records: collected.records.map(record => ({
        line: record.line,
        model: record.model,
        coverage: record.coverage,
        reason: record.reason,
        status: record.status,
        revisions: record.revisions,
        evidence: record.evidence.length,
        citations: record.citations,
      })),
      pending: collected.pending,
      diagnostics: collected.diagnostics,
      notice: collected.notice,
    },
    evidence: store.evidence(),
  }, null, 2));
} finally { store.close(); await source.close(); }
