import {
  ALLOWED_ACCOUNT_IDS,
  DEFAULT_INTERVAL_DAYS,
  MAX_ESCALATIONS,
  STAGE_INTERVAL_DAYS,
} from '@/lib/monday';

// Render the cadence rules straight from the source-of-truth map so this page
// can never drift from what the service actually does.
const cadenceGroups = [
  { label: 'Weekly (7 days)', days: 7 },
  { label: 'Every 2 weeks (14 days)', days: 14 },
];

const statusesFor = (days: number | null) =>
  Object.entries(STAGE_INTERVAL_DAYS)
    .filter(([, v]) => v === days)
    .map(([label]) => label);

const noFollowUpStatuses = statusesFor(null);

const box: React.CSSProperties = {
  background: '#f5f5f4',
  border: '1px solid #e7e5e4',
  borderRadius: 8,
  padding: '0.85rem 1.1rem',
};

export default function Home() {
  const guarded = ALLOWED_ACCOUNT_IDS.length > 0;

  return (
    <main>
      <h1 style={{ marginBottom: '0.25rem' }}>Monday Outreach Automation</h1>
      <p style={{ marginTop: 0, color: '#57534e' }}>
        Account-level follow-up scheduling for Monday.com. Contacting anyone at an account
        rolls the outreach up to the organization and sets a single, status-based follow-up clock.
      </p>

      <h2>What happens on outreach</h2>
      <ol>
        <li>
          A contact&rsquo;s <strong>Latest Outreach Date</strong> changes (manually, or from a
          logged email) &rarr; Monday fires a webhook to <code>POST /api/monday/webhook</code>.
        </li>
        <li>
          The service finds the linked <strong>Account</strong> and reads the most-recent outreach
          across <em>all</em> of that account&rsquo;s contacts, writing it to{' '}
          <strong>Acct Latest Outreach (calc)</strong>.
        </li>
        <li>
          It sets the account&rsquo;s <strong>Next Follow-Up Date</strong> = latest outreach +
          the cadence for the account&rsquo;s <strong>Status</strong> (below), nudged to the next
          weekday, and resets the escalation counter.
        </li>
        <li>
          It resolves the account&rsquo;s <strong>Owner</strong> to their Slack handle (via the
          team roster) and writes it to <strong>Person to Slack</strong>, so the reminder can
          @mention the right person.
        </li>
        <li>
          Monday&rsquo;s native automation sends the Slack reminder to{' '}
          <strong>#client-outreach</strong> when that date arrives, pinging the owner.
        </li>
      </ol>

      <h2>Cadence by account status</h2>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', borderBottom: '2px solid #d6d3d1', padding: '0.4rem 0' }}>
              Cadence
            </th>
            <th style={{ textAlign: 'left', borderBottom: '2px solid #d6d3d1', padding: '0.4rem 0' }}>
              Account statuses
            </th>
          </tr>
        </thead>
        <tbody>
          {cadenceGroups.map((g) => (
            <tr key={g.label}>
              <td style={{ borderBottom: '1px solid #e7e5e4', padding: '0.5rem 0', verticalAlign: 'top' }}>
                <strong>{g.label}</strong>
              </td>
              <td style={{ borderBottom: '1px solid #e7e5e4', padding: '0.5rem 0' }}>
                {statusesFor(g.days).join(', ')}
              </td>
            </tr>
          ))}
          <tr>
            <td style={{ borderBottom: '1px solid #e7e5e4', padding: '0.5rem 0', verticalAlign: 'top' }}>
              <strong>No follow-up</strong>
              <br />
              <span style={{ color: '#57534e', fontSize: '0.9em' }}>(date cleared)</span>
            </td>
            <td style={{ borderBottom: '1px solid #e7e5e4', padding: '0.5rem 0' }}>
              {noFollowUpStatuses.join(', ')}
            </td>
          </tr>
        </tbody>
      </table>
      <p style={{ color: '#57534e', fontSize: '0.9em' }}>
        Blank or unrecognized statuses fall back to the cold cadence of{' '}
        <strong>{DEFAULT_INTERVAL_DAYS} days</strong> so no account silently drops off the radar.
      </p>

      <h2>Escalation</h2>
      <p>
        If a follow-up date passes with <strong>no new outreach</strong> (a real contact would have
        pushed the date into the future), a daily sweep re-nudges the account:
      </p>
      <div style={box}>
        due date &rarr; +2 business days &rarr; +2 more business days &rarr; <strong>stop</strong>
      </div>
      <p>
        That&rsquo;s up to <strong>{MAX_ESCALATIONS} reminders</strong> after the original, weekends
        skipped. After the last one the date is cleared, so the account only restarts its clock when
        someone is actually contacted again. The sweep runs once daily via{' '}
        <code>GET /api/cron/sweep</code> (Vercel Cron, 13:00 UTC); Monday still sends the Slack
        message each time the date lands.
      </p>

      <h2>Owner notifications</h2>
      <p>
        The reminder @mentions whoever <strong>owns</strong> the account. Since Monday can&rsquo;t
        mention a people column directly, the service keeps a text column,{' '}
        <strong>Person to Slack</strong>, filled with the owner&rsquo;s Slack handle:
      </p>
      <ul>
        <li>
          Each team member has a contact row under the internal <strong>team account</strong> with
          their <strong>Slack Handle</strong> set.
        </li>
        <li>
          On each update, the service matches the account&rsquo;s Owner name to that roster and
          writes the handle to <strong>Person to Slack</strong>; the Slack message uses the{' '}
          <code>{'{Person to Slack}'}</code> token to ping them.
        </li>
        <li>
          A new potential owner just needs a roster contact with a Slack Handle &mdash; no code
          change. An unmatched owner posts without a ping (safe).
        </li>
      </ul>

      <h2>Status</h2>
      <p>
        Rollout mode:{' '}
        {guarded ? <strong>guarded</strong> : <strong>live (all accounts)</strong>}
        {guarded && (
          <>
            {' '}
            — only acting on account ID(s): <code>{ALLOWED_ACCOUNT_IDS.join(', ')}</code>
          </>
        )}
        . Config &amp; health: <code>GET /api/monday/webhook</code>.
      </p>

      <hr style={{ border: 'none', borderTop: '1px solid #e7e5e4', margin: '2rem 0 1rem' }} />
      <p style={{ color: '#57534e', fontSize: '0.9em' }}>
        Questions? Contact me on{' '}
        <a
          href="https://www.linkedin.com/in/adrian-barnes-software-engineer/"
          target="_blank"
          rel="noopener noreferrer"
        >
          LinkedIn
        </a>
        .
      </p>
    </main>
  );
}
