# Monday Account-Level Follow-Up Service

A small Next.js service that gives each **Account** (organization) in Monday.com its
own follow-up clock. When anyone at an account is contacted, the service rolls the
most-recent outreach up to the account and calculates the account's **Next Follow-Up
Date** from that account's own interval. Monday's native automations then handle the
reminder + Slack notification.

See [WHY.md](./WHY.md) for the reasoning behind this design.

## How it works

```
Contact reached out to → Monday stamps the contact's Latest Outreach Date
  → Monday webhook fires → POST /api/monday/webhook
  → Service finds the Account linked to that contact
  → Reads Latest Outreach Date across ALL of the account's contacts, takes the most recent
  → Writes it to the account's "Acct Latest Outreach (calc)" column
  → Reads the account's Follow-Up Interval (days), adds it → account Next Follow-Up Date
  → Monday native automation: when Next Follow-Up Date arrives → Slack notification → clear date
```

The interval and the follow-up clock live on the **Account**, so each organization
gets one interval regardless of how many contacts it has.

## Monday board setup

**Contacts board** — needs a date column for outreach and a link to the Accounts board:

| Column                | Type            | Notes                                   |
|-----------------------|-----------------|-----------------------------------------|
| Latest Outreach Date  | Date            | Stamped when a contact is reached out to |
| Account               | Connect boards  | Links each contact to its Account        |

**Accounts board** — holds the per-account follow-up state:

| Column                      | Type            | Notes                                          |
|-----------------------------|-----------------|------------------------------------------------|
| Contacts                    | Connect boards  | Links each account to its contacts             |
| Acct Latest Outreach (calc) | Date            | **Written by this service** (max across contacts) |
| Follow-Up Interval (days)   | Number          | Days between follow-ups, per account           |
| Next Follow-Up Date         | Date            | **Written by this service**                    |

> Monday's built-in account "Latest Outreach Date" mirror is read-only and can't
> produce a single most-recent value, so the service maintains its own writable
> "Acct Latest Outreach (calc)" date column instead.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.local.example .env.local
# Edit .env.local with your token, board IDs, and column IDs
```

Get your API token: **Profile avatar → Administration → API → Copy token**.

Don't know your board/column IDs? Run the discovery script (see below) — it prints
every board and the columns on them.

### 3. Find your board & column IDs

```bash
npm run monday:test
```

`scripts/monday-test.mjs` is a step-by-step harness that connects, lists boards,
inspects columns, reads a contact, finds its account, and (with `WRITE=1`) performs
the full roll-up against a single test contact/account. It only writes when run as
`WRITE=1 npm run monday:test`.

### 4. Run locally

```bash
npm run dev
```

Webhook endpoint: `http://localhost:3000/api/monday/webhook`

### Health check

`GET /api/monday/webhook` returns a JSON status you can open in a browser to confirm
a deployment is live and correctly configured — **before** sending a test email:

```json
{
  "status": "ok",
  "signatureVerification": "enabled",
  "rollout": { "mode": "guarded", "allowedAccountCount": 1 },
  "config": { "apiToken": true, "accountsBoardId": true, "contactOutreachDate": true, "...": true }
}
```

Each `config` flag is `true` only when that env var is set and not left as a
placeholder, so a `false` immediately points at a missing variable in your host's
settings. No secrets or IDs are exposed.

### 5. Deploy

Deploy to any Node host (e.g. Vercel: `npx vercel`). Set the same environment
variables in your host's dashboard.

### 6. Register the webhook in Monday

On your **Contacts** board → **Integrate → Webhooks**:

- **URL**: `https://your-deployment-url/api/monday/webhook`
- **Event**: `Change specific column value`
- **Column**: `Latest Outreach Date`

Monday sends a challenge to verify the endpoint — the service echoes it automatically.

### 7. Slack notification automation (native Monday)

On your **Accounts** board → **Automate → Create custom automation**:

- Trigger: **When Next Follow-Up Date arrives**
- Action 1: **Send Slack notification** → your channel
- Action 2: **Set Next Follow-Up Date to blank** (prevents re-firing)

## Security: webhook signature verification

Monday signs every webhook with a JWT in the `Authorization` header (HS256, keyed by
your app's **Signing Secret**, found at monday.com → Developers → your app → Signing
Secret). Set `MONDAY_SIGNING_SECRET` to enable verification:

- **Set** → event requests must carry a valid, unexpired signature, or they're
  rejected with `401`. (The registration challenge is still allowed through, since it
  carries no data and proves URL ownership.)
- **Unset** → verification is skipped and a warning is logged. **Set it before
  exposing the endpoint publicly.**

Verification uses Node's `crypto` directly (no dependencies) and always computes
HMAC-SHA256, so it isn't vulnerable to JWT algorithm-confusion attacks.

## Guarded rollout

`MONDAY_ALLOWED_ACCOUNT_IDS` (comma-separated account IDs) restricts the service to
specific accounts while you test against the live board. Leave it **empty to act on
all accounts**. Any account not on a non-empty list is ignored with no writes.

## Default interval

If an account has no Follow-Up Interval set, the service defaults to **30 days**.

## Configuration reference

All configuration is environment-driven — see [`.env.local.example`](./.env.local.example)
for the full list of variables (API token, board IDs, column IDs, allowlist, and the
optional test target).
