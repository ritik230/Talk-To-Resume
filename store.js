export function createStore() {
  return {
    token: localStorage.getItem("talkToResumeToken") || "",
    user: safeParse(localStorage.getItem("talkToResumeUser")),
    sessionId: localStorage.getItem("talkToResumeSessionId") || "",
    route: window.location.pathname || "/login",
    candidateProfile: null,
    recruiterMatches: [],
    decisionMemory: null,
    lastChatDebug: null,
    chatPending: false,
    debug: {
      mode: true,
      lastIntent: "idle",
      lastEvidence: [],
      lastConfidence: 0,
      lastLatencyMs: 0
    }
  };
}

export function setAuth(store, token, user) {
  store.token = token;
  store.user = user;
  localStorage.setItem("talkToResumeToken", token);
  localStorage.setItem("talkToResumeUser", JSON.stringify(user));
}
export function clearAuth(store) {
  store.token = "";
  store.user = null;
  store.sessionId = "";
  localStorage.removeItem("talkToResumeToken");
  localStorage.removeItem("talkToResumeUser");
  localStorage.removeItem("talkToResumeSessionId");
}

function safeParse(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}
