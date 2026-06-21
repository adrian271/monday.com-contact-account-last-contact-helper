import { NextRequest, NextResponse } from 'next/server';
import {
  COLUMN_IDS,
  addDaysUTC,
  findLinkedAccountId,
  isAccountAllowed,
  readAccountIntervalDays,
  rollUpAccountOutreach,
  writeAccountDate,
} from '@/lib/monday';

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Monday sends a challenge on webhook registration — must echo it back.
  if (body.challenge) {
    return NextResponse.json({ challenge: body.challenge });
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
