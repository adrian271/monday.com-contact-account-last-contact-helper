# Why Per-Account Follow-Up Reminders Need a Little Extra Help

Monday.com's built-in automations are great for straightforward rules — "when this happens, do that." But our follow-up reminder system has a few wrinkles that put it just outside what Monday can handle on its own.

---

## The goal

We want each **account** (organization) to have its own follow-up window, and that window should depend on **how warm the relationship is**. A cold prospect doesn't need chasing as often as someone we're actively pitching. When anyone at that account is contacted, the clock resets and a reminder fires at the right time for _that specific account_ — and if nobody acts on the reminder, it nudges again a couple more times before going quiet.

---

## Wrinkle 1: Monday can't do per-row date math

Monday automations work with **fixed values**. You can tell it:

> "When a date is set, schedule a reminder for 30 days later."

But you can't tell it:

> "When a date is set, schedule a reminder for however many days _this particular account's stage_ calls for."

We drive the interval off the account's **Status** — Prospect/Outreached/In Conversation get a 14-day cadence, Checked In/Pitched/Contracting get 7 days, and stages like Active Client/Closed/Vendor get no automated follow-up at all. Monday can read a row's status, but it can't turn that into "add N days to this date" on the fly. The interval would have to be hardcoded into the automation — one fixed number for every account, no exceptions.

---

## Wrinkle 2: The data hierarchy

Our CRM has two levels:

- **Accounts** — the companies we work with
- **Contacts** — the individual people at those companies

Outreach happens to a _person_ (a contact), but the follow-up window belongs to the _company_ (the account). Monday links contacts to accounts, but it doesn't automatically understand that contacting one person should reset the whole account's follow-up clock — or that the account's "last contacted" date should be the most recent outreach across _all_ its contacts.

Monday's mirror columns can show a contact field up at the account level, but a mirror just lists every linked contact's value — it can't reduce them to a single "most recent" date, and it's read-only, so nothing downstream can build on it.

---

## Wrinkle 3: Business-day escalation that knows when to stop

A single reminder is easy. What we actually want is:

> Nudge on the due date. If nobody follows up, nudge again 2 **business days** later. Then once more, 2 business days after that. Then stop.

Monday can't do this natively. Its date math counts calendar days (so "+2 days" from a Thursday lands on a weekend), and it has no clean way to count "how many times have I nudged about this?" and stop after two. Left to its own devices it would either ping people on Saturdays or nag forever.

---

## What we built

A small background service sits alongside Monday and handles just the pieces Monday can't:

**When a contact is reached out to** (their outreach date updates), the service wakes up and:

1. Finds the **account** that contact belongs to.
2. Looks at **every contact** on that account and takes the **most recent** outreach date — the account's true "last contacted."
3. Reads **that account's Status**, maps it to an interval, adds it to the most-recent date (landing on a weekday), and writes the account's **Next Follow-Up Date**. Accounts in a no-follow-up stage have their date cleared instead.

**Once a day**, a scheduled sweep looks for accounts whose follow-up date has passed without anyone acting, and walks them through the escalation: push the date forward 2 business days (re-arming Monday's reminder), up to twice, then clear it so the account goes quiet until the next real contact.

From there, Monday takes over and sends the Slack notification natively — it just needed someone to do the roll-up, the stage-aware math, and the business-day escalation first.

---

The end result works exactly like a native Monday automation from the team's perspective. The extra layer is invisible in day-to-day use.
