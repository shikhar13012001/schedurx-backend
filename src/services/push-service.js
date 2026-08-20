// Web push (VAPID). Like the WhatsApp stub, this is a single action embedded
// inside otherwise-real flows: subscriptions always persist correctly; only the
// actual push send no-ops (logged) when VAPID keys aren't configured.

const webpush = require("web-push");
const { makeId } = require("../lib/ids");
const { config } = require("../config");

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}

let vapidConfigured = false;
function ensureVapid() {
  if (vapidConfigured || !config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) return vapidConfigured;
  webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY);
  vapidConfigured = true;
  return true;
}

async function listSubscriptionsForStaff(supabaseClient, staffId) {
  const { data, error } = await supabaseClient.from("PushSubscription").select("*").eq("staffId", staffId);
  if (error) throw dbErr(`listing push subscriptions: ${error.message}`);
  return data ?? [];
}

// Clinic-wide reminders (staffId: null on the Notification row) go to every
// active staff member's subscriptions, not just one — PushSubscription has no
// clinicId of its own, so this goes through Staff first.
async function listSubscriptionsForClinic(supabaseClient, clinicId) {
  const { data: staff, error: staffErr } = await supabaseClient
    .from("Staff")
    .select("id")
    .eq("clinicId", clinicId)
    .eq("isActive", true);
  if (staffErr) throw dbErr(`listing staff for push: ${staffErr.message}`);
  const staffIds = (staff ?? []).map((s) => s.id);
  if (!staffIds.length) return [];

  const { data, error } = await supabaseClient
    .from("PushSubscription")
    .select("*")
    .or(staffIds.map((id) => `staffId.eq.${id}`).join(","));
  if (error) throw dbErr(`listing push subscriptions: ${error.message}`);
  return data ?? [];
}

async function saveSubscription(supabaseClient, { staffId, subscription }) {
  const { data, error } = await supabaseClient
    .from("PushSubscription")
    .upsert(
      {
        id: makeId("push"),
        staffId,
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        createdAt: new Date().toISOString(),
      },
      { onConflict: "endpoint" },
    )
    .select()
    .single();
  if (error) throw dbErr(`saving push subscription: ${error.message}`);
  return data;
}

// sendFn is injectable (mirrors NettuClient's injectable fetchImpl) since
// web-push has no per-instance client object to swap in tests.
async function sendPush(subscription, payload, log, { sendFn = webpush.sendNotification } = {}) {
  if (!ensureVapid()) {
    log?.info({ endpoint: subscription.endpoint }, "[push:noop] VAPID not configured — push skipped");
    return { ok: true, stubbed: true };
  }

  try {
    await sendFn(subscription, JSON.stringify(payload));
    return { ok: true, stubbed: false };
  } catch (err) {
    log?.warn({ err, endpoint: subscription.endpoint }, "[push] send failed");
    return { ok: false, stubbed: false, error: err.message };
  }
}

module.exports = { saveSubscription, sendPush, listSubscriptionsForStaff, listSubscriptionsForClinic };
