export async function preview(source, store) {
  const response = await fetch(source.url + '/search');
  if (!response.ok) throw new Error(`search: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const evidence = store.saveEvidence('search-page', { url: response.url }, bytes);
  const page = JSON.parse(bytes);
  const candidate = page.candidates[0];
  const detail = await fetch(source.url + '/certificate/' + candidate);
  const detailBytes = Buffer.from(await detail.arrayBuffer());
  const detailEvidence = store.saveEvidence('certificate', { url: detail.url }, detailBytes);
  return { mode: 'preview', candidate, detail: JSON.parse(detailBytes), evidence: [evidence, detailEvidence], next: page.next };
}
