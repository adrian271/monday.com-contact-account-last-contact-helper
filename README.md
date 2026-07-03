# Monday Account-Level Follow-Up Service

A small Next.js service that gives each **Account** (organization) in Monday.com its
own follow-up clock. When anyone at an account is contacted, the service rolls the
most-recent outreach up to the account and calculates the account's **Next Follow-Up
Date** from a cadence that depends on the account's **Status**. A daily sweep
escalates follow-ups nobody has acted on (twice, in business days, then stops).
Monday's native automation handles the Slack notification.

See [WHY.md](./WHY.md) for the reasoning behind this design.

## How it works

There are two moving parts: a **webhook** that reacts to outreach in real time, and a
**daily sweep** that escalates follow-ups nobody has acted on.

```
# Real-time (webhook)
Contact reached out to → Monday stamps the contact's Latest Outreach Date
  → Monday webhook fires → POST /api/monday/webhook
  → Service finds the Account linked to that contact
  → Reads Latest Outreach Date across ALL of the account's contacts, takes the most recent
  → Writes it to the account's "Acct Latest Outreach (calc)" column
  → Reads the account's Status → maps it to an interval → adds it (landing on a weekday)
    → account Next Follow-Up Date (and resets the escalation counter)
  → Resolves the account Owner → looks up their Slack handle in the team roster
    → writes it to the account's "Person to Slack" column (so the reminder can @mention them)
  → Monday native automation: when Next Follow-Up Date arrives → Slack notification

# Daily (cron sweep)
GET /api/cron/sweep (once a day)
  → For each account whose Next Follow-Up Date has passed with no follow-up:
    → under the nudge cap → push the date +2 business days (re-fires the Slack reminder)
    → at the cap (2 extra nudges) → clear the date so the account goes quiet
```

The cadence and the follow-up clock live on the **Account**, so each organization
gets one schedule regardless of how many contacts it has.

### Follow-up cadence by status

The interval is driven by the account's **Status** column
(`STAGE_INTERVAL_DAYS` in [`lib/monday.ts`](./lib/monday.ts)):

| Status | Cadence |
|--------|---------|
| Prospect, Outreached, In Conversation | last outreach **+14 days** |
| Checked In, Pitched, Contracting | last outreach **+7 days** |
| Active Client, Closed, Vendor | **no follow-up** — the date is cleared |
| _blank / unrecognized_ | **+14 days** (so accounts never silently drop off) |

Follow-up dates always land on a **weekday**, and escalation reminders step forward in
**business days** (skipping weekends).

## Monday board setup

**Contacts board** — needs a date column for outreach and a link to the Accounts board:

| Column                | Type            | Notes                                   |
|-----------------------|-----------------|-----------------------------------------|
| Latest Outreach Date  | Date            | Stamped when a contact is reached out to |
| Account               | Connect boards  | Links each contact to its Account        |
| Slack Handle          | Text            | Each team member's Slack handle (e.g. `@jenna`) — read for the owner roster (see below) |

**Accounts board** — holds the per-account follow-up state:

| Column                      | Type            | Notes                                          |
|-----------------------------|-----------------|------------------------------------------------|
| Contacts                    | Connect boards  | Links each account to its contacts             |
| Owner                       | People          | The account owner — matched **by name** to the team roster to find their Slack handle |
| Acct Latest Outreach (calc) | Date            | **Written by this service** (max across contacts) |
| Status                      | Status          | Relationship stage — drives the follow-up cadence (see table above) |
| Next Follow-Up Date         | Date            | **Written by this service**; watched by the Slack automation |
| Person to Slack             | Text            | **Written by this service** — the owner's resolved Slack handle, used by the reminder to @mention them |
| Reminder Count (auto)       | Number          | **Managed by the sweep** — escalation counter. Don't edit by hand (you can hide it). |

> Monday's built-in account "Latest Outreach Date" mirror is read-only and can't
> produce a single most-recent value, so the service maintains its own writable
> "Acct Latest Outreach (calc)" date column instead.

### Owner → Slack handle (the roster)

The reminder should @mention **whoever owns the account**, dynamically. Monday's
Slack "send message" action can't mention a people column directly, and Monday user
profiles don't expose a Slack handle — so the service resolves it from your own data:

1. Your internal team members each have a **contact row** under one dedicated
   "team" account (for 10/10 Research, the account of the same name — set its ID as
   `MONDAY_INTERNAL_ACCOUNT_ID`), with their **Slack Handle** column filled.
2. On each webhook, the service reads the account's **Owner**, matches the owner's
   name against that roster (case-insensitive; trailing credentials like `, PhD` are
   ignored), and writes the matched **Slack Handle** into **Person to Slack**.
3. The Slack automation's message uses the **`{Person to Slack}`** token, which
   outputs e.g. `@jenna` — Slack renders it as a real ping.

**Maintenance:** when a new person can own accounts, add them once as a contact under
the team account with their Slack Handle — no code or config change. An owner with no
matching roster entry (or a blank handle) resolves to an empty Person to Slack, so the
reminder simply posts without a ping (safe). Matching is **by name**, so an owner's
Monday display name must match their roster contact name.

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
  "config": { "apiToken": true, "accountsBoardId": true, "accountStage": true, "accountReminderCount": true, "...": true }
}
```

Each `config` flag is `true` only when that env var is set and not left as a
placeholder, so a `false` immediately points at a missing variable in your host's
settings. No secrets or IDs are exposed.

### 5. Deploy

Deploy to any Node host (e.g. Vercel: `npx vercel`). Set the same environment
variables in your host's dashboard, and add a **`CRON_SECRET`** (any random string) —
it protects the daily sweep endpoint.

On Vercel, [`vercel.json`](./vercel.json) registers the daily cron automatically
(`/api/cron/sweep` at 13:00 UTC) and Vercel sends `Authorization: Bearer $CRON_SECRET`
with each invocation. On another host, point any scheduler (GitHub Actions,
cron-job.org, …) at `GET /api/cron/sweep` once a day with that same bearer header.

### 6. Register the webhook in Monday

On your **Contacts** board → **Integrate → Webhooks**:

- **URL**: `https://your-deployment-url/api/monday/webhook`
- **Event**: `Change specific column value`
- **Column**: `Latest Outreach Date`

Monday sends a challenge to verify the endpoint — the service echoes it automatically.

### 7. Slack notification automation (native Monday)

On your **Accounts** board → **Automate → Create custom automation**:

- Trigger: **When Next Follow-Up Date arrives**
- Action: **Send Slack notification** → `#client-outreach`, and include the
  **`{Person to Slack}`** column as a token in the message to @-ping the account owner,
  e.g. `{Person to Slack} — {Account's Name} is due for outreach`. The service keeps
  `Person to Slack` populated with the owner's handle (see [the roster](#owner--slack-handle-the-roster)).

> Don't try to @-mention the **Owner** people column directly — Monday's Slack action
> only substitutes it as plain text (the person's name), which Slack won't turn into a
> ping. The `{Person to Slack}` handle is what resolves to an actual mention.

> **Keep this automation Slack-only — do not add a "set date" or "clear date" action.**
> The service owns the Next Follow-Up Date lifecycle: the webhook sets it, and the
> daily sweep advances it (re-firing this reminder) and clears it after the escalation
> cap. A date-mutating action here would fight the sweep.

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

## Escalation (the daily sweep)

`GET /api/cron/sweep` runs once a day and chases follow-ups nobody acted on. For each
account whose Next Follow-Up Date is **strictly in the past** (acting only on past
dates means it never races Monday's own same-day reminder):

- **Under the cap** (`MAX_ESCALATIONS` = 2 in `lib/monday.ts`) → push the date forward
  **2 business days** and increment the *Reminder Count (auto)* column. Monday's
  "when date arrives" recipe fires the Slack nudge again on the new date.
- **At the cap** → clear the date and reset the counter, so the account goes quiet
  until someone is contacted again (which restarts the whole cycle via the webhook).

The result is three nudges — on the due date, +2 business days, and +2 more — then
silence. The endpoint is protected by `CRON_SECRET` (see Deploy).

## Configuration reference

All configuration is environment-driven — see [`.env.local.example`](./.env.local.example)
for the full list of variables (API token, board IDs, column IDs, allowlist, and the
optional test target).
