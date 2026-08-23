// Handles the "patient calls a clinic/doctor number, it goes unanswered, the
// carrier forwards it to our shared Twilio number" flow described in the
// Core Flow spec. Distinct from — and doesn't touch — the existing Ultravox
// voice-agent path (/tools/*, /internal/call-context): that's a live,
// separate, opaque system this backend has no visibility into. This is a
// fresh, config-driven path for the specific "call went unanswered" case.
//
// POST /voice        — inbound forwarded call, returns TwiML.
// POST /voice-status — call status callback (used to fire the missed-call
//                      follow-up once the call actually ends).
// POST /message-status — SMS/WhatsApp delivery callbacks (slice 2: wires
//                        into Reminder.status once comms-workflow-service
//                        lands; accepted and logged today so Twilio doesn't
//                        see 404s if the number's already configured for it).
// POST /whatsapp-inbound — a patient texting the clinic's WhatsApp number.
//                        Always routes into the existing staff Thread/ChatMsg
//                        consult inbox (same model sendReply() already uses)
//                        so a human sees the exchange either way. When
//                        assistantModel is configured, also runs the WhatsApp
//                        patient agent (whatsapp-agent-service.js — same tool-
//                        calling pattern as the staff "Ask ScheduRx" assistant,
//                        scoped to the phone-verified caller's own data) and
//                        replies with its answer; otherwise falls back to the
//                        original empty-TwiML-ack behavior.

const { Router } = require("express");
const { renderTemplate } = require("../lib/template");
const clinicSvc = require("../services/clinic-service");
const phoneRouteSvc = require("../services/phone-route-service");
const callLogSvc = require("../services/call-log-service");
const messagingSvc = require("../services/messaging-service");
const tableSvc = require("../services/table-service");
const whatsappAgentSvc = require("../services/whatsapp-agent-service");
const openaiSvc = require("../services/openai-service");
const notificationSvc = require("../services/notification-service");
const plansSvc = require("../lib/plans");
const crypto = require("node:crypto");
const { config } = require("../config");

const GREETING_BUCKET = "clinic-voice";

function greetingHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Best-effort — synthesizes and caches a natural-sounding greeting for NEXT
// time; never blocks or delays the current call (which already got the fast
// <Say> fallback before this is called, unawaited, from the handler below).
// Uploads to the public clinic-voice bucket (scripts/setup-voice-bucket.js)
// and stamps the clinic's settings so the next /voice call for this clinic
// can <Play> the cached audio instead of falling back to <Say> again.
async function cacheGreetingAudio(supabaseClient, elevenLabsClient, clinic, greeting, hash, log) {
  if (!elevenLabsClient) return;
  try {
    const audio = await elevenLabsClient.synthesizeSpeech({ text: greeting });
    const path = `${clinic.id}/greeting.mp3`;
    const { error: uploadErr } = await supabaseClient.storage
      .from(GREETING_BUCKET)
      .upload(path, audio, { contentType: "audio/mpeg", upsert: true });
    if (uploadErr) throw uploadErr;

    const {
      data: { publicUrl },
    } = supabaseClient.storage.from(GREETING_BUCKET).getPublicUrl(path);

    const settings = clinic.settings ?? {};
    const communication = settings.communication ?? {};
    const { error: updateErr } = await supabaseClient
      .from("Clinic")
      .update({
        settings: { ...settings, communication: { ...communication, voiceGreetingAudio: { path, hash, url: publicUrl } } },
        updatedAt: new Date().toISOString(),
      })
      .eq("id", clinic.id);
    if (updateErr) throw updateErr;

    log?.info({ clinicId: clinic.id }, "[webhooks:twilio] greeting audio cached for next call");
  } catch (err) {
    log?.warn({ err, clinicId: clinic.id }, "[webhooks:twilio] greeting synthesis/cache failed");
  }
}

const DEFAULT_GREETING =
  "Thanks for calling. We're unable to take your call right now — we'll text you shortly to help you book an appointment.";
const DEFAULT_FALLBACK = "Sorry, we couldn't connect your call. Please try again in a moment.";

function verifyTwilioSignature(twilioClient) {
  return (req, res, next) => {
    const signature = req.headers["x-twilio-signature"];
    const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    if (!twilioClient.validateSignature(signature, url, req.body)) {
      req.log?.warn({ url }, "[webhooks:twilio] signature verification failed");
      return res.status(401).send("Unauthorized");
    }
    next();
  };
}

// Best-effort — a triage-classification failure must never break the rest of
// the inbound handler. Written conditionally (retry without the new columns
// on a schema-cache miss) so this works before the Thread.triage/aiSummary
// migration has been applied, same defensive pattern as
// messaging-service.js's recordOutboundAiMessage.
//
// Takes the full `thread` (not just its id) so it can both read the
// pre-update triage — auto-escalate (Phase 5) only fires the first time a
// thread newly reaches "critical", not on every repeat classification of an
// already-critical conversation — and target the notification correctly
// (thread.doctorId for a booking-scoped thread, clinic-wide broadcast for a
// general one).
async function classifyAndStoreTriage(supabaseClient, openaiClient, thread, body, log) {
  if (!openaiClient || !body) return;
  const wasCritical = thread.triage === "critical";
  try {
    const { triage, summary } = await openaiSvc.classifyTriage(openaiClient, body);
    const { error } = await supabaseClient.from("Thread").update({ triage, aiSummary: summary }).eq("id", thread.id);
    if (error && /column/i.test(error.message ?? "")) {
      await supabaseClient.from("Thread").update({ triage }).eq("id", thread.id);
    }
    if (triage === "critical" && !wasCritical) {
      await notifyNewCriticalThread(supabaseClient, thread, log);
    }
  } catch (err) {
    log?.warn({ err, threadId: thread.id }, "[webhooks:twilio] triage classification failed");
  }
}

// Notifies the thread's own doctor (booking-scoped) or the whole clinic
// (general — no single doctor owns it) that a conversation just became High
// priority. Never throws — a notification failure shouldn't undo the triage
// classification that already succeeded.
async function notifyNewCriticalThread(supabaseClient, thread, log) {
  try {
    let staffId = null;
    if (thread.doctorId) {
      const { data: staffRow } = await supabaseClient
        .from("Staff")
        .select("id")
        .eq("clinicId", thread.clinicId)
        .eq("doctorId", thread.doctorId)
        .maybeSingle();
      staffId = staffRow?.id ?? null; // no matching Staff row — falls back to the clinic-wide broadcast below
    }
    await notificationSvc.createNotification(supabaseClient, {
      clinicId: thread.clinicId,
      staffId,
      type: "thread_critical",
      title: "Urgent message needs attention",
      body: "A patient conversation was just flagged High priority.",
      data: { threadId: thread.id },
    });
  } catch (err) {
    log?.warn({ err, threadId: thread.id }, "[webhooks:twilio] failed to create critical-triage notification");
  }
}

// Last-10-digits match, same tolerance the dashboard's own phone lookups use
// (booking-sheet.tsx) — robust against +91/91/bare-10-digit formatting
// differences between how a number was typed at booking time vs. what
// Twilio hands back as the inbound From.
function phonesMatch(a, b) {
  if (!a || !b) return false;
  const digitsA = a.replace(/\D/g, "").slice(-10);
  const digitsB = b.replace(/\D/g, "").slice(-10);
  return digitsA.length === 10 && digitsA === digitsB;
}

// Resolves a booking-ID deep link's target thread — null if the id doesn't
// exist, the appointment has no patient/phone on file, or (critically) the
// inbound phone doesn't match that appointment's own patient. Never throws;
// the caller falls back to normal phone-based resolution on a null return.
async function resolveBookingThread(supabaseClient, appointmentId, fromPhone, log) {
  const { data: appointment } = await supabaseClient
    .from("Appointment")
    .select("id, clinicId, doctorId, patientId")
    .eq("id", appointmentId)
    .maybeSingle();
  if (!appointment?.clinicId) return null;

  const [{ data: clinic }, { data: patient }] = await Promise.all([
    supabaseClient.from("Clinic").select("*").eq("id", appointment.clinicId).maybeSingle(),
    appointment.patientId
      ? supabaseClient.from("Patient").select("*").eq("id", appointment.patientId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (!clinic || !patient?.contactNumber) return null;

  if (!phonesMatch(fromPhone, patient.contactNumber)) {
    log?.warn(
      { appointmentId, clinicId: clinic.id },
      "[webhooks:twilio] booking-ID deep link phone mismatch — rejecting, falling back to normal resolution",
    );
    return null;
  }

  const thread = await messagingSvc.findOrCreateBookingThread(supabaseClient, {
    clinicId: clinic.id,
    appointmentId: appointment.id,
    doctorId: appointment.doctorId,
    patientId: patient.id,
    contactPhone: fromPhone,
  });

  return { clinic, patient, thread };
}

// The non-conversational-AI reply for a clinic whose plan doesn't include
// whatsappConversationalAi (basic, or custom without the ai_whatsapp_agent
// addon) — every plan still gets whatsappStructuredBooking per
// entitlementsForPlan(), so this is the "dropdown/CTA-based" flow the raw
// request asked for, not a silent drop to empty-reply. This is a same-session
// TwiML reply (the patient just messaged in), not a business-initiated send,
// so it doesn't need a Meta Content Template the way a cold outbound message
// would — sendTemplatedMessage's contentSid path is for outside-24h-session
// sends, which this isn't.
function buildStructuredFallbackReply(clinic, callerPhone) {
  const selfServiceUrl = config.PATIENT_APP_BASE_URL
    ? `${config.PATIENT_APP_BASE_URL}/${clinic.id}/${encodeURIComponent(callerPhone)}`
    : null;
  const lines = [
    `Thanks for messaging ${clinic.name ?? "our clinic"}! Our team will get back to you shortly.`,
  ];
  if (selfServiceUrl) {
    lines.push(`To book, reschedule, or cancel an appointment yourself right now: ${selfServiceUrl}`);
  }
  return lines.join(" ");
}

function createTwilioWebhookRouter({ supabaseClient, twilioClient, nettuClient, assistantModel, openaiClient, elevenLabsClient }) {
  const router = Router();
  const verify = verifyTwilioSignature(twilioClient);

  router.post("/voice", verify, async (req, res) => {
    const VoiceResponse = twilioClient.VoiceResponse;
    try {
      const originalNumber = phoneRouteSvc.resolveOriginalDestination(req);
      const route = await phoneRouteSvc.resolveRoute(supabaseClient, originalNumber);

      if (!route) {
        req.log?.warn(
          { originalNumber, callSid: req.body?.CallSid },
          "[webhooks:twilio] voice — could not resolve clinic, using fallback",
        );
        const twiml = new VoiceResponse();
        twiml.say(DEFAULT_FALLBACK);
        return res.type("text/xml").send(twiml.toString());
      }

      const clinic = await clinicSvc.getClinic(supabaseClient, route.clinicId);
      const comms = clinic?.settings?.communication ?? {};
      const greeting = renderTemplate(comms.voiceGreetingTemplate || DEFAULT_GREETING, {
        clinicName: clinic?.name,
        clinicPhone: clinic?.phone,
      });
      const hash = greetingHash(greeting);

      const twiml = new VoiceResponse();
      const cachedAudio = comms.voiceGreetingAudio;
      if (cachedAudio?.hash === hash && cachedAudio?.url) {
        twiml.play(cachedAudio.url);
      } else {
        twiml.say(greeting);
        // Not awaited — this call already got its (fast) <Say> greeting above;
        // synthesis/upload runs in the background so it never adds latency to
        // the call in progress, and the NEXT call for this clinic gets <Play>.
        cacheGreetingAudio(supabaseClient, elevenLabsClient, clinic, greeting, hash, req.log);
      }

      await callLogSvc.upsertByTwilioCallSid(supabaseClient, {
        clinicId: route.clinicId,
        twilioCallSid: req.body.CallSid,
        phone: req.body.From ?? "unknown",
        durationSec: 0,
        outcome: "info",
      });

      res.type("text/xml").send(twiml.toString());
    } catch (err) {
      req.log?.error({ err }, "[webhooks:twilio] voice handler failed");
      const twiml = new VoiceResponse();
      twiml.say(DEFAULT_FALLBACK);
      res.type("text/xml").send(twiml.toString());
    }
  });

  router.post("/voice-status", verify, async (req, res) => {
    try {
      const callSid = req.body?.CallSid;
      const callStatus = req.body?.CallStatus;
      if (!callSid) return res.sendStatus(200);

      const { data: callLog } = await supabaseClient
        .from("CallLog")
        .select("*")
        .eq("twilioCallSid", callSid)
        .maybeSingle();
      const clinicId =
        callLog?.clinicId ??
        (await phoneRouteSvc.resolveRoute(supabaseClient, phoneRouteSvc.resolveOriginalDestination(req)))?.clinicId;
      if (!clinicId) return res.sendStatus(200);

      if (callLog) {
        await callLogSvc.upsertByTwilioCallSid(supabaseClient, {
          clinicId,
          twilioCallSid: callSid,
          phone: callLog.phone,
          durationSec: Number(req.body?.CallDuration ?? 0) || 0,
          outcome: callLog.outcome,
        });
      }

      // Only the terminal "the automated greeting played and the caller hung
      // up" status should trigger a follow-up — not every intermediate
      // ringing/in-progress callback Twilio sends for the same call.
      if (callStatus === "completed") {
        await triggerMissedCallFollowup(supabaseClient, twilioClient, clinicId, req.body?.From, req.log);
      }

      res.sendStatus(200);
    } catch (err) {
      req.log?.error({ err }, "[webhooks:twilio] voice-status handler failed");
      res.sendStatus(200); // never make Twilio retry over our own follow-up failure
    }
  });

  router.post("/message-status", verify, async (req, res) => {
    req.log?.info(
      { sid: req.body?.MessageSid, status: req.body?.MessageStatus },
      "[webhooks:twilio] message-status received",
    );
    res.sendStatus(200);
  });

  router.post("/whatsapp-inbound", verify, async (req, res) => {
    const MessagingResponse = twilioClient.MessagingResponse;
    const emptyReply = () => res.type("text/xml").send(new MessagingResponse().toString());

    try {
      const from = (req.body?.From ?? "").replace(/^whatsapp:/, "");
      const to = (req.body?.To ?? "").replace(/^whatsapp:/, "");
      const body = req.body?.Body ?? "";
      const messageSid = req.body?.MessageSid;

      if (!from || !to) return emptyReply();

      // Twilio retries a webhook that's slow to respond — an LLM round trip
      // (below) is slow enough to make that a real possibility here, unlike
      // before. A retry must not re-run a reschedule/cancel tool call a
      // second time, so bail out early if this MessageSid was already logged.
      if (messageSid) {
        const { data: existing } = await supabaseClient
          .from("ChatMsg")
          .select("id")
          .eq("waMessageId", messageSid)
          .maybeSingle();
        if (existing) return emptyReply();
      }

      // Booking-ID fast path (Phase 4): a click-to-chat deep link
      // (wa.me/<number>?text=BOOKING%20<appointmentId>, from the thank-you
      // page CTA — Phase 7) arrives as this exact text as the message body.
      // Resolving via the appointment id directly (rather than the messy
      // phone-based clinic/thread resolution below) also sidesteps the
      // "which clinic does this phone belong to" ambiguity entirely — but
      // only once the inbound phone is verified to actually be that
      // appointment's own patient's phone, so a leaked/guessed booking id
      // can't be used to read or attach to someone else's thread.
      const bookingMatch = /^BOOKING\s+(apt_[\w-]+)/i.exec(body.trim());
      if (bookingMatch) {
        const bookingThread = await resolveBookingThread(supabaseClient, bookingMatch[1], from, req.log);
        if (bookingThread) {
          const { clinic, patient, thread } = bookingThread;
          await messagingSvc.recordInboundMessage(supabaseClient, { clinicId: clinic.id, thread, body, waMessageId: messageSid });
          await classifyAndStoreTriage(supabaseClient, openaiClient, thread, body, req.log);

          const entitlements = plansSvc.entitlementsForPlan(clinic.plan?.planId, clinic.plan?.addonIds);
          if (!assistantModel || !entitlements.whatsappConversationalAi) {
            if (!entitlements.whatsappStructuredBooking) return emptyReply();
            const replyText = buildStructuredFallbackReply(clinic, from);
            await messagingSvc.recordOutboundAiMessage(supabaseClient, { clinicId: clinic.id, thread, body: replyText });
            const twiml = new MessagingResponse();
            twiml.message(replyText);
            return res.type("text/xml").send(twiml.toString());
          }

          const replyText = await whatsappAgentSvc.respondToPatientMessage(
            { supabaseClient, nettuClient, twilioClient, assistantModel, clinic, patient, thread },
            req.log,
          );
          if (!replyText) return emptyReply();
          await messagingSvc.recordOutboundAiMessage(supabaseClient, { clinicId: clinic.id, thread, body: replyText });
          const twiml = new MessagingResponse();
          twiml.message(replyText);
          return res.type("text/xml").send(twiml.toString());
        }
        // No match, or the phone didn't verify — fall through to the normal
        // phone-based resolution below rather than trusting the claimed id.
      }

      // Resolves the receiving WhatsApp number to a clinic exactly like
      // /voice resolves the receiving phone number — a shared Twilio
      // account can send/receive on behalf of more than one clinic's
      // WhatsApp sender, so this can't assume a single fixed clinic.
      let { data: clinic } = await supabaseClient.from("Clinic").select("*").eq("whatsappFrom", to).maybeSingle();

      // In practice almost no clinic has its own dedicated whatsappFrom yet —
      // they all share the one platform number, so the exact match above
      // only ever resolves the one clinic that happens to have it configured
      // and silently orphans every other clinic's inbound WhatsApp (a real
      // patient with real bookings under a different clinic would get told
      // "you have no appointments" by that other clinic's empty data). Fall
      // back to whichever clinic(s) this phone number is actually a patient
      // of; if it's a patient of more than one (as can happen once several
      // clinics share one number), prefer the one with the most recent
      // appointment activity — the clinic they're actually engaging with.
      if (!clinic) {
        const candidates = await tableSvc.findPatientsByPhoneAcrossClinics(supabaseClient, from);
        let resolvedClinicId = null;
        if (candidates.length === 1) {
          resolvedClinicId = candidates[0].clinicId;
        } else if (candidates.length > 1) {
          const { data: recentAppt } = await supabaseClient
            .from("Appointment")
            .select("clinicId, createdAt")
            .in(
              "patientId",
              candidates.map((c) => c.id),
            )
            .order("createdAt", { ascending: false })
            .limit(1)
            .maybeSingle();
          resolvedClinicId =
            recentAppt?.clinicId ??
            [...candidates].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0].clinicId;
        }
        if (resolvedClinicId) {
          ({ data: clinic } = await supabaseClient.from("Clinic").select("*").eq("id", resolvedClinicId).maybeSingle());
        }
      }

      if (!clinic) {
        req.log?.warn({ to, from }, "[webhooks:twilio] whatsapp-inbound — no clinic owns this WhatsApp number");
        return emptyReply();
      }

      const patient = await tableSvc.findOrCreatePatient(supabaseClient, clinic.id, { phone: from });
      const thread = await messagingSvc.findOrCreateThread(supabaseClient, {
        clinicId: clinic.id,
        patientId: patient.id,
        contactPhone: from,
      });
      await messagingSvc.recordInboundMessage(supabaseClient, {
        clinicId: clinic.id,
        thread,
        body,
        waMessageId: messageSid,
      });
      await classifyAndStoreTriage(supabaseClient, openaiClient, thread, body, req.log);

      // Plan-gated: the full conversational agent only runs for clinics whose
      // plan actually includes it (premium, or custom + ai_whatsapp_agent) —
      // entitlementsForPlan already modeled this split, it just wasn't read
      // anywhere before now. Every clinic still gets *some* reply via the
      // structured fallback rather than silently going quiet.
      const entitlements = plansSvc.entitlementsForPlan(clinic.plan?.planId, clinic.plan?.addonIds);
      if (!assistantModel || !entitlements.whatsappConversationalAi) {
        if (!entitlements.whatsappStructuredBooking) return emptyReply();
        const replyText = buildStructuredFallbackReply(clinic, from);
        await messagingSvc.recordOutboundAiMessage(supabaseClient, { clinicId: clinic.id, thread, body: replyText });
        const twiml = new MessagingResponse();
        twiml.message(replyText);
        return res.type("text/xml").send(twiml.toString());
      }

      const replyText = await whatsappAgentSvc.respondToPatientMessage(
        { supabaseClient, nettuClient, twilioClient, assistantModel, clinic, patient, thread },
        req.log,
      );
      if (!replyText) return emptyReply();

      await messagingSvc.recordOutboundAiMessage(supabaseClient, { clinicId: clinic.id, thread, body: replyText });
      const twiml = new MessagingResponse();
      twiml.message(replyText);
      return res.type("text/xml").send(twiml.toString());
    } catch (err) {
      req.log?.error({ err }, "[webhooks:twilio] whatsapp-inbound failed");
      return emptyReply();
    }
  });

  return router;
}

// Zero-delay only (slice 1 scope) — sends synchronously once the call is
// confirmed ended. A clinic that wants a delayed follow-up instead configures
// a workflow with a non-zero offset, handled once comms-workflow-service
// (slice 2) lands and rides the same lightweight nettu carrier-event pattern
// built for task reminders.
async function triggerMissedCallFollowup(supabaseClient, twilioClient, clinicId, callerPhone, log) {
  if (!callerPhone) return;

  const clinic = await clinicSvc.getClinic(supabaseClient, clinicId);
  const comms = clinic?.settings?.communication ?? {};
  const channelsEnabled = comms.channelsEnabled ?? [];
  const workflow = (comms.workflows ?? []).find(
    (w) => w.enabled && w.trigger === "missed_call_followup" && (!w.offsetMinutes || w.offsetMinutes === 0),
  );
  if (!workflow || !channelsEnabled.includes(workflow.channel)) return;

  const from = workflow.channel === "whatsapp" ? clinic?.whatsappFrom : null;
  // Unlike booking_confirmed/reschedule's {{bookingUrl}} (an existing
  // appointment's manage link), there's no appointment yet here — this
  // points at the pre-booking entry point instead (the same
  // /{clinicId}/{phone} route schedurx-form-agent's IntakeForm already
  // handles), pre-filling the caller's own number.
  const bookingUrl = config.PATIENT_APP_BASE_URL ? `${config.PATIENT_APP_BASE_URL}/${clinicId}/${encodeURIComponent(callerPhone)}` : undefined;
  // Suffix-only form for Content Template URL buttons — see bookingUrlPath in
  // appointment-service.js for why the button variant can't just reuse bookingUrl.
  const bookingUrlPath = `${clinicId}/${encodeURIComponent(callerPhone)}`;
  try {
    await messagingSvc.sendTemplatedMessage(
      {
        twilioClient,
        channel: workflow.channel,
        toPhone: callerPhone,
        from,
        template: workflow.template,
        data: { clinicName: clinic?.name, clinicPhone: clinic?.phone, bookingUrl, bookingUrlPath },
      },
      log,
    );
  } catch (err) {
    log?.error({ err, clinicId, workflowId: workflow.id }, "[webhooks:twilio] missed-call follow-up send failed");
  }
}

module.exports = { createTwilioWebhookRouter };
