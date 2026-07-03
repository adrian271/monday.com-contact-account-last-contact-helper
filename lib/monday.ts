// Monday.com API client + account-level follow-up domain logic.
//
// The flow: when a contact's Latest Outreach Date changes, roll the most-recent
// outreach across all of that account's contacts up to the Account, then compute
// the account's Next Follow-Up Date from the account's own interval.

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN!;

// All board/column IDs are read from the environment. The placeholder fallbacks
// below are intentionally NOT real IDs — set the real values in .env.local (see
// .env.local.example). Find IDs via the test script: `npm run monday:test`.
export const ACCOUNTS_BOARD_ID = process.env.MONDAY_ACCOUNTS_BOARD_ID || 'YOUR_ACCOUNTS_BOARD_ID';

// The internal "10/10 Research" account. Its linked contacts are the team roster
// we look up owner Slack handles from (owner name -> contact's Slack Handle).
export const INTERNAL_ACCOUNT_ID = process.env.MONDAY_INTERNAL_ACCOUNT_ID || 'YOUR_INTERNAL_ACCOUNT_ID';

export const COLUMN_IDS = {
  // Contacts board
  contactOutreachDate: process.env.MONDAY_OUTREACH_DATE_COLUMN_ID || 'YOUR_CONTACT_OUTREACH_DATE_COLUMN_ID',
  contactAccountLink: process.env.MONDAY_CONTACT_ACCOUNT_LINK_COLUMN_ID || 'YOUR_CONTACT_ACCOUNT_LINK_COLUMN_ID',
  contactSlackHandle: process.env.MONDAY_CONTACT_SLACK_HANDLE_COLUMN_ID || 'YOUR_CONTACT_SLACK_HANDLE_COLUMN_ID',
  // Accounts board
  accountContactsLink: process.env.MONDAY_ACCOUNT_CONTACTS_LINK_COLUMN_ID || 'YOUR_ACCOUNT_CONTACTS_LINK_COLUMN_ID',
  accountLatestOutreach: process.env.MONDAY_ACCOUNT_LATEST_OUTREACH_COLUMN_ID || 'YOUR_ACCOUNT_LATEST_OUTREACH_COLUMN_ID',
  accountStage: process.env.MONDAY_ACCOUNT_STAGE_COLUMN_ID || 'YOUR_ACCOUNT_STAGE_COLUMN_ID',
  accountNextFollowUp: process.env.MONDAY_ACCOUNT_NEXT_FOLLOWUP_COLUMN_ID || 'YOUR_ACCOUNT_NEXT_FOLLOWUP_COLUMN_ID',
  accountOwner: process.env.MONDAY_ACCOUNT_OWNER_COLUMN_ID || 'YOUR_ACCOUNT_OWNER_COLUMN_ID',
  // Text column this service writes the owner's Slack handle into, so the Monday ->
  // Slack automation can @mention them via a {Person to Slack} token.
  accountPersonToSlack: process.env.MONDAY_ACCOUNT_PERSON_TO_SLACK_COLUMN_ID || 'YOUR_ACCOUNT_PERSON_TO_SLACK_COLUMN_ID',
  // Number column tracking how many escalation nudges have been sent for the
  // current follow-up cycle. The daily sweep reads/increments it and stops after
  // MAX_ESCALATIONS; the webhook resets it to 0 when a fresh contact restarts the cycle.
  accountReminderCount: process.env.MONDAY_REMINDER_COUNT_COLUMN_ID || 'YOUR_REMINDER_COUNT_COLUMN_ID',
};

// How many extra reminders to send after the initial "date arrives" nudge.
// 2 → reminders land on the due date, +2 business days, and +2 more, then stop.
export const MAX_ESCALATIONS = 2;

// Follow-up cadence (days) keyed by the account's Status label.
// `null` means "no automated follow-up" — the service clears any stale date instead.
export const STAGE_INTERVAL_DAYS: Record<string, number | null> = {
  Prospect: 14,
  Outreached: 14,
  'In Conversation': 14,
  'Checked In': 7,
  Pitched: 7,
  Contracting: 7,
  'Active Client': null,
  Closed: null,
  Vendor: null,
};

// Blank or unrecognized status falls back to the cold cadence so accounts don't
// silently drop off the radar.
export const DEFAULT_INTERVAL_DAYS = 14;

// Safety allowlist for a guarded rollout. When set (comma-separated account IDs),
// only those accounts are acted on; everything else is ignored. Defaults to empty
// = act on ALL accounts. Set MONDAY_ALLOWED_ACCOUNT_IDS in .env.local to restrict.
export const ALLOWED_ACCOUNT_IDS = (process.env.MONDAY_ALLOWED_ACCOUNT_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function isAccountAllowed(accountId: string): boolean {
  return ALLOWED_ACCOUNT_IDS.length === 0 || ALLOWED_ACCOUNT_IDS.includes(accountId);
}

// --- API helper --------------------------------------------------------------

export async function mondayRequest<T = any>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: MONDAY_API_TOKEN,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (json.errors) {
    throw new Error(`Monday API error: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

// Add whole days to a YYYY-MM-DD date using UTC math (no timezone off-by-one).
export function addDaysUTC(yyyymmdd: string, days: number): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// True for Saturday/Sunday (UTC).
function isWeekend(yyyymmdd: string): boolean {
  const day = new Date(`${yyyymmdd}T00:00:00Z`).getUTCDay(); // 0 = Sun, 6 = Sat
  return day === 0 || day === 6;
}

// Roll a date forward to the next weekday if it lands on a weekend (no-op on weekdays).
export function nextBusinessDay(yyyymmdd: string): string {
  let d = yyyymmdd;
  while (isWeekend(d)) d = addDaysUTC(d, 1);
  return d;
}

// Add N business days (skipping weekends) to a date.
export function addBusinessDays(yyyymmdd: string, n: number): string {
  let d = yyyymmdd;
  let added = 0;
  while (added < n) {
    d = addDaysUTC(d, 1);
    if (!isWeekend(d)) added++;
  }
  return d;
}

// --- Domain steps ------------------------------------------------------------

// Resolve the Account linked to a contact. Returns the first linked account id.
export async function findLinkedAccountId(contactId: string): Promise<string | null> {
  const data = await mondayRequest(
    `query ($itemId: [ID!]) {
       items(ids: $itemId) {
         column_values(ids: ["${COLUMN_IDS.contactAccountLink}"]) {
           ... on BoardRelationValue { linked_item_ids }
         }
       }
     }`,
    { itemId: [contactId] }
  );
  const ids: string[] = data?.items?.[0]?.column_values?.[0]?.linked_item_ids ?? [];
  return ids[0] ?? null;
}

// Most recent Latest Outreach Date across ALL of the account's contacts.
// Date strings are YYYY-MM-DD, so lexical comparison is chronological.
export async function rollUpAccountOutreach(accountId: string): Promise<string | null> {
  const acct = await mondayRequest(
    `query ($itemId: [ID!]) {
       items(ids: $itemId) {
         column_values(ids: ["${COLUMN_IDS.accountContactsLink}"]) {
           ... on BoardRelationValue { linked_item_ids }
         }
       }
     }`,
    { itemId: [accountId] }
  );
  const contactIds: string[] = acct?.items?.[0]?.column_values?.[0]?.linked_item_ids ?? [];
  if (contactIds.length === 0) return null;

  const contacts = await mondayRequest(
    `query ($ids: [ID!]) {
       items(ids: $ids) {
         column_values(ids: ["${COLUMN_IDS.contactOutreachDate}"]) { text }
       }
     }`,
    { ids: contactIds }
  );

  let maxDate = '';
  for (const c of contacts?.items ?? []) {
    const d = c.column_values?.[0]?.text ?? '';
    if (d && d > maxDate) maxDate = d;
  }
  return maxDate || null;
}

// Resolve the account's follow-up cadence from its Status column.
// Returns the interval in days, or `null` when the stage means "no follow-up".
export async function readAccountInterval(accountId: string): Promise<number | null> {
  const data = await mondayRequest(
    `query ($itemId: [ID!]) {
       items(ids: $itemId) {
         column_values(ids: ["${COLUMN_IDS.accountStage}"]) { text }
       }
     }`,
    { itemId: [accountId] }
  );
  const label = (data?.items?.[0]?.column_values?.[0]?.text ?? '').trim();
  // A known label maps to its cadence (which may be null = skip); anything else
  // (blank / unrecognized) uses the cold-cadence default.
  return label in STAGE_INTERVAL_DAYS ? STAGE_INTERVAL_DAYS[label] : DEFAULT_INTERVAL_DAYS;
}

export async function writeAccountDate(accountId: string, columnId: string, date: string) {
  await mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $value: JSON!) {
       change_column_value(board_id: $boardId, item_id: $itemId, column_id: "${columnId}", value: $value) { id }
     }`,
    { boardId: ACCOUNTS_BOARD_ID, itemId: accountId, value: JSON.stringify({ date }) }
  );
}

// Clear a date column (e.g. when an account moves to a no-follow-up stage).
export async function clearAccountDate(accountId: string, columnId: string) {
  await mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!) {
       change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: "${columnId}", value: "") { id }
     }`,
    { boardId: ACCOUNTS_BOARD_ID, itemId: accountId }
  );
}

// Write a number column (used for the reminder/escalation counter).
export async function writeAccountNumber(accountId: string, columnId: string, n: number) {
  await mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!) {
       change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: "${columnId}", value: "${n}") { id }
     }`,
    { boardId: ACCOUNTS_BOARD_ID, itemId: accountId }
  );
}

// Write a plain-text column (used for the resolved owner Slack handle).
export async function writeAccountText(accountId: string, columnId: string, text: string) {
  await mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $value: String!) {
       change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: "${columnId}", value: $value) { id }
     }`,
    { boardId: ACCOUNTS_BOARD_ID, itemId: accountId, value: text }
  );
}

// --- Owner Slack handle resolution -------------------------------------------

// Normalize a person name for matching: lowercase, drop trailing credentials
// after a comma (e.g. "Tara Weatherholt, PhD" -> "tara weatherholt"), collapse
// whitespace. Owner (Monday user) names and internal contact names are matched
// on this normalized form since the internal contacts have no email to key on.
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/,.*$/, '').replace(/\s+/g, ' ').trim();
}

// The account's Owner (people column) display name — first owner if several, '' if none.
export async function readAccountOwnerName(accountId: string): Promise<string> {
  const data = await mondayRequest(
    `query ($itemId: [ID!]) {
       items(ids: $itemId) {
         column_values(ids: ["${COLUMN_IDS.accountOwner}"]) { text }
       }
     }`,
    { itemId: [accountId] }
  );
  const text = (data?.items?.[0]?.column_values?.[0]?.text ?? '').trim();
  return text ? text.split(',')[0].trim() : '';
}

// Build a map of internal team member name -> Slack handle, from the contacts
// linked to the 10/10 Research account. Only entries with a handle are included.
export async function fetchInternalSlackRoster(): Promise<Record<string, string>> {
  const acct = await mondayRequest(
    `query ($itemId: [ID!]) {
       items(ids: $itemId) {
         column_values(ids: ["${COLUMN_IDS.accountContactsLink}"]) {
           ... on BoardRelationValue { linked_item_ids }
         }
       }
     }`,
    { itemId: [INTERNAL_ACCOUNT_ID] }
  );
  const ids: string[] = acct?.items?.[0]?.column_values?.[0]?.linked_item_ids ?? [];
  if (ids.length === 0) return {};

  const contacts = await mondayRequest(
    `query ($ids: [ID!]) {
       items(ids: $ids) {
         name
         column_values(ids: ["${COLUMN_IDS.contactSlackHandle}"]) { text }
       }
     }`,
    { ids }
  );

  const roster: Record<string, string> = {};
  for (const c of contacts?.items ?? []) {
    const handle = (c.column_values?.[0]?.text ?? '').trim();
    if (handle) roster[normalizeName(c.name)] = handle;
  }
  return roster;
}

// Resolve the account owner's Slack handle by matching the owner's name against
// the internal team roster. Returns '' when there's no owner, no matching roster
// entry, or that member has no handle set (all safe "no ping" cases).
export async function resolveOwnerSlackHandle(accountId: string): Promise<string> {
  const ownerName = await readAccountOwnerName(accountId);
  if (!ownerName) return '';
  const roster = await fetchInternalSlackRoster();
  return roster[normalizeName(ownerName)] ?? '';
}

// --- Escalation sweep --------------------------------------------------------

interface AccountFollowUp {
  id: string;
  name: string;
  nextFollowUp: string; // YYYY-MM-DD, '' if unset
  reminderCount: number;
}

// Page through every account on the board, reading the follow-up date + counter.
async function fetchAccountsWithFollowUp(): Promise<AccountFollowUp[]> {
  const out: AccountFollowUp[] = [];
  let cursor: string | null = null;

  do {
    const data: any = await mondayRequest(
      `query ($boardId: [ID!], $cursor: String) {
         boards(ids: $boardId) {
           items_page(limit: 100, cursor: $cursor) {
             cursor
             items {
               id
               name
               column_values(ids: ["${COLUMN_IDS.accountNextFollowUp}", "${COLUMN_IDS.accountReminderCount}"]) { id text }
             }
           }
         }
       }`,
      { boardId: [ACCOUNTS_BOARD_ID], cursor }
    );

    const page = data?.boards?.[0]?.items_page;
    for (const item of page?.items ?? []) {
      const byId: Record<string, string> = {};
      for (const cv of item.column_values ?? []) byId[cv.id] = cv.text ?? '';
      out.push({
        id: item.id,
        name: item.name,
        nextFollowUp: byId[COLUMN_IDS.accountNextFollowUp] ?? '',
        reminderCount: parseInt(byId[COLUMN_IDS.accountReminderCount] ?? '', 10) || 0,
      });
    }
    cursor = page?.cursor ?? null;
  } while (cursor);

  return out;
}

// Next escalation date: 2 business days past the current follow-up date. If the
// sweep fell behind (computed date already passed), keep hopping in 2-business-day
// steps until it's in the future, so it stays on the original cadence grid.
function nextEscalationDate(currentFollowUp: string, today: string): string {
  let next = addBusinessDays(currentFollowUp, 2);
  while (next <= today) next = addBusinessDays(next, 2);
  return next;
}

export type SweepAction = 'escalated' | 'exhausted';
export interface SweepResult {
  accountId: string;
  name: string;
  action: SweepAction;
  nextFollowUp: string | null;
  reminderCount: number;
}

// Daily escalation pass. For each allowed account whose Next Follow-Up Date is
// strictly in the PAST (so Monday's "when date arrives" already fired and nobody
// followed up — a follow-up would have pushed the date into the future):
//   - under the escalation cap  -> move the date forward 2 business days, bump the counter
//   - at the cap                -> clear the date and reset the counter (stop nagging)
// Acting only on past dates avoids racing Monday's same-day notification.
export async function runFollowUpSweep(today: string): Promise<SweepResult[]> {
  const accounts = await fetchAccountsWithFollowUp();
  const results: SweepResult[] = [];

  for (const acct of accounts) {
    if (!acct.nextFollowUp) continue; // no active follow-up
    if (acct.nextFollowUp >= today) continue; // due today or future — leave it to Monday
    if (!isAccountAllowed(acct.id)) continue; // guarded rollout

    if (acct.reminderCount >= MAX_ESCALATIONS) {
      // Escalation exhausted — stop nagging until a real contact restarts the cycle.
      await clearAccountDate(acct.id, COLUMN_IDS.accountNextFollowUp);
      await writeAccountNumber(acct.id, COLUMN_IDS.accountReminderCount, 0);
      results.push({ accountId: acct.id, name: acct.name, action: 'exhausted', nextFollowUp: null, reminderCount: 0 });
    } else {
      const next = nextEscalationDate(acct.nextFollowUp, today);
      const count = acct.reminderCount + 1;
      await writeAccountDate(acct.id, COLUMN_IDS.accountNextFollowUp, next);
      await writeAccountNumber(acct.id, COLUMN_IDS.accountReminderCount, count);
      results.push({ accountId: acct.id, name: acct.name, action: 'escalated', nextFollowUp: next, reminderCount: count });
    }
  }

  return results;
}
