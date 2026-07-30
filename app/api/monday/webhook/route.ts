import { NextRequest, NextResponse } from 'next/server';
import {
  ACCOUNTS_BOARD_ID,
  ALLOWED_ACCOUNT_IDS,
  COLUMN_IDS,
  INTERNAL_ACCOUNT_ID,
  findLinkedAccountIds,
  isAccountAllowed,
  processAccountFollowUp,
} from '@/lib/monday';
import { MONDAY_SIGNING_SECRET, verifyMondaySignature } from '@/lib/auth';
import { ALERTING_ENABLED, sendFailureAlert } from '@/lib/alert';

// crypto-based signature verification requires the Node.js runtime.
export const runtime = 'nodejs';

// The handler makes several Monday API calls (three reads in parallel, then one
// combined write); give it headroom so a slow run isn't killed mid-flow (which
// would leave the account half-updated). Vercel clamps this to the plan's ceiling.
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
    failureAlerts: ALERTING_ENABLED ? 'enabled' : 'disabled (set ALERT_SLACK_BOT_TOKEN + ALERT_SLACK_USER_ID)',
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
      accountInterval: configured(COLUMN_IDS.accountInterval),
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
    // 1. Contact -> Account(s). A contact can be linked to several accounts (common
    // with duplicate/merged rows), so process EVERY linked account, not just the
    // first — otherwise a contact whose intended org isn't listed first is missed.
    const accountIds = await findLinkedAccountIds(String(contactId));
    if (accountIds.length === 0) {
      console.warn(`[monday-webhook] Contact ${contactId} has no linked account`);
      return NextResponse.json({ status: 'ignored', reason: 'no linked account' }, { status: 200 });
    }

    // Guarded rollout: keep only allowlisted accounts (if a list is set).
    const allowed = accountIds.filter(isAccountAllowed);
    if (allowed.length === 0) {
      console.log(`[monday-webhook] None of contact ${contactId}'s accounts are on the allowlist:`, accountIds);
      return NextResponse.json({ status: 'ignored', reason: 'no linked account on allowlist', accountIds });
    }

    // 2. Roll up + stamp each allowed account (concurrently).
    const results = await Promise.all(allowed.map((id) => processAccountFollowUp(id)));

    console.log(`[monday-webhook] Contact ${contactId} -> accounts ${allowed.join(', ')}:`, results);

    return NextResponse.json({ status: 'ok', contactId, results });
  } catch (err) {
    console.error('[monday-webhook] Error processing webhook:', err);
    await sendFailureAlert(`⚠️ Follow-up *webhook* failed for contact ${contactId}: ${String(err)}`);
    // Unexpected failure (e.g. a transient Monday API error or timeout) — return
    // 500 so Monday RETRIES. The whole flow is idempotent (it recomputes the same
    // roll-up, dates, and handle), so a retry safely finishes a half-done run
    // instead of leaving the account stuck. Expected "ignore" outcomes above
    // return 200 and are never retried.
    return NextResponse.json({ status: 'error', reason: String(err) }, { status: 500 });
  }
}
