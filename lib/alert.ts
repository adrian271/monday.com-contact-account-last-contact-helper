// Best-effort failure alerting: DMs one or more Slack users when the webhook or
// the daily sweep hits an unexpected error, so failures don't go unnoticed.
//
// A Slack Incoming Webhook can only post to a fixed channel, so DMing requires a
// bot token: chat.postMessage with the recipient's user ID as the channel sends a
// direct message. Create a Slack app with the `chat:write` and `im:write` bot
// scopes, install it, and set:
//   ALERT_SLACK_BOT_TOKEN=xoxb-...              (Bot User OAuth Token)
//   ALERT_SLACK_USER_ID=U0B5N1JHDPZ             (comma-separated to DM several people)
// Leave either unset to disable alerting (the helper becomes a no-op).

const ALERT_SLACK_BOT_TOKEN = process.env.ALERT_SLACK_BOT_TOKEN || '';
const ALERT_SLACK_USER_IDS = (process.env.ALERT_SLACK_USER_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const ALERTING_ENABLED = Boolean(ALERT_SLACK_BOT_TOKEN) && ALERT_SLACK_USER_IDS.length > 0;

// Send a failure DM. Never throws — alerting must not add a new failure mode to the
// code path that's already failing. Await it so the message actually sends before a
// serverless function exits, but any error here is swallowed and logged.
export async function sendFailureAlert(message: string): Promise<void> {
  if (!ALERTING_ENABLED) return;
  try {
    await Promise.all(
      ALERT_SLACK_USER_IDS.map(async (userId) => {
        const res = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${ALERT_SLACK_BOT_TOKEN}`,
          },
          body: JSON.stringify({ channel: userId, text: message }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!data.ok) {
          console.error(`[alert] Slack DM to ${userId} failed:`, data.error || res.status);
        }
      })
    );
  } catch (e) {
    console.error('[alert] Failed to send failure alert:', e);
  }
}
