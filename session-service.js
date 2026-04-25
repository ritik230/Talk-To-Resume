import { getCollections } from "./db.js";

const DEFAULT_SESSION_STATE = {
  selectedCandidate: null,
  lastCandidates: [],
  lastShortlist: [],
  activeRole: "",
  searchContext: null,
  lastQuery: "",
  lastIntent: "",
  filters: {},
  history: [],
  summary: ""
};

export async function getSession(sessionId, userId) {
  const { sessionsCollection } = getCollections();
  const existing = await sessionsCollection.findOne({ sessionId, userId });
  if (existing) {
    return normalizeSession(existing);
  }

  const now = new Date();
  const fresh = {
    sessionId,
    userId,
    ...DEFAULT_SESSION_STATE,
    createdAt: now,
    updatedAt: now
  };

  await sessionsCollection.insertOne(fresh);
  return fresh;
}

export async function updateSession(sessionId, userId, updates) {
  const { sessionsCollection } = getCollections();
  const now = new Date();
  const patch = {
    ...updates,
    updatedAt: now
  };

  await sessionsCollection.updateOne(
    { sessionId, userId },
    {
      $set: patch,
      $setOnInsert: {
        sessionId,
        userId,
        createdAt: now
      }
    },
    { upsert: true }
  );

  return getSession(sessionId, userId);
}

export async function clearSession(sessionId, userId) {
  const { sessionsCollection } = getCollections();
  await sessionsCollection.deleteOne({ sessionId, userId });
}

function normalizeSession(sessionDoc) {
  if (!sessionDoc) {
    return null;
  }

  return {
    sessionId: sessionDoc.sessionId,
    userId: sessionDoc.userId,
    selectedCandidate: sessionDoc.selectedCandidate || null,
    lastCandidates: Array.isArray(sessionDoc.lastCandidates) ? sessionDoc.lastCandidates : [],
    lastShortlist: Array.isArray(sessionDoc.lastShortlist) ? sessionDoc.lastShortlist : [],
    activeRole: sessionDoc.activeRole || "",
    searchContext: sessionDoc.searchContext || null,
    lastQuery: sessionDoc.lastQuery || "",
    lastIntent: sessionDoc.lastIntent || "",
    filters: sessionDoc.filters || {},
    history: normalizeHistory(sessionDoc.history),
    summary: sessionDoc.summary || "",
    createdAt: sessionDoc.createdAt,
    updatedAt: sessionDoc.updatedAt
  };
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history.map((entry) => {
    if (entry && typeof entry === "object" && typeof entry.role === "string" && typeof entry.content === "string") {
      return {
        role: entry.role,
        content: entry.content
      };
    }

    if (entry && typeof entry === "object" && typeof entry.query === "string") {
      return {
        role: "user",
        content: entry.query
      };
    }

    if (entry && typeof entry === "object" && typeof entry.answer === "string") {
      return {
        role: "assistant",
        content: entry.answer
      };
    }

    return {
      role: "user",
      content: String(entry || "")
    };
  });
}
