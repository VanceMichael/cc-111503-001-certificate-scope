import { randomUUID } from 'node:crypto';

const MAX_SEARCH_PAGES = 25;
const MAX_CERTIFICATE_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 20000;
const ACTIVE_STATUS = 'active';
const INACTIVE_STATUSES = new Set(['suspended', 'expired', 'revoked', 'inactive', 'withdrawn']);

const NOTICE = '证书当期状态与附件适用范围只用于进货核验；covered 不代表车辆可上牌或符合其他准入要求。';

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function parseJson(bytes) {
  try {
    return { ok: true, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

async function requestJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { url: response.url || url, status: response.status, ok: response.ok, bytes };
  } catch (error) {
    const bytes = Buffer.from(JSON.stringify({ error: error.message }));
    return { url, status: 0, ok: false, bytes, error: error.message };
  }
}

function remember(store, evidence, citations, kind, metadata, response) {
  const recorded = { ...metadata, capturedAt: new Date().toISOString() };
  const id = store.saveEvidence(kind, recorded, response.bytes);
  evidence.push(id);
  citations.push({
    evidence: id,
    kind,
    url: response.url,
    status: response.status,
    capturedAt: recorded.capturedAt,
    ...(response.error ? { error: response.error } : {}),
  });
  return id;
}

async function searchCandidates(source, store) {
  const evidence = [];
  const citations = [];
  const pages = [];
  const candidates = [];
  const seenCandidates = new Set();
  const seenPages = new Set();
  const errors = [];
  let next = '/search';
  let complete = false;

  while (next) {
    if (typeof next !== 'string') {
      errors.push({ code: 'invalid-next-link', next: String(next) });
      break;
    }
    let target;
    try {
      target = new URL(next, source.url).toString();
    } catch {
      errors.push({ code: 'invalid-next-link', next });
      break;
    }
    if (new URL(target).origin !== new URL(source.url).origin) {
      errors.push({ code: 'next-link-outside-source', url: target });
      break;
    }
    if (seenPages.has(target)) {
      errors.push({ code: 'search-pagination-cycle', url: target });
      break;
    }
    if (seenPages.size >= MAX_SEARCH_PAGES) {
      errors.push({ code: 'search-page-limit', limit: MAX_SEARCH_PAGES });
      break;
    }
    seenPages.add(target);

    const response = await requestJson(target);
    remember(store, evidence, citations, 'search-page',
      { url: response.url, status: response.status, page: pages.length + 1 }, response);
    const parsed = response.ok ? parseJson(response.bytes) : { ok: false };
    if (!response.ok || !parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      errors.push({ code: response.ok ? 'invalid-search-page' : 'search-request-failed',
        url: response.url, status: response.status });
      break;
    }

    const listed = Array.isArray(parsed.value.candidates) ? parsed.value.candidates : [];
    const pageCandidates = [];
    for (const candidate of listed) {
      if (typeof candidate !== 'string' || !candidate.trim()) continue;
      pageCandidates.push(candidate);
      if (!seenCandidates.has(candidate)) {
        seenCandidates.add(candidate);
        candidates.push(candidate);
      }
    }
    pages.push({ url: response.url, candidates: pageCandidates });
    if (parsed.value.next == null) {
      complete = true;
      break;
    }
    next = parsed.value.next;
  }

  return { complete, pages, candidates, evidence, citations, errors };
}

async function acquireCertificate(source, store, candidate) {
  const evidence = [];
  const citations = [];
  const attempts = [];
  let lastReason = null;
  const detailUrl = new URL('/certificate/' + encodeURIComponent(candidate), source.url).toString();

  for (let attempt = 1; attempt <= MAX_CERTIFICATE_ATTEMPTS; attempt++) {
    const detailResponse = await requestJson(detailUrl);
    remember(store, evidence, citations, 'certificate-detail',
      { url: detailResponse.url, status: detailResponse.status, candidate, attempt }, detailResponse);
    const detailParsed = detailResponse.ok ? parseJson(detailResponse.bytes) : { ok: false };
    if (!detailResponse.ok || !detailParsed.ok || !detailParsed.value || typeof detailParsed.value !== 'object') {
      attempts.push({ attempt, outcome: 'detail-unavailable' });
      return {
        candidate, complete: false, attempts,
        reason: detailResponse.ok ? 'invalid-certificate-detail' : 'certificate-unavailable',
        status: null, revision: null, appendices: [], evidence, citations,
      };
    }

    const detail = detailParsed.value;
    const revision = text(detail.revision);
    const status = text(detail.status).toLowerCase() || null;
    if (!revision) {
      attempts.push({ attempt, outcome: 'missing-revision' });
      return { candidate, complete: false, attempts, reason: 'missing-certificate-revision',
        status, revision: null, appendices: [], evidence, citations };
    }
    if (!Array.isArray(detail.appendices)) {
      attempts.push({ attempt, outcome: 'missing-appendix-list' });
      return { candidate, complete: false, attempts, reason: 'missing-appendix-list',
        status, revision, appendices: [], evidence, citations };
    }

    const appendices = [];
    let stale = false;
    let failure = null;
    for (const appendixRef of detail.appendices) {
      if (typeof appendixRef !== 'string' || !appendixRef.trim()) {
        failure = { reason: 'invalid-appendix-link', appendix: appendixRef };
        break;
      }
      let appendixUrl;
      try {
        appendixUrl = new URL(appendixRef, source.url);
      } catch {
        failure = { reason: 'invalid-appendix-link', appendix: appendixRef };
        break;
      }
      if (appendixUrl.origin !== new URL(source.url).origin) {
        failure = { reason: 'appendix-outside-source', appendix: appendixRef };
        break;
      }
      appendixUrl.searchParams.set('revision', revision);
      const response = await requestJson(appendixUrl.toString());
      remember(store, evidence, citations, 'certificate-appendix',
        { url: response.url, status: response.status, candidate, revision, appendix: appendixRef, attempt }, response);
      if (response.status === 409) {
        // The held detail no longer describes the live certificate.  Retry from a
        // fresh detail rather than combining appendices across revisions.
        stale = true;
        break;
      }
      if (!response.ok) {
        failure = { reason: 'appendix-unavailable', appendix: appendixRef, status: response.status };
        break;
      }
      const parsed = parseJson(response.bytes);
      if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
        failure = { reason: 'invalid-appendix-body', appendix: appendixRef };
        break;
      }
      if (text(parsed.value.revision) !== revision) {
        stale = true;
        break;
      }
      appendices.push({ url: response.url, appendix: appendixRef, body: parsed.value });
    }

    if (stale) {
      lastReason = 'revision-changed';
      attempts.push({ attempt, revision, outcome: 'revision-changed' });
      continue;
    }
    if (failure) {
      attempts.push({ attempt, revision, outcome: failure.reason });
      return { candidate, complete: false, attempts, reason: failure.reason, failure,
        status, revision, appendices: [], evidence, citations };
    }
    attempts.push({ attempt, revision, outcome: 'complete' });
    return { candidate, complete: true, attempts, reason: null, status, revision,
      appendices, evidence, citations };
  }

  return { candidate, complete: false, attempts, reason: lastReason ?? 'revision-unstable',
    status: null, revision: null, appendices: [], evidence, citations };
}

function exclusionMatches(order, excludeConfigurations) {
  if (!Array.isArray(excludeConfigurations)) return { matches: false, unknown: false, valid: true };
  let unknown = false;
  for (const exclusion of excludeConfigurations) {
    if (!exclusion || typeof exclusion !== 'object' || Array.isArray(exclusion)) {
      return { matches: false, unknown: false, valid: false };
    }
    const keys = Object.keys(exclusion);
    // An empty object has no key-values to match, so the project's data
    // convention does not define its effect; leave it unresolved rather than
    // reading it as either a wildcard or a no-op.
    if (keys.length === 0) return { matches: false, unknown: false, valid: false };
    let mismatch = false;
    let missing = false;
    for (const key of keys) {
      const rawExcluded = exclusion[key];
      if (typeof rawExcluded !== 'string' && typeof rawExcluded !== 'number') {
        return { matches: false, unknown: false, valid: false };
      }
      const excludedValue = text(rawExcluded);
      // An empty exclusion value is not a wildcard: it matches no configuration.
      if (!excludedValue) { mismatch = true; break; }
      const orderValue = text(order[key]);
      // A concrete exclusion on a field the purchase line does not state leaves
      // the effect unresolved; it must not silently become coverage.
      if (!orderValue) { missing = true; continue; }
      if (orderValue !== excludedValue) { mismatch = true; break; }
    }
    if (!mismatch && !missing) return { matches: true, unknown: false, valid: true, exclusion };
    if (!mismatch && missing) unknown = true;
  }
  return { matches: false, unknown, valid: true };
}

function assessCertificate(certificate, canonicalModel, configuration) {
  const base = {
    candidate: certificate.candidate,
    revision: certificate.revision,
    status: certificate.status,
    complete: certificate.complete,
    attempts: certificate.attempts,
    evidence: certificate.evidence,
    citations: certificate.citations,
  };
  if (!certificate.complete) {
    // A certificate already proven inactive cannot supply coverage even if some
    // appendix is unavailable; its status evidence is still kept.
    if (certificate.status && INACTIVE_STATUSES.has(certificate.status)) {
      return { ...base, outcome: 'inactive', reason: certificate.reason, appendixChecks: [] };
    }
    return { ...base, outcome: 'unresolved', reason: certificate.reason, appendixChecks: [] };
  }

  const appendixChecks = [];
  let included = false;
  let configurationCovered = false;
  let exclusionUnknown = false;
  let malformed = false;

  if (certificate.appendices.length === 0) {
    // A detail with no appendices declares no scope at all.  That is missing
    // material, not a statement that the model is inapplicable.
    return { ...base, outcome: 'unresolved', reason: 'no-appendices', appendixChecks };
  }

  for (const appendix of certificate.appendices) {
    const scope = appendix.body?.scope;
    if (!scope || typeof scope !== 'object' || !Array.isArray(scope.models)) {
      malformed = true;
      appendixChecks.push({ appendix: appendix.appendix, url: appendix.url, valid: false });
      continue;
    }
    if (scope.excludeConfigurations != null && !Array.isArray(scope.excludeConfigurations)) {
      malformed = true;
      appendixChecks.push({ appendix: appendix.appendix, url: appendix.url, valid: false });
      continue;
    }
    const models = scope.models.map(text).filter(Boolean);
    const isIncluded = models.includes(canonicalModel);
    const exclusion = isIncluded
      ? exclusionMatches(configuration, scope.excludeConfigurations ?? [])
      : { matches: false, unknown: false, valid: true };
    if (!exclusion.valid) malformed = true;
    const check = {
      appendix: appendix.appendix,
      url: appendix.url,
      valid: exclusion.valid,
      models,
      excludeConfigurations: scope.excludeConfigurations ?? [],
      includesModel: isIncluded,
      excluded: isIncluded && exclusion.matches,
      ...(isIncluded && exclusion.unknown ? { exclusionUnresolved: true } : {}),
      ...(exclusion.matches ? { matchedExclusion: exclusion.exclusion } : {}),
    };
    appendixChecks.push(check);
    if (isIncluded) included = true;
    if (isIncluded && exclusion.unknown) exclusionUnknown = true;
    // Each appendix contributes a scope set: its models minus its excluded
    // configurations.  The certificate covers a configuration when at least one
    // appendix of this same revision contributes it.
    if (isIncluded && exclusion.valid && !exclusion.matches && !exclusion.unknown) {
      configurationCovered = true;
    }
  }

  if (malformed) return { ...base, outcome: 'unresolved', reason: 'malformed-scope', appendixChecks };
  if (!included) return { ...base, outcome: 'not-applicable', appendixChecks };
  if (!configurationCovered) {
    if (exclusionUnknown) return { ...base, outcome: 'unresolved', reason: 'exclusion-unresolved', appendixChecks };
    return { ...base, outcome: 'excluded', appendixChecks };
  }

  if (certificate.status === ACTIVE_STATUS) {
    return { ...base, outcome: 'covered', appendixChecks };
  }
  if (certificate.status && INACTIVE_STATUSES.has(certificate.status)) {
    return { ...base, outcome: 'inactive', appendixChecks };
  }
  // The source did not give a status this collector can interpret.  Do not
  // upgrade an otherwise applicable certificate to coverage.
  return { ...base, outcome: 'status-unclear', appendixChecks };
}

function resolveModel(aliases, requestedModel) {
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return null;
  const requested = text(requestedModel);
  if (!requested) return null;
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (text(alias) === requested) {
      const resolved = text(canonical);
      return resolved || null;
    }
  }
  return null;
}

function unique(values) {
  return [...new Set(values)];
}

function recordStatus({ canonicalModel, coverage }) {
  // A record is complete only when the source closed the material needed for the
  // stated conclusion.  An unresolved candidate or an uninterpretable status
  // leaves the line at unknown, which needs manual review.
  if (!canonicalModel) return 'incomplete';
  return coverage === 'unknown' ? 'incomplete' : 'complete';
}

export async function collect(source, store) {
  if (!source || typeof source.url !== 'string') throw new Error('collect requires a source with a url');
  if (!store || typeof store.saveEvidence !== 'function') throw new Error('collect requires an Inbox');

  const runId = randomUUID();
  const searched = await searchCandidates(source, store);
  const orders = Array.isArray(source.orders) ? source.orders : [];
  const records = [];
  const pending = [];

  for (let index = 0; index < orders.length; index++) {
    const order = orders[index] ?? {};
    const line = text(order.line) || `line-${index + 1}`;
    const requested = { model: order.model ?? null, battery: order.battery ?? null };
    const canonicalModel = resolveModel(source.modelAliases, order.model);

    const evidence = [...searched.evidence];
    const citations = [...searched.citations];
    const certificates = [];
    let coverage = 'unknown';
    let reason = null;

    if (!searched.complete && searched.candidates.length === 0) {
      reason = 'search-incomplete';
    } else if (!canonicalModel) {
      reason = 'model-unmapped';
    } else {
      for (const candidate of searched.candidates) {
        // Each line reads the certificate afresh: a revision read for an earlier
        // line may no longer be the live one, so sharing it could prove a line
        // with material that had already been replaced.
        const certificate = await acquireCertificate(source, store, candidate);
        evidence.push(...certificate.evidence);
        citations.push(...certificate.citations);
        certificates.push(assessCertificate(certificate, canonicalModel, order));
      }

      const covering = certificates.find(item => item.outcome === 'covered');
      if (covering) {
        coverage = 'covered';
        reason = 'active-certificate-with-complete-scope';
      } else if (!searched.complete) {
        // Search pagination stopped early, so an unseen candidate may yet cover
        // this configuration.  Do not turn an incomplete search into a negative.
        reason = 'search-incomplete';
      } else if (searched.candidates.length === 0) {
        reason = 'no-candidates';
      } else if (certificates.some(item => item.outcome === 'unresolved' || item.outcome === 'status-unclear')) {
        reason = 'candidate-unresolved';
      } else {
        coverage = 'not-covered';
        if (certificates.every(item => item.outcome === 'not-applicable')) {
          reason = 'all-candidates-inapplicable';
        } else if (certificates.some(item => item.outcome === 'excluded')) {
          reason = 'configuration-excluded';
        } else {
          reason = 'no-active-covering-certificate';
        }
      }
    }

    const proof = certificates.find(item => item.outcome === 'covered') ?? null;
    // A covered line carries exactly the revision of its proof.  A negative or
    // unknown line lists the revisions whose scopes were actually read, so the
    // reviewer can see which versions informed the answer.
    const revisions = proof
      ? [proof.revision]
      : unique(certificates.filter(item => item.complete && item.revision).map(item => item.revision));
    const status = recordStatus({ canonicalModel, coverage });

    const notes = [];
    if (!searched.complete && searched.candidates.length === 0) notes.push('候选页未完整取得');
    if (reason === 'model-unmapped') notes.push('清单型号不在别名表中，未按近似名称处理');
    if (reason === 'search-incomplete' && searched.candidates.length > 0) notes.push('候选列表未闭合，可能存在未取回候选');
    if (reason === 'candidate-unresolved') notes.push('存在资料不足的候选，需人工复核');

    const record = {
      line,
      order: requested,
      model: canonicalModel,
      coverage,
      reason,
      status,
      revisions,
      evidence: unique(evidence),
      citations,
      certificates,
      needsReview: coverage === 'unknown',
      notes,
      notice: NOTICE,
    };
    records.push(record);
    store.put('collection-records', `${runId}:${line}`, record);
    if (coverage === 'unknown') {
      pending.push({
        line,
        reason,
        status,
        action: 'manual-review',
        evidence: record.evidence,
      });
    }
  }

  const summary = {
    mode: 'collect',
    runId,
    createdAt: new Date().toISOString(),
    records: records.length,
    searchComplete: searched.complete,
    lines: records.map(record => ({
      line: record.line,
      coverage: record.coverage,
      reason: record.reason,
      status: record.status,
    })),
  };
  store.put('collection-runs', runId, summary);

  const status = records.length === 0
    ? 'empty'
    : records.every(record => record.status === 'complete') ? 'complete' : 'incomplete';
  return {
    mode: 'collect',
    runId,
    status,
    records,
    pending,
    diagnostics: {
      search: {
        complete: searched.complete,
        pages: searched.pages,
        candidates: searched.candidates,
        errors: searched.errors,
      },
      lines: summary.lines,
      notices: [NOTICE],
    },
    notice: NOTICE,
  };
}
