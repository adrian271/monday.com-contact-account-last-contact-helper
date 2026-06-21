/**
 * Monday.com step-by-step test script
 * ------------------------------------
 * Run with:  node --env-file=.env.local monday-test.mjs
 *
 * We build this up one step at a time. Each step is a small function we can
 * run, read the output of, and verify before moving to the next one.
 *
 * STEP 1: Make a connection and confirm who we're authenticated as.
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;

// All board/column/test IDs come from the environment (.env.local). See
// .env.local.example for the full list. Run Step 2/3 to discover IDs for a board.
const CONTACTS_BOARD_ID = process.env.MONDAY_CONTACTS_BOARD_ID;
const COLUMN_IDS = {
  latestOutreachDate: process.env.MONDAY_OUTREACH_DATE_COLUMN_ID,
  followUpInterval: process.env.MONDAY_INTERVAL_COLUMN_ID,
  nextFollowUpDate: process.env.MONDAY_NEXT_FOLLOWUP_COLUMN_ID,
};

// Accounts board + the account-level columns (see Step 6 onward)
const ACCOUNTS_BOARD_ID = process.env.MONDAY_ACCOUNTS_BOARD_ID;
const CONTACT_ACCOUNT_LINK = process.env.MONDAY_CONTACT_ACCOUNT_LINK_COLUMN_ID; // Contact -> Account link
const ACCOUNT_COLS = {
  contactsLink: process.env.MONDAY_ACCOUNT_CONTACTS_LINK_COLUMN_ID,   // Account -> Contacts link
  latestOutreach: process.env.MONDAY_ACCOUNT_LATEST_OUTREACH_COLUMN_ID, // writable; max outreach across contacts
  followUpInterval: process.env.MONDAY_ACCOUNT_INTERVAL_COLUMN_ID,    // per-account interval (days)
  nextFollowUpDate: process.env.MONDAY_ACCOUNT_NEXT_FOLLOWUP_COLUMN_ID, // writable; latestOutreach + interval
};

// --- tiny API helper ---------------------------------------------------------

async function mondayRequest(query, variables) {
  if (!MONDAY_API_TOKEN) {
    throw new Error('MONDAY_API_TOKEN is not set. Run with: node --env-file=.env.local monday-test.mjs');
  }

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
    throw new Error(`Monday API error: ${JSON.stringify(json.errors, null, 2)}`);
  }

  return json.data;
}

// --- STEP 1: connection test -------------------------------------------------

async function step1_testConnection() {
  console.log('STEP 1 — Testing connection to Monday.com...\n');

  const query = `
    query {
      me {
        id
        name
        email
      }
      account {
        id
        name
        tier
      }
    }
  `;

  const data = await mondayRequest(query);

  console.log('✅ Connected!');
  console.log('   Authenticated as:', data.me.name, `<${data.me.email}>`);
  console.log('   User ID:         ', data.me.id);
  console.log('   Account:         ', data.account.name, `(id ${data.account.id}, tier: ${data.account.tier})`);
}

// --- STEP 2: list boards -----------------------------------------------------

async function step2_listBoards() {
  console.log('\nSTEP 2 — Listing boards...\n');

  const query = `
    query {
      boards(limit: 100, order_by: used_at) {
        id
        name
        type
        items_count
      }
    }
  `;

  const data = await mondayRequest(query);
  const boards = (data.boards ?? []).filter((b) => b.type === 'board');

  if (boards.length === 0) {
    console.log('⚠️  No boards found on this account.');
    return;
  }

  console.log(`✅ Found ${boards.length} board(s):\n`);
  for (const b of boards) {
    console.log(`   ${b.name}`);
    console.log(`      id: ${b.id}   items: ${b.items_count}`);
  }
  console.log('\n   👉 Note the id of your Contacts board for Step 3.');
}

// --- STEP 3: inspect Contacts board columns ----------------------------------

async function step3_inspectColumns() {
  console.log('\nSTEP 3 — Inspecting columns on the Contacts board...\n');

  const query = `
    query ($boardId: [ID!]) {
      boards(ids: $boardId) {
        name
        columns {
          id
          title
          type
        }
      }
    }
  `;

  const data = await mondayRequest(query, { boardId: [CONTACTS_BOARD_ID] });
  const board = data?.boards?.[0];

  if (!board) {
    console.log(`⚠️  Board ${CONTACTS_BOARD_ID} not found.`);
    return;
  }

  const columns = board.columns ?? [];
  console.log(`✅ Board "${board.name}" has ${columns.length} columns.\n`);

  // Verify the three column IDs we rely on actually exist + are the right type.
  const expected = [
    { key: 'Latest Outreach Date', id: COLUMN_IDS.latestOutreachDate, wantType: 'date' },
    { key: 'Follow-Up Interval', id: COLUMN_IDS.followUpInterval, wantType: 'numbers' },
    { key: 'Next Follow-Up Date', id: COLUMN_IDS.nextFollowUpDate, wantType: 'date' },
  ];

  console.log('   Checking the columns this service depends on:\n');
  let allGood = true;
  for (const e of expected) {
    const found = columns.find((c) => c.id === e.id);
    if (!found) {
      allGood = false;
      console.log(`   ❌ ${e.key}: id "${e.id}" NOT FOUND on board`);
    } else if (found.type !== e.wantType) {
      allGood = false;
      console.log(`   ⚠️  ${e.key}: found "${found.title}" but type is "${found.type}" (expected "${e.wantType}")`);
    } else {
      console.log(`   ✅ ${e.key}: "${found.title}" (id ${found.id}, type ${found.type})`);
    }
  }

  console.log(allGood ? '\n   All three columns check out.' : '\n   ⚠️  Some columns need attention (see above).');
}

// --- STEP 4: read one specific contact ---------------------------------------

// A contact + its linked account used as the manual test target (from .env.local).
const TEST_CONTACT_ID = process.env.MONDAY_TEST_CONTACT_ID;
const TEST_ACCOUNT_ID = process.env.MONDAY_TEST_ACCOUNT_ID;

async function step4_readContact() {
  console.log('\nSTEP 4 — Reading contact', TEST_CONTACT_ID, '...\n');

  const query = `
    query ($itemId: [ID!]) {
      items(ids: $itemId) {
        id
        name
        column_values(ids: ["${COLUMN_IDS.latestOutreachDate}", "${COLUMN_IDS.followUpInterval}", "${COLUMN_IDS.nextFollowUpDate}"]) {
          id
          column { title }
          text
          value
        }
      }
    }
  `;

  const data = await mondayRequest(query, { itemId: [TEST_CONTACT_ID] });
  const item = data?.items?.[0];

  if (!item) {
    console.log(`⚠️  Contact ${TEST_CONTACT_ID} not found.`);
    return;
  }

  console.log(`✅ Found contact: "${item.name}"\n`);
  console.log('   Relevant column values:\n');
  for (const col of item.column_values) {
    console.log(`   ${col.column.title}`);
    console.log(`      text:  ${col.text === '' ? '(empty)' : col.text}`);
    console.log(`      value: ${col.value ?? '(null)'}`);
  }
}

// --- STEP 5: calculate + (optionally) write Next Follow-Up Date ---------------
//
// This is the first step that MUTATES data. It is guarded: it only writes when
// the script is run with WRITE=1. Otherwise it does a dry run and just prints
// what it *would* write.
//
//   Dry run:  node --env-file=.env.local monday-test.mjs
//   Write:    WRITE=1 node --env-file=.env.local monday-test.mjs

function addDaysUTC(yyyymmdd, days) {
  // Parse as UTC midnight and add days in UTC to avoid timezone off-by-one.
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

async function step5_writeNextFollowUp() {
  const willWrite = process.env.WRITE === '1';
  console.log(`\nSTEP 5 — Calculate Next Follow-Up Date ${willWrite ? '(WRITE mode)' : '(dry run)'}...\n`);

  // Re-read just the inputs we need so this step is self-contained.
  const query = `
    query ($itemId: [ID!]) {
      items(ids: $itemId) {
        id
        name
        column_values(ids: ["${COLUMN_IDS.latestOutreachDate}", "${COLUMN_IDS.followUpInterval}"]) {
          id
          text
        }
      }
    }
  `;
  const data = await mondayRequest(query, { itemId: [TEST_CONTACT_ID] });
  const item = data?.items?.[0];
  if (!item) {
    console.log(`⚠️  Contact ${TEST_CONTACT_ID} not found.`);
    return;
  }

  const getText = (id) => item.column_values.find((c) => c.id === id)?.text ?? '';
  const outreachDate = getText(COLUMN_IDS.latestOutreachDate);
  const intervalText = getText(COLUMN_IDS.followUpInterval);

  if (!outreachDate) {
    console.log('   No Latest Outreach Date set — nothing to calculate.');
    return;
  }

  const parsed = parseInt(intervalText, 10);
  const days = Number.isNaN(parsed) || parsed <= 0 ? 30 : parsed;
  if (parsed !== days) {
    console.log(`   ⚠️  Interval "${intervalText}" invalid — defaulting to 30 days.`);
  }

  const nextFollowUp = addDaysUTC(outreachDate, days);

  console.log(`   Contact:            ${item.name}`);
  console.log(`   Latest Outreach:    ${outreachDate}`);
  console.log(`   Interval (days):    ${days}`);
  console.log(`   → Next Follow-Up:   ${nextFollowUp}`);

  if (!willWrite) {
    console.log('\n   (dry run — re-run with WRITE=1 to actually write this back)');
    return;
  }

  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $value: JSON!) {
      change_column_value(
        board_id: $boardId
        item_id: $itemId
        column_id: "${COLUMN_IDS.nextFollowUpDate}"
        value: $value
      ) {
        id
      }
    }
  `;
  await mondayRequest(mutation, {
    boardId: CONTACTS_BOARD_ID,
    itemId: TEST_CONTACT_ID,
    value: JSON.stringify({ date: nextFollowUp }),
  });

  console.log(`\n   ✅ Wrote ${nextFollowUp} to "${item.name}" Next Follow-Up Date.`);
}

// --- STEP 6: find the contact's linked Account -------------------------------
//
// The account-level goal: when a contact is reached out to, we roll the outreach
// up to their organization (Account). First we need to resolve contact -> account.

async function step6_findLinkedAccount() {
  console.log('\nSTEP 6 — Finding the Account linked to contact', TEST_CONTACT_ID, '...\n');

  const query = `
    query ($itemId: [ID!]) {
      items(ids: $itemId) {
        id
        name
        column_values(ids: ["${CONTACT_ACCOUNT_LINK}"]) {
          ... on BoardRelationValue {
            linked_item_ids
            linked_items { id name }
          }
        }
      }
    }
  `;

  const data = await mondayRequest(query, { itemId: [TEST_CONTACT_ID] });
  const item = data?.items?.[0];
  if (!item) {
    console.log(`⚠️  Contact ${TEST_CONTACT_ID} not found.`);
    return;
  }

  const linked = item.column_values[0]?.linked_items ?? [];
  if (linked.length === 0) {
    console.log(`⚠️  Contact "${item.name}" has no linked Account.`);
    return;
  }

  console.log(`✅ Contact "${item.name}" is linked to:`);
  for (const acct of linked) {
    console.log(`   • ${acct.name} (account id ${acct.id})`);
  }
  if (linked.length > 1) {
    console.log('\n   ⚠️  More than one linked account — we will need a rule for which one to update.');
  }
}

// --- STEP 7: roll up account-wide latest outreach ----------------------------
//
// For the test account, read EVERY linked contact's Latest Outreach Date, pick
// the most recent one, and (with WRITE=1) write it to the account's writable
// "Acct Latest Outreach (calc)" column. Date strings are YYYY-MM-DD, so a plain
// string comparison gives correct chronological ordering.

async function step7_rollUpAccountOutreach() {
  const willWrite = process.env.WRITE === '1';
  console.log(`\nSTEP 7 — Roll up account-wide latest outreach ${willWrite ? '(WRITE mode)' : '(dry run)'}...\n`);

  // 1. Get the account's linked contact ids.
  const acctData = await mondayRequest(
    `query ($itemId: [ID!]) {
       items(ids: $itemId) {
         id
         name
         column_values(ids: ["${ACCOUNT_COLS.contactsLink}"]) {
           ... on BoardRelationValue { linked_item_ids }
         }
       }
     }`,
    { itemId: [TEST_ACCOUNT_ID] }
  );
  const account = acctData?.items?.[0];
  if (!account) {
    console.log(`⚠️  Account ${TEST_ACCOUNT_ID} not found.`);
    return;
  }
  const contactIds = account.column_values[0]?.linked_item_ids ?? [];
  if (contactIds.length === 0) {
    console.log(`⚠️  Account "${account.name}" has no linked contacts.`);
    return;
  }

  // 2. Read each contact's Latest Outreach Date.
  const contactData = await mondayRequest(
    `query ($ids: [ID!]) {
       items(ids: $ids) {
         id
         name
         column_values(ids: ["${COLUMN_IDS.latestOutreachDate}"]) { text }
       }
     }`,
    { ids: contactIds }
  );

  console.log(`   Account: ${account.name}`);
  console.log(`   Contacts (${contactIds.length}):`);
  let maxDate = '';
  let maxName = null;
  for (const c of contactData.items) {
    const d = c.column_values[0]?.text ?? '';
    console.log(`     • ${c.name}: ${d === '' ? '(none)' : d}`);
    if (d && d > maxDate) {
      maxDate = d;
      maxName = c.name;
    }
  }

  if (!maxDate) {
    console.log('\n   No contact has an outreach date — nothing to roll up.');
    return;
  }

  console.log(`\n   → Account-wide latest outreach: ${maxDate} (from ${maxName})`);

  if (!willWrite) {
    console.log('   (dry run — re-run with WRITE=1 to write this to the account)');
    return;
  }

  await mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $value: JSON!) {
       change_column_value(board_id: $boardId, item_id: $itemId, column_id: "${ACCOUNT_COLS.latestOutreach}", value: $value) { id }
     }`,
    { boardId: ACCOUNTS_BOARD_ID, itemId: TEST_ACCOUNT_ID, value: JSON.stringify({ date: maxDate }) }
  );
  console.log(`\n   ✅ Wrote ${maxDate} to "${account.name}" Acct Latest Outreach (calc).`);
}

// --- STEP 8: compute + write the account's Next Follow-Up Date ----------------
//
// Reads the account's rolled-up latest outreach (written in Step 7) and its own
// Follow-up Interval, then writes Next Follow-Up Date = latestOutreach + interval.
// Falls back to a 30-day interval if the account has none set. WRITE-guarded.

async function step8_writeAccountNextFollowUp() {
  const willWrite = process.env.WRITE === '1';
  console.log(`\nSTEP 8 — Compute account Next Follow-Up Date ${willWrite ? '(WRITE mode)' : '(dry run)'}...\n`);

  const data = await mondayRequest(
    `query ($itemId: [ID!]) {
       items(ids: $itemId) {
         id
         name
         column_values(ids: ["${ACCOUNT_COLS.latestOutreach}", "${ACCOUNT_COLS.followUpInterval}"]) { id text }
       }
     }`,
    { itemId: [TEST_ACCOUNT_ID] }
  );
  const account = data?.items?.[0];
  if (!account) {
    console.log(`⚠️  Account ${TEST_ACCOUNT_ID} not found.`);
    return;
  }

  const getText = (id) => account.column_values.find((c) => c.id === id)?.text ?? '';
  const latestOutreach = getText(ACCOUNT_COLS.latestOutreach);
  const intervalText = getText(ACCOUNT_COLS.followUpInterval);

  if (!latestOutreach) {
    console.log('   No account-wide latest outreach set (run Step 7 first) — nothing to calculate.');
    return;
  }

  const parsed = parseInt(intervalText, 10);
  const days = Number.isNaN(parsed) || parsed <= 0 ? 30 : parsed;
  if (parsed !== days) {
    console.log(`   ⚠️  Account interval "${intervalText}" invalid/empty — defaulting to 30 days.`);
  }

  const nextFollowUp = addDaysUTC(latestOutreach, days);

  console.log(`   Account:            ${account.name}`);
  console.log(`   Latest Outreach:    ${latestOutreach}`);
  console.log(`   Interval (days):    ${days}`);
  console.log(`   → Next Follow-Up:   ${nextFollowUp}`);

  if (!willWrite) {
    console.log('\n   (dry run — re-run with WRITE=1 to write this to the account)');
    return;
  }

  await mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $value: JSON!) {
       change_column_value(board_id: $boardId, item_id: $itemId, column_id: "${ACCOUNT_COLS.nextFollowUpDate}", value: $value) { id }
     }`,
    { boardId: ACCOUNTS_BOARD_ID, itemId: TEST_ACCOUNT_ID, value: JSON.stringify({ date: nextFollowUp }) }
  );
  console.log(`\n   ✅ Wrote ${nextFollowUp} to "${account.name}" Next Follow-up Date.`);
}

// --- runner ------------------------------------------------------------------

async function main() {
  try {
    await step1_testConnection();
    await step2_listBoards();
    await step3_inspectColumns();
    await step4_readContact();
    await step5_writeNextFollowUp();
    await step6_findLinkedAccount();
    await step7_rollUpAccountOutreach();
    await step8_writeAccountNextFollowUp();
  } catch (err) {
    console.error('\n❌ Failed:', err.message);
    process.exit(1);
  }
}

main();
