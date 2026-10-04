# Lead Scanner

**Live tool:** https://leads.aligned-tech.com (login required)

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

## Install on your own server (recommended)

Runs the page and the Apollo connection from one small Node.js process behind Nginx, with its own sign-in page (passwords are stored as scrypt hashes; sessions last 7 days; 8 wrong attempts lock an address out for 15 minutes). The Apollo key stays on the server. Needs Ubuntu with Nginx and Node.js 18+, and a DNS record pointing the domain at the server.

```bash
git clone https://github.com/techtoch1/lead-scanner.git ~/lead-scanner
sudo bash ~/lead-scanner/deploy/install.sh
```

The script asks for your Apollo API key and a username and password for the sign-in page, then adds a service on `127.0.0.1:3010`, an Nginx site for `leads.aligned-tech.com` and an HTTPS certificate. It doesn't touch other Nginx sites. Use `DOMAIN=other.example.com PORT=3011 sudo -E bash ...` to change the defaults.

- Update: `bash ~/lead-scanner/deploy/update.sh`
- Change the username or password: `sudo bash ~/lead-scanner/deploy/install.sh` and answer `y` when it asks to replace the sign-in
- Remove: `sudo bash ~/lead-scanner/deploy/uninstall.sh`
- Logs: `sudo journalctl -u lead-scanner -n 50`

### CRM

On the server version, tick companies in the scanner results and press **Add to CRM**. The **CRM** tab lists them with a status (New, Contacted, Meeting, Proposal, Won, Lost), a follow-up date and notes, and can be filtered and exported to CSV. The data is stored in `/var/lib/lead-scanner/crm.json` on the server and shared by everyone who signs in.

When a company is added, Lead Scanner fills in details without using Apollo credits:

- **Apollo**: it looks the domain up among the accounts in your Apollo workspace, adds it as an account if it isn't there, and reads the account record. Reading and creating accounts work on free plans; Apollo can take a minute to fill in a newly added company, so use *Refresh company data* if fields are empty.
- **The company's website**: title, description, social links, and the emails and phone numbers it lists.

### What works on which Apollo plan

| Feature | Free / trial | Paid |
|---|---|---|
| **CRM company details**: employees, industry, revenue, founded, location, LinkedIn, phone, description, technologies (via Apollo accounts) | ✅ | ✅ |
| Search Apollo for companies | ❌ | ✅ |
| Find decision makers, reveal emails, add contacts to lists | ❌ | ✅ |

The page checks your plan and only shows what works.

## Connect Apollo with a Cloudflare Worker (alternative)

Only needed if you host the page on GitHub Pages instead of your own server.

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
