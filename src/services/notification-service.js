const { makeId } = require("../lib/ids");

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}

function notFound(id) {
  return Object.assign(new Error(`Notification '${id}' not found`), {
    code: "NOTIFICATION_NOT_FOUND",
    statusCode: 404,
  });
}

async function listNotifications(supabaseClient, clinicId, staffId) {
  const { data, error } = await supabaseClient
    .from("Notification")
    .select("*")
    .eq("clinicId", clinicId)
    .or(`staffId.eq.${staffId},staffId.is.null`)
    .order("createdAt", { ascending: false });
  if (error) throw dbErr(`listing notifications: ${error.message}`);
  return data ?? [];
}

// Used internally by other services (queue/messaging/etc.) once they need to
// notify — not yet called anywhere, but the shape is real so those call sites
// don't need this service's contract to change later.
async function createNotification(supabaseClient, { clinicId, staffId, type, title, body, data }) {
  const { data: row, error } = await supabaseClient
    .from("Notification")
    .insert({
      id: makeId("notif"),
      clinicId,
      staffId: staffId ?? null,
      type,
      title: title ?? null,
      body: body ?? null,
      data: data ?? {},
      createdAt: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw dbErr(`creating notification: ${error.message}`);
  return row;
}

async function markAllRead(supabaseClient, clinicId, staffId) {
  const now = new Date().toISOString();
  const { error } = await supabaseClient
    .from("Notification")
    .update({ readAt: now })
    .eq("clinicId", clinicId)
    .or(`staffId.eq.${staffId},staffId.is.null`)
    .is("readAt", null);
  if (error) throw dbErr(`marking notifications read: ${error.message}`);
}

// Scoped the same way as listNotifications/markAllRead — a staff member can
// only touch their own notifications plus clinic-wide broadcasts (staffId
// null), never another staff member's private ones.
async function markRead(supabaseClient, clinicId, staffId, notificationId) {
  const { data, error } = await supabaseClient
    .from("Notification")
    .update({ readAt: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("clinicId", clinicId)
    .or(`staffId.eq.${staffId},staffId.is.null`)
    .select()
    .maybeSingle();
  if (error) throw dbErr(`marking notification read: ${error.message}`);
  if (!data) throw notFound(notificationId);
  return data;
}

async function deleteNotification(supabaseClient, clinicId, staffId, notificationId) {
  const { error } = await supabaseClient
    .from("Notification")
    .delete()
    .eq("id", notificationId)
    .eq("clinicId", clinicId)
    .or(`staffId.eq.${staffId},staffId.is.null`);
  if (error) throw dbErr(`deleting notification: ${error.message}`);
}

module.exports = { listNotifications, createNotification, markAllRead, markRead, deleteNotification };
