import { ObjectId } from "mongodb";
import { keywordFallbackRanking, rankResumesByQuery } from "./embeddings.js";
import { getAllCandidateDocuments, convertCandidateDocumentForRetrieval, exposeMatchedCandidate } from "./candidate-service.js";
const MAX_HISTORY_MESSAGES = 6;

const sessions = new Map();
const embeddingCache = new Map();

export async function answerRecruiterQuestion({ recruiter, question, sessionId }) {
  const chatProvider = process.env.CHAT_PROVIDER || "gemini";
  const candidateDocs = await getAllCandidateDocuments();
  if (!candidateDocs.length) {
    throw new Error("No candidate profiles are available yet.");
  }

  const activeSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : new ObjectId().toString();
  const session = getOrCreateSession(recruiter.id, activeSessionId);
  const candidatePool = candidateDocs.map(convertCandidateDocumentForRetrieval);
  const retrievalQuestion = buildRetrievalQuery(question, session.memory || {});
  const retrieval = await retrieveTopMatches(candidatePool, retrievalQuestion, Math.min(5, candidatePool.length));
  const matchedResumes = retrieval.matches.map((resume) => ({
    id: resume.id,
    name: resume.name,
    parsedData: resume.structuredData,
    metadata: resume.metadata,
    retrieval: resume.retrieval,
    resumeScore: resume.resumeScore,
    skillGapAnalysis: resume.skillGapAnalysis,
    suggestedImprovements: resume.suggestedImprovements
  }));

  const updatedMemory = updateSessionMemory(session.memory, question, matchedResumes);
  const singleCandidateIntent = shouldReduceToSingleCandidate(question);
  const contextualResumes = limitForIntent(selectContextualResumes(matchedResumes, updatedMemory, question), singleCandidateIntent);
  const directDecisionAnswer = answerFromDecisionMemory(question, updatedMemory);
  const directSingleCandidateAnswer = answerFromSingleCandidateIntent(question, contextualResumes, updatedMemory, singleCandidateIntent);

  if (directDecisionAnswer) {
    appendHistory(session.history, { role: "user", content: question });
    appendHistory(session.history, { role: "assistant", content: directDecisionAnswer.answer });
    session.memory = finalizeSessionMemory(updatedMemory, matchedResumes, question, directDecisionAnswer.answer);
    return {
      sessionId: activeSessionId,
      answer: directDecisionAnswer.answer,
      confidence: directDecisionAnswer.confidence,
      decisionMemory: projectDecisionMemory(session.memory),
      matchedCandidates: matchedResumes.map(exposeMatchedCandidate),
      totalCandidates: candidateDocs.length
    };
  }

  if (directSingleCandidateAnswer) {
    appendHistory(session.history, { role: "user", content: question });
    appendHistory(session.history, { role: "assistant", content: directSingleCandidateAnswer.answer });
    session.memory = finalizeSessionMemory(updatedMemory, contextualResumes, question, directSingleCandidateAnswer.answer);
    return {
      sessionId: activeSessionId,
      answer: directSingleCandidateAnswer.answer,
      confidence: directSingleCandidateAnswer.confidence,
      decisionMemory: projectDecisionMemory(session.memory),
      matchedCandidates: matchedResumes.map(exposeMatchedCandidate),
      totalCandidates: candidateDocs.length
    };
  }

  const parsed = chatProvider === "ollama"
    ? await requestOllamaAnswer(question, contextualResumes, retrieval, session, updatedMemory)
    : chatProvider === "openai"
      ? await requestOpenAiAnswer(question, contextualResumes, retrieval, session, updatedMemory)
      : await requestGeminiAnswer(question, contextualResumes, retrieval, session, updatedMemory);

  const normalizedParsed = applyHeuristicFallback(question, contextualResumes, parsed, updatedMemory);
  appendHistory(session.history, { role: "user", content: question });
  appendHistory(session.history, { role: "assistant", content: sanitizeAnswer(normalizedParsed.answer) });
  session.memory = finalizeSessionMemory(updatedMemory, contextualResumes, question, normalizedParsed.answer);

  return {
    sessionId: activeSessionId,
    answer: sanitizeAnswer(normalizedParsed.answer),
    confidence: computeResponseConfidence(question, matchedResumes, normalizedParsed.answer, normalizedParsed.confidence),
    decisionMemory: projectDecisionMemory(session.memory),
    matchedCandidates: matchedResumes.map(exposeMatchedCandidate),
    totalCandidates: candidateDocs.length
  };
}

async function retrieveTopMatches(candidates, question, limit) {
  const geminiEmbeddingModel = process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004";
  try {
    const [queryEmbedding] = await embedTextsWithGemini([question], "RETRIEVAL_QUERY");
    return rankResumesByQuery(candidates, question, limit, { queryEmbedding });
  } catch {
    return keywordFallbackRanking(candidates, question, limit);
  }
}

async function embedTextsWithGemini(texts, taskType) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const geminiEmbeddingModel = process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004";
  const embeddings = [];
  for (const text of texts) {
    const normalizedText = String(text || "").trim();
    const cacheKey = `${geminiEmbeddingModel}:${taskType}:${normalizedText}`;
    if (embeddingCache.has(cacheKey)) {
      embeddings.push(embeddingCache.get(cacheKey));
      continue;
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiEmbeddingModel}:embedContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey
      },
      body: JSON.stringify({
        model: `models/${geminiEmbeddingModel}`,
        taskType,
        content: {
          parts: [{ text: normalizedText }]
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini embedding request failed: ${await response.text()}`);
    }

    const payload = await response.json();
    const vector = payload.embedding?.values;
    if (!Array.isArray(vector) || !vector.length) {
      throw new Error("Gemini embedding response did not include a vector.");
    }

    embeddingCache.set(cacheKey, vector);
    embeddings.push(vector);
  }
  return embeddings;
}

async function requestOpenAiAnswer(question, resumes, retrieval, session, memory) {
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const openAiModel = process.env.OPENAI_MODEL || "gpt-5.4-mini";
  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured on the backend.");
  }

  const prompt = buildUserPrompt(question, resumes, retrieval, session, memory);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openAiApiKey}`
    },
    body: JSON.stringify({
      model: openAiModel,
      reasoning: { effort: "low" },
      max_output_tokens: 420,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: recruiterSystemPrompt() }]
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
  return {
    answer: extractOutputText(payload),
    confidence: 72
  };
}

async function requestOllamaAnswer(question, resumes, retrieval, session, memory) {
  const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const ollamaModel = process.env.OLLAMA_MODEL || "phi3";
  const prompt = buildUserPrompt(question, resumes, retrieval, session, memory);
  const response = await fetch(`${ollamaUrl}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: ollamaModel,
      system: recruiterSystemPrompt(),
      prompt,
      stream: false
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${await response.text()}`);
  }

  const payload = await response.json();
  return {
    answer: payload.response || "",
    confidence: 68
  };
}

async function requestGeminiAnswer(question, resumes, retrieval, session, memory) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the backend.");
  }

  const prompt = buildUserPrompt(question, resumes, retrieval, session, memory);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: recruiterSystemPrompt() }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 420
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${await response.text()}`);
  }

  const payload = await response.json();
  return {
    answer: extractGeminiText(payload),
    confidence: 72
  };
}

function recruiterSystemPrompt() {
  return [
    "You are an AI assistant helping recruiters evaluate candidates.",
    "Be clear, direct, and professional.",
    "Avoid vague language like maybe, appears, somewhat, or possibly unless uncertainty is genuinely unavoidable.",
    "Focus on the question and answer only what is asked.",
    "Use provided context carefully.",
    "If a specific candidate is referenced explicitly or implicitly, answer only about that candidate.",
    "Handle follow-up questions naturally and resolve references like he, she, they, or that candidate using conversation context.",
    "Provide practical, decision-oriented responses and prefer clear conclusions over generic descriptions.",
    "If exact data is missing, make reasonable inferences based on skills, experience, projects, and typical market expectations.",
    "Keep responses concise but complete.",
    "Never return JSON or raw structured data.",
    "Always respond in natural language.",
    "Do not include phrases like 'Here is the JSON' or 'Based on the provided data'.",
    "Use the provided resume data as your factual base, but you may combine it with reasonable industry knowledge and hiring expectations.",
    "If one candidate is provided, answer directly.",
    "If multiple candidates are provided, compare them clearly, mention strengths and gaps, and recommend the best fit when appropriate.",
    "If the question is about suitability, level, salary, or hiring expectations, include a short line starting with 'Market Insight:'.",
    "For salary questions, always provide a realistic salary range based on years of experience, skills, and likely role level.",
    "For project questions, summarize in short bullet-style lines covering project purpose and technologies used.",
    "Maintain consistency with prior context and do not contradict earlier decisions unless explicitly asked to re-evaluate.",
    "Tone: professional, concise, and decision-focused."
  ].join(" ");
}

function buildUserPrompt(question, resumes, retrieval, session, memory) {
  const recentHistory = session.history.slice(-5);
  const decisionInstruction = buildDecisionInstruction(memory, question);
  const targetCandidate = determineTargetCandidate(memory, question);
  return [
    `Candidate count: ${resumes.length}`,
    resumes.length > 1
      ? "Multiple candidates are provided. Compare them where relevant and recommend the best fit if the question implies a choice."
      : "A single candidate is provided. Answer directly from that resume and use reasonable market inference when useful.",
    decisionInstruction,
    targetCandidate
      ? `Target candidate for this question: ${targetCandidate}. Answer only about this candidate unless the recruiter explicitly asks for a comparison.`
      : "No single target candidate is locked for this question unless comparison is requested.",
    "Context:",
    JSON.stringify({
      selectedCandidates: memory.selectedCandidates,
      lastComparedCandidates: memory.lastComparedCandidates,
      role: memory.role,
      focusSkill: memory.focusSkill,
      lastIntent: memory.lastIntent,
      decision: memory.decision
    }, null, 2),
    "Recent conversation:",
    JSON.stringify(recentHistory, null, 2),
    "Top semantic matches selected for reasoning:",
    JSON.stringify(retrieval.matches.map((resume) => ({
      name: resume.name,
      score: resume.retrieval.score,
      topChunks: resume.retrieval.topChunks
    })), null, 2),
    "Resume JSON:",
    JSON.stringify(resumes, null, 2),
    `Recruiter question: ${question}`,
    "Answer in plain text only.",
    "Do not return JSON.",
    "Keep the answer short, direct, and recruiter-friendly."
  ].join("\n\n");
}

function extractOutputText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const values = [];
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") {
        values.push(content.text);
      }
    }
  }
  return values.join("\n").trim();
}

function extractGeminiText(payload) {
  return (payload.candidates?.[0]?.content?.parts ?? [])
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("\n")
    .trim();
}

function sanitizeAnswer(answer) {
  if (typeof answer !== "string" || !answer.trim()) {
    return "This information is not clearly available in the provided resumes.";
  }
  return answer
    .replace(/^here is the json requested[:\s-]*/i, "")
    .replace(/^json[:\s-]*/i, "")
    .replace(/^\{\s*"answer"\s*:\s*/i, "")
    .replace(/"\s*,?\s*"confidence"\s*:\s*\d+\s*\}?$/i, "")
    .replace(/^"+|"+$/g, "")
    .trim() || "This information is not clearly available in the provided resumes.";
}

function normalizeConfidence(confidence) {
  const numeric = Number(confidence);
  if (!Number.isFinite(numeric)) {
    return 50;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function computeResponseConfidence(question, resumes, answer, modelConfidence) {
  if (/this information is not clearly available in the provided resumes/i.test(answer)) {
    return 28;
  }

  const normalizedQuestion = question.toLowerCase();
  const totalSignals = resumes.reduce((sum, resume) => {
    const data = resume.parsedData || {};
    return sum + (data.skills?.length || 0) + (data.projects?.length || 0) + (data.experience?.length || 0);
  }, 0);
  const questionSkillHits = resumes.reduce((sum, resume) => {
    const skills = resume.parsedData?.skills || [];
    return sum + skills.filter((skill) => normalizedQuestion.includes((skill.name || "").toLowerCase())).length;
  }, 0);
  const relevance = clamp(18 + (questionSkillHits * 4), 18, 35);
  const completeness = clamp(answer.split(/\n+/).filter(Boolean).length * 7, 14, 25);
  const availability = clamp(totalSignals * 3, 20, 45);
  const blended = Number.isFinite(Number(modelConfidence)) ? Number(modelConfidence) : 0;
  return normalizeConfidence((availability + relevance + completeness + blended) / (blended ? 1.35 : 1));
}

function applyHeuristicFallback(question, resumes, parsed, memory) {
  const answer = sanitizeAnswer(parsed?.answer || "");
  if (!/this information is not clearly available in the provided resumes/i.test(answer)
    && !looksIncompleteAnswer(answer)
    && isAnswerAlignedWithResumes(answer, resumes, memory, question)) {
    if (isExplicitSingleResponseRequest(question)) {
      return heuristicSingleCandidateSelection(resumes, memory, question);
    }
    return { answer: enforceResponseShape(answer, resumes, question), confidence: parsed?.confidence ?? 55 };
  }

  const normalizedQuestion = question.toLowerCase();
  if (isExplicitSingleResponseRequest(normalizedQuestion)) {
    return heuristicSingleCandidateSelection(resumes, memory, question);
  }
  if (isSingleNameContactRequest(normalizedQuestion)) {
    return heuristicSingleContactDetails(resumes, memory, question);
  }
  if (isAvailabilityQuestion(normalizedQuestion)) {
    return heuristicAvailabilityAnswer(resumes, question, memory);
  }
  if (/(few profiles|profiles|ranking|ranked|shortlist|top candidates|top profiles|boomi developer role|boomi role)/i.test(normalizedQuestion)) {
    return heuristicProfileRanking(resumes, question);
  }
  if (/(why.*(chose|chosen|selected)|why him|why her|why first)/i.test(normalizedQuestion)) {
    return heuristicWhyChosen(resumes);
  }
  if (/(contact|email|phone|mobile|reach|linkedin|github)/i.test(normalizedQuestion)) {
    return heuristicContactDetails(resumes);
  }
  if (/(salary|ctc|compensation|pay range|package)/i.test(normalizedQuestion)) {
    return heuristicSalaryEstimate(resumes, memory, question);
  }
  if (/(backend role|backend|java|spring|microservices|api)/i.test(normalizedQuestion)) {
    return heuristicBackendComparison(resumes);
  }
  if (/(worked on|projects|what they worked on|built)/i.test(normalizedQuestion)) {
    return heuristicProjectSummary(resumes);
  }
  if (/(integration|boomi|etl|soap|edi|workflow)/i.test(normalizedQuestion)) {
    return heuristicIntegrationComparison(resumes);
  }

  return { answer, confidence: 28 };
}

function looksIncompleteAnswer(answer) {
  const normalized = sanitizeAnswer(answer).trim();
  if (!normalized || normalized.length < 45) return true;
  return /(?:due to|because of|based on|with|for|including|such as|consideration:|\*\*|:-?|for a|with a|is an?|has|have)\s*$/i.test(normalized);
}

function selectContextualResumes(resumes, memory, question) {
  if (!Array.isArray(resumes) || !resumes.length) {
    return resumes;
  }

  const normalizedQuestion = String(question || "").toLowerCase();
  if (isComparisonQuestion(normalizedQuestion) || isGlobalSearchQuestion(normalizedQuestion)) {
    return resumes;
  }

  const targetCandidate = determineTargetCandidate(memory, question);
  if (!targetCandidate) {
    return resumes;
  }

  const narrowed = resumes.filter((resume) => resume.name.toLowerCase() === targetCandidate.toLowerCase());
  return narrowed.length ? narrowed : resumes;
}

function determineTargetCandidate(memory, question) {
  const normalizedQuestion = String(question || "").toLowerCase();
  if (isGlobalSearchQuestion(normalizedQuestion)) {
    return null;
  }

  if (/\b(he|his|him|she|her|that candidate|this candidate)\b/i.test(normalizedQuestion) && memory.decision?.selectedCandidate) {
    return memory.decision.selectedCandidate;
  }

  if (Array.isArray(memory.selectedCandidates) && memory.selectedCandidates.length === 1) {
    return memory.selectedCandidates[0];
  }

  if (memory.decision?.selectedCandidate && !/\b(compare|better|best|vs|versus|other candidate)\b/i.test(normalizedQuestion)) {
    return memory.decision.selectedCandidate;
  }

  return null;
}

function heuristicBackendComparison(resumes) {
  const scored = resumes.map((resume) => {
    const skills = resume.parsedData?.skills || [];
    const backendSkills = skills.filter((skill) => ["backend", "database", "tools"].includes(skill.category));
    const score = backendSkills.reduce((sum, skill) => sum + (skill.mentions || 0) + ((skill.experience_years || 0) * 2) + ((skill.projects?.length || 0) * 2), 0);
    return { name: resume.name, score, topSkills: backendSkills.slice(0, 4).map((skill) => skill.name) };
  }).sort((left, right) => right.score - left.score);

  if (!scored.length) return { answer: "This information is not clearly available in the provided resumes.", confidence: 28 };
  if (scored.length === 1) {
    return {
      answer: `${scored[0].name} is suitable for backend work based on ${joinList(scored[0].topSkills)}. Market Insight: backend roles usually expect clear API, database, and delivery experience.`,
      confidence: 68
    };
  }
  return {
    answer: `${scored[0].name} is stronger for a backend role based on ${joinList(scored[0].topSkills)}. ${scored[1].name} also has relevant experience in ${joinList(scored[1].topSkills)}. Market Insight: stronger backend candidates usually show clearer API and service depth across projects.`,
    confidence: 72
  };
}

function heuristicIntegrationComparison(resumes) {
  const scored = resumes.map((resume) => {
    const skills = resume.parsedData?.skills || [];
    const integrationSkills = skills.filter((skill) => ["Integration Development", "Dell Boomi", "ETL", "SOAP", "XML", "EDI", "SAP", "REST APIs"].includes(skill.name));
    const score = integrationSkills.reduce((sum, skill) => sum + (skill.mentions || 0) + ((skill.experience_years || 0) * 2), 0);
    return { name: resume.name, score, topSkills: integrationSkills.slice(0, 5).map((skill) => skill.name) };
  }).sort((left, right) => right.score - left.score);

  if (!scored.length || !scored[0].topSkills.length) {
    return { answer: "This information is not clearly available in the provided resumes.", confidence: 28 };
  }
  if (scored.length === 1) {
    return {
      answer: `${scored[0].name} shows strong integration evidence in ${joinList(scored[0].topSkills)}. Market Insight: strong integration profiles usually show connector, workflow, transformation, and enterprise-system experience.`,
      confidence: 70
    };
  }
  return {
    answer: `${scored[0].name} is stronger for integration development with evidence in ${joinList(scored[0].topSkills)}. ${scored[1].name} has comparatively weaker integration-specific evidence. Market Insight: integration roles usually favor proven platform and system-interop experience.`,
    confidence: 73
  };
}

function heuristicProjectSummary(resumes) {
  const lines = resumes.map((resume) => {
    const projects = resume.parsedData?.projects || [];
    return projects.slice(0, 2).map((project) => `- ${resume.name}: ${project.name} using ${joinList(project.techStack || []) || "relevant technologies"}.`).join("\n");
  }).filter(Boolean);
  return { answer: lines.join("\n") || "This information is not clearly available in the provided resumes.", confidence: 66 };
}

function heuristicSalaryEstimate(resumes, memory, question) {
  const narrowedResumes = selectContextualResumes(resumes, memory || {}, question || "");
  const activeEstimates = (narrowedResumes.length ? narrowedResumes : resumes).map((resume) => {
    const years = (resume.parsedData?.experience || []).reduce((sum, entry) => sum + (entry.duration_years || 0), 0);
    const skillCount = (resume.parsedData?.skills || []).length;
    const strongSignal = (resume.parsedData?.skills || []).some((skill) => ["Java", "Spring Boot", "Microservices", "Integration Development", "Dell Boomi", "Guidewire"].includes(skill.name));
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
    if (strongSignal && skillCount >= 5) {
      min += 1;
      max += 2;
    }
    return `${resume.name}: estimated market range ${min}-${max} LPA based on roughly ${roundOne(years)} years of experience and visible skill depth.`;
  });

  return {
    answer: `${activeEstimates.join(" ")} Market Insight: compensation varies by location, company tier, and hands-on ownership.`,
    confidence: 69
  };
}

function heuristicContactDetails(resumes) {
  const lines = resumes.map((resume) => {
    const contact = resume.parsedData?.contactDetails || {};
    const parts = [
      contact.email ? `email ${contact.email}` : "",
      contact.phone ? `phone ${contact.phone}` : "",
      contact.linkedin ? `LinkedIn ${contact.linkedin}` : "",
      contact.github ? `GitHub ${contact.github}` : ""
    ].filter(Boolean);
    return parts.length ? `${resume.name}: ${parts.join(", ")}.` : "";
  }).filter(Boolean);
  return { answer: lines.join(" ") || "This information is not clearly available in the provided resumes.", confidence: lines.length ? 74 : 28 };
}

function heuristicSingleContactDetails(resumes, memory, question) {
  const targetName = determineTargetCandidate(memory || {}, question || "") || memory?.decision?.selectedCandidate || resumes[0]?.name || null;
  const targetResume = resumes.find((resume) => resume.name.toLowerCase() === String(targetName || "").toLowerCase()) || resumes[0];
  if (!targetResume) {
    return { answer: "This information is not clearly available in the provided resumes.", confidence: 28 };
  }

  const contact = targetResume.parsedData?.contactDetails || {};
  const parts = [
    contact.email ? `email ${contact.email}` : "",
    contact.phone ? `phone ${contact.phone}` : "",
    contact.linkedin ? `LinkedIn ${contact.linkedin}` : "",
    contact.github ? `GitHub ${contact.github}` : ""
  ].filter(Boolean);

  if (!parts.length) {
    return { answer: `The best fit is ${targetResume.name}, but direct contact details are not clearly present in the stored profile.`, confidence: 58 };
  }

  return {
    answer: `${targetResume.name}. ${parts.join(", ")}.`,
    confidence: 82
  };
}

function heuristicSingleCandidateSelection(resumes, memory, question) {
  const targetName = determineTargetCandidate(memory || {}, question || "") || memory?.decision?.selectedCandidate || resumes[0]?.name || null;
  const targetResume = resumes.find((resume) => resume.name.toLowerCase() === String(targetName || "").toLowerCase()) || resumes[0];
  if (!targetResume) {
    return { answer: "No matching candidate is available right now.", confidence: 28 };
  }

  return {
    answer: formatCandidateContactLine(targetResume),
    confidence: 86
  };
}

function heuristicAvailabilityAnswer(resumes, question, memory) {
  const normalizedQuestion = String(question || "").toLowerCase();
  const filtered = filterResumesForQuestion(resumes, question, memory);
  if (!filtered.length) {
    return {
      answer: "No strong matching candidate is available for that requirement right now.",
      confidence: 34
    };
  }

  const top = filtered.slice(0, 3);
  const roleOrSkill = memory?.focusSkill || memory?.role || inferRoleFromQuestion(question) || "that requirement";
  return {
    answer: `Yes, we have ${top.map((resume) => resume.name).join(", ")} for ${roleOrSkill}.`,
    confidence: 78
  };
}

function heuristicProfileRanking(resumes, question) {
  const normalizedQuestion = question.toLowerCase();
  const ranked = resumes.map((resume) => {
    const skills = resume.parsedData?.skills || [];
    const matchingSkills = selectMatchingSkillsForQuestion(skills, question);
    const matchWeight = matchingSkills.reduce((sum, skill) => {
      return sum + 12 + (skill.mentions * 2) + ((skill.experience_years || 0) * 8);
    }, 0);
    const overallScore = typeof resume.retrieval?.score === "number" ? resume.retrieval.score * 100 : matchWeight;
    return {
      name: resume.name,
      score: roundOne(overallScore + matchWeight),
      summary: resume.parsedData?.summary || "",
      skills: (matchingSkills.length ? matchingSkills : skills).slice(0, 4).map((skill) => skill.name)
    };
  }).sort((left, right) => right.score - left.score).slice(0, 3);

  const intro = /few profiles|profiles|shortlist|top candidates|top profiles/i.test(normalizedQuestion)
    ? "Here are a few relevant profiles:"
    : `${ranked[0]?.name || "Top candidate"} is strongest for this role.`;

  return {
    answer: [intro, ...ranked.map((candidate, index) => `${index + 1}. ${candidate.name} - strongest evidence in ${joinList(candidate.skills) || "relevant integration and platform experience"}. ${candidate.summary}`)].join("\n"),
    confidence: ranked.length ? 82 : 28
  };
}

function heuristicWhyChosen(resumes) {
  const first = resumes[0];
  if (!first) return { answer: "This information is not clearly available in the provided resumes.", confidence: 28 };
  const strengths = (first.parsedData?.skills || []).slice(0, 4).map((skill) => skill.name);
  const projects = (first.parsedData?.projects || []).slice(0, 2).map((project) => project.name);
  return {
    answer: `${first.name} was chosen first because the profile shows stronger alignment through ${joinList(strengths) || "relevant skills"}. Key supporting work includes ${joinList(projects) || "clear project delivery evidence"}, which made this candidate rank ahead of the others.`,
    confidence: 80
  };
}

function getOrCreateSession(userId, sessionId) {
  const key = `${userId}:${sessionId}`;
  if (!sessions.has(key)) {
    sessions.set(key, {
      history: [],
      memory: {
        selectedCandidates: [],
        lastComparedCandidates: [],
        role: null,
        focusSkill: null,
        lastIntent: null,
        decision: {
          selectedCandidate: null,
          rankedCandidates: [],
          role: null
        }
      }
    });
  }
  return sessions.get(key);
}

function appendHistory(history, message) {
  history.push(message);
  while (history.length > MAX_HISTORY_MESSAGES) {
    history.shift();
  }
}

function updateSessionMemory(memory, question, resumes) {
  const normalizedQuestion = question.toLowerCase();
  const next = {
    selectedCandidates: [...(memory.selectedCandidates || [])],
    lastComparedCandidates: [...(memory.lastComparedCandidates || [])],
    role: memory.role || null,
    focusSkill: memory.focusSkill || null,
    lastIntent: "recruiter_chat",
    decision: {
      selectedCandidate: memory.decision?.selectedCandidate || null,
      rankedCandidates: [...(memory.decision?.rankedCandidates || [])],
      role: memory.decision?.role || memory.role || null
    }
  };

  const explicitNames = resumes.map((resume) => resume.name).filter((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(question));
  if (isGlobalSearchQuestion(normalizedQuestion)) {
    next.selectedCandidates = resumes.map((resume) => resume.name);
  } else if (explicitNames.length) {
    next.selectedCandidates = explicitNames;
  } else if (/\b(he|his|him)\b/i.test(question) && next.decision.selectedCandidate) {
    next.selectedCandidates = [next.decision.selectedCandidate];
  } else if (/\b(they|them|those|these|again)\b/i.test(question) && memory.lastComparedCandidates?.length) {
    next.selectedCandidates = [...memory.lastComparedCandidates];
  } else if (!next.selectedCandidates.length) {
    next.selectedCandidates = resumes.map((resume) => resume.name);
  }

  const role = inferRoleFromQuestion(question);
  const previousRole = next.role;
  if (role) {
    next.role = role;
    next.decision.role = role;
  }

  const focusSkill = inferFocusSkill(question);
  const previousFocusSkill = next.focusSkill;
  if (focusSkill) {
    next.focusSkill = focusSkill;
  }

  if ((role && previousRole && role !== previousRole) || (focusSkill && previousFocusSkill && focusSkill !== previousFocusSkill)) {
    next.decision.selectedCandidate = null;
    next.decision.rankedCandidates = [];
  }

  if (resumes.length > 1 || /\b(compare|better|best|again)\b/i.test(question)) {
    next.lastComparedCandidates = resumes.map((resume) => resume.name);
  }

  if (shouldAllowDecisionOverride(question)) {
    next.decision.selectedCandidate = null;
    next.decision.rankedCandidates = [];
  }

  return next;
}

function finalizeSessionMemory(memory, resumes, question, answer) {
  const next = { ...memory };
  if (!next.selectedCandidates.length) {
    next.selectedCandidates = resumes.map((resume) => resume.name);
  }
  if (/\b(compare|better|best|again)\b/i.test(question)) {
    next.lastComparedCandidates = resumes.map((resume) => resume.name);
  }
  next.decision = extractDecisionMemory(next.decision, question, answer, resumes);
  return next;
}

function answerFromDecisionMemory(question, memory) {
  const normalized = question.toLowerCase();
  const selectedCandidate = memory.decision?.selectedCandidate;
  if (!selectedCandidate) return null;
  if (/\b(which candidate (did )?(we )?select|who (did )?(we )?select|selected candidate)\b/i.test(normalized)) {
    return {
      answer: `${selectedCandidate} is the selected candidate based on the earlier decision in this conversation.`,
      confidence: 96
    };
  }
  return null;
}

function answerFromSingleCandidateIntent(question, resumes, memory, singleCandidateIntent) {
  if (!singleCandidateIntent || !isExplicitSingleResponseRequest(question)) {
    return null;
  }

  const candidate = resumes[0];
  if (!candidate) {
    return {
      answer: "No matching candidate is available right now.",
      confidence: 28
    };
  }

  return {
    answer: formatCandidateContactLine(candidate),
    confidence: 88
  };
}

function buildDecisionInstruction(memory, question) {
  const selectedCandidate = memory.decision?.selectedCandidate;
  if (!selectedCandidate) {
    return "No locked hiring decision exists yet. You may recommend a candidate if the evidence supports it.";
  }
  if (shouldAllowDecisionOverride(question)) {
    return `A previous decision selected ${selectedCandidate}, but the recruiter explicitly asked to re-evaluate or compare again, so you may revise the selection if the evidence supports it.`;
  }
  return `Selected candidate is ${selectedCandidate}. Do not change unless explicitly asked to re-evaluate, compare again, or change selection.`;
}

function shouldAllowDecisionOverride(question) {
  return /\b(re-?evaluate|compare again|change selection|reconsider|rank again)\b/i.test(question);
}

function extractDecisionMemory(previousDecision, question, answer, resumes) {
  const next = {
    selectedCandidate: previousDecision?.selectedCandidate || null,
    rankedCandidates: [...(previousDecision?.rankedCandidates || [])],
    role: previousDecision?.role || null
  };
  const normalizedQuestion = question.toLowerCase();
  const candidateNames = resumes.map((resume) => resume.name).filter(Boolean);
  const ranked = candidateNames.filter((name) => answer.toLowerCase().includes(name.toLowerCase()));
  if (ranked.length) {
    next.rankedCandidates = ranked;
  }
  if (shouldAllowDecisionOverride(question)) {
    next.selectedCandidate = ranked[0] || next.selectedCandidate;
    return next;
  }
  if (!next.selectedCandidate && /\b(who is better|who is best|best fit|recommend|selected|choose|selection)\b/i.test(normalizedQuestion) && ranked.length) {
    next.selectedCandidate = ranked[0];
  }
  return next;
}

function projectDecisionMemory(memory) {
  return {
    selectedCandidate: memory.decision?.selectedCandidate || null,
    rankedCandidates: [...(memory.decision?.rankedCandidates || [])],
    role: memory.decision?.role || null
  };
}

function inferRoleFromQuestion(question) {
  const normalized = question.toLowerCase();
  if (normalized.includes("backend")) return "backend";
  if (normalized.includes("frontend")) return "frontend";
  if (normalized.includes("integration")) return "integration";
  if (normalized.includes("sales")) return "sales";
  if (normalized.includes("accounting")) return "accounting";
  if (normalized.includes("operations")) return "operations";
  return null;
}

function inferFocusSkill(question) {
  const normalized = String(question || "").toLowerCase();
  const skillMap = [
    "python", "java", "spring boot", "microservices", "dell boomi", "boomi", "guidewire",
    "gosu", "react", "node.js", "sql", "salesforce", "crm", "sap", "etl", "soap", "edi", "xml"
  ];

  const match = skillMap.find((skill) => normalized.includes(skill));
  if (!match) {
    return null;
  }

  return toDisplaySkill(match);
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function joinList(items) {
  const values = (items || []).filter(Boolean);
  if (!values.length) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function limitForIntent(resumes, singleCandidateIntent) {
  if (!Array.isArray(resumes) || !resumes.length) {
    return [];
  }
  return singleCandidateIntent ? resumes.slice(0, 1) : resumes;
}

function enforceResponseShape(answer, resumes, question) {
  if (isExplicitSingleResponseRequest(question)) {
    return formatCandidateContactLine(resumes[0]);
  }
  return answer;
}

function isComparisonQuestion(normalizedQuestion) {
  return /\b(compare|comparison|better|best|stronger|vs|versus|other candidate|all candidates|which one|who is best in them|among them)\b/i.test(normalizedQuestion);
}

function isGlobalSearchQuestion(normalizedQuestion) {
  return /\b(anyone|any one|any other|who else|available|show|list|find|search|profiles?)\b/i.test(normalizedQuestion)
    && !/\b(he|his|him|she|her|that candidate|this candidate)\b/i.test(normalizedQuestion)
    && !isSingleNameContactRequest(normalizedQuestion);
}

function isSingleNameContactRequest(normalizedQuestion) {
  return /\b(one name|single name|just give one|only one|best candidate|best fit)\b/i.test(normalizedQuestion)
    && /\b(contact|email|phone|mobile|reach|linkedin|github)\b/i.test(normalizedQuestion);
}

function shouldReduceToSingleCandidate(question) {
  const normalizedQuestion = String(question || "").toLowerCase();
  if (isExplicitSingleResponseRequest(normalizedQuestion)) {
    return true;
  }

  return /\b(who is best|best fit|top candidate|recommend one|select one)\b/i.test(normalizedQuestion)
    && !/\b(compare|comparison|which one|better|vs|versus|few profiles|profiles|list|show all|all candidates)\b/i.test(normalizedQuestion);
}

function isExplicitSingleResponseRequest(question) {
  const normalizedQuestion = String(question || "").toLowerCase();
  return (/\b(one|only|just one|single)\b/i.test(normalizedQuestion) || isSingleNameContactRequest(normalizedQuestion))
    && !/\b(compare|comparison|which one|better|vs|versus|few profiles|profiles|list|show all|all candidates)\b/i.test(normalizedQuestion);
}

function isAvailabilityQuestion(normalizedQuestion) {
  return /\b(do we have|is there|any profile|any candidate|available|profiles? for|developer for)\b/i.test(normalizedQuestion);
}

function formatCandidateContactLine(candidate) {
  if (!candidate) {
    return "No matching candidate is available right now.";
  }

  const contact = candidate.parsedData?.contactDetails || {};
  const parts = [
    contact.email || "",
    contact.phone || ""
  ].filter(Boolean);

  if (!parts.length) {
    return candidate.name;
  }

  return `${candidate.name} — ${parts.join(" | ")}`;
}

function buildRetrievalQuery(question, memory) {
  const normalizedQuestion = String(question || "").toLowerCase();
  if (!isFollowUpDiscoveryQuestion(normalizedQuestion)) {
    return question;
  }

  const contextParts = [];
  if (memory?.role) {
    contextParts.push(`role ${memory.role}`);
  }
  if (memory?.focusSkill) {
    contextParts.push(`skill ${memory.focusSkill}`);
  }

  return contextParts.length ? `${question} ${contextParts.join(" ")}` : question;
}

function isFollowUpDiscoveryQuestion(normalizedQuestion) {
  return /\b(few profiles|profiles|shortlist|show profiles|which one|who is better|who is best|top candidate|in them|among them)\b/i.test(normalizedQuestion);
}

function filterResumesForQuestion(resumes, question, memory) {
  const role = inferRoleFromQuestion(question) || memory?.role;
  const focusSkill = inferFocusSkill(question) || memory?.focusSkill;
  const minYears = inferMinimumYears(question);

  return resumes.filter((resume) => {
    const skills = resume.parsedData?.skills || [];
    const summary = String(resume.parsedData?.summary || "").toLowerCase();
    const experienceYears = (resume.parsedData?.experience || []).reduce((sum, entry) => sum + (entry.duration_years || 0), 0);

    const roleMatch = !role || summary.includes(role.toLowerCase()) || (resume.metadata?.role || "").toLowerCase() === role.toLowerCase();
    const skillMatch = !focusSkill || skills.some((skill) => skill.name.toLowerCase() === focusSkill.toLowerCase());
    const experienceMatch = !minYears || experienceYears >= minYears;

    return roleMatch && skillMatch && experienceMatch;
  });
}

function inferMinimumYears(question) {
  const match = String(question || "").match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:year|years)/i);
  return match ? Number(match[1]) : 0;
}

function selectMatchingSkillsForQuestion(skills, question) {
  const normalizedQuestion = String(question || "").toLowerCase();
  const matching = skills.filter((skill) => normalizedQuestion.includes(skill.name.toLowerCase()));
  if (matching.length) {
    return matching;
  }

  const role = inferRoleFromQuestion(question);
  if (role) {
    return skills.filter((skill) => skill.category === role || (role === "sales" && ["CRM", "Salesforce", "Lead Generation"].includes(skill.name)));
  }

  return skills;
}

function isAnswerAlignedWithResumes(answer, resumes, memory, question) {
  const normalizedAnswer = String(answer || "").toLowerCase();
  const shortlistedNames = resumes.map((resume) => resume.name.toLowerCase());
  const knownNames = getKnownCandidateNamesFromMemory(memory);
  const mentionedKnownNames = knownNames.filter((name) => normalizedAnswer.includes(name));

  if (mentionedKnownNames.some((name) => !shortlistedNames.includes(name))) {
    return false;
  }

  if (isComparisonQuestion(String(question || "").toLowerCase()) && shortlistedNames.length > 1) {
    return mentionedKnownNames.length === 0 || mentionedKnownNames.some((name) => shortlistedNames.includes(name));
  }

  return true;
}

function getKnownCandidateNamesFromMemory(memory) {
  const values = new Set();
  for (const value of memory?.selectedCandidates || []) values.add(String(value).toLowerCase());
  for (const value of memory?.lastComparedCandidates || []) values.add(String(value).toLowerCase());
  if (memory?.decision?.selectedCandidate) values.add(String(memory.decision.selectedCandidate).toLowerCase());
  for (const value of memory?.decision?.rankedCandidates || []) values.add(String(value).toLowerCase());
  return [...values];
}

function toDisplaySkill(value) {
  const map = {
    python: "Python",
    java: "Java",
    "spring boot": "Spring Boot",
    microservices: "Microservices",
    "dell boomi": "Dell Boomi",
    boomi: "Dell Boomi",
    guidewire: "Guidewire",
    gosu: "Gosu",
    react: "React",
    "node.js": "Node.js",
    sql: "SQL",
    salesforce: "Salesforce",
    crm: "CRM",
    sap: "SAP",
    etl: "ETL",
    soap: "SOAP",
    edi: "EDI",
    xml: "XML"
  };

  return map[value] || value;
}
