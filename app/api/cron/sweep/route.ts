import { NextRequest, NextResponse } from 'next/server';
import { runFollowUpSweep } from '@/lib/monday';
import { sendFailureAlert } from '@/lib/alert';

// Monday API calls require the Node.js runtime.
export const runtime = 'nodejs';

// The sweep pages through every account and writes to each overdue one, so it can
// run long. Give it headroom past the default ~10s limit. Vercel clamps to the
// plan's ceiling.
export const maxDuration = 60;

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
    const { results, failures } = await runFollowUpSweep(today);
    console.log(
      `[cron-sweep] ${today}: processed ${results.length}, failed ${failures.length}`,
      { results, failures }
    );

    // Per-account failures don't fail the run (the healthy accounts were processed),
    // but they must stay visible — send one summary DM so a skipped account isn't lost.
    if (failures.length > 0) {
      const detail = failures.map((f) => `${f.name} (${f.accountId})`).join(', ');
      await sendFailureAlert(
        `⚠️ Follow-up *sweep* finished on ${today} with ${failures.length} failed account(s): ${detail}`
      );
    }

    return NextResponse.json({
      status: 'ok',
      today,
      processed: results.length,
      failed: failures.length,
      results,
      failures,
    });
  } catch (err) {
    // Total failure (e.g. the account fetch itself threw) — nothing was processed.
    console.error('[cron-sweep] Error during sweep:', err);
    await sendFailureAlert(`⚠️ Follow-up *cron sweep* failed on ${today}: ${String(err)}`);
    return NextResponse.json({ status: 'error', reason: String(err) }, { status: 500 });
  }
}
