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

## Running it

It's a single static page with no server or build step. Open `index.html` in a browser, or host it anywhere static (it's published with GitHub Pages).
