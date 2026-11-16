import { serve, json } from './http.mjs';

export async function fixture(scenario = 'normal') {
  const requests = [];
  let revision = 'r1';
  const source = await serve((request, response) => {
    const url = new URL(request.url, 'http://source');
    requests.push(url.pathname + url.search);
    if (url.pathname === '/search') {
      if (scenario === 'empty') return json(response, 200, { candidates: [], next: null });
      const page = url.searchParams.get('page') || '1';
      return json(response, 200, { candidates: page === '1' ? ['C-101'] : ['C-102'],
        next: page === '1' ? '/search?page=2' : null });
    }
    if (url.pathname === '/certificate/C-101') {
      const seen = revision;
      if (scenario === 'revision') revision = 'r2';
      return json(response, 200, { id: 'C-101', revision: seen, status: 'active',
        appendices: ['/appendix/C-101/a', '/appendix/C-101/b'] });
    }
    if (url.pathname === '/certificate/C-102') {
      return json(response, 200, { id: 'C-102', revision: 'r4', status: 'suspended',
        appendices: ['/appendix/C-102/a'] });
    }
    if (url.pathname.startsWith('/appendix/C-101/')) {
      if (url.searchParams.get('revision') !== revision) return json(response, 409, { revision });
      if (scenario === 'missing' && url.pathname.endsWith('/b')) return json(response, 503, { retry: true });
      const scope = url.pathname.endsWith('/a')
        ? { models: ['E-9'],
          excludeConfigurations: scenario === 'wildcard' ? [{}] : [{ battery: 'B-48' }] }
        : { models: ['E-12'], excludeConfigurations: [] };
      return json(response, 200, { revision, scope });
    }
    if (url.pathname === '/appendix/C-102/a') {
      return json(response, 200, { revision: 'r4', scope: { models: ['E-9'], excludeConfigurations: [] } });
    }
    return json(response, 404, { error: 'not found' });
  });
  return { ...source, requests, modelAliases: { 'City Nine': 'E-9', 'E-9': 'E-9', 'E-12': 'E-12' },
    orders: [{ line: 'L1', model: 'City Nine', battery: 'B-48' },
      { line: 'L2', model: 'E-12', battery: 'B-60' }] };
}
