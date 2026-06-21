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

export const COLUMN_IDS = {
  // Contacts board
  contactOutreachDate: process.env.MONDAY_OUTREACH_DATE_COLUMN_ID || 'YOUR_CONTACT_OUTREACH_DATE_COLUMN_ID',
  contactAccountLink: process.env.MONDAY_CONTACT_ACCOUNT_LINK_COLUMN_ID || 'YOUR_CONTACT_ACCOUNT_LINK_COLUMN_ID',
  // Accounts board
  accountContactsLink: process.env.MONDAY_ACCOUNT_CONTACTS_LINK_COLUMN_ID || 'YOUR_ACCOUNT_CONTACTS_LINK_COLUMN_ID',
  accountLatestOutreach: process.env.MONDAY_ACCOUNT_LATEST_OUTREACH_COLUMN_ID || 'YOUR_ACCOUNT_LATEST_OUTREACH_COLUMN_ID',
  accountInterval: process.env.MONDAY_ACCOUNT_INTERVAL_COLUMN_ID || 'YOUR_ACCOUNT_INTERVAL_COLUMN_ID',
  accountNextFollowUp: process.env.MONDAY_ACCOUNT_NEXT_FOLLOWUP_COLUMN_ID || 'YOUR_ACCOUNT_NEXT_FOLLOWUP_COLUMN_ID',
};

export const DEFAULT_INTERVAL_DAYS = 30;

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

export async function readAccountIntervalDays(accountId: string): Promise<number> {
  const data = await mondayRequest(
    `query ($itemId: [ID!]) {
       items(ids: $itemId) {
         column_values(ids: ["${COLUMN_IDS.accountInterval}"]) { text }
       }
     }`,
    { itemId: [accountId] }
  );
  const text = data?.items?.[0]?.column_values?.[0]?.text ?? '';
  const parsed = parseInt(text, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_INTERVAL_DAYS : parsed;
}

export async function writeAccountDate(accountId: string, columnId: string, date: string) {
  await mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $value: JSON!) {
       change_column_value(board_id: $boardId, item_id: $itemId, column_id: "${columnId}", value: $value) { id }
     }`,
    { boardId: ACCOUNTS_BOARD_ID, itemId: accountId, value: JSON.stringify({ date }) }
  );
}
