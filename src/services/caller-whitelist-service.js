// Clinic-scoped "log anyway" list for the Android missed-call safety net —
// a known contact on this list is still reported as a missed call (see
// missed-call-service.js) even though it resolves to a saved name on the
// device. This is a clinic policy, not a personal per-staff preference, so
// every staff member's app honors the same list (CallerWhitelist.clinicId,
// not staffId).

const { makeId } = require("../lib/ids");
const { normalizeIndianMobile } = require("../lib/phone");

function dbErr(msg) {
  return Object.assign(new Error(`DB error ${msg}`), { code: "DATABASE_ERROR", statusCode: 500 });
}

async function listWhitelist(supabaseClient, clinicId) {
  const { data, error } = await supabaseClient
    .from("CallerWhitelist")
    .select("*")
    .eq("clinicId", clinicId)
    .order("createdAt", { ascending: false });
  if (error) throw dbErr(`listing caller whitelist: ${error.message}`);
  return data ?? [];
}

async function addToWhitelist(supabaseClient, clinicId, { phone, label, addedByStaffId }) {
  const normalized = normalizeIndianMobile(phone);
  if (!normalized) {
    throw Object.assign(new Error("phone is not a valid Indian mobile number"), {
      code: "INVALID_PHONE",
      statusCode: 422,
    });
  }

  const { data, error } = await supabaseClient
    .from("CallerWhitelist")
    .insert({
      id: makeId("wl"),
      clinicId,
      phone: normalized,
      label: label ?? null,
      addedByStaffId: addedByStaffId ?? null,
      createdAt: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) {
    if (/duplicate|unique/i.test(error.message ?? "")) {
      throw Object.assign(new Error("This number is already on the whitelist"), {
        code: "ALREADY_WHITELISTED",
        statusCode: 409,
      });
    }
    throw dbErr(`adding to caller whitelist: ${error.message}`);
  }
  return data;
}

async function removeFromWhitelist(supabaseClient, clinicId, id) {
  const { error } = await supabaseClient.from("CallerWhitelist").delete().eq("id", id).eq("clinicId", clinicId);
  if (error) throw dbErr(`removing from caller whitelist: ${error.message}`);
}

module.exports = { listWhitelist, addToWhitelist, removeFromWhitelist };
