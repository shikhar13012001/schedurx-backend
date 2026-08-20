// Minimal {{key}} / {{a.b}} substitution for clinic-configured voice/SMS/
// WhatsApp templates (Clinic.settings.communication — see api-v1-clinic-
// settings.js). Deliberately no fixed variable list: whatever's in `data` is
// available, and an unresolved placeholder renders as empty string rather
// than throwing — a misconfigured template shouldn't break the send/call it's
// attached to.
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

function renderTemplate(template, data = {}) {
  if (!template) return "";
  return template.replace(PLACEHOLDER, (_match, path) => {
    const value = path.split(".").reduce((obj, key) => (obj == null ? obj : obj[key]), data);
    return value == null ? "" : String(value);
  });
}

module.exports = { renderTemplate };
