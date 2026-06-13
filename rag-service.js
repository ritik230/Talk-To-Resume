import { ObjectId } from "mongodb";
import { getCollections as importedGetCollections } from "./db.js";
import { getSession as importedGetSession, updateSession as importedUpdateSession } from "./session-service.js";
import { parseRecruiterQuery, mergeFilters, buildSearchText } from "./query-parser.js";
import { convertCandidateDocumentForRetrieval, exposeMatchedCandidate } from "./candidate-service.js";
import { embedText, cosineSimilarity, keywordFallbackRanking, rankResumesByQuery } from "./embeddings.js";

const EMBEDDING_CACHE = new Map();
const EMBEDDING_CACHE_MAX_SIZE = 500;
const MAX_SESSION_HISTORY = 20;
const MAX_LLM_HISTORY = 10;
let getCollections = importedGetCollections;
let getSession = importedGetSession;
let updateSession = importedUpdateSession;

const INTENT_HANDLERS = Object.freeze({
  location_analytics: "handleLocationAnalytics",
  location_filter_search: "handleCandidateSearch",
  candidate_search: "handleCandidateSearch",
  comparison: "handleCandidateSearch",
  exclusion: "handleCandidateSearch",
  salary: "handleCandidateSearch",
  contact: "handleCandidateSearch",
  project: "handleCandidateSearch",
  exact_name: "handleExactName",
  general: "handleCandidateSearch"
});

export async function answerRecruiterQuestion({ recruiter, question, sessionId }) {
  const { candidatesCollection, retrievalMetricsCollection } = getCollections();
  const activeSessionId = normalizeSessionId(sessionId);
  const session = await getSession(activeSessionId, recruiter.id);
  const parsed = parseRecruiterQuery(question, session);
  const handlerName = resolveIntentHandlerName(parsed);
  const contextSession = parsed.searchAgain && session.searchContext
    ? {
      ...session,
      ...session.searchContext,
      filters: session.searchContext.filters || session.filters || {},
      summary: session.searchContext.summary || session.summary || "",
      lastQuery: session.searchContext.lastQuery || session.lastQuery || "",
      activeRole: session.searchContext.activeRole || session.activeRole || ""
    }
    : session;
  const shouldMergeSessionFilters = parsed.followUp || parsed.searchAgain || parsed.singularReference || parsed.pluralReference || parsed.contact || parsed.project || parsed.salary || parsed.exclusion || parsed.comparison || parsed.locationAnalytics;
  const mergedFilters = shouldMergeSessionFilters ? mergeFilters(contextSession.filters || {}, parsed.filters) : parsed.filters;
  const searchText = buildSearchText(question, mergedFilters, contextSession, parsed);
  const hydeText = buildHydeQueryText(question, mergedFilters, session, parsed);
  const chatDebug = {
    ...buildChatDebugInfo({
    question,
    hydeText,
    filters: mergedFilters,
    intent: parsed.intent,
    searchAgain: parsed.searchAgain,
    exactName: parsed.exactName,
    sessionSummary: contextSession.summary || ""
    }),
    llmPrompt: null
  };

  const allCandidates = await candidatesCollection.find({}).toArray();
  if (!allCandidates.length) {
    throw new Error("No candidate profiles are available yet.");
  }
  const dbPreFilter = buildMongoPreFilter(mergedFilters);
  let searchableCandidates;
  if (Object.keys(dbPreFilter).length > 0) {
    const dbFiltered = await candidatesCollection.find({ ...dbPreFilter, embeddingStatus: "success" }).toArray();
    searchableCandidates = dbFiltered.length >= 2 ? dbFiltered : allCandidates.filter((c) => c.embeddingStatus === "success");
  } else {
    searchableCandidates = allCandidates.filter((c) => c.embeddingStatus === "success");
  }

  const resolvedExactCandidate = resolveExactCandidateFromQuestion(question, parsed.exactName, allCandidates);
  const hasExactCandidate = Boolean(resolvedExactCandidate);

  if (hasExactCandidate || (parsed.exactNameQuery && parsed.exactName)) {
    const exactCandidate = resolvedExactCandidate || findExactCandidateByName(allCandidates, parsed.exactName);
    const exactShortlisted = exactCandidate ? [convertCandidateDocumentForRetrieval(exactCandidate)] : [];
    const exactSelectedCandidate = exactShortlisted[0] ? toSelectedCandidate(exactShortlisted[0]) : null;
    const exactAnswer = parsed.salary
      ? buildSalaryAnswer(exactShortlisted, exactSelectedCandidate, session, parsed, question)
      : parsed.project
        ? buildProjectAnswer(exactShortlisted, exactSelectedCandidate, parsed, question)
        : parsed.contact
          ? buildContactAnswer(exactShortlisted, exactSelectedCandidate, parsed, question)
          : buildExactNameAnswer(exactCandidate, parsed.exactName || exactCandidate?.name || question, parsed, question);
    const exactHistory = trimHistory([
      ...(session.history || []),
      { role: "user", content: question },
      { role: "assistant", content: exactAnswer.answer }
    ]);
    const exactSummary = buildExactNameSummary(session.summary, question, parsed.exactName, exactCandidate);
    const exactSession = await updateSession(activeSessionId, recruiter.id, {
      selectedCandidate: exactCandidate ? toSelectedCandidate(exactCandidate) : session.selectedCandidate || null,
      lastCandidates: exactCandidate ? [{
        id: exactCandidate._id.toString(),
        name: exactCandidate.name,
        metadata: exactCandidate.metadata || {}
      }] : [],
      lastShortlist: exactCandidate ? [{
        id: exactCandidate._id.toString(),
        name: exactCandidate.name,
        metadata: exactCandidate.metadata || {},
        reason: "Exact name lookup",
        score: 100
      }] : [],
      activeRole: session.activeRole || "",
      lastQuery: question,
      lastIntent: "exact-name",
      filters: mergedFilters,
      history: exactHistory,
      summary: exactSummary
    });

    return {
      sessionId: activeSessionId,
      answer: exactAnswer.answer,
      confidence: exactAnswer.confidence,
      decisionMemory: {
        selectedCandidate: exactSession.selectedCandidate || null,
        lastCandidates: exactSession.lastCandidates || [],
        lastShortlist: exactSession.lastShortlist || [],
        activeRole: exactSession.activeRole || "",
        filters: exactSession.filters || {},
        lastQuery: exactSession.lastQuery || "",
        lastIntent: exactSession.lastIntent || "",
        summary: exactSession.summary || ""
      },
      matchedCandidates: exactCandidate ? [exposeExactMatchedCandidate(exactCandidate)] : [],
      totalCandidates: allCandidates.length,
      ...buildOptionalDiagnostics({
        debug: chatDebug,
        evaluation: {
          query: question,
          k: exactCandidate ? 1 : 0,
          precisionAtK: exactCandidate ? 1 : 0,
          relevantCount: exactCandidate ? 1 : 0,
          retrievedCandidates: exactCandidate ? [{
            id: exactCandidate._id.toString(),
            name: exactCandidate.name,
            score: 1,
            relevant: true
          }] : []
        }
      }),
    };
  }

  if (!searchableCandidates.length) {
    throw new Error("No searchable candidate profiles are available yet because embedding generation has not completed successfully.");
  }

  const pool = searchableCandidates.map(convertCandidateDocumentForRetrieval);
  const scopedPool = scopeCandidatesToSession(pool, contextSession, parsed);
  const semanticPool = scopedPool.length ? scopedPool : pool;

  const retrieval = await hybridRankCandidates({
    candidates: semanticPool,
    question: searchText,
    hydeText,
    parsed,
    filters: mergedFilters,
    candidatesCollection
  });
  const ranked = retrieval.rankedCandidates;
  const finalRanked = applyFinalStrictFilters(ranked, mergedFilters);
  const hasHardFilters = hasStrictFilters(mergedFilters);
  const rankedForAnswer = finalRanked.length || !hasHardFilters ? (finalRanked.length ? finalRanked : ranked) : [];

  if (!rankedForAnswer.length && hasHardFilters) {
    const noMatchAnswer = buildNoExactMatchesAnswer(mergedFilters);
    const noMatchHistory = trimHistory([
      ...(session.history || []),
      {
        role: "user",
        content: question
      },
      {
        role: "assistant",
        content: noMatchAnswer.answer
      }
    ]);
    await updateSession(activeSessionId, recruiter.id, {
      selectedCandidate: null,
      lastCandidates: [],
      lastShortlist: [],
      activeRole: mergedFilters.role || contextSession.activeRole || "",
      lastQuery: question,
      lastIntent: parsed.intent,
      filters: mergedFilters,
      history: noMatchHistory,
      summary: buildSessionSummary(contextSession.summary, question, mergedFilters, [], null, parsed, contextSession),
      searchContext: {
        lastQuery: question,
        summary: buildSessionSummary(contextSession.summary, question, mergedFilters, [], null, parsed, contextSession),
        filters: mergedFilters,
        activeRole: mergedFilters.role || contextSession.activeRole || "",
        lastIntent: parsed.intent,
        shortlist: [],
        selectedCandidate: null
      }
    });

    const evaluation = buildRetrievalEvaluation({
      question,
      parsed,
      filters: mergedFilters,
      ranked: [],
      k: 0
    });

    if (retrievalMetricsCollection) {
      await recordRetrievalEvaluation(retrievalMetricsCollection, {
        sessionId: activeSessionId,
        userId: recruiter.id,
        question,
        parsed,
        filters: mergedFilters,
        ranked: [],
        evaluation
      });
    }

    return {
      sessionId: activeSessionId,
      answer: noMatchAnswer.answer,
      confidence: noMatchAnswer.confidence,
      decisionMemory: {
        selectedCandidate: null,
        lastCandidates: [],
        lastShortlist: [],
        activeRole: mergedFilters.role || contextSession.activeRole || "",
        filters: mergedFilters,
        lastQuery: question,
        lastIntent: parsed.intent,
        summary: buildSessionSummary(contextSession.summary, question, mergedFilters, [], null, parsed, contextSession)
      },
      matchedCandidates: [],
      totalCandidates: allCandidates.length,
      ...buildOptionalDiagnostics({
        debug: chatDebug,
        evaluation
      })
    };
  }

  if (handlerName === "handleLocationAnalytics") {
    const locationPool = finalRanked.length ? finalRanked : rankedForAnswer.length ? rankedForAnswer : ranked;
    const locationAnswer = buildLocationAvailabilityAnswer(locationPool, mergedFilters);
    const locationHistory = trimHistory([
      ...(session.history || []),
      {
        role: "user",
        content: question
      },
      {
        role: "assistant",
        content: locationAnswer.answer
      }
    ]);
    const locationSummary = buildSessionSummary(contextSession.summary, question, mergedFilters, locationPool.slice(0, 5), null, parsed, contextSession);
    await updateSession(activeSessionId, recruiter.id, {
      selectedCandidate: contextSession.selectedCandidate || null,
      lastCandidates: locationPool.slice(0, 5).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        metadata: candidate.metadata || {}
      })),
      lastShortlist: locationPool.slice(0, 5).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        metadata: candidate.metadata || {},
        reason: candidate.reason || "",
        score: candidate.finalScore || candidate.vectorScore || 0
      })),
      activeRole: mergedFilters.role || contextSession.activeRole || "",
      lastQuery: question,
      lastIntent: parsed.intent,
      filters: mergedFilters,
      history: locationHistory,
      summary: locationSummary,
      searchContext: {
        lastQuery: question,
        summary: locationSummary,
        filters: mergedFilters,
        activeRole: mergedFilters.role || contextSession.activeRole || "",
        lastIntent: parsed.intent,
        shortlist: locationPool.slice(0, 5).map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          metadata: candidate.metadata || {}
        })),
        selectedCandidate: contextSession.selectedCandidate || null
      }
    });

    const locationEvaluation = buildRetrievalEvaluation({
      question,
      parsed,
      filters: mergedFilters,
      ranked: rankedForAnswer,
      k: Math.min(5, rankedForAnswer.length || ranked.length)
    });

    if (retrievalMetricsCollection) {
      await recordRetrievalEvaluation(retrievalMetricsCollection, {
        sessionId: activeSessionId,
        userId: recruiter.id,
        question,
        parsed,
        filters: mergedFilters,
        ranked: rankedForAnswer,
        evaluation: locationEvaluation
      });
    }

    return {
      sessionId: activeSessionId,
      answer: locationAnswer.answer,
      confidence: locationAnswer.confidence,
      decisionMemory: {
        selectedCandidate: contextSession.selectedCandidate || null,
        lastCandidates: locationPool.slice(0, 5).map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          metadata: candidate.metadata || {}
        })),
        lastShortlist: locationPool.slice(0, 5).map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          metadata: candidate.metadata || {},
          reason: candidate.reason || "",
          score: candidate.finalScore || candidate.vectorScore || 0
        })),
        activeRole: mergedFilters.role || contextSession.activeRole || "",
        filters: mergedFilters,
        lastQuery: question,
        lastIntent: parsed.intent,
        summary: locationSummary
      },
      matchedCandidates: locationPool.map(exposeRankedCandidate),
      totalCandidates: allCandidates.length,
      ...buildOptionalDiagnostics({
        debug: chatDebug,
        evaluation: locationEvaluation
      })
    };
  }

  const shortlisted = selectShortlist(rankedForAnswer, parsed);
  const selectedCandidate = chooseSelectedCandidate(shortlisted, contextSession, parsed);
  const persistedCandidates = getPersistedCandidates(shortlisted, parsed);
  const sessionSummary = buildSessionSummary(contextSession.summary, question, mergedFilters, shortlisted, selectedCandidate, parsed, contextSession);
  const deterministicAnswer = normalizeAnswerPayload(buildAnswer({
    question,
    parsed,
    shortlisted,
    selectedCandidate,
    session: contextSession,
    filters: mergedFilters
  }));

  const recentMessages = getRecentMessages(session.history, MAX_LLM_HISTORY);
  const finalAnswer = await generateAssistantAnswer({
    provider: process.env.CHAT_PROVIDER || "gemini",
    question,
    summary: sessionSummary,
    recentMessages,
    shortlisted,
    selectedCandidate,
    filters: mergedFilters,
    deterministicAnswer: deterministicAnswer.answer
  });
  let answerPayload = normalizeAnswerPayload(finalAnswer?.answer || finalAnswer || deterministicAnswer);
  chatDebug.llmPrompt = finalAnswer?.prompt || null;

  if (finalAnswer?.action === "RETRIEVE_MORE") {
    const broaderRetrieval = await hybridRankCandidates({
      candidates: pool,
      question: searchText,
      hydeText,
      parsed,
      filters: mergedFilters,
      candidatesCollection
    });
    const broaderRanked = broaderRetrieval.rankedCandidates;
    const broaderFinalRanked = applyFinalStrictFilters(broaderRanked, mergedFilters);
    const broaderShortlisted = selectShortlist(broaderFinalRanked.length ? broaderFinalRanked : broaderRanked, parsed);
    const broaderSelectedCandidate = chooseSelectedCandidate(broaderShortlisted, contextSession, parsed);
    const broaderSessionSummary = buildSessionSummary(contextSession.summary, question, mergedFilters, broaderShortlisted, broaderSelectedCandidate, parsed, contextSession);
    const broaderDeterministic = normalizeAnswerPayload(buildAnswer({
      question,
      parsed,
      shortlisted: broaderShortlisted,
      selectedCandidate: broaderSelectedCandidate,
      session: contextSession,
      filters: mergedFilters
    }));
    const broaderFinalAnswer = await generateAssistantAnswer({
      provider: process.env.CHAT_PROVIDER || "gemini",
      question,
      summary: broaderSessionSummary,
      recentMessages,
      shortlisted: broaderShortlisted,
      selectedCandidate: broaderSelectedCandidate,
      filters: mergedFilters,
      deterministicAnswer: broaderDeterministic.answer,
      allowRetry: false
    });
    answerPayload = normalizeAnswerPayload(broaderFinalAnswer?.answer || broaderFinalAnswer || broaderDeterministic);
    chatDebug.llmPrompt = broaderFinalAnswer?.prompt || chatDebug.llmPrompt || null;
  }

  const updatedHistory = trimHistory([
    ...(session.history || []),
    {
      role: "user",
      content: question
    },
    {
      role: "assistant",
      content: answerPayload.answer
    }
  ]);

  const nextSession = await updateSession(activeSessionId, recruiter.id, {
    selectedCandidate,
    lastCandidates: persistedCandidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      metadata: candidate.metadata || {}
    })),
    lastShortlist: persistedCandidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      metadata: candidate.metadata || {},
      reason: candidate.reason || "",
      score: candidate.finalScore || candidate.vectorScore || 0
    })),
    activeRole: mergedFilters.role || session.activeRole || "",
    lastQuery: question,
    lastIntent: parsed.intent,
    filters: mergedFilters,
    history: updatedHistory,
    summary: sessionSummary,
    searchContext: {
      lastQuery: question,
      summary: sessionSummary,
      filters: mergedFilters,
      activeRole: mergedFilters.role || contextSession.activeRole || "",
      lastIntent: parsed.intent,
      shortlist: persistedCandidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        metadata: candidate.metadata || {}
      })),
      selectedCandidate: selectedCandidate ? {
        id: selectedCandidate.id,
        name: selectedCandidate.name,
        metadata: selectedCandidate.metadata || {}
      } : null
    }
  });
  const evaluation = buildRetrievalEvaluation({
    question,
    parsed,
    filters: mergedFilters,
    ranked: rankedForAnswer,
    k: Math.min(5, rankedForAnswer.length || ranked.length)
  });
  if (retrievalMetricsCollection) {
    await recordRetrievalEvaluation(retrievalMetricsCollection, {
      sessionId: activeSessionId,
      userId: recruiter.id,
      question,
      parsed,
      filters: mergedFilters,
      ranked,
      evaluation
    });
  }

  const confidence = computeConfidence({ answer: answerPayload.answer, shortlisted: rankedForAnswer, parsed, selectedCandidate, filters: mergedFilters });

  return {
    sessionId: activeSessionId,
    answer: answerPayload.answer,
    confidence,
    decisionMemory: {
      selectedCandidate: nextSession.selectedCandidate || null,
      lastCandidates: nextSession.lastCandidates || [],
      lastShortlist: nextSession.lastShortlist || [],
      activeRole: nextSession.activeRole || "",
      filters: nextSession.filters || {},
      lastQuery: nextSession.lastQuery || "",
      lastIntent: nextSession.lastIntent || "",
      summary: nextSession.summary || ""
      },
      matchedCandidates: rankedForAnswer.map(exposeRankedCandidate),
      totalCandidates: allCandidates.length,
      ...buildOptionalDiagnostics({
        debug: chatDebug,
        evaluation
      })
    };
  }

async function hybridRankCandidates({ candidates, question, hydeText = "", parsed, filters, candidatesCollection }) {
  const searchableCandidates = (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate.embeddingStatus === "success");
  const normalizedCandidates = searchableCandidates.map((candidate) => ({
    ...candidate,
    semanticProfile: candidate.semanticProfile || candidate.semanticProfile || null
  }));

  if (!normalizedCandidates.length) {
    throw new Error("No candidates are searchable because embedding generation has failed or is incomplete.");
  }

  const vectorMode = determineEmbeddingMode(normalizedCandidates);
  const queryVector = await buildQueryEmbedding(question, vectorMode, hydeText);
  const semanticCandidates = await tryAtlasVectorSearch({
    candidatesCollection,
    queryVector,
    filters,
    mode: vectorMode,
    limit: Math.min(50, normalizedCandidates.length || 50)
  });

  const semanticRanking = semanticCandidates.length ? semanticCandidates : rankCandidatesLocally(normalizedCandidates, question, queryVector);
  const keywordRanking = rankCandidatesByKeyword(normalizedCandidates, [question, hydeText].filter(Boolean).join(" "));
  const fusedRanking = reciprocalRankFusion([semanticRanking, keywordRanking]);
  const baseCandidates = fusedRanking.length ? fusedRanking : semanticRanking;
  const filtered = applyStructuredFilters(baseCandidates, filters);
  const relaxed = filtered.length ? filtered : applyRelaxedFilters(baseCandidates, filters);
  const ranked = relaxed.map((candidate) => scoreCandidate(candidate, filters, parsed, queryVector))
    .sort((left, right) => right.finalScore - left.finalScore);

  return {
    rankedCandidates: ranked,
    semanticCandidates: semanticRanking,
    keywordCandidates: keywordRanking,
    queryVector,
    vectorMode
  };
}

async function tryAtlasVectorSearch({ candidatesCollection, queryVector, filters, mode, limit = 20 }) {
  if (!process.env.MONGODB_VECTOR_INDEX || !queryVector?.length || mode === "mixed") {
    return [];
  }

  try {
    const pipeline = [
      {
          $vectorSearch: {
          index: process.env.MONGODB_VECTOR_INDEX,
          path: "embedding",
          queryVector,
          numCandidates: Math.max(100, limit * 4),
          limit
          }
        },
      {
        $project: {
          _id: 1,
          userId: 1,
          name: 1,
          structuredData: 1,
          embedding: 1,
          semanticProfile: 1,
          metadata: 1,
          resumeScore: 1,
          skillGapAnalysis: 1,
          suggestedImprovements: 1,
          vectorScore: { $meta: "vectorSearchScore" }
        }
      }
    ];

    const docs = await candidatesCollection.aggregate(pipeline).toArray();
    return docs.map((doc, index) => ({
      id: doc._id.toString(),
      name: doc.name,
      parsedData: doc.structuredData,
      metadata: doc.metadata || {},
      resumeScore: doc.resumeScore,
      skillGapAnalysis: doc.skillGapAnalysis || [],
      suggestedImprovements: doc.suggestedImprovements || [],
      semanticProfile: doc.semanticProfile,
      vectorScore: normalizeScore(doc.vectorScore),
      semanticRank: index + 1,
      semanticScore: normalizeScore(doc.vectorScore)
    }));
  } catch {
    return [];
  }
}

function rankCandidatesLocally(candidates, question, queryVector) {
  const semanticRanking = rankResumesByQuery(candidates, question, Math.max(5, candidates.length), {
    queryEmbedding: queryVector
  });
  return semanticRanking.matches.map((candidate, index) => ({
    id: candidate.id,
    name: candidate.name,
    parsedData: candidate.structuredData,
    metadata: candidate.metadata || {},
    resumeScore: candidate.resumeScore,
    skillGapAnalysis: candidate.skillGapAnalysis || [],
    suggestedImprovements: candidate.suggestedImprovements || [],
    semanticProfile: candidate.semanticProfile,
    vectorScore: normalizeScore(candidate.retrieval?.score),
    semanticRank: index + 1,
    semanticScore: normalizeScore(candidate.retrieval?.score)
  }));
}

function rankCandidatesByKeyword(candidates, question) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return [];
  }

  const queryTokens = tokenizeText(question);
  if (!queryTokens.length) {
    return candidates.map((candidate, index) => ({
      ...candidate,
      keywordRank: index + 1,
      keywordScore: 0
    }));
  }

  const corpus = candidates.map((candidate) => {
    const text = buildCandidateKeywordText(candidate);
    const tokens = tokenizeText(text);
    return {
      candidate,
      tokens,
      termFrequency: countTerms(tokens),
      length: tokens.length || 1
    };
  });

  const docCount = corpus.length;
  const avgLength = corpus.reduce((sum, entry) => sum + entry.length, 0) / Math.max(1, docCount);
  const documentFrequency = new Map();
  for (const term of new Set(queryTokens)) {
    let df = 0;
    for (const entry of corpus) {
      if (entry.termFrequency.has(term)) {
        df += 1;
      }
    }
    documentFrequency.set(term, df);
  }

  const scored = corpus.map((entry) => {
    const score = queryTokens.reduce((sum, term) => {
      const tf = entry.termFrequency.get(term) || 0;
      if (!tf) return sum;
      const df = documentFrequency.get(term) || 0;
      const idf = Math.log(1 + ((docCount - df + 0.5) / (df + 0.5)));
      const numerator = tf * 2.2;
      const denominator = tf + 1.2 * (0.25 + 0.75 * (entry.length / Math.max(1, avgLength)));
      return sum + (idf * (numerator / denominator));
    }, 0);

    return {
      ...entry.candidate,
      keywordScore: round(score),
      keywordRank: 0
    };
  }).sort((left, right) => right.keywordScore - left.keywordScore)
    .map((candidate, index) => ({
      ...candidate,
      keywordRank: index + 1
    }));

  return scored;
}

function reciprocalRankFusion(resultSets, constant = 60) {
  const fused = new Map();
  const candidates = resultSets.filter(Array.isArray);

  candidates.forEach((set, setIndex) => {
    set.forEach((candidate, rankIndex) => {
      if (!candidate || !candidate.id) {
        return;
      }
      const existing = fused.get(candidate.id) || {
        ...candidate,
        semanticRank: candidate.semanticRank || null,
        keywordRank: candidate.keywordRank || null,
        semanticScore: candidate.semanticScore || 0,
        keywordScore: candidate.keywordScore || 0,
        rrfScore: 0,
        sources: []
      };
      existing.rrfScore += 1 / (constant + rankIndex + 1);
      existing.sources.push(setIndex === 0 ? "semantic" : "keyword");
      if (candidate.semanticRank && !existing.semanticRank) existing.semanticRank = candidate.semanticRank;
      if (candidate.keywordRank && !existing.keywordRank) existing.keywordRank = candidate.keywordRank;
      if (candidate.semanticScore && !existing.semanticScore) existing.semanticScore = candidate.semanticScore;
      if (candidate.keywordScore && !existing.keywordScore) existing.keywordScore = candidate.keywordScore;
      fused.set(candidate.id, existing);
    });
  });

  const entries = [...fused.values()];
  const bestScore = Math.max(...entries.map((candidate) => candidate.rrfScore), 0.0001);
  return entries.map((candidate) => ({
    ...candidate,
    rrfNormalized: candidate.rrfScore / bestScore
  })).sort((left, right) => right.rrfScore - left.rrfScore);
}

function applyStructuredFilters(candidates, filters) {
  const filtered = candidates.filter((candidate) => matchesFilters(candidate, filters));
  return filtered;
}

function applyRelaxedFilters(candidates, filters) {
  const hasStrictRole = Boolean(filters.role);
  const hasSkill = Array.isArray(filters.skills) && filters.skills.length > 0;
  const hasLocation = Boolean(filters.location);
  const minExperience = Number(filters.experience || 0);
  const experienceRange = filters.experienceRange || null;

  return candidates.filter((candidate) => {
    const profile = candidate.parsedData || {};
    const metadata = candidate.metadata || {};
    const candidateSkills = getCandidateSkills(profile);
    const candidateExperience = getCandidateExperience(profile);

    const roleOk = !hasStrictRole || matchesRole(candidate, filters.role);
    const skillOk = !hasSkill || candidateSkills.some((skill) => filters.skills.some((requested) => skill.toLowerCase().includes(requested.toLowerCase())));
    const locationOk = !hasLocation || matchesLocation(candidate, filters.location);
    const experienceOk = !minExperience || candidateExperience >= Math.max(0, minExperience - 1);
    const rangeOk = !experienceRange || matchesExperienceRange(candidateExperience, experienceRange);

    return (roleOk || skillOk || locationOk || experienceOk) && rangeOk;
  });
}

function matchesFilters(candidate, filters) {
  const profile = candidate.parsedData || {};
  const metadata = candidate.metadata || {};
  const candidateSkills = getCandidateSkills(profile);
  const candidateExperience = getCandidateExperience(profile);

  if (filters.role && !matchesRole(candidate, filters.role)) {
    return false;
  }

  if (filters.location && !matchesLocation(candidate, filters.location)) {
    return false;
  }

  if (Number(filters.experience || 0) > 0 && candidateExperience < Number(filters.experience || 0)) {
    return false;
  }

  if (filters.experienceRange && !matchesExperienceRange(candidateExperience, filters.experienceRange)) {
    return false;
  }

  if (Array.isArray(filters.locations) && filters.locations.length && !matchesAnyLocation(candidate, filters.locations)) {
    return false;
  }

  if (Array.isArray(filters.skills) && filters.skills.length) {
    const skillHit = candidateSkills.some((skill) => filters.skills.some((requested) => skill.toLowerCase().includes(requested.toLowerCase())));
    if (!skillHit) {
      return false;
    }
  }

  return true;
}

function matchesRole(candidate, role) {
  const metadataRole = String(candidate.metadata?.role || "").toLowerCase();
  const summary = String(candidate.parsedData?.summary || "").toLowerCase();
  const strengths = (candidate.parsedData?.strengths || []).map((item) => String(item).toLowerCase());
  const roleText = String(role || "").toLowerCase();
  return metadataRole === roleText || summary.includes(roleText) || strengths.some((value) => value.includes(roleText));
}

function matchesLocation(candidate, location) {
  const candidateLocation = String(candidate.metadata?.location || candidate.parsedData?.location || "").toLowerCase();
  if (Array.isArray(location)) {
    return location.some((entry) => candidateLocation.includes(String(entry || "").toLowerCase()));
  }
  return candidateLocation.includes(String(location || "").toLowerCase());
}

function matchesAnyLocation(candidate, locations) {
  const candidateLocation = String(candidate.metadata?.location || candidate.parsedData?.location || "").toLowerCase();
  return (Array.isArray(locations) ? locations : []).some((location) => candidateLocation.includes(String(location || "").toLowerCase()));
}

function matchesExperienceRange(candidateExperience, experienceRange) {
  if (!experienceRange) {
    return true;
  }

  const min = Number(experienceRange.min || 0);
  const max = Number(experienceRange.max || 0);
  if (min && candidateExperience < min) {
    return false;
  }
  if (max && candidateExperience > max) {
    return false;
  }
  return true;
}

function applyFinalStrictFilters(candidates, filters) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return [];
  }

  if (!hasStrictFilters(filters)) {
    return candidates;
  }

  return candidates.filter((candidate) => matchesFilters(candidate, filters));
}

function hasStrictFilters(filters) {
  return Boolean(filters?.role)
    || Boolean(filters?.location)
    || Boolean(filters?.experienceRange)
    || Number(filters?.experience || 0) > 0
    || (Array.isArray(filters?.skills) && filters.skills.length > 0)
    || (Array.isArray(filters?.locations) && filters.locations.length > 0);
}

function scoreCandidate(candidate, filters, parsed, queryVector) {
  const candidateSkills = getCandidateSkills(candidate.parsedData || {});
  const candidateExperience = getCandidateExperience(candidate.parsedData || {});
  const requestedSkills = Array.isArray(filters.skills) ? filters.skills : [];
  const vectorSimilarity = normalizeScore(candidate.rrfNormalized ?? candidate.vectorScore ?? candidate.retrieval?.score ?? 0);
  const experienceMatch = requestedSkills.length || Number(filters.experience || 0)
    ? clamp(candidateExperience / Math.max(Number(filters.experience || 0), 1), 0, 1)
    : clamp(candidateExperience / 8, 0.3, 1);
  const skillMatches = requestedSkills.length
    ? requestedSkills.filter((skill) => candidateSkills.some((candidateSkill) => candidateSkill.toLowerCase().includes(skill.toLowerCase()))).length
    : Math.min(candidateSkills.length / 6, 1);
  const skillMatch = requestedSkills.length ? skillMatches / requestedSkills.length : skillMatches;
  const w = getScoringWeights(parsed, filters);
  const exactSkillBonus = requestedSkills.length > 0 && skillMatches === requestedSkills.length ? 0.08 : 0;
  const finalScore = (vectorSimilarity * w.vector) + (experienceMatch * w.experience) + (skillMatch * w.skill) + exactSkillBonus;
  const reason = buildReason(candidate, filters, candidateSkills, candidateExperience, finalScore);
  return {
    ...candidate,
    vectorScore: vectorSimilarity,
    experienceMatch,
    skillMatch,
    finalScore: round(finalScore),
    reason,
    retrieval: {
      score: round(vectorSimilarity),
      semanticRank: candidate.semanticRank || null,
      keywordRank: candidate.keywordRank || null,
      rrfScore: round(candidate.rrfScore || 0),
      rrfNormalized: round(candidate.rrfNormalized || vectorSimilarity),
      semanticScore: round(candidate.semanticScore || 0),
      keywordScore: round(candidate.keywordScore || 0),
      topChunks: candidate.semanticProfile?.chunks?.slice(0, 3).map((chunk) => ({
        type: chunk.type,
        label: chunk.label,
        text: chunk.text,
        similarity: round(normalizeScore(chunk.embedding ? cosineSimilarity(queryVector, chunk.embedding) : 0))
      })) || []
    }
  };
}

function buildReason(candidate, filters, candidateSkills, candidateExperience, finalScore) {
  const parts = [];
  if (filters.role) {
    parts.push(`matched role ${filters.role}`);
  }
  if (Array.isArray(filters.skills) && filters.skills.length) {
    const matchedSkills = filters.skills.filter((requested) => candidateSkills.some((candidateSkill) => candidateSkill.toLowerCase().includes(requested.toLowerCase())));
    if (matchedSkills.length) {
      parts.push(`matched ${matchedSkills.join(", ")}`);
    }
  }
  if (filters.location && matchesLocation(candidate, filters.location)) {
    parts.push(`location ${filters.location}`);
  }
  if (filters.experienceRange) {
    parts.push(`${round(candidateExperience)} years experience within requested range`);
  } else if (Number(filters.experience || 0) > 0) {
    parts.push(`${round(candidateExperience)} years experience`);
  } else {
    parts.push(`${round(candidateExperience)} years experience`);
  }
  return parts.join(" + ") || `score ${round(finalScore)}`;
}

function buildCandidateKeywordText(candidate) {
  const profile = candidate.parsedData || {};
  const parts = [
    candidate.name,
    profile.summary,
    profile.location,
    candidate.metadata?.role,
    candidate.metadata?.location,
    ...(profile.skills || []).map((skill) => skill.name),
    ...(profile.projects || []).flatMap((project) => [
      project.name,
      project.description,
      ...(Array.isArray(project.techStack) ? project.techStack : []),
      ...(Array.isArray(project.features) ? project.features : [])
    ]),
    ...(profile.experience || []).flatMap((entry) => [
      entry.company,
      entry.role,
      ...(Array.isArray(entry.responsibilities) ? entry.responsibilities : []),
      ...(Array.isArray(entry.techUsed) ? entry.techUsed : [])
    ]),
    ...(profile.strengths || [])
  ];

  return parts.filter(Boolean).join(" ");
}

function tokenizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9.+#/\- ]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .flatMap((token) => splitCompoundToken(token));
}

function splitCompoundToken(token) {
  if (!token) return [];
  if (token.includes(" ")) return token.split(/\s+/).filter(Boolean);
  const replaced = token.replace(/[./#+-]/g, " ");
  return replaced.split(/\s+/).filter(Boolean);
}

function countTerms(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

function selectShortlist(rankedCandidates, parsed) {
  if (!rankedCandidates.length) {
    return [];
  }

  if (parsed.explicitSingle) {
    return rankedCandidates.slice(0, 1);
  }

  if (parsed.salary || parsed.comparison) {
    return rankedCandidates.slice(0, 3);
  }

  return rankedCandidates.slice(0, 5);
}

function getPersistedCandidates(shortlisted, parsed) {
  if (!Array.isArray(shortlisted) || !shortlisted.length) {
    return [];
  }

  if (parsed.comparison) {
    return shortlisted.slice(0, Math.min(2, shortlisted.length));
  }

  if (parsed.availability || parsed.exclusion) {
    return shortlisted.slice(0, Math.min(5, shortlisted.length));
  }

  if (parsed.salary || parsed.contact || parsed.project || parsed.explicitSingle || parsed.intent === "single") {
    return shortlisted.slice(0, 1);
  }

  return shortlisted.slice(0, 1);
}

function chooseSelectedCandidate(shortlisted, session, parsed) {
  if (!shortlisted.length) {
    return null;
  }

  if (parsed.exclusion || parsed.availability || parsed.shortlistReference || parsed.followUp) {
    return session.selectedCandidate || null;
  }

  if (parsed.explicitSingle) {
    return session.selectedCandidate || toSelectedCandidate(shortlisted[0]);
  }

  if (parsed.intent === "comparison") {
    return toSelectedCandidate(shortlisted[0]);
  }

  const top = shortlisted[0];
  return top ? toSelectedCandidate(top) : session.selectedCandidate ? session.selectedCandidate : null;
}

function buildAnswer({ question, parsed, shortlisted, selectedCandidate, session, filters }) {
  if (!shortlisted.length) {
    return {
      answer: "This information is not clearly available in the provided resumes.",
      confidence: 28
    };
  }

  if (parsed.salary) {
    return buildSalaryAnswer(shortlisted, selectedCandidate, session, parsed, question);
  }

  if (parsed.explicitSingle) {
    const top = shortlisted[0];
    return {
      answer: formatContactLine(top),
      confidence: 92
    };
  }

  switch (parsed.intent) {
    case "contact":
      return buildContactAnswer(shortlisted, selectedCandidate, parsed, question);
    case "project":
      return buildProjectAnswer(shortlisted, selectedCandidate, parsed, question);
    case "comparison":
      return buildComparisonAnswer(shortlisted, session, parsed);
    case "exclusion":
      return buildExclusionAnswer(shortlisted);
    case "candidate_search":
    case "location_filter_search":
      return buildListAnswer(shortlisted, filters);
    case "single":
      return {
        answer: formatContactLine(shortlisted[0]),
        confidence: 92
      };
    default:
      return buildBestAnswer(shortlisted);
  }
}

function buildListAnswer(shortlisted, filters) {
  const displayRole = buildDisplayRole(filters);
  const intro = displayRole || (Array.isArray(filters.skills) && filters.skills.length)
    ? `Yes, here are the closest matches for ${displayRole || filters.skills.join(", ")}:`
    : "Here are the strongest matches:";

  const lines = shortlisted.map((candidate, index) => {
    return `${index + 1}. ${candidate.name} - ${candidate.reason}`;
  });
  return {
    answer: [intro, ...lines].join("\n"),
    confidence: 84
  };
}

function buildDisplayRole(filters) {
  const role = String(filters.role || "").toLowerCase();
  const skillNames = Array.isArray(filters.skills) ? filters.skills.map((skill) => String(skill || "").toLowerCase()) : [];
  if (skillNames.includes("java") && role === "backend") {
    return "Java developers";
  }
  if (skillNames.includes("dell boomi") || skillNames.includes("boomi")) {
    return "Boomi developers";
  }
  if (skillNames.includes("guidewire")) {
    return "Guidewire developers";
  }
  return filters.role || (Array.isArray(filters.skills) && filters.skills.length ? filters.skills.join(", ") : "");
}

function buildComparisonAnswer(shortlisted, session, parsed) {
  const pluralMode = Boolean(parsed?.pluralReference) || getSessionShortlist(session).length > 1;
  if (pluralMode && shortlisted.length) {
    const lines = shortlisted.slice(0, 5).map((candidate, index) => `${index + 1}. ${candidate.name} - ${candidate.reason}`);
    const top = shortlisted[0];
    return {
      answer: `Here is the comparison for the current shortlist:\n${lines.join("\n")}${top ? `\n\n${top.name} is the strongest match because ${top.reason}.` : ""}`,
      confidence: 90
    };
  }

  const top = shortlisted[0];
  if (!top) {
    return {
      answer: "This information is not clearly available in the provided resumes.",
      confidence: 28
    };
  }

  if (shortlisted.length === 1) {
    return {
      answer: `${top.name} is the strongest match because ${top.reason}.`,
      confidence: 90
    };
  }

  const second = shortlisted[1];
  return {
    answer: `${top.name} is the strongest match because ${top.reason}. ${second.name} is the next best option because ${second.reason}.`,
    confidence: 90
  };
}

function buildExclusionAnswer(shortlisted) {
  if (!shortlisted.length) {
    return {
      answer: "No additional matching candidates are available beyond the current shortlist.",
      confidence: 42
    };
  }

  const lines = shortlisted.slice(0, 5).map((candidate, index) => `${index + 1}. ${candidate.name} - ${candidate.reason}`);
  return {
    answer: `Here are other candidates apart from the current shortlist:\n${lines.join("\n")}`,
    confidence: 84
  };
}

function buildLocationAvailabilityAnswer(candidates, filters) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return {
      answer: `No location information is available for ${buildDisplayRole(filters) || "the current candidates"}.`,
      confidence: 58
    };
  }

  const locationMap = new Map();
  for (const candidate of candidates) {
    const rawLocation = String(candidate.metadata?.location || candidate.parsedData?.location || "").trim();
    if (!rawLocation) {
      continue;
    }
    const normalized = rawLocation.toLowerCase();
    if (!locationMap.has(normalized)) {
      locationMap.set(normalized, {
        label: rawLocation,
        count: 0
      });
    }
    locationMap.get(normalized).count += 1;
  }

  const locations = [...locationMap.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  if (!locations.length) {
    return {
      answer: `No location information is available for ${buildDisplayRole(filters) || "the current candidates"}.`,
      confidence: 58
    };
  }

  const locationText = locations.slice(0, 8).map((entry) => entry.label);
  const roleLabel = buildDisplayRole(filters) || "the current candidates";
  return {
    answer: `${roleLabel} are available in ${joinList(locationText)}.`,
    confidence: 90
  };
}

function buildBestAnswer(shortlisted) {
  const top = shortlisted[0];
  if (!top) {
    return {
      answer: "This information is not clearly available in the provided resumes.",
      confidence: 28
    };
  }

  return {
    answer: `${top.name} is the strongest match because ${top.reason}.`,
    confidence: 88
  };
}

function buildNoExactMatchesAnswer(filters) {
  const roleLabel = buildDisplayRole(filters) || "this role";
  const experienceLabel = buildExperienceLabel(filters);
  const locationLabel = buildLocationLabel(filters);
  const scope = [roleLabel, experienceLabel, locationLabel].filter(Boolean).join(" ");
  return {
    answer: scope
      ? `No exact matches were found for ${scope}.`
      : "No exact matches were found in the database.",
    confidence: 96
  };
}

function buildExperienceLabel(filters) {
  if (filters?.experienceRange?.min || filters?.experienceRange?.max) {
    const min = filters.experienceRange.min;
    const max = filters.experienceRange.max;
    if (Number.isFinite(Number(min)) && Number.isFinite(Number(max))) {
      return `${min} to ${max} years of experience`;
    }
  }
  if (Number(filters?.experience || 0) > 0) {
    return `${filters.experience} years of experience`;
  }
  return "";
}

function buildLocationLabel(filters) {
  if (Array.isArray(filters?.locations) && filters.locations.length) {
    return `in ${joinList(filters.locations)}`;
  }
  if (filters?.location) {
    return `in ${filters.location}`;
  }
  return "";
}

function getSessionShortlist(session) {
  if (!session) {
    return [];
  }

  if (Array.isArray(session.lastShortlist) && session.lastShortlist.length) {
    return session.lastShortlist;
  }

  if (Array.isArray(session.lastCandidates) && session.lastCandidates.length) {
    return session.lastCandidates;
  }

  return [];
}

function normalizeAnswerPayload(result) {
  if (typeof result === "string") {
    return {
      answer: result,
      confidence: 84
    };
  }

  if (!result || typeof result !== "object") {
    return {
      answer: "This information is not clearly available in the provided resumes.",
      confidence: 28
    };
  }

  return {
    answer: typeof result.answer === "string" && result.answer.trim()
      ? result.answer
      : "This information is not clearly available in the provided resumes.",
    confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : 50
  };
}

function getRecentMessages(history, limit = MAX_LLM_HISTORY) {
  if (!Array.isArray(history) || !history.length) {
    return [];
  }

  return history
    .filter((message) => message && typeof message === "object" && typeof message.role === "string" && typeof message.content === "string")
    .slice(-Math.max(1, limit));
}

async function generateAssistantAnswer({ provider, question, summary, recentMessages, shortlisted, selectedCandidate, filters, deterministicAnswer, allowRetry = true }) {
  if (!Array.isArray(shortlisted) || !shortlisted.length) {
    return { answer: deterministicAnswer, action: "FINAL", prompt: "" };
  }

  const prompt = buildAssistantPrompt({
    question,
    summary,
    recentMessages,
    shortlisted,
    selectedCandidate,
    filters,
    deterministicAnswer
  });

  let answer = "";
  try {
    if (provider === "openai") {
      answer = await requestOpenAiText(prompt);
    } else if (provider === "ollama") {
      answer = await requestOllamaText(prompt);
    } else {
      answer = await requestGeminiText(prompt);
    }
  } catch {
    return { answer: deterministicAnswer, action: "FINAL", prompt };
  }

  const sanitized = sanitizeAssistantText(answer);
  if (!sanitized) {
    return { answer: deterministicAnswer, action: "FINAL", prompt };
  }

  const control = parseAssistantControl(sanitized);
  if (control.action === "RETRIEVE_MORE" && allowRetry) {
    return {
      answer: deterministicAnswer,
      action: "RETRIEVE_MORE",
      reason: control.reason || "",
      prompt
    };
  }

  if (!isAnswerAllowed(sanitized, shortlisted, selectedCandidate)) {
    return { answer: deterministicAnswer, action: "FINAL", prompt };
  }

  return {
    answer: sanitized,
    action: "FINAL",
    prompt
  };
}

function buildAssistantPrompt({ question, summary, recentMessages, shortlisted, selectedCandidate, filters, deterministicAnswer }) {
  return [
    "You are an AI recruiter assistant.",
    "Use the supplied shortlist and session context to answer the recruiter naturally.",
    "Do not invent candidates, contact details, skills, projects, or experience that are not in the shortlist.",
    "If the recruiter names a specific candidate, answer only about that person and do not compare against others.",
    "If the recruiter asks for all details about one person, give a concise profile summary, experience, top skills, and recent projects for that person only.",
    "If the recruiter asks for contact details, return only the contact details for the resolved candidate.",
    "If the recruiter asks for salary, estimate salary only for the resolved candidate or shortlist, never for unrelated candidates.",
    "Never replace a named candidate with the current shortlist or with a different top match.",
    "Stay concise, professional, and decision-oriented.",
    "Keep the answer grounded in the shortlist and the session summary.",
    selectedCandidate?.name
      ? `Selected candidate in memory: ${selectedCandidate.name}.`
      : "No single candidate is locked in memory.",
    selectedCandidate?.topSkills?.length
      ? `Selected candidate's known skills: ${selectedCandidate.topSkills.join(", ")}.`
      : null,
    selectedCandidate?.recentExperience?.length
      ? `Selected candidate's recent experience: ${selectedCandidate.recentExperience.join("; ")}.`
      : null,
    "Session summary:",
    summary || "No summary available.",
    "Recent conversation (last 5 messages):",
    JSON.stringify(recentMessages, null, 2),
    "Current shortlist:",
    JSON.stringify(shortlisted.slice(0, 5).map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      reason: candidate.reason,
      score: candidate.finalScore,
      metadata: candidate.metadata
    })), null, 2),
    "Active filters:",
    JSON.stringify(filters || {}, null, 2),
    "Deterministic answer blueprint:",
    deterministicAnswer,
    "If you need a broader database search before answering, start your reply with exactly: ACTION: RETRIEVE_MORE",
    "Only use RETRIEVE_MORE when the current shortlist is insufficient.",
    `Recruiter question: ${question}`,
    "Return plain text only. Do not return JSON."
  ].filter(Boolean).join("\n\n");
}

async function requestOpenAiText(prompt) {
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const openAiModel = process.env.OPENAI_MODEL || "gpt-5.4-mini";
  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured on the backend.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openAiApiKey}`
    },
    body: JSON.stringify({
      model: openAiModel,
      reasoning: { effort: "low" },
      max_output_tokens: 360,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: "Answer recruiter questions using the provided shortlist and context only. Do not return JSON." }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${await response.text()}`);
  }

  const payload = await response.json();
  return extractOutputText(payload);
}

async function requestGeminiText(prompt) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the backend.");
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: "Answer recruiter questions using the provided shortlist and context only. Do not return JSON." }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 360
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${await response.text()}`);
  }

  const payload = await response.json();
  return extractGeminiText(payload);
}

async function requestOllamaText(prompt) {
  const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const ollamaModel = process.env.OLLAMA_MODEL || "phi3";
  const response = await fetch(`${ollamaUrl}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: ollamaModel,
      system: "Answer recruiter questions using the provided shortlist and context only. Do not return JSON.",
      prompt,
      stream: false
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${await response.text()}`);
  }

  const payload = await response.json();
  return payload.response || "";
}

function sanitizeAssistantText(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  return text
    .replace(/^here is the json requested[:\s-]*/i, "")
    .replace(/^json[:\s-]*/i, "")
    .replace(/^"+|"+$/g, "")
      .trim();
}

function parseAssistantControl(value) {
  const text = String(value || "");
  const actionMatch = text.match(/ACTION:\s*(RETRIEVE_MORE|FINAL)/i);
  if (!actionMatch) {
    return { action: "FINAL", reason: "" };
  }

  const reasonMatch = text.match(/(?:REASON|Reason|reason):\s*(.+)$/im);
  return {
    action: actionMatch[1].toUpperCase(),
    reason: reasonMatch ? reasonMatch[1].trim() : ""
  };
}

function isAnswerAllowed(answer, shortlisted, selectedCandidate) {
  const shortlistedNames = new Set((Array.isArray(shortlisted) ? shortlisted : []).map((candidate) => String(candidate.name || "").toLowerCase()));
  if (selectedCandidate?.name) {
    shortlistedNames.add(String(selectedCandidate.name).toLowerCase());
  }

  if (!shortlistedNames.size) {
    return true;
  }

  const answerText = String(answer || "").toLowerCase();
  const rememberedNames = [...shortlistedNames].filter((name) => answerText.includes(name));
  if (rememberedNames.length) {
    return true;
  }

  const namedEntities = extractCandidateLikeNames(answer);
  if (!namedEntities.length) {
    return answerText.includes("current shortlist") || answerText.includes("selected candidate");
  }

  const allowedTokens = new Set();
  shortlistedNames.forEach((name) => {
    allowedTokens.add(name);
  });

  return namedEntities.every((entity) => allowedTokens.has(entity.toLowerCase()));
}

function findExactCandidateByName(allCandidates, exactName) {
  const target = normalizeLookupName(exactName);
  if (!target) {
    return null;
  }

  return (Array.isArray(allCandidates) ? allCandidates : []).find((candidate) => {
    const candidateName = normalizeLookupName(candidate?.name);
    return candidateName === target;
  }) || null;
}

function resolveExactCandidateFromQuestion(question, exactName, allCandidates) {
  const directCandidate = findExactCandidateByName(allCandidates, exactName);
  if (directCandidate) {
    return directCandidate;
  }

  const normalizedQuestion = normalizeLookupName(question);
  if (!normalizedQuestion) {
    return null;
  }

  const candidates = [...(Array.isArray(allCandidates) ? allCandidates : [])]
    .map((candidate) => ({
      candidate,
      name: normalizeLookupName(candidate?.name)
    }))
    .filter((entry) => entry.name && entry.name.length >= 6)
    .sort((left, right) => right.name.length - left.name.length);

  for (const entry of candidates) {
    const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(entry.name)}(?:\\s|$)`);
    if (pattern.test(normalizedQuestion) || normalizedQuestion.includes(entry.name)) {
      return entry.candidate;
    }
  }

  return null;
}

function buildExactNameAnswer(candidate, exactName, parsed, question) {
  if (!candidate) {
    return {
      answer: `No, we do not have ${exactName} in the database.`,
      confidence: 98
    };
  }

  const profile = candidate.structuredData || candidate.parsedData || {};
  const answerParts = [`Yes, we do have ${candidate.name} in the database.`];
  if (profile.summary) {
    answerParts.push(`Summary: ${profile.summary}`);
  }

  const years = round(getCandidateExperience(profile));
  if (years) {
    answerParts.push(`Experience: ${years} years`);
  }

  const skills = (profile.skills || []).map((skill) => skill.name).filter(Boolean).slice(0, 6);
  if (skills.length) {
    answerParts.push(`Top skills: ${joinList(skills)}`);
  }

  const projects = (profile.projects || []).slice(0, 2).map((project) => {
    const techStack = Array.isArray(project.techStack) && project.techStack.length ? ` (${project.techStack.join(", ")})` : "";
    return `${project.name}${techStack}${project.description ? ` - ${project.description}` : ""}`;
  }).filter(Boolean);
  if (projects.length) {
    answerParts.push(`Projects: ${projects.join("; ")}`);
  }

  const contact = profile.contactDetails || {};
  const contactParts = [contact.email, contact.phone].filter(Boolean);
  if (parsed?.contact && contactParts.length) {
    answerParts.push(`Contact: ${contactParts.join(" | ")}`);
  }

  if (/detail|details|about|profile|summary|experience|project|worked on/i.test(String(question || "")) && contactParts.length && !parsed?.contact) {
    answerParts.push(`Contact details are available if needed.`);
  }

  return {
    answer: answerParts.join("\n"),
    confidence: 98
  };
}

function buildExactNameSummary(previousSummary, question, exactName, candidate) {
  const parts = [];
  if (previousSummary) {
    parts.push(String(previousSummary).trim().replace(/\s+/g, " "));
  }
  parts.push(`Exact name lookup: ${exactName}.`);
  if (candidate?.name) {
    parts.push(`Selected candidate: ${candidate.name}.`);
  } else {
    parts.push("Candidate not found in the database.");
  }
  parts.push(`Latest question: ${question}.`);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function normalizeLookupName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exposeExactMatchedCandidate(candidate) {
  return {
    id: candidate._id.toString(),
    name: candidate.name,
    structuredData: candidate.structuredData,
    metadata: candidate.metadata,
    resumeScore: candidate.resumeScore,
    skillGapAnalysis: candidate.skillGapAnalysis || [],
    suggestedImprovements: candidate.suggestedImprovements || []
  };
}

function extractCandidateLikeNames(answer) {
  const text = String(answer || "");
  const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g);
  if (!matches) {
    return [];
  }

  return [...new Set(matches.map((match) => match.trim()))];
}

function buildSessionSummary(previousSummary, question, filters, shortlisted, selectedCandidate, parsed, session) {
  const focusParts = [];
  if (filters.role) {
    focusParts.push(`${filters.role} role`);
  }
  if (Array.isArray(filters.skills) && filters.skills.length) {
    focusParts.push(`${filters.skills.join(" and ")} skills`);
  }
  if (Number(filters.experience || 0) > 0) {
    focusParts.push(`${filters.experience}+ years experience`);
  }
  if (filters.location) {
    focusParts.push(`location ${filters.location}`);
  }

  const shortlistNames = shortlisted.slice(0, 5).map((candidate) => candidate.name).filter(Boolean);
  const shortlistDetails = shortlisted.slice(0, 3).map((candidate) => {
    const years = round(getCandidateExperience(candidate.parsedData || {}));
    const skills = (candidate.parsedData?.skills || []).slice(0, 4).map((skill) => skill.name).filter(Boolean);
    const detailParts = [`${candidate.name}`];
    if (years) {
      detailParts.push(`${years} years`);
    }
    if (skills.length) {
      detailParts.push(joinList(skills));
    }
    return detailParts.join(" - ");
  }).filter(Boolean);
  const summaryParts = [];

  if (focusParts.length) {
    summaryParts.push(`User is hiring for ${joinList(focusParts)}.`);
  } else if (previousSummary) {
    summaryParts.push(String(previousSummary).trim().replace(/\s+/g, " "));
  }

  if (selectedCandidate?.name) {
    summaryParts.push(`Selected candidate: ${selectedCandidate.name}.`);
  }

  if (shortlistNames.length) {
    summaryParts.push(`Current shortlist: ${joinList(shortlistDetails.length ? shortlistDetails : shortlistNames)}.`);
  }

  summaryParts.push(`Last intent: ${parsed?.intent || "general"}.`);
  if (session?.activeRole) {
    summaryParts.push(`Active role: ${session.activeRole}.`);
  }
  summaryParts.push(`Latest question: ${question}.`);

  const currentSummary = summaryParts.join(" ").replace(/\s+/g, " ").trim();
  if (previousSummary && previousSummary.trim() && previousSummary !== currentSummary) {
    const combined = `${currentSummary} | Prior context: ${previousSummary}`;
    return combined.slice(0, 700).trim();
  }
  return currentSummary;
}

function buildRetrievalEvaluation({ question, parsed, filters, ranked, k = 5 }) {
  const topK = ranked.slice(0, Math.max(1, k));
  const judged = topK.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    score: candidate.finalScore,
    relevant: isRelevantRetrievalHit(candidate, parsed, filters)
  }));
  const relevantCount = judged.filter((candidate) => candidate.relevant).length;
  const precisionAtK = relevantCount / Math.max(1, topK.length);

  return {
    query: question,
    k: topK.length,
    precisionAtK: round(precisionAtK),
    relevantCount,
    retrievedCandidates: judged
  };
}

function isRelevantRetrievalHit(candidate, parsed, filters) {
  if (!candidate) {
    return false;
  }

  const candidateSkills = getCandidateSkills(candidate.parsedData || {});
  const candidateExperience = getCandidateExperience(candidate.parsedData || {});
  const candidateLocation = String(candidate.metadata?.location || candidate.parsedData?.location || "").toLowerCase();
  const candidateRole = String(candidate.metadata?.role || "").toLowerCase();
  const requestedSkills = Array.isArray(filters?.skills) ? filters.skills : [];
  const requestedRole = String(filters?.role || "").toLowerCase();
  const requestedLocation = String(filters?.location || "").toLowerCase();
  const requestedExperience = Number(filters?.experience || 0);

  if (requestedRole && (candidateRole.includes(requestedRole) || String(candidate.parsedData?.summary || "").toLowerCase().includes(requestedRole))) {
    return true;
  }

  if (requestedLocation && candidateLocation.includes(requestedLocation)) {
    return true;
  }

  if (requestedExperience > 0 && candidateExperience >= requestedExperience) {
    return true;
  }

  if (requestedSkills.length) {
    return requestedSkills.some((skill) => candidateSkills.some((candidateSkill) => candidateSkill.toLowerCase().includes(skill.toLowerCase())));
  }

  const inferredRole = String(parsed?.role || "").toLowerCase();
  if (inferredRole && (candidateRole.includes(inferredRole) || String(candidate.parsedData?.summary || "").toLowerCase().includes(inferredRole))) {
    return true;
  }

  return candidate.finalScore >= 0.5;
}

async function recordRetrievalEvaluation(collection, payload) {
  try {
    await collection.insertOne({
      sessionId: payload.sessionId,
      userId: payload.userId,
      query: payload.question,
      filters: payload.filters,
      intent: payload.parsed.intent,
      precisionAtK: payload.evaluation.precisionAtK,
      k: payload.evaluation.k,
      retrievedCandidates: payload.evaluation.retrievedCandidates,
      createdAt: new Date()
    });
  } catch {
    // best effort logging only
  }
}

function buildProjectAnswer(shortlisted, selectedCandidate, parsed, question) {
  const pluralMode = Boolean(parsed?.pluralReference) || (parsed?.followUp && !parsed?.singularReference && shortlisted.length > 1);
  if (pluralMode) {
    const lines = shortlisted.slice(0, 3).map((candidate, index) => {
      const projects = Array.isArray(candidate.parsedData?.projects) ? candidate.parsedData.projects.slice(0, 2) : [];
      const projectSummary = projects.length
        ? projects.map((project) => `${project.name} (${Array.isArray(project.techStack) && project.techStack.length ? project.techStack.join(", ") : "relevant technologies"})`).join("; ")
        : "No clear project details are available";
      return `${index + 1}. ${candidate.name} - ${projectSummary}`;
    });

    return {
      answer: `Here are the relevant projects for the current shortlist:\n${lines.join("\n")}`,
      confidence: 86
    };
  }

  const target = resolveTargetCandidate(shortlisted, selectedCandidate) || shortlisted[0];
  if (!target) {
    return {
      answer: "This information is not clearly available in the provided resumes.",
      confidence: 28
    };
  }

  const projects = target.parsedData?.projects || [];
  if (!projects.length) {
    return {
      answer: `No clear project details are available for ${target.name} in the provided resumes.`,
      confidence: 48
    };
  }

  const lines = projects.slice(0, 3).map((project, index) => {
    const stack = Array.isArray(project.techStack) && project.techStack.length ? project.techStack.join(", ") : "relevant technologies";
    return `${index + 1}. ${project.name} - ${project.description} Technologies: ${stack}.`;
  });

  return {
    answer: `${target.name}'s key projects:\n${lines.join("\n")}`,
    confidence: 88
  };
}

function buildContactAnswer(shortlisted, selectedCandidate, parsed, question) {
  const pluralMode = Boolean(parsed?.pluralReference) || (parsed?.followUp && !parsed?.singularReference && shortlisted.length > 1);
  if (pluralMode) {
    const lines = shortlisted.slice(0, 3).map((candidate, index) => {
      const contact = candidate.parsedData?.contactDetails || {};
      const parts = [contact.email, contact.phone].filter(Boolean);
      return parts.length ? `${index + 1}. ${candidate.name} — ${parts.join(" | ")}` : `${index + 1}. ${candidate.name}`;
    });

    return {
      answer: `Here are the contact details for the current shortlist:\n${lines.join("\n")}`,
      confidence: 88
    };
  }

  const target = resolveTargetCandidate(shortlisted, selectedCandidate) || shortlisted[0];
  if (!target) {
    return {
      answer: "No matching candidate is available right now.",
      confidence: 28
    };
  }

  const contact = target.parsedData?.contactDetails || {};
  const parts = [];
  if (contact.email) parts.push(contact.email);
  if (contact.phone) parts.push(contact.phone);
  if (!parts.length) {
    return {
      answer: `${target.name}: contact details are not clearly available in the provided resumes.`,
      confidence: 48
    };
  }

  return {
    answer: `${target.name} — ${parts.join(" | ")}`,
    confidence: 92
  };
}

function buildSalaryAnswer(shortlisted, selectedCandidate, session, parsed, question) {
  const pluralMode = Boolean(parsed?.pluralReference) || /\b(both|both of them|these two|those two)\b/i.test(String(question || "").toLowerCase());
  const activeShortlist = pluralMode ? shortlisted.slice(0, 5) : shortlisted;

  if (pluralMode && activeShortlist.length > 1) {
    const lines = activeShortlist.map((candidate, index) => {
      const years = getCandidateExperience(candidate?.structuredData || candidate?.parsedData || {});
      let min = 4;
      let max = 7;
      if (years >= 2) {
        min = 6;
        max = 10;
      }
      if (years >= 4) {
        min = 10;
        max = 16;
      }
      if (years >= 7) {
        min = 15;
        max = 24;
      }
      return `${index + 1}. ${candidate.name}: estimated market range ${min}-${max} LPA based on roughly ${round(years)} years of experience and visible skill depth.`;
    });

    return {
      answer: lines.join("\n"),
      confidence: 86
    };
  }

  const target = resolveTargetCandidate(activeShortlist, selectedCandidate) || activeShortlist[0] || shortlisted[0];
  const years = getCandidateExperience(target?.parsedData || {});
  let min = 4;
  let max = 7;
  if (years >= 2) {
    min = 6;
    max = 10;
  }
  if (years >= 4) {
    min = 10;
    max = 16;
  }
  if (years >= 7) {
    min = 15;
    max = 24;
  }
    return {
    answer: `${target?.name || shortlisted[0].name}: estimated market range ${min}-${max} LPA based on roughly ${round(years)} years of experience and visible skill depth.`,
    confidence: 88
  };
}

function formatContactLine(candidate) {
  if (!candidate) {
    return "No matching candidate is available right now.";
  }

  const contact = candidate.parsedData?.contactDetails || {};
  const parts = [contact.email, contact.phone].filter(Boolean);
  if (!parts.length) {
    return candidate.name;
  }
  return `${candidate.name} — ${parts.join(" | ")}`;
}

function toSelectedCandidate(candidate) {
  if (!candidate) return null;
  const profile = candidate.parsedData || candidate.structuredData || {};
  return {
    id: candidate.id,
    name: candidate.name,
    metadata: candidate.metadata || {},
    topSkills: (profile.skills || []).slice(0, 8).map((s) => s.name).filter(Boolean),
    recentExperience: (profile.experience || []).slice(0, 2).map((e) => `${e.role}${e.company ? ` at ${e.company}` : ""}`).filter(Boolean),
    contactDetails: profile.contactDetails || {}
  };
}

function resolveTargetCandidate(shortlisted, selectedCandidate) {
  if (!selectedCandidate) {
    return shortlisted[0] || null;
  }

  const resolved = shortlisted.find((candidate) => candidate.id === selectedCandidate.id || candidate.name === selectedCandidate.name);
  return resolved || shortlisted[0] || null;
}

function exposeRankedCandidate(candidate) {
  return {
    id: candidate.id,
    name: candidate.name,
    structuredData: candidate.parsedData,
    metadata: candidate.metadata,
    resumeScore: candidate.resumeScore,
    skillGapAnalysis: candidate.skillGapAnalysis,
    suggestedImprovements: candidate.suggestedImprovements,
    retrieval: {
      score: candidate.finalScore,
      reason: candidate.reason,
      vectorScore: candidate.vectorScore,
      experienceMatch: candidate.experienceMatch,
      skillMatch: candidate.skillMatch,
      topChunks: candidate.retrieval?.topChunks || []
    }
  };
}

function scopeCandidatesToSession(pool, session, parsed) {
  const shortlist = getSessionShortlist(session);

  if (parsed.exclusion && shortlist.length) {
    const excludedIds = new Set(shortlist.map((candidate) => candidate.id));
    return pool.filter((candidate) => !excludedIds.has(candidate.id));
  }

  if (parsed.shortlistReference && shortlist.length) {
    const lastIds = shortlist.map((candidate) => candidate.id);
    return pool.filter((candidate) => lastIds.includes(candidate.id));
  }

  if (parsed.pluralReference && shortlist.length && !parsed.comparison) {
    const lastIds = shortlist.map((candidate) => candidate.id);
    return pool.filter((candidate) => lastIds.includes(candidate.id));
  }

  if (parsed.singularReference && session.selectedCandidate && !parsed.comparison) {
    const filtered = pool.filter((candidate) => candidate.id === session.selectedCandidate.id || candidate.name === session.selectedCandidate.name);
    return filtered.length ? filtered : pool;
  }

  if (parsed.followUp && session.selectedCandidate && !parsed.comparison) {
    const filtered = pool.filter((candidate) => candidate.id === session.selectedCandidate.id || candidate.name === session.selectedCandidate.name);
    return filtered.length ? filtered : pool;
  }

  if (parsed.comparison && shortlist.length) {
    const lastIds = shortlist.map((candidate) => candidate.id);
    return pool.filter((candidate) => lastIds.includes(candidate.id));
  }

  return pool;
}

function buildHydeQueryText(question, filters = {}, session = {}, parsed = {}) {
  const parts = [];
  const role = String(filters.role || parsed.role || "").trim();
  const skills = Array.isArray(filters.skills) ? filters.skills : [];
  const experienceRange = filters.experienceRange || null;
  const minExperience = Number(filters.experience || parsed.experience || 0);
  const locations = Array.isArray(filters.locations) ? filters.locations : [];
  const location = filters.location || parsed.location || "";
  const intentLabel = buildHydeIntentLabel(parsed);

  if (intentLabel) {
    parts.push(`Retrieval intent: ${intentLabel}.`);
  }

  if (parsed.searchAgain && session?.searchContext) {
    parts.push("Reuse the previously found shortlist and search context, but re-evaluate with the current hard filters.");
  }

  if (role) {
    parts.push(`Primary role signal: ${role}.`);
  }

  if (skills.length) {
    parts.push(`Semantic skills to preserve: ${joinList(skills)}.`);
  }

  if (experienceRange?.min || experienceRange?.max) {
    const minText = Number.isFinite(Number(experienceRange.min)) ? Number(experienceRange.min) : "";
    const maxText = Number.isFinite(Number(experienceRange.max)) ? Number(experienceRange.max) : "";
    parts.push(`Hard experience filter: ${minText} to ${maxText} years.`);
  } else if (minExperience > 0) {
    parts.push(`Hard experience filter: ${minExperience}+ years experience.`);
  }

  if (locations.length) {
    parts.push(`Hard location filter: ${joinList(locations)}.`);
  } else if (location) {
    parts.push(`Hard location filter: ${location}.`);
  }

  if (parsed.pluralReference || parsed.availability) {
    parts.push("Return a shortlist of multiple matching candidates, not a single profile, unless the user explicitly requested one.");
  }

  if (parsed.explicitSingle || parsed.contact || parsed.project || parsed.salary) {
    parts.push("Return a single candidate focus for this query.");
  }

  if (session?.summary) {
    parts.push(String(session.summary).trim());
  }

  parts.push(`Canonical recruiter query: ${question}.`);
  return parts.filter(Boolean).join(" ");
}

function buildHydeIntentLabel(parsed = {}) {
  if (parsed.intent === "exact_name" || parsed.exactNameQuery) return "Exact name lookup";
  if (parsed.exclusion) return "Find alternatives outside the current shortlist";
  if (parsed.comparison) return "Compare candidates in the current shortlist";
  if (parsed.salary) return "Salary estimation for the selected candidate";
  if (parsed.contact) return "Contact details for a candidate";
  if (parsed.project) return "Project details for the selected candidates";
  if (parsed.intent === "location_analytics") return "Location distribution for matching candidates";
  if (parsed.intent === "location_filter_search") return "Shortlist multiple matching candidates with the requested location filter";
  if (parsed.explicitSingle) return "Single best candidate";
  if (parsed.availability || parsed.intent === "candidate_search") return "Shortlist multiple matching candidates";
  return "General candidate retrieval";
}

function buildChatDebugInfo({ question, hydeText, filters, intent, searchAgain, exactName, sessionSummary }) {
  return {
    originalQuery: question,
    hydeQuery: hydeText,
    activeIntent: intent || "general",
    searchAgain: Boolean(searchAgain),
    exactName: exactName || null,
    activeFilters: filters || {},
    sessionSummary: sessionSummary || ""
  };
}

export function resolveIntentHandlerName(parsed = {}) {
  return INTENT_HANDLERS[parsed.intent] || INTENT_HANDLERS.general;
}

function buildOptionalDiagnostics({ debug, evaluation }) {
  if (!isDebugMode()) {
    return {};
  }

  return {
    debug: debug || null,
    evaluation: evaluation || null
  };
}

function isDebugMode() {
  return String(process.env.DEBUG_MODE || "").toLowerCase() === "true";
}

function determineEmbeddingMode(candidates) {
  const successfulCandidates = (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate.embeddingStatus === "success");
  const providers = new Set(successfulCandidates.map((candidate) => candidate.embeddingProvider || candidate.semanticProfile?.provider || "unknown"));
  if (providers.size !== 1) {
    return "mixed";
  }
  return [...providers][0].startsWith("gemini") ? "gemini" : "local";
}

async function buildQueryEmbedding(question, mode, hydeText = "") {
  const primaryVector = await embedSingleQueryEmbedding(question, mode, "query");
  const hydeVector = hydeText && hydeText.trim() ? await embedSingleQueryEmbedding(hydeText, mode, "hyde") : [];
  if (!hydeVector.length) {
    return primaryVector;
  }
  if (!primaryVector.length) {
    return hydeVector;
  }
  return averageVectors([primaryVector, hydeVector]);
}

async function embedSingleQueryEmbedding(text, mode, suffix = "query") {
  if (mode !== "gemini") {
    return embedText(text);
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  const geminiEmbeddingModel = process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004";
  if (!geminiApiKey) {
    throw new Error("Query embedding failed because GEMINI_API_KEY is not configured.");
  }

  const cacheKey = `${geminiEmbeddingModel}:${suffix}:${String(text || "").trim()}`;
  if (EMBEDDING_CACHE.has(cacheKey)) {
    return EMBEDDING_CACHE.get(cacheKey);
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiEmbeddingModel}:embedContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey
      },
      body: JSON.stringify({
        model: `models/${geminiEmbeddingModel}`,
        taskType: "RETRIEVAL_QUERY",
        content: {
          parts: [{ text: String(text || "").trim() }]
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini query embedding request failed: ${await response.text()}`);
    }

    const payload = await response.json();
    const vector = Array.isArray(payload.embedding?.values) ? payload.embedding.values : [];
    if (!vector.length) {
      throw new Error("Gemini query embedding response did not include a vector.");
    }
    setCachedEmbedding(cacheKey, vector);
    return vector;
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error("Query embedding failed unexpectedly.");
  }
}

function getCandidateSkills(parsedData) {
  return (parsedData.skills || []).map((skill) => skill.name);
}

function getCandidateExperience(parsedData) {
  return (parsedData.experience || []).reduce((sum, entry) => sum + (Number(entry.duration_years) || 0), 0);
}

function computeConfidence({ answer, shortlisted, parsed, selectedCandidate, filters }) {
  if (/not clearly available/i.test(answer)) {
    return 28;
  }

  const topScore = shortlisted[0]?.finalScore || 0.5;
  const filterStrength = Object.keys(filters || {}).length;
  const base = 60 + (topScore * 30) + (Math.min(filterStrength, 4) * 2);
  return clamp(Math.round(base), 35, 98);
}

function trimHistory(history) {
  return history.slice(-MAX_SESSION_HISTORY);
}

export function __setRagServiceTestDeps(overrides = {}) {
  if (typeof overrides.getCollections === "function") {
    getCollections = overrides.getCollections;
  }
  if (typeof overrides.getSession === "function") {
    getSession = overrides.getSession;
  }
  if (typeof overrides.updateSession === "function") {
    updateSession = overrides.updateSession;
  }
}

export function __resetRagServiceTestDeps() {
  getCollections = importedGetCollections;
  getSession = importedGetSession;
  updateSession = importedUpdateSession;
}

function normalizeSessionId(sessionId) {
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : new ObjectId().toString();
}

function normalizeScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  if (numeric <= 1) return clamp(numeric, 0, 1);
  if (numeric <= 10) return clamp(numeric / 10, 0, 1);
  return clamp(numeric / 100, 0, 1);
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function averageVectors(vectors) {
  const validVectors = (Array.isArray(vectors) ? vectors : []).filter((vector) => Array.isArray(vector) && vector.length);
  if (!validVectors.length) {
    return [];
  }

  const size = Math.max(...validVectors.map((vector) => vector.length));
  const averaged = new Array(size).fill(0);
  for (const vector of validVectors) {
    for (let index = 0; index < size; index += 1) {
      averaged[index] += Number(vector[index] || 0);
    }
  }

  return averaged.map((value) => value / validVectors.length);
}

function buildMongoPreFilter(filters) {
  const match = {};
  if (filters.role) {
    match["metadata.role"] = filters.role;
  }
  if (filters.location) {
    match["metadata.location"] = { $regex: filters.location, $options: "i" };
  }
  return match;
}

function getScoringWeights(parsed, filters) {
  if (
    parsed.intent === "location_filter_search"
    || (Array.isArray(filters.locations) && filters.locations.length > 0)
  ) {
    return { vector: 0.45, experience: 0.15, skill: 0.40 };
  }
  if (Array.isArray(filters.skills) && filters.skills.length >= 2) {
    return { vector: 0.50, experience: 0.15, skill: 0.35 };
  }
  if (Number(filters.experience || 0) > 0 || filters.experienceRange) {
    return { vector: 0.50, experience: 0.40, skill: 0.10 };
  }
  return { vector: 0.70, experience: 0.20, skill: 0.10 };
}

function setCachedEmbedding(key, value) {
  if (EMBEDDING_CACHE.size >= EMBEDDING_CACHE_MAX_SIZE) {
    const firstKey = EMBEDDING_CACHE.keys().next().value;
    EMBEDDING_CACHE.delete(firstKey);
  }
  EMBEDDING_CACHE.set(key, value);
}

function joinList(items) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!values.length) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}
