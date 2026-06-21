# Why Per-Account Follow-Up Reminders Need a Little Extra Help

Monday.com's built-in automations are great for straightforward rules — "when this happens, do that." But our follow-up reminder system has two wrinkles that put it just outside what Monday can handle on its own.

---

## The goal

We want each **account** (organization) to have its own follow-up window. One account might need outreach every 30 days, another every 90. When anyone at that account is contacted, the clock resets and a reminder fires at the right time for _that specific account_.

---

## Wrinkle 1: Monday can't do per-row date math

Monday automations work with **fixed values**. You can tell it:

> "When a date is set, schedule a reminder for 30 days later."

But you can't tell it:

> "When a date is set, schedule a reminder for however many days _this particular account's row_ says."

Monday can read a number stored on a row, but it can't use that number as part of a date calculation on the fly. The interval has to be hardcoded into the automation — one fixed number for every account, no exceptions.

---

## Wrinkle 2: The data hierarchy

Our CRM has two levels:

- **Accounts** — the companies we work with
- **Contacts** — the individual people at those companies

Outreach happens to a _person_ (a contact), but the follow-up window belongs to the _company_ (the account). Monday links contacts to accounts, but it doesn't automatically understand that contacting one person should reset the whole account's follow-up clock — or that the account's "last contacted" date should be the most recent outreach across _all_ its contacts.

Monday's mirror columns can show a contact field up at the account level, but a mirror just lists every linked contact's value — it can't reduce them to a single "most recent" date, and it's read-only, so nothing downstream can build on it.

---

## What we built

A small background service sits alongside Monday and handles just the pieces Monday can't:

When a contact is reached out to and their outreach date updates, the service wakes up and:

1. Finds the **account** that contact belongs to.
2. Looks at **every contact** on that account and takes the **most recent** outreach date — the account's true "last contacted."
3. Reads **that account's own interval**, adds it to the most-recent date, and writes the result back as the account's **Next Follow-Up Date**.

From there, Monday takes over and handles the reminder and Slack notification natively — it just needed someone to do the roll-up and the math first.

Think of it as a calculator-plus-roll-up that Monday can call on whenever it needs something more dynamic than its built-in automations allow.

---

The end result works exactly like a native Monday automation from the team's perspective. The extra layer is invisible in day-to-day use.
