import { NextRequest, NextResponse } from 'next/server';
import {
  ACCOUNTS_BOARD_ID,
  ALLOWED_ACCOUNT_IDS,
  COLUMN_IDS,
  INTERNAL_ACCOUNT_ID,
  addDaysUTC,
  clearAccountDate,
  findLinkedAccountId,
  isAccountAllowed,
  nextBusinessDay,
  readAccountInterval,
  resolveOwnerSlackHandle,
  rollUpAccountOutreach,
  writeAccountDate,
  writeAccountNumber,
  writeAccountText,
} from '@/lib/monday';
import { MONDAY_SIGNING_SECRET, verifyMondaySignature } from '@/lib/auth';

// crypto-based signature verification requires the Node.js runtime.
export const runtime = 'nodejs';

// The handler makes ~10 sequential Monday API calls; give it headroom so a slow
// run isn't killed mid-flow (which would leave the account half-updated). Vercel
// clamps this to the plan's ceiling.
export const maxDuration = 60;

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
      accountStage: configured(COLUMN_IDS.accountStage),
      accountNextFollowUp: configured(COLUMN_IDS.accountNextFollowUp),
      accountReminderCount: configured(COLUMN_IDS.accountReminderCount),
      accountOwner: configured(COLUMN_IDS.accountOwner),
      accountPersonToSlack: configured(COLUMN_IDS.accountPersonToSlack),
      contactSlackHandle: configured(COLUMN_IDS.contactSlackHandle),
      internalAccountId: configured(INTERNAL_ACCOUNT_ID),
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

    // 3. Status-driven cadence -> Next Follow-Up Date.
    const intervalDays = await readAccountInterval(accountId);

    // A null interval means a no-follow-up stage (Active Client / Closed / Vendor):
    // clear any stale follow-up date so the account stops nagging.
    if (intervalDays === null) {
      await clearAccountDate(accountId, COLUMN_IDS.accountNextFollowUp);
      await writeAccountNumber(accountId, COLUMN_IDS.accountReminderCount, 0);
      console.log(
        `[monday-webhook] Account ${accountId}: latestOutreach=${latestOutreach}, stage=no-follow-up, cleared Next Follow-Up Date`
      );
      return NextResponse.json({
        status: 'ok',
        accountId,
        latestOutreach,
        intervalDays: null,
        nextFollowUp: null,
      });
    }

    // Land the follow-up on a weekday, and reset the escalation counter — this
    // contact event starts a fresh follow-up cycle.
    const nextFollowUp = nextBusinessDay(addDaysUTC(latestOutreach, intervalDays));
    await writeAccountDate(accountId, COLUMN_IDS.accountNextFollowUp, nextFollowUp);
    await writeAccountNumber(accountId, COLUMN_IDS.accountReminderCount, 0);

    // Stamp the owner's Slack handle (looked up from the 10/10 Research roster)
    // onto the account so the Monday -> Slack automation can @mention them. A
    // failure here must not undo the follow-up date, so it's isolated.
    let ownerHandle = '';
    try {
      ownerHandle = await resolveOwnerSlackHandle(accountId);
      await writeAccountText(accountId, COLUMN_IDS.accountPersonToSlack, ownerHandle);
    } catch (e) {
      console.warn(`[monday-webhook] Owner Slack handle resolution failed for ${accountId}:`, e);
    }

    console.log(
      `[monday-webhook] Account ${accountId}: latestOutreach=${latestOutreach}, interval=${intervalDays}, nextFollowUp=${nextFollowUp}, ownerHandle=${ownerHandle || '(none)'}`
    );

    return NextResponse.json({
      status: 'ok',
      accountId,
      latestOutreach,
      intervalDays,
      nextFollowUp,
      ownerHandle: ownerHandle || null,
    });
  } catch (err) {
    console.error('[monday-webhook] Error processing webhook:', err);
    // Unexpected failure (e.g. a transient Monday API error or timeout) — return
    // 500 so Monday RETRIES. The whole flow is idempotent (it recomputes the same
    // roll-up, dates, and handle), so a retry safely finishes a half-done run
    // instead of leaving the account stuck. Expected "ignore" outcomes above
    // return 200 and are never retried.
    return NextResponse.json({ status: 'error', reason: String(err) }, { status: 500 });
  }
}
