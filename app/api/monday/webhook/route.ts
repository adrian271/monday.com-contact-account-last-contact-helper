import { NextRequest, NextResponse } from 'next/server';
import {
  ACCOUNTS_BOARD_ID,
  ALLOWED_ACCOUNT_IDS,
  COLUMN_IDS,
  addDaysUTC,
  findLinkedAccountId,
  isAccountAllowed,
  readAccountIntervalDays,
  rollUpAccountOutreach,
  writeAccountDate,
} from '@/lib/monday';
import { MONDAY_SIGNING_SECRET, verifyMondaySignature } from '@/lib/auth';

// crypto-based signature verification requires the Node.js runtime.
export const runtime = 'nodejs';

// Health check — confirms the deployment is live and reports its configuration
// state WITHOUT exposing any secrets or actual IDs. Useful before sending a test
// email: hit GET /api/monday/webhook and check everything reads "configured".
export async function GET() {
  // A value is "configured" if it's set and not left as a YOUR_* placeholder.
  const configured = (v: string | undefined) => Boolean(v) && !v!.startsWith('YOUR_');

  return NextResponse.json({
    status: 'ok',
    service: 'monday-account-followup',
    signatureVerification: MONDAY_SIGNING_SECRET ? 'enabled' : 'disabled (set MONDAY_SIGNING_SECRET)',
    rollout:
      ALLOWED_ACCOUNT_IDS.length > 0
        ? { mode: 'guarded', allowedAccountCount: ALLOWED_ACCOUNT_IDS.length }
        : { mode: 'all accounts' },
    config: {
      apiToken: Boolean(process.env.MONDAY_API_TOKEN),
      accountsBoardId: configured(ACCOUNTS_BOARD_ID),
      contactOutreachDate: configured(COLUMN_IDS.contactOutreachDate),
      contactAccountLink: configured(COLUMN_IDS.contactAccountLink),
      accountContactsLink: configured(COLUMN_IDS.accountContactsLink),
      accountLatestOutreach: configured(COLUMN_IDS.accountLatestOutreach),
      accountInterval: configured(COLUMN_IDS.accountInterval),
      accountNextFollowUp: configured(COLUMN_IDS.accountNextFollowUp),
    },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Monday sends a challenge on webhook registration — must echo it back.
  // The challenge carries no data and proves URL ownership, so it's allowed
  // through before signature checks (Monday may send it without a signature).
  if (body.challenge) {
    return NextResponse.json({ challenge: body.challenge });
  }

  // Verify the webhook signature on real events.
  if (MONDAY_SIGNING_SECRET) {
    const verdict = verifyMondaySignature(req.headers.get('authorization'));
    if (!verdict.ok) {
      console.warn(`[monday-webhook] Rejected unsigned/invalid request: ${verdict.reason}`);
      return NextResponse.json({ status: 'unauthorized', reason: verdict.reason }, { status: 401 });
    }
  } else {
    console.warn(
      '[monday-webhook] MONDAY_SIGNING_SECRET is not set — skipping signature verification. ' +
        'Set it before exposing this endpoint publicly.'
    );
  }

  const event = body.event;
  if (!event) {
    return NextResponse.json({ status: 'no event' }, { status: 200 });
  }

  const { pulseId: contactId, columnId, value } = event;

  // Only react to changes on the contact's Latest Outreach Date column.
  if (columnId !== COLUMN_IDS.contactOutreachDate) {
    return NextResponse.json({ status: 'ignored', reason: 'not outreach date column' });
  }

  // If the date was cleared, do nothing.
  if (!value?.date) {
    return NextResponse.json({ status: 'ignored', reason: 'date cleared' });
  }

  try {
    // 1. Contact -> Account
    const accountId = await findLinkedAccountId(String(contactId));
    if (!accountId) {
      console.warn(`[monday-webhook] Contact ${contactId} has no linked account`);
      return NextResponse.json({ status: 'ignored', reason: 'no linked account' }, { status: 200 });
    }

    // Guarded rollout: skip any account not on the allowlist (if one is set).
    if (!isAccountAllowed(accountId)) {
      console.log(`[monday-webhook] Account ${accountId} not on allowlist — skipping`);
      return NextResponse.json({ status: 'ignored', reason: 'account not on allowlist', accountId });
    }

    // 2. Roll up the account-wide most-recent outreach across all its contacts.
    const latestOutreach = await rollUpAccountOutreach(accountId);
    if (!latestOutreach) {
      console.warn(`[monday-webhook] Account ${accountId} has no contact outreach dates`);
      return NextResponse.json({ status: 'ignored', reason: 'no outreach dates' }, { status: 200 });
    }
    await writeAccountDate(accountId, COLUMN_IDS.accountLatestOutreach, latestOutreach);

    // 3. Account interval -> Next Follow-Up Date.
    const intervalDays = await readAccountIntervalDays(accountId);
    const nextFollowUp = addDaysUTC(latestOutreach, intervalDays);
    await writeAccountDate(accountId, COLUMN_IDS.accountNextFollowUp, nextFollowUp);

    console.log(
      `[monday-webhook] Account ${accountId}: latestOutreach=${latestOutreach}, interval=${intervalDays}, nextFollowUp=${nextFollowUp}`
    );

    return NextResponse.json({
      status: 'ok',
      accountId,
      latestOutreach,
      intervalDays,
      nextFollowUp,
    });
  } catch (err) {
    console.error('[monday-webhook] Error processing webhook:', err);
    // Return 200 so Monday doesn't keep retrying a permanent error.
    return NextResponse.json({ status: 'error', reason: String(err) }, { status: 200 });
  }
}
