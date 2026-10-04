# Lead Scanner

**Live tool:** https://techtoch1.github.io/lead-scanner/

Paste websites, domains or email addresses and see which companies **aren't** using Google Workspace or Microsoft 365 for email. Those are your leads.

## How it works

For each domain the page looks up two DNS records from your browser, using Google Public DNS (Cloudflare as fallback):

- **MX**: which server receives the domain's email.
- **SPF**: which services are allowed to send email for it. This is used to see through security gateways like Mimecast or Proofpoint.
- **DMARC** (`_dmarc.<domain>`): whether receivers are told to reject or quarantine mail that fails SPF/DKIM.
- **DKIM** (`<selector>._domainkey.<domain>`): checked on the provider's selector and a list of common ones.

Each domain is marked as:

| Status | Meaning |
|---|---|
| Professional | On Google Workspace or Microsoft 365 (or another provider you tick) |
| Lead | Any other host (Zoho, GoDaddy, Titan, cPanel/self-hosted...), a free inbox like gmail.com, or no email set up |
| Review | Behind a security gateway with no SPF hint about the provider. Check by hand |
| Error | Domain doesn't exist or the lookup failed |

Each domain also gets an **email security** grade:

| Grade | Meaning |
|---|---|
| At risk | No DMARC, no SPF, SPF `+all`, more than one SPF record, or an invalid DMARC policy |
| Weak | Records exist but don't block spoofed mail: DMARC `p=none`, DMARC `pct` under 100, SPF `?all` or no `all` rule |
| Good | SPF plus an enforced DMARC policy (`quarantine` or `reject`) |

"Can be spoofed" means DMARC is missing or set to `p=none`. DKIM uses custom selectors at some companies, so "not found" never lowers the grade on its own.

Results can be filtered, searched and exported to CSV (all, or leads only).

## Connect Apollo

Lead Scanner can work with your Apollo account:

- **Find companies in Apollo** by location, industry keywords and size, then scan them automatically.
- **Find decision makers** (owner, CEO, IT manager...) for each lead. Uses Apollo's People API Search, which costs no credits.
- **Reveal email**, one person at a time. Each reveal costs **1 Apollo credit**, and nothing is revealed unless you click.
- **Add revealed contacts to Apollo** under a list name you choose.

The Apollo API key must never go in this page: the page and repo are public. It lives in a small Cloudflare Worker (`worker/apollo-proxy.js`) that only answers requests carrying your password.

### Setup (about 10 minutes, free)

1. **Get an Apollo API key.** In Apollo, open *Settings → Integrations → API* and create a key. If Apollo offers it, make it a **master key**; adding contacts needs one.
2. **Create the Worker.** Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) (free plan), then go to *Workers & Pages → Create → Create Worker*. Name it `lead-scanner-apollo` and click *Deploy*.
3. **Paste the code.** Click *Edit code*, replace everything with the contents of [`worker/apollo-proxy.js`](worker/apollo-proxy.js), and click *Deploy*.
4. **Add the settings.** In the Worker, open *Settings → Variables and Secrets* and add:
   | Name | Type | Value |
   |---|---|---|
   | `APOLLO_API_KEY` | Secret | your Apollo API key |
   | `ACCESS_PASSWORD` | Secret | a long password you make up |
   | `ALLOWED_ORIGIN` | Text | `https://techtoch1.github.io` |
5. **Connect the page.** Open Lead Scanner, expand *Apollo connection settings*, enter the Worker address (shown on the Worker's page, like `https://lead-scanner-apollo.<you>.workers.dev`) and the password, then click *Save and test*.

Prefer the command line? Run `npx wrangler deploy` inside `worker/`, then `npx wrangler secret put APOLLO_API_KEY` and `npx wrangler secret put ACCESS_PASSWORD`.

Share the password only with people who should use your Apollo credits. To cut someone off, change `ACCESS_PASSWORD` in Cloudflare.

## Running it

The scanner is a single static page with no build step (Apollo features need the Worker above). Open `index.html` in a browser, or host it anywhere static (it's published with GitHub Pages).
