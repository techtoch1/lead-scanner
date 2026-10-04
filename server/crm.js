// A small CRM for Lead Scanner: companies you tick in the scanner, stored in one
// JSON file on the server and shared by everyone who signs in.
//
// Company details come from two credit-free sources:
//  - Apollo: the company is looked up among the accounts saved in your Apollo
//    workspace (or added as one), and the account record is read. Reading
//    and creating accounts are included in free Apollo plans; enrichment and
//    search endpoints are not.
//  - The company's own homepage: title, description, social links, emails and
//    phone numbers it lists.
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { apollo, cleanDomain } from '../worker/apollo-proxy.js';

export const STATUSES = ['New', 'Contacted', 'Meeting', 'Proposal', 'Won', 'Lost'];
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const str = (v, max = 500) => (v == null ? '' : String(v)).slice(0, max);
const httpError = (status, message) => Object.assign(new Error(message), { status });

export function createCrm({ dataDir, env }) {
  const file = path.join(dataDir, 'crm.json');
  let items = null;          // domain -> record
  let saving = Promise.resolve();

  async function load() {
    if (items) return items;
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      items = new Map((data.items || []).map(r => [r.domain, r]));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      items = new Map();
    }
    return items;
  }

  // Writes go through one queue and land atomically (temp file + rename).
  function save() {
    saving = saving.then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify({ version: 1, items: [...items.values()] }, null, 1));
      await fs.rename(tmp, file);
    });
    return saving;
  }

  const list = () => [...items.values()].sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));

  function cleanScan(s) {
    if (!s || typeof s !== 'object') return null;
    return {
      status: str(s.status, 30), provider: str(s.provider, 100), grade: str(s.grade, 20),
      spoofable: Boolean(s.spoofable), issues: str(s.issues, 1500), mx: str(s.mx, 500),
      scannedAt: new Date().toISOString(),
    };
  }

  const routes = {
    async list() {
      await load();
      return { items: list(), statuses: STATUSES };
    },

    // body: { items: [{ domain, name?, scan? }] }; existing entries only get their scan refreshed.
    async add(_user, body) {
      await load();
      const incoming = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
      const added = [];
      for (const it of incoming) {
        const domain = cleanDomain(it.domain);
        if (!DOMAIN_RE.test(domain)) continue;
        const now = new Date().toISOString();
        const existing = items.get(domain);
        if (existing) {
          if (it.scan) existing.scan = cleanScan(it.scan);
          existing.updatedAt = now;
          continue;
        }
        items.set(domain, {
          domain, name: str(it.name, 200), status: 'New', notes: '', followUp: '',
          addedAt: now, updatedAt: now, addedBy: str(_user, 100),
          scan: cleanScan(it.scan), apollo: null, web: null,
        });
        added.push(domain);
      }
      await save();
      return { added, items: list() };
    },

    // body: { domain, status?, notes?, followUp?, name? }
    async update(_user, body) {
      await load();
      const rec = items.get(cleanDomain(body.domain));
      if (!rec) throw httpError(404, 'Not in the CRM.');
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) throw httpError(400, 'Unknown status.');
        rec.status = body.status;
      }
      if (body.notes !== undefined) rec.notes = str(body.notes, 5000);
      if (body.name !== undefined) rec.name = str(body.name, 200);
      if (body.followUp !== undefined) {
        if (body.followUp && !/^\d{4}-\d{2}-\d{2}$/.test(body.followUp)) throw httpError(400, 'Follow-up must be a date.');
        rec.followUp = body.followUp || '';
      }
      rec.updatedAt = new Date().toISOString();
      await save();
      return { item: rec };
    },

    async remove(_user, body) {
      await load();
      items.delete(cleanDomain(body.domain));
      await save();
      return { ok: true };
    },

    // Fetches Apollo and website details for one company. body: { domain }
    async enrich(_user, body) {
      await load();
      const rec = items.get(cleanDomain(body.domain));
      if (!rec) throw httpError(404, 'Not in the CRM.');
      const [ap, web] = await Promise.all([
        apolloDetails(rec).catch(e => ({ error: e.message, fetchedAt: new Date().toISOString() })),
        websiteDetails(rec.domain).catch(e => ({ error: e.message, fetchedAt: new Date().toISOString() })),
      ]);
      // Keep the Apollo account id even if this attempt failed after finding it.
      rec.apollo = { ...(rec.apollo && rec.apollo.accountId ? { accountId: rec.apollo.accountId } : {}), ...ap };
      rec.web = web;
      if (!rec.name) rec.name = ap.name || web.siteName || '';
      rec.updatedAt = new Date().toISOString();
      await save();
      return { item: rec };
    },
  };

  // ---- Apollo (accounts API: no credits) -----------------------------------
  async function apolloDetails(rec) {
    if (!env.APOLLO_API_KEY) throw new Error('No Apollo key on the server.');
    let id = rec.apollo && rec.apollo.accountId;
    let created = false;
    if (!id) {
      const found = await apollo(env, '/accounts/search', { q_organization_domains_list: [rec.domain], page: 1, per_page: 5 });
      const match = (found.accounts || []).find(a => cleanDomain(a.primary_domain || a.domain || a.website_url) === rec.domain);
      id = match && match.id;
    }
    if (!id) {
      // Never add junk to Apollo: the domain must be a real public website first.
      await assertPublicHost(rec.domain).catch(() => { throw new Error('Not added to Apollo: this domain isn\'t a public website.'); });
      const made = await apollo(env, '/accounts', { name: rec.name || rec.domain, domain: rec.domain });
      id = made.account && made.account.id;
      created = true;
      if (!id) throw new Error('Apollo didn\'t return an account id.');
    }
    const data = await apollo(env, '/accounts/' + encodeURIComponent(id), null, 'GET');
    const a = data.account || {};
    const names = v => (Array.isArray(v) ? v.map(x => (x && typeof x === 'object' ? x.name : x)).filter(Boolean) : []);
    const out = {
      accountId: id,
      name: a.name || '',
      employees: a.estimated_num_employees ?? null,
      industry: a.industry || '',
      industries: names(a.industries).slice(0, 5),
      revenue: a.annual_revenue_printed || '',
      founded: a.founded_year || null,
      linkedin: a.linkedin_url || '',
      phone: a.sanitized_phone || a.phone || (a.primary_phone && a.primary_phone.sanitized_number) || '',
      city: a.city || a.organization_city || '',
      country: a.country || a.organization_country || '',
      description: str(a.short_description, 600),
      keywords: names(a.keywords).slice(0, 12),
      technologies: names(a.current_technologies).slice(0, 15),
      headcountGrowth12m: a.organization_headcount_twelve_month_growth ?? null,
      funding: a.latest_funding_stage || '',
      fetchedAt: new Date().toISOString(),
    };
    if (created && !out.employees && !out.industry) {
      out.note = 'Added to Apollo just now; Apollo can take a minute to fill in company details. Use Refresh company data shortly.';
    }
    return out;
  }

  return { routes, load };
}

// ---- Company homepage ---------------------------------------------------------
// Only public addresses, so this can't be pointed at the server's own network.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') ||
    v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

async function assertPublicHost(host) {
  if (!DOMAIN_RE.test(host)) throw new Error('Not a public website address.');
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('Website resolves to a private address.');
}

async function fetchPage(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || (u.port && !['80', '443'].includes(u.port))) throw new Error('Unsupported redirect.');
    await assertPublicHost(u.hostname);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadScanner/1.0)', Accept: 'text/html,*/*;q=0.5' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).toString();
      continue;
    }
    if (!res.ok) throw new Error('Website answered ' + res.status + '.');
    // Read at most 1.5 MB.
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < 1.5e6) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.length;
    }
    reader.cancel().catch(() => {});
    return { url, html: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('Too many redirects.');
}

const decode = s => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, ' ').trim();

function meta(html, names) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:name|property)=["']${n}["'][^>]*>`, 'i');
    const tag = html.match(re);
    if (tag) {
      const c = tag[0].match(/content=["']([^"']*)["']/i);
      if (c && c[1].trim()) return decode(c[1]).slice(0, 400);
    }
  }
  return '';
}

async function websiteDetails(domain) {
  let page = null, lastErr;
  for (const start of [`https://${domain}/`, `https://www.${domain}/`, `http://${domain}/`]) {
    try { page = await fetchPage(start); break; } catch (e) { lastErr = e; }
  }
  if (!page) throw new Error('Couldn\'t load the website: ' + (lastErr ? lastErr.message : 'no answer'));
  const { html, url } = page;
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').slice(0, 200);
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map(m => decode(m[1]));
  const firstLink = re => hrefs.find(h => re.test(h)) || '';
  const socials = {
    linkedin: firstLink(/^https?:\/\/([a-z]+\.)?linkedin\.com\/(company|school|in)\//i),
    instagram: firstLink(/^https?:\/\/(www\.)?instagram\.com\/[^/?#]+/i),
    facebook: firstLink(/^https?:\/\/(www\.|m\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr\b)[^?#]+/i),
    x: firstLink(/^https?:\/\/(www\.)?(twitter|x)\.com\/(?!intent|share)[^/?#]+/i),
    whatsapp: firstLink(/^https?:\/\/(wa\.me|api\.whatsapp\.com)\//i),
  };
  const uniq = arr => [...new Set(arr)];
  const emails = uniq([
    ...hrefs.filter(h => /^mailto:/i.test(h)).map(h => h.slice(7).split('?')[0]),
    ...(html.replace(/<script[\s\S]*?<\/script>/gi, '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []),
  ].map(e => e.toLowerCase()).filter(e => !/\.(png|jpe?g|gif|svg|webp)$/.test(e) && !/example\.|sentry|wixpress|@2x/.test(e))).slice(0, 8);
  const phones = uniq(hrefs.filter(h => /^tel:/i.test(h)).map(h => h.slice(4).replace(/[^\d+]/g, '')).filter(p => p.length >= 7)).slice(0, 5);
  const generator = meta(html, ['generator']);
  return {
    url,
    siteName: meta(html, ['og:site_name']) || '',
    title,
    description: meta(html, ['description', 'og:description', 'twitter:description']),
    socials: Object.fromEntries(Object.entries(socials).filter(([, v]) => v)),
    emails,
    phones,
    builtWith: generator.slice(0, 80),
    fetchedAt: new Date().toISOString(),
  };
}
