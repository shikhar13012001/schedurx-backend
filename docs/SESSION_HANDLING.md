# Session handling and tracking

Evidence-based description of how ScheduRx actually authenticates a request
today, what's stored where, what changed in this pass, and what's still a
gap. Written from the current code, not aspirational design — file/line
references are accurate as of this commit; re-verify before relying on them
after further changes.

## How a session actually works today

There is no server-side session store (no session table, no Redis, no
cookie-backed session). Identity is carried entirely by a **Firebase ID
token**, sent as `Authorization: Bearer <token>` on every `/api/v1/*`
request and verified fresh on every single request:

1. **Sign-in** (dashboard, `firebase/auth`) authenticates the staff member
   against Firebase (Google sign-in, or a custom-token exchange for the E2E
   test user) and gets back a short-lived ID token plus a longer-lived
   refresh token. The Firebase Web SDK stores and auto-refreshes both
   itself, in its own IndexedDB storage — this is Firebase's mechanism, not
   application code, and the app never touches the raw token value except
   to attach it to outgoing requests (`src/lib/api-client.ts`'s
   `authHeader()`, `user.getIdToken()` called fresh per request).
2. **Custom claims** (`role`, `clinicId`, `doctorId`, `fullName`) are set on
   the Firebase user at onboarding/invite-accept time
   (`internal-clinic-onboarding.js`, `staff-invite-service.js`'s
   `acceptInvite`) via `firebaseAdminApp.setCustomUserClaims`. These claims
   are baked into the ID token itself and only refresh when the client asks
   Firebase for a new one — normally on the client SDK's own ~1h cadence,
   or immediately after `getIdToken(true)` (forced refresh, used right
   after onboarding actions that just changed the staff member's claims —
   see `onboarding/page.tsx`'s `await user.getIdToken(true)` calls).
3. **Every `/api/v1/*` request** is verified by `firebase-auth.js`'s
   middleware: `verifyIdToken()`, confirm `clinicId`/`role` claims are
   present, look up the matching `Staff` row by `firebaseUid`, and reject if
   any of that fails. `req.staff = { uid, staffId, email, fullName, role,
   clinicId, doctorId }` is attached for the rest of the request — this is
   the *only* source of truth every route trusts for tenant scoping
   (`clinicId` from a URL/body param is never trusted — see the middleware's
   own header comment).
4. **What the frontend persists client-side**: `useSession`'s Zustand store
   (`src/stores/index.ts`) persists `{ session, onboarded }` to
   `localStorage` under the key `srx-session` — name, email, role,
   clinicId/clinicName, doctorId, staffId, firebaseUid. **Not** a raw ID or
   refresh token; those stay inside Firebase's own IndexedDB storage,
   outside application code's reach. This is profile/identity metadata, not
   a bearer credential — losing it doesn't grant access, it just means the
   UI has to re-fetch `/api/v1/me` on next load. Still PII (name, email) at
   rest in `localStorage` indefinitely; see Gaps below.

## What changed in this pass

- **Deactivated staff could keep working indefinitely.** `firebaseAuth`
  looked up the `Staff` row but never checked `isActive` — a fired/removed
  staff member's existing ID token (and its silent auto-refresh) kept
  authenticating successfully regardless, since nothing about "isActive"
  was ever encoded in the Firebase claims themselves. The middleware now
  rejects with `STAFF_DEACTIVATED` (403) the moment `isActive === false`,
  checked fresh on every request rather than trusted from a claim set once.
  There was previously no way to *set* `isActive: false` at all — added a
  minimal `PATCH /api/v1/team/:staffId/deactivate` (owner-only, can't
  target yourself, tenant-scoped) so the check has something to act on.
- **Service worker cached authenticated API responses indefinitely,
  including after logout.** `public/sw.js` cached every same-origin GET —
  no exclusion for `/api/*`. Patient/appointment/visit/message data served
  through the dashboard was landing in Cache Storage and staying there.
  Fixed to skip the cache entirely for `/api/`, `/webhooks/`, `/internal/`
  paths, plus logout now posts a `CLEAR_CACHE` message the worker uses to
  wipe what it already has (covers anything cached before this fix shipped,
  or on browsers running a stale worker version).
- **Invite tokens (a session-adjacent credential — possessing one grants a
  new session) were stored and compared in plaintext.** Now hashed
  (SHA-256) at rest; see the paired commit for the accept-flow implications
  of that change (short-code lookup now hands back the invite's own id in
  place of the token, since a hash can't be reversed to prove possession).

## Practical effect of "deactivation" today

Deactivating a staff member blocks every subsequent `/api/v1/*` request
immediately — there is no propagation delay, because the check runs fresh
per request rather than depending on a claim or cache expiring. It does
**not**:

- Revoke the Firebase refresh token itself (Firebase Admin's
  `revokeRefreshTokens(uid)` is available and not yet called — would force
  the *next* token refresh attempt to fail client-side too, belt-and-braces
  on top of the app-layer check above, which is sufficient on its own since
  every request re-checks `isActive`).
- Force sign-out on any tab currently open under that account — it'll surface
  as 403s on the next request that account makes, not an immediate kick.
- Clear that account's own service-worker cache remotely (only their own
  `logout()` call does that — see above); a deactivated account signing out
  themselves still gets the benefit, but forced-deactivation-while-signed-in
  doesn't.

## Known gaps (not addressed this pass — scoping reasons below)

- **No inactivity timeout / auto-logout.** A signed-in shared clinic device
  left unattended stays authenticated until the Firebase token's own
  refresh cycle eventually lapses (days, in practice, given auto-refresh).
  Worth a real UX design pass (what counts as "inactive", how a mid-task
  logout is communicated) rather than a rushed timer — flagged, not built.
- **No reauthentication step for high-risk actions** (role changes, staff
  deactivation, bulk messaging). The new deactivate endpoint is gated by
  role only, same as every other owner-only route in this codebase — adding
  a step-up-auth requirement would be a pattern change affecting more than
  this one endpoint, out of scope for a single-session fix.
- **No MFA.** Google sign-in alone; whatever MFA policy Google account
  itself has (if any) is the only second factor in practice today.
- **`srx-session` in localStorage is plaintext PII** (name, email,
  clinicName) with no expiry of its own — relies entirely on the Firebase
  session underneath it being what actually gates access. Low severity
  (it's identity metadata, not a credential) but worth revisiting alongside
  a real data-minimization pass rather than in isolation.
- **No server-side "list active sessions" or "sign out everywhere" UI** —
  Firebase Admin supports revoking all refresh tokens for a user
  (`revokeRefreshTokens`), which would need wiring into a
  deactivation/security-event flow to be useful; not called anywhere today.
