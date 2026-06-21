import { ALLOWED_ACCOUNT_IDS } from '@/lib/monday';

export default function Home() {
  const guarded = ALLOWED_ACCOUNT_IDS.length > 0;

  return (
    <main>
      <h1>Monday Outreach Automation</h1>
      <p>
        Account-level follow-up date service. When a contact&rsquo;s <strong>Latest Outreach Date</strong>{' '}
        changes, this service rolls the most recent outreach up to the linked Account and computes the
        account&rsquo;s <strong>Next Follow-Up Date</strong> from its own interval.
      </p>

      <p>
        Webhook endpoint: <code>POST /api/monday/webhook</code>
      </p>

      <p>
        Rollout mode:{' '}
        {guarded ? (
          <strong>guarded</strong>
        ) : (
          <strong>live (all accounts)</strong>
        )}
        {guarded && (
          <>
            {' '}
            — only acting on account ID(s): <code>{ALLOWED_ACCOUNT_IDS.join(', ')}</code>
          </>
        )}
        .
      </p>
    </main>
  );
}
