// Thin wrapper around nodemailer's Gmail SMTP transport — the only file in
// this repo that knows this wire format, mirroring twilio-client.js's role
// for Twilio. Ops alert email only (see config.js's ALERT_EMAIL_* comment):
// a Stripe webhook going unhealthy, or a message exhausting its retries.
// Never a patient-facing send — that's twilio-client.js's job.

const nodemailer = require("nodemailer");

// Built once per process (server.js/scripts construct this the same way
// they construct twilioClient) rather than per-send — nodemailer's
// transport pools/reuses the underlying SMTP connection.
function createEmailClient({ gmailUser, gmailAppPassword, alertTo }) {
  if (!gmailUser || !gmailAppPassword) return null;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailAppPassword },
    // The droplet has no IPv6 route, but Node's DNS resolution still
    // returns Gmail's SMTP AAAA record first — without this, every send
    // fails immediately with ENETUNREACH before ever reaching Gmail. Forces
    // the underlying socket connect() to resolve IPv4 (A record) only.
    family: 4,
  });
  const to = alertTo || gmailUser;

  return {
    // Plain text only — this is an internal ops alert, not patient-facing,
    // so no template/HTML rendering machinery is worth building for it.
    async sendAlert({ subject, text }) {
      return transporter.sendMail({ from: gmailUser, to, subject: `[ScheduRx alert] ${subject}`, text });
    },
  };
}

module.exports = { createEmailClient };
