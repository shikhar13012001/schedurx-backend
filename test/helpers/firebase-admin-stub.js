// Shaped like the resolved Auth service server.js's buildFirebaseAdminApp()
// now returns (firebase-admin v14+'s getAuth(app), called once at boot) —
// just the .verifyIdToken()/.setCustomUserClaims() surface firebase-auth.js
// and the staff-onboarding routes actually call.
function createFirebaseAdminStub({ decodedToken = null, shouldReject = false } = {}) {
  return {
    async verifyIdToken() {
      if (shouldReject || !decodedToken) throw new Error("invalid token");
      return decodedToken;
    },
    async setCustomUserClaims() {
      return undefined;
    },
  };
}

module.exports = { createFirebaseAdminStub };
