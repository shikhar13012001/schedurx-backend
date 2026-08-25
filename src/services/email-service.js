// Thin wrapper around Resend's REST API — plain fetch, no SDK dependency,
// mirroring elevenlabs-client.js's/twilio-client.js's role as the only file
// that knows a provider's wire format. Ops alert email only (see config.js's
// ALERT_EMAIL_* comment): a Stripe webhook going unhealthy, or a message
// exhausting its retries. Never a patient-facing send — that's
// twilio-client.js's job.
//
// HTTPS (443), not SMTP (465/587) — this codebase originally used Gmail
// SMTP directly, but the droplet's cloud provider blocks outbound SMTP
// ports at the network level by default (confirmed via a raw TCP connect
// test — ufw's own outbound policy is "allow", the block is upstream of
// the OS). An HTTP-based provider sidesteps that entirely, using the exact
// same port every other outbound call in this codebase already uses.

const RESEND_API_URL = "https://api.resend.com/emails";

// Built once per process (server.js/scripts construct this the same way
// they construct twilioClient) rather than per-send.
function createEmailClient({ apiKey, from, alertTo }) {
  if (!apiKey || !alertTo) return null;

  // Resend's shared sender for accounts that haven't verified their own
  // domain yet — works out of the box for mailing the account's own
  // registered address, which is exactly this alert system's use case.
  const fromAddress = from || "onboarding@resend.dev";

  return {
    // Plain text only — this is an internal ops alert, not patient-facing,
    // so no template/HTML rendering machinery is worth building for it.
    async sendAlert({ subject, text }) {
      const response = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromAddress, to: alertTo, subject: `[ScheduRx alert] ${subject}`, text }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw Object.assign(new Error(`Resend send failed (${response.status}): ${detail.slice(0, 300)}`), {
          code: "RESEND_ERROR",
          statusCode: 502,
        });
      }
      return response.json();
    },
  };
}

module.exports = { createEmailClient };
