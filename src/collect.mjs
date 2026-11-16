const MAX_PAGES = 32;
const MAX_REVISION_RESTARTS = 4;

async function fetchJson(source, store, kind, path, metadata = {}) {
  const url = path.startsWith('http') ? path : source.url + path;
  const response = await fetch(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const evidence = store.saveEvidence(kind, { url: response.url, status: response.status, ...metadata }, bytes);
  let body = null;
  try { body = JSON.parse(bytes.toString('utf8')); } catch { body = null; }
  return { status: response.status, body, evidence };
}

// 搜索命中只是候选；分页未闭合时候选集合本身不可靠。
async function fetchSearch(source, store, diagnostics) {
  const candidates = [];
  const evidence = [];
  const seen = new Set();
  let next = '/search';
  while (next) {
    if (seen.has(next) || seen.size >= MAX_PAGES) {
      diagnostics.push({ issue: 'search-pagination-open', path: next });
      return { closed: false, candidates, evidence };
    }
    seen.add(next);
    const page = await fetchJson(source, store, 'search-page', next, { page: seen.size });
    evidence.push(page.evidence);
    if (page.status !== 200 || !page.body || !Array.isArray(page.body.candidates)) {
      diagnostics.push({ issue: 'search-unavailable', path: next, status: page.status, evidence: [page.evidence] });
      return { closed: false, candidates, evidence };
    }
    candidates.push(...page.body.candidates);
    next = page.body.next ?? null;
  }
  return { closed: true, candidates, evidence };
}

// 闭合一份证书：详情与其声明的全部附录必须落在同一 revision 上。
// 409 或附录 revision 不一致说明详情已过期，整份证书重取，不跨版本拼接。
async function closeCandidate(source, store, id, diagnostics) {
  const evidence = [];
  let scopes = [];
  for (let attempt = 1; attempt <= MAX_REVISION_RESTARTS; attempt += 1) {
    const detail = await fetchJson(source, store, 'certificate', `/certificate/${encodeURIComponent(id)}`, { candidate: id, attempt });
    evidence.push(detail.evidence);
    if (detail.status !== 200 || !detail.body) {
      diagnostics.push({ candidate: id, issue: 'detail-unavailable', status: detail.status, evidence: [detail.evidence] });
      return { id, closed: false, status: null, revision: null, scopes: [], evidence };
    }
    const revision = detail.body.revision ?? null;
    const status = detail.body.status ?? null;
    const declared = Array.isArray(detail.body.appendices) ? detail.body.appendices : [];
    if (!revision) {
      diagnostics.push({ candidate: id, issue: 'detail-incomplete', evidence: [detail.evidence] });
      return { id, closed: false, status, revision, scopes: [], evidence };
    }
    scopes = [];
    let restart = false;
    let gap = null;
    for (const appendix of declared) {
      const joiner = appendix.includes('?') ? '&' : '?';
      const res = await fetchJson(source, store, 'appendix',
        `${appendix}${joiner}revision=${encodeURIComponent(revision)}`,
        { candidate: id, revision, attempt });
      evidence.push(res.evidence);
      if (res.status === 409) {
        diagnostics.push({ candidate: id, issue: 'revision-changed', revision, attempt, evidence: [res.evidence] });
        restart = true;
        break;
      }
      if (res.status !== 200 || !res.body) {
        gap = { appendix, status: res.status };
        break;
      }
      if (res.body.revision !== revision) {
        diagnostics.push({ candidate: id, issue: 'revision-changed', revision, attempt, evidence: [res.evidence] });
        restart = true;
        break;
      }
      scopes.push({ appendix, revision, scope: res.body.scope ?? {}, evidence: res.evidence });
    }
    if (restart) continue;
    if (gap) {
      diagnostics.push({ candidate: id, issue: 'appendix-unavailable', appendix: gap.appendix, status: gap.status, revision });
      return { id, closed: false, status, revision, scopes, evidence };
    }
    return { id, closed: true, status, revision, scopes, evidence };
  }
  diagnostics.push({ candidate: id, issue: 'revision-unstable', attempts: MAX_REVISION_RESTARTS });
  return { id, closed: false, status: null, revision: null, scopes: [], evidence };
}

// 排除条件任一键值全匹配才排除；空配置不是通配。
function exclusionMatches(entry, config) {
  const keys = Object.keys(entry ?? {});
  return keys.length > 0 && keys.every(key => config[key] === entry[key]);
}

function appendixVerdict(scope, canonical, config) {
  const models = Array.isArray(scope?.models) ? scope.models : [];
  if (!models.includes(canonical)) return 'absent';
  const exclusions = Array.isArray(scope?.excludeConfigurations) ? scope.excludeConfigurations : [];
  return exclusions.some(entry => exclusionMatches(entry, config)) ? 'excluded' : 'included';
}

function assessCandidate(candidate, canonical, config) {
  if (!candidate.closed) return { candidate: candidate.id, closed: false, verdict: 'open' };
  const appendices = candidate.scopes.map(entry => ({
    appendix: entry.appendix, revision: entry.revision,
    verdict: appendixVerdict(entry.scope, canonical, config),
  }));
  const included = appendices.some(entry => entry.verdict === 'included');
  const active = candidate.status === 'active';
  let verdict = 'absent';
  if (appendices.some(entry => entry.verdict === 'excluded')) verdict = 'excluded';
  if (included) verdict = active ? 'covers' : 'inactive-status';
  return { candidate: candidate.id, closed: true, status: candidate.status, revision: candidate.revision, verdict, appendices };
}

function unique(values) {
  return [...new Set(values)];
}

function closedRevisions(candidates) {
  return unique(candidates.filter(candidate => candidate.closed).map(candidate => candidate.revision));
}

function assessOrder(order, aliases, candidates, search) {
  const model = String(order.model ?? '');
  const key = model.trim();
  const canonical = Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : null;
  const config = {};
  for (const [name, value] of Object.entries(order)) {
    if (name !== 'line' && name !== 'model') config[name] = value;
  }
  const record = {
    line: order.line, model, canonicalModel: canonical, config,
    coverage: 'unknown', reason: 'alias-unmapped',
    evidence: [...search.evidence], revisions: [], basis: null, trail: [],
  };
  if (!canonical) return record;
  if (!search.closed) { record.reason = 'search-incomplete'; return record; }
  if (candidates.length === 0) { record.reason = 'no-candidates'; return record; }

  record.trail = candidates.map(candidate => assessCandidate(candidate, canonical, config));
  const covering = candidates.find((candidate, index) => record.trail[index].verdict === 'covers');
  if (covering) {
    record.coverage = 'covered';
    record.reason = 'covered';
    record.basis = { candidate: covering.id, revision: covering.revision };
    record.revisions = [covering.revision];
    record.evidence = unique([...record.evidence, ...covering.evidence]);
    return record;
  }
  const open = candidates.filter(candidate => !candidate.closed);
  if (open.length > 0) {
    record.reason = 'candidate-open';
    record.evidence = unique([...record.evidence, ...open.flatMap(candidate => candidate.evidence)]);
    record.revisions = closedRevisions(candidates);
    return record;
  }
  record.coverage = 'not-covered';
  record.reason = 'no-applicable-certificate';
  record.evidence = unique([...record.evidence, ...candidates.flatMap(candidate => candidate.evidence)]);
  record.revisions = closedRevisions(candidates);
  return record;
}

export async function collect(source, store) {
  const diagnostics = [];
  const search = await fetchSearch(source, store, diagnostics);
  const ids = unique(search.candidates);
  const candidates = [];
  for (const id of ids) candidates.push(await closeCandidate(source, store, id, diagnostics));
  if (search.closed && ids.length === 0) diagnostics.push({ issue: 'no-candidates' });
  for (const candidate of candidates) {
    if (candidate.closed && candidate.status !== 'active') {
      diagnostics.push({ candidate: candidate.id, issue: 'candidate-inactive', status: candidate.status, revision: candidate.revision });
    }
  }

  const aliases = source.modelAliases ?? {};
  const orders = Array.isArray(source.orders) ? source.orders : [];
  const records = orders.map(order => assessOrder(order, aliases, candidates, search));
  const pending = records
    .filter(record => record.coverage === 'unknown')
    .map(record => ({ line: record.line, model: record.model, reason: record.reason }));

  for (const record of records) store.put('collect-records', String(record.line), record);
  store.put('collect-runs', new Date().toISOString(), {
    orders: orders.length,
    covered: records.filter(record => record.coverage === 'covered').length,
    notCovered: records.filter(record => record.coverage === 'not-covered').length,
    unknown: records.filter(record => record.coverage === 'unknown').length,
  });

  return {
    mode: 'collect',
    notice: 'coverage 仅说明当期有效证书附件的适用范围，不构成上牌许可',
    records, pending, diagnostics,
  };
}
