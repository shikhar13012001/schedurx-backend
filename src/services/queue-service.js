// Live clinic queue — walk-ins, check-ins, and the doctor's "now serving" state.
// Every write here is also what a Supabase Realtime `postgres_changes`
// subscription on QueueItem broadcasts to connected dashboards.

const { makeId } = require("../lib/ids");

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}
function notFound(id) {
  return Object.assign(new Error(`Queue item '${id}' not found`), { code: "QUEUE_ITEM_NOT_FOUND", statusCode: 404 });
}

async function listQueue(supabaseClient, clinicId, { doctorId } = {}) {
  let query = supabaseClient.from("QueueItem").select("*").eq("clinicId", clinicId).neq("status", "done");
  if (doctorId) query = query.eq("doctorId", doctorId);

  const { data, error } = await query.order("position", { ascending: true });
  if (error) throw dbErr(`listing queue: ${error.message}`);
  return data ?? [];
}

async function addWalkIn(supabaseClient, { clinicId, doctorId, patientId, displayName, phoneNumber, appointmentId }) {
  const { data: maxRow } = await supabaseClient
    .from("QueueItem")
    .select("position")
    .eq("clinicId", clinicId)
    .eq("doctorId", doctorId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  const now = new Date().toISOString();
  const { data, error } = await supabaseClient
    .from("QueueItem")
    .insert({
      id: makeId("queue"),
      clinicId,
      doctorId,
      patientId: patientId ?? null,
      appointmentId: appointmentId ?? null,
      displayName: displayName ?? null,
      phoneNumber: phoneNumber ?? null,
      status: "waiting",
      position: (maxRow?.position ?? 0) + 1,
      walkIn: true,
      checkedInAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .select()
    .single();

  if (error) throw dbErr(`adding walk-in: ${error.message}`);
  return data;
}

async function getCurrentInRoom(supabaseClient, clinicId, doctorId) {
  const { data, error } = await supabaseClient
    .from("QueueItem")
    .select("*")
    .eq("clinicId", clinicId)
    .eq("doctorId", doctorId)
    .eq("status", "in_room")
    .maybeSingle();
  if (error) throw dbErr(`fetching current queue item: ${error.message}`);
  return data ?? null;
}

async function setStatus(supabaseClient, id, patch) {
  const { data, error } = await supabaseClient
    .from("QueueItem")
    .update({ ...patch, updatedAt: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw dbErr(`updating queue item: ${error.message}`);
  return data;
}

// direction: "next" | "prev" | "jumpTo" (jumpTo requires targetId)
async function advance(supabaseClient, { clinicId, doctorId, direction, targetId }) {
  const now = new Date().toISOString();
  const current = await getCurrentInRoom(supabaseClient, clinicId, doctorId);

  if (direction === "jumpTo") {
    if (!targetId)
      throw Object.assign(new Error("targetId is required for jumpTo"), { code: "MISSING_TARGET", statusCode: 422 });
    if (current) await setStatus(supabaseClient, current.id, { status: "waiting", calledAt: null });
    const target = await setStatus(supabaseClient, targetId, { status: "in_room", calledAt: now, completedAt: null });
    return { nowServing: target };
  }

  if (direction === "next") {
    if (current) await setStatus(supabaseClient, current.id, { status: "done", completedAt: now });

    const { data: nextWaiting, error } = await supabaseClient
      .from("QueueItem")
      .select("*")
      .eq("clinicId", clinicId)
      .eq("doctorId", doctorId)
      .eq("status", "waiting")
      .order("position", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw dbErr(`finding next queue item: ${error.message}`);
    if (!nextWaiting) return { nowServing: null };

    const target = await setStatus(supabaseClient, nextWaiting.id, { status: "in_room", calledAt: now });
    return { nowServing: target };
  }

  if (direction === "prev") {
    if (current) await setStatus(supabaseClient, current.id, { status: "waiting", calledAt: null });

    const { data: lastDone, error } = await supabaseClient
      .from("QueueItem")
      .select("*")
      .eq("clinicId", clinicId)
      .eq("doctorId", doctorId)
      .eq("status", "done")
      .order("completedAt", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw dbErr(`finding previous queue item: ${error.message}`);
    if (!lastDone) return { nowServing: null };

    const target = await setStatus(supabaseClient, lastDone.id, {
      status: "in_room",
      calledAt: now,
      completedAt: null,
    });
    return { nowServing: target };
  }

  throw Object.assign(new Error(`Unknown direction '${direction}'`), { code: "INVALID_DIRECTION", statusCode: 422 });
}

async function reorder(supabaseClient, { clinicId, ids }) {
  await Promise.all(
    ids.map((id, index) =>
      supabaseClient
        .from("QueueItem")
        .update({ position: index, updatedAt: new Date().toISOString() })
        .eq("id", id)
        .eq("clinicId", clinicId),
    ),
  );
  return listQueue(supabaseClient, clinicId);
}

module.exports = { listQueue, addWalkIn, advance, reorder, notFound };
