// Schedurx currently serves Indian clinics, so patient/staff phone entry is
// intentionally normalized to an Indian mobile E.164 number at API boundaries.
// Keeping this in one helper prevents UI formatting (spaces/dashes) from being
// passed through to Twilio, which rejects it with error 21211.
function normalizeIndianMobile(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  let subscriber = digits;
  if (subscriber.length === 12 && subscriber.startsWith("91")) subscriber = subscriber.slice(2);
  else if (subscriber.length === 11 && subscriber.startsWith("0")) subscriber = subscriber.slice(1);
  if (!/^[6-9]\d{9}$/.test(subscriber)) return null;
  return `+91${subscriber}`;
}

module.exports = { normalizeIndianMobile };
