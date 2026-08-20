// Centralized plan/add-on pricing and feature entitlements — the single
// place `if (plan === "premium")`-style checks should ever be resolved
// against, instead of scattered through routes/services.
//
// IMPORTANT: this is a persisted-intent catalog, not a billing engine.
// Nothing here charges a card, creates a Stripe subscription, or meters
// usage — this codebase's Stripe integration (stripe-service.js) only
// handles one-off patient Invoice payments today, and there is no
// credits/wallet ledger anywhere. A clinic's `plan` selection is stored
// as-is (see clinic-service.js's updateClinicPlan) so a real subscription/
// metering system can be wired onto it later without another onboarding
// rewrite — see entitlementsForPlan() below for what "later" should read.

const PLAN_IDS = ["basic", "premium", "custom"];

const PLANS = {
  basic: {
    id: "basic",
    name: "Clinic Core",
    tagline: "Everything you need to run appointments digitally.",
    monthlyPaise: 99900,
  },
  premium: {
    id: "premium",
    name: "Clinic Autopilot",
    tagline: "Your AI receptionist and clinic operations layer.",
    monthlyPaise: 449900,
    recommended: true,
    includedCreditsPerMonth: 1517,
  },
  custom: {
    id: "custom",
    name: "Build Your Own",
    tagline: "Start with the essentials. Add only the automation you need.",
    basePaise: 99900,
  },
};

// Build Your Own add-on catalog — id must be stable, it's what a Clinic's
// `plan.addonIds` array stores.
const ADDONS = {
  online_consultations: { id: "online_consultations", name: "Online Consultations", monthlyPaise: 34900 },
  smart_ivr: { id: "smart_ivr", name: "Smart IVR", monthlyPaise: 49900 },
  ai_calling_agent: { id: "ai_calling_agent", name: "AI Calling Agent", monthlyPaise: 59900, usageBased: true },
  ai_whatsapp_agent: { id: "ai_whatsapp_agent", name: "AI WhatsApp Agent", monthlyPaise: 69900, usageBased: true },
  recorded_call_reminders: { id: "recorded_call_reminders", name: "Recorded Call Reminders", monthlyPaise: 29900, usageBased: true },
  ai_followup_agent: { id: "ai_followup_agent", name: "AI Follow-up Agent", monthlyPaise: 39900, usageBased: true },
  ambient_listening: { id: "ambient_listening", name: "Ambient Clinical Listening", monthlyPaise: 149900, perDoctor: true },
  premium_website: { id: "premium_website", name: "Premium Website", monthlyPaise: 39900 },
};

// Recharge packs shown once a real wallet exists — kept here now so the
// numbers live in one place from day one rather than being invented twice.
const CREDIT_PACKS = [
  { id: "starter", pricePaise: 49900, credits: 347 },
  { id: "standard", pricePaise: 99900, credits: 743 },
  { id: "growth", pricePaise: 199900, credits: 1517 },
  { id: "scale", pricePaise: 499900, credits: 3941 },
];

const PRICE_CONFIG_VERSION = "2026-08-21";

function addon(id) {
  const a = ADDONS[id];
  if (!a) throw Object.assign(new Error(`Unknown add-on '${id}'`), { code: "INVALID_ADDON", statusCode: 422 });
  return a;
}

// The only arithmetic that should ever compute a plan's monthly fixed cost —
// server-side, so the client can display it but never define it.
function estimateMonthlyPaise(planId, addonIds = []) {
  if (planId === "basic") return PLANS.basic.monthlyPaise;
  if (planId === "premium") return PLANS.premium.monthlyPaise;
  if (planId === "custom") {
    const addonsTotal = addonIds.reduce((sum, id) => sum + addon(id).monthlyPaise, 0);
    return PLANS.custom.basePaise + addonsTotal;
  }
  throw Object.assign(new Error(`Unknown plan '${planId}'`), { code: "INVALID_PLAN", statusCode: 422 });
}

// Feature entitlements a plan grants — the map other services/routes should
// check against (e.g. `entitlementsForPlan(clinic.plan).aiInboundVoice`)
// once those features actually gate on it. Nothing in the codebase reads
// this yet; it exists so that wiring is additive, not another schema
// migration, when it happens.
function entitlementsForPlan(planId, addonIds = []) {
  if (planId === "premium") {
    return {
      missedCallSafetyNet: true,
      aiInboundVoice: true,
      aiOutboundVoice: true,
      whatsappStructuredBooking: true,
      whatsappConversationalAi: true,
      voiceNotes: true,
      ambientListening: true,
      onlineConsultations: true,
    };
  }
  if (planId === "custom") {
    const has = (id) => addonIds.includes(id);
    return {
      missedCallSafetyNet: true,
      aiInboundVoice: has("ai_calling_agent"),
      aiOutboundVoice: has("ai_calling_agent") || has("ai_followup_agent"),
      whatsappStructuredBooking: true,
      whatsappConversationalAi: has("ai_whatsapp_agent"),
      voiceNotes: true,
      ambientListening: has("ambient_listening"),
      onlineConsultations: has("online_consultations"),
    };
  }
  // basic (and unknown/unselected) — the safe default.
  return {
    missedCallSafetyNet: true,
    aiInboundVoice: false,
    aiOutboundVoice: false,
    whatsappStructuredBooking: true,
    whatsappConversationalAi: false,
    voiceNotes: true,
    ambientListening: false,
    onlineConsultations: false,
  };
}

function validatePlanSelection({ planId, addonIds }) {
  if (!PLAN_IDS.includes(planId)) {
    throw Object.assign(new Error(`Unknown plan '${planId}'`), { code: "INVALID_PLAN", statusCode: 422 });
  }
  if (addonIds?.length) {
    if (planId !== "custom") {
      throw Object.assign(new Error("Add-ons only apply to the 'custom' plan"), {
        code: "INVALID_ADDON",
        statusCode: 422,
      });
    }
    addonIds.forEach(addon); // throws on any unknown id
  }
}

module.exports = {
  PLAN_IDS,
  PLANS,
  ADDONS,
  CREDIT_PACKS,
  PRICE_CONFIG_VERSION,
  estimateMonthlyPaise,
  entitlementsForPlan,
  validatePlanSelection,
};
