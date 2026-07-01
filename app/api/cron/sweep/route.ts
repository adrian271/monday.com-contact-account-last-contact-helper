import { NextRequest, NextResponse } from 'next/server';
import { runFollowUpSweep } from '@/lib/monday';

// Monday API calls require the Node.js runtime.
export const runtime = 'nodejs';

// Daily escalation sweep. Intended to be hit once per day by Vercel Cron (see
// vercel.json) or any external scheduler (GitHub Actions, cron-job.org, …).
//
// For each account whose Next Follow-Up Date is already in the past, it advances
// the date by 2 business days (up to MAX_ESCALATIONS times) so Monday's native
// "when date arrives → Slack" recipe nudges again, then clears the date once the
// escalation cap is reached. Monday still owns the actual Slack message.
//
// Protect the endpoint with CRON_SECRET: Vercel Cron automatically sends
// `Authorization: Bearer <CRON_SECRET>` when that env var is set. External
// schedulers must send the same header. If CRON_SECRET is unset, the endpoint is
// open (fine for local dev) and logs a warning.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (req.headers.get('authorization') !== `Bearer ${secret}`) {
      return NextResponse.json({ status: 'unauthorized' }, { status: 401 });
    }
  } else {
    console.warn('[cron-sweep] CRON_SECRET is not set — endpoint is unauthenticated. Set it before deploying.');
  }

  const today = new Date().toISOString().split('T')[0];
  try {
    const results = await runFollowUpSweep(today);
    console.log(`[cron-sweep] ${today}: processed ${results.length} overdue account(s)`, results);
    return NextResponse.json({ status: 'ok', today, processed: results.length, results });
  } catch (err) {
    console.error('[cron-sweep] Error during sweep:', err);
    return NextResponse.json({ status: 'error', reason: String(err) }, { status: 500 });
  }
}
