// Lead Scanner → Apollo proxy (Cloudflare Worker).
//
// Keeps the Apollo API key off the public page. The page calls this Worker with
// a shared password; the Worker checks it, calls Apollo, and returns only the
// fields the page needs.
//
// Secrets / variables (set in the Cloudflare dashboard or with wrangler):
//   APOLLO_API_KEY   (secret)  your Apollo API key
//   ACCESS_PASSWORD  (secret)  password the page must send; pick a long one
//   ALLOWED_ORIGIN   (var)     e.g. https://techtoch1.github.io (no trailing slash)
//
// Also used by server/server.js when Lead Scanner runs on your own server.
//
// Routes (all POST, JSON):
//   /capabilities    which features this Apollo plan allows
//   /saved-accounts  companies already saved in your Apollo account (works on free plans)
//   /saved-contacts  contacts already saved in your Apollo account  (works on free plans)
//   /companies       search Apollo companies              (paid plans)
//   /people          find decision makers at a domain     (paid plans; People API Search, no credits)
//   /reveal          get one person's work email          (paid plans; costs credits)
//   /push            add contacts to Apollo under a list  (paid plans)

const APOLLO = 'https://api.apollo.io/api/v1';

const DEFAULT_TITLES = [
  'IT Manager', 'IT Director', 'Head of IT', 'CTO', 'CIO', 'Chief Technology Officer',
  'CEO', 'Founder', 'Co-Founder', 'Owner', 'Managing Director', 'General Manager',
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const corsOrigin = allowed.includes(origin) ? origin : allowed[0] || '';
    const cors = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    if (!env.APOLLO_API_KEY || !env.ACCESS_PASSWORD) return json({ error: 'Worker is missing APOLLO_API_KEY or ACCESS_PASSWORD.' }, 500);
    if (allowed.length && origin && !allowed.includes(origin)) return json({ error: 'Origin not allowed.' }, 403);

    const auth = request.headers.get('Authorization') || '';
    if (!safeEqual(auth, 'Bearer ' + env.ACCESS_PASSWORD)) return json({ error: 'Wrong password.' }, 401);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Body must be JSON.' }, 400); }

    const route = new URL(request.url).pathname.replace(/\/+$/, '').slice(1);
    const result = await runRoute(env, route, body);
    return json(result.body, result.status);
  },
};

export const ROUTES = {
  ping: async () => ({ ok: true }),
  capabilities,
  'saved-accounts': savedAccounts,
  'saved-contacts': savedContacts,
  companies: searchCompanies,
  people: findPeople,
  reveal: revealPerson,
  push: pushContacts,
};

// Shared by the Worker and the Node server: returns { status, body }.
export async function runRoute(env, route, body) {
  const handler = Object.prototype.hasOwnProperty.call(ROUTES, route) ? ROUTES[route] : null;
  if (!handler) return { status: 404, body: { error: 'Unknown route.' } };
  try {
    return { status: 200, body: await handler(env, body || {}) };
  } catch (e) {
    return { status: e.status && e.status < 500 ? e.status : 502, body: { error: e.message, apolloStatus: e.status } };
  }
}

// Constant-time compare so the password can't be guessed by timing.
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export async function apollo(env, path, payload, method = 'POST') {
  const res = await fetch(APOLLO + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': env.APOLLO_API_KEY },
    body: method === 'GET' ? undefined : JSON.stringify(payload || {}),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = data.error || data.message || (data.errors && JSON.stringify(data.errors)) || data.raw || res.statusText;
    const err = new Error(`Apollo ${res.status}: ${msg}`);
    err.status = res.status;
    err.code = data.error_code || '';
    throw err;
  }
  return data;
}

const list = v => (Array.isArray(v) ? v : String(v || '').split(','))
  .map(s => String(s).trim()).filter(Boolean).slice(0, 50);
const clampInt = (v, lo, hi, dflt) => Math.min(hi, Math.max(lo, Number.parseInt(v, 10) || dflt));
export const cleanDomain = d => String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];

// Free and trial plans can't call the search endpoints (Apollo answers 403
// API_INACCESSIBLE). People API Search costs no credits, so it's a safe probe.
async function capabilities(env) {
  try {
    await apollo(env, '/mixed_people/api_search', { q_organization_domains_list: ['apollo.io'], page: 1, per_page: 1 });
    return { search: true };
  } catch (e) {
    if (e.code === 'API_INACCESSIBLE') return { search: false, reason: e.message };
    throw e;
  }
}

async function savedAccounts(env, body) {
  const page = clampInt(body.page, 1, 500, 1);
  const data = await apollo(env, '/accounts/search', { page, per_page: 100 });
  const companies = (data.accounts || []).map(a => ({
    apollo_id: a.id,
    name: a.name || '',
    domain: cleanDomain(a.primary_domain || a.domain || a.website_url),
    industry: '',
    employees: null,
    location: [a.city || a.organization_city, a.state || a.organization_state, a.country || a.organization_country].filter(Boolean).join(', '),
    linkedin: a.linkedin_url || '',
    phone: a.sanitized_phone || a.phone || '',
  })).filter(c => c.domain);
  const p = data.pagination || {};
  return { companies, page, total_pages: p.total_pages || 1, total: p.total_entries || companies.length };
}

async function savedContacts(env, body) {
  const page = clampInt(body.page, 1, 500, 1);
  const data = await apollo(env, '/contacts/search', { page, per_page: 100 });
  const contacts = (data.contacts || []).map(c => {
    const org = c.organization || {};
    const acct = c.account || {};
    const emailDomain = c.email && !c.free_domain ? c.email.split('@').pop() : '';
    return {
      id: c.id,
      first_name: c.first_name || '',
      last_name: c.last_name || '',
      title: c.title || '',
      email: c.email || '',
      email_status: c.email_status || '',
      linkedin: c.linkedin_url || '',
      organization_name: c.organization_name || org.name || acct.name || '',
      domain: cleanDomain(org.primary_domain || acct.primary_domain || acct.domain || org.website_url || emailDomain),
    };
  }).filter(c => c.domain);
  const p = data.pagination || {};
  return { contacts, page, total_pages: p.total_pages || 1, total: p.total_entries || contacts.length };
}

async function searchCompanies(env, body) {
  const payload = {
    page: clampInt(body.page, 1, 500, 1),
    per_page: clampInt(body.per_page, 1, 100, 100),
  };
  const locations = list(body.locations);
  const keywords = list(body.keywords);
  const sizes = list(body.sizes).filter(s => /^\d+,\d+$/.test(s));
  if (locations.length) payload.organization_locations = locations;
  if (keywords.length) payload.q_organization_keyword_tags = keywords;
  if (sizes.length) payload.organization_num_employees_ranges = sizes;
  if (body.name) payload.q_organization_name = String(body.name).slice(0, 200);
  if (!locations.length && !keywords.length && !body.name) throw Object.assign(new Error('Add at least a location, keyword or company name.'), { status: 400 });

  const data = await apollo(env, '/mixed_companies/search', payload);
  const orgs = [...(data.organizations || []), ...(data.accounts || [])];
  const seen = new Set();
  const companies = [];
  for (const o of orgs) {
    const domain = cleanDomain(o.primary_domain || o.domain || o.website_url);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    companies.push({
      apollo_id: o.id || o.organization_id || null,
      name: o.name || '',
      domain,
      industry: o.industry || '',
      employees: o.estimated_num_employees || null,
      location: [o.city, o.state, o.country].filter(Boolean).join(', '),
      linkedin: o.linkedin_url || '',
      phone: (o.primary_phone && o.primary_phone.sanitized_number) || o.phone || '',
    });
  }
  const p = data.pagination || {};
  return { companies, page: p.page || payload.page, total_pages: p.total_pages || null, total: p.total_entries || null };
}

async function findPeople(env, body) {
  const domain = cleanDomain(body.domain);
  if (!domain) throw Object.assign(new Error('domain is required.'), { status: 400 });
  const titles = list(body.titles);
  const data = await apollo(env, '/mixed_people/api_search', {
    q_organization_domains_list: [domain],
    person_titles: titles.length ? titles : DEFAULT_TITLES,
    page: 1,
    per_page: clampInt(body.limit, 1, 25, 5),
  });
  const people = (data.people || data.contacts || []).map(p => ({
    id: p.id,
    first_name: p.first_name || '',
    last_name: p.last_name || p.last_name_obfuscated || '',
    title: p.title || '',
    linkedin: p.linkedin_url || '',
    has_email: p.has_email ?? null,
  }));
  return { domain, people };
}

async function revealPerson(env, body) {
  if (!body.id) throw Object.assign(new Error('id is required.'), { status: 400 });
  const data = await apollo(env, '/people/match', { id: String(body.id), reveal_personal_emails: false });
  const p = data.person || {};
  return {
    id: p.id || body.id,
    first_name: p.first_name || '',
    last_name: p.last_name || '',
    title: p.title || '',
    email: p.email && !/email_not_unlocked/i.test(p.email) ? p.email : '',
    email_status: p.email_status || '',
    linkedin: p.linkedin_url || '',
    organization_name: (p.organization && p.organization.name) || '',
  };
}

async function pushContacts(env, body) {
  const contacts = (Array.isArray(body.contacts) ? body.contacts : []).slice(0, 100).map(c => ({
    first_name: String(c.first_name || '').slice(0, 100),
    last_name: String(c.last_name || '').slice(0, 100),
    email: String(c.email || '').slice(0, 200),
    title: String(c.title || '').slice(0, 200),
    organization_name: String(c.organization_name || '').slice(0, 200),
    website_url: c.domain ? 'https://' + cleanDomain(c.domain) : undefined,
  })).filter(c => c.email || (c.first_name && c.organization_name));
  if (!contacts.length) throw Object.assign(new Error('No contacts to add.'), { status: 400 });
  const label = String(body.label || 'Lead Scanner').slice(0, 100);
  const data = await apollo(env, '/contacts/bulk_create', { contacts, append_label_names: [label], run_dedupe: true });
  const created = (data.created_contacts || data.contacts || []).length;
  const existing = (data.existing_contacts || []).length;
  return { created, existing, label };
}
