export async function signup(payload) {
  return apiRequest("/auth/signup", {
    method: "POST",
    body: payload
  });
}

export async function login(payload) {
  return apiRequest("/auth/login", {
    method: "POST",
    body: payload
  });
}

export async function fetchMe(token) {
  return apiRequest("/auth/me", {
    token
  });
}

export async function createCandidateProfile(parsedData, token) {
  const payload = await apiRequest("/candidate/profile", {
    method: "POST",
    token,
    body: { parsedData }
  });
  return {
    candidateId: payload.candidateId,
    candidate: payload.candidate,
    warning: payload.warning || ""
  };
}

export async function fetchCandidateProfile(token) {
  return apiRequest("/candidate/profile", {
    token
  });
}

export async function fetchCandidatePool(token) {
  return apiRequest("/candidate-pool", {
    token
  });
}

export async function requestChatAnswer(question, sessionId, token) {
  const payload = await apiRequest("/chat", {
    method: "POST",
    token,
    body: { question, sessionId }
  });

  return {
    answer: typeof payload.answer === "string" && payload.answer.trim()
      ? payload.answer
      : "The recruiter assistant could not generate a response right now.",
    confidence: Number.isFinite(Number(payload.confidence))
      ? Number(payload.confidence)
      : 50,
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : sessionId || null,
    matchedCandidates: Array.isArray(payload.matchedCandidates) ? payload.matchedCandidates : [],
    totalCandidates: Number.isFinite(Number(payload.totalCandidates)) ? Number(payload.totalCandidates) : 0,
    decisionMemory: payload.decisionMemory && typeof payload.decisionMemory === "object"
      ? payload.decisionMemory
      : null,
    debug: payload.debug && typeof payload.debug === "object" ? payload.debug : null
  };
}

async function apiRequest(pathname, { method = "GET", token = "", body } = {}) {
  const response = await fetch(resolveApiEndpoint(pathname), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

function resolveApiEndpoint(pathname) {
  const { protocol, hostname, port } = window.location;
  if (port === "3000") {
    return pathname;
  }
  return `${protocol}//${hostname}:3000${pathname}`;
}
