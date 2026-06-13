const LOCAL_EMBEDDING_DIMENSION = 256;

export function createCandidateSemanticDocument(parsedData) {
  const chunks = [];

  for (const skill of parsedData.skills || []) {
    const text = [
      skill.name,
      skill.category,
      `${skill.mentions} mentions`,
      `${skill.experience_years} years experience`,
      `projects ${Array.isArray(skill.projects) ? skill.projects.join(" ") : ""}`
    ].join(" ");
    chunks.push(makeChunk("skill", skill.name, text));
  }

  for (const project of parsedData.projects || []) {
    const text = [
      project.name,
      project.description,
      `tech stack ${Array.isArray(project.techStack) ? project.techStack.join(" ") : ""}`,
      `features ${Array.isArray(project.features) ? project.features.join(" ") : ""}`,
      `complexity ${project.complexity || ""}`
    ].join(" ");
    chunks.push(makeChunk("project", project.name, text));
  }

  for (const experience of parsedData.experience || []) {
    const text = [
      experience.company,
      experience.role,
      experience.duration,
      `${experience.duration_years || 0} years`,
      `responsibilities ${Array.isArray(experience.responsibilities) ? experience.responsibilities.join(" ") : ""}`,
      `tech used ${Array.isArray(experience.techUsed) ? experience.techUsed.join(" ") : ""}`
    ].join(" ");
    chunks.push(makeChunk("experience", `${experience.role} ${experience.company || ""}`.trim(), text));
  }

  const metadata = buildMetadata(parsedData);
  const overviewText = [
    parsedData.name,
    parsedData.summary,
    parsedData.location ? `location ${parsedData.location}` : "",
    `role ${metadata.role || "generalist"}`,
    `skills ${metadata.skills.join(" ")}`,
    `experience ${metadata.experience} years`,
    `projects ${Array.isArray(parsedData.projects) ? parsedData.projects.map((project) => project.name).join(" ") : ""}`,
    `strengths ${Array.isArray(parsedData.strengths) ? parsedData.strengths.join(" ") : ""}`
  ].join(" ");

  return {
    overviewText,
    metadata,
    chunks
  };
}

export function buildSemanticProfile(parsedData) {
  return buildLocalSemanticProfile(parsedData);
}
export function buildLocalSemanticProfile(parsedData) {
  const document = createCandidateSemanticDocument(parsedData);
  return {
    provider: "local-fallback",
    overviewText: document.overviewText,
    overviewEmbedding: embedText(document.overviewText),
    metadata: document.metadata,
    chunks: document.chunks.map((chunk) => ({
      ...chunk,
      embedding: embedText(chunk.text)
    }))
  };
}

export function withEmbeddings(document, embeddings, provider = "remote") {
  const vectors = Array.isArray(embeddings) ? embeddings : [];
  const [overviewEmbedding, ...chunkEmbeddings] = vectors;
  return {
    provider,
    overviewText: document.overviewText,
    overviewEmbedding: normalizeVector(Array.isArray(overviewEmbedding) ? overviewEmbedding : []),
    metadata: document.metadata,
    chunks: document.chunks.map((chunk, index) => ({
      ...chunk,
      embedding: normalizeVector(Array.isArray(chunkEmbeddings[index]) ? chunkEmbeddings[index] : [])
    }))
  };
}

export function rankResumesByQuery(resumes, question, limit = 3, options = {}) {
  const queryEmbedding = Array.isArray(options.queryEmbedding) ? normalizeVector(options.queryEmbedding) : embedText(question);
  const ranked = resumes.map((resume) => {
    const semanticProfile = resume.semanticProfile || buildLocalSemanticProfile(resume.parsedData || {});
    const chunkScores = (semanticProfile.chunks || [])
      .map((chunk) => ({
        ...chunk,
        similarity: cosineSimilarity(queryEmbedding, chunk.embedding)
      }))
      .sort((left, right) => right.similarity - left.similarity);

    const topChunks = chunkScores.slice(0, 5);
    const chunkScore = average(topChunks.map((chunk) => chunk.similarity));
    const overviewScore = cosineSimilarity(queryEmbedding, semanticProfile.overviewEmbedding);

    return {
      ...resume,
      semanticProfile,
      retrieval: {
        query: question,
        score: round((overviewScore * 0.35) + (chunkScore * 0.65)),
        topChunks: topChunks.map((chunk) => ({
          type: chunk.type,
          label: chunk.label,
          text: chunk.text,
          similarity: round(chunk.similarity)
        }))
      }
    };
  }).sort((left, right) => right.retrieval.score - left.retrieval.score);

  return {
    queryEmbedding,
    matches: ranked.slice(0, limit)
  };
}

export function keywordFallbackRanking(resumes, question, limit = 3) {
  const tokens = tokenize(question);
  const ranked = resumes.map((resume) => {
    const semanticProfile = resume.semanticProfile || buildLocalSemanticProfile(resume.parsedData || {});
    const overviewHits = countTokenHits(semanticProfile.overviewText, tokens);
    const chunkScores = (semanticProfile.chunks || [])
      .map((chunk) => ({
        ...chunk,
        similarity: countTokenHits(chunk.text, tokens)
      }))
      .sort((left, right) => right.similarity - left.similarity);

    const topChunks = chunkScores.slice(0, 5);
    const chunkScore = average(topChunks.map((chunk) => chunk.similarity));
    return {
      ...resume,
      semanticProfile,
      retrieval: {
        query: question,
        score: round((overviewHits * 0.4) + (chunkScore * 0.6)),
        topChunks: topChunks.map((chunk) => ({
          type: chunk.type,
          label: chunk.label,
          text: chunk.text,
          similarity: round(chunk.similarity)
        }))
      }
    };
  }).sort((left, right) => right.retrieval.score - left.retrieval.score);

  return {
    queryEmbedding: null,
    matches: ranked.slice(0, limit)
  };
}

export function embedText(text) {
  const vector = new Array(LOCAL_EMBEDDING_DIMENSION).fill(0);
  const tokens = tokenize(text);
  const grams = buildNgrams(tokens);

  for (const token of [...tokens, ...grams]) {
    const index = hashToken(token) % LOCAL_EMBEDDING_DIMENSION;
    vector[index] += token.length > 4 ? 1.2 : 1;
  }

  return normalizeVector(vector);
}

export function cosineSimilarity(left, right) {
  const size = Math.max(left?.length || 0, right?.length || 0);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < size; index += 1) {
    const l = left?.[index] || 0;
    const r = right?.[index] || 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }

  if (!leftNorm || !rightNorm) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function buildMetadata(parsedData) {
  const experienceYears = (parsedData.experience || [])
    .reduce((sum, entry) => sum + (Number(entry.duration_years) || 0), 0);
  const primaryRole = inferPrimaryRole(parsedData);

  return {
    skills: (parsedData.skills || []).map((skill) => skill.name),
    experience: round(experienceYears),
    role: primaryRole,
    location: String(parsedData.location || parsedData.contactDetails?.location || "").trim() || null
  };
}

function inferPrimaryRole(parsedData) {
  const summary = String(parsedData.summary || "").toLowerCase();
  const strengths = (parsedData.strengths || []).map((item) => String(item).toLowerCase());
  const roleSignals = [
    { role: "sales", matches: ["sales", "crm", "lead generation", "salesforce", "pipeline"] },
    { role: "accounting", matches: ["accounting", "reconciliation", "ledger", "audit", "finance"] },
    { role: "operations", matches: ["operations", "workflow", "vendor", "dispatch", "supply"] },
    { role: "integration", matches: ["integration", "boomi", "edi", "soap", "etl", "middleware"] },
    { role: "guidewire", matches: ["guidewire", "claimcenter", "gosu", "policycenter"] },
    { role: "frontend", matches: ["frontend", "react", "javascript", "typescript", "ui"] },
    { role: "backend", matches: ["backend", "java", "spring", "microservices", "api", "python"] }
  ];

  for (const signal of roleSignals) {
    if (signal.matches.some((term) => summary.includes(term) || strengths.some((value) => value.includes(term)))) {
      return signal.role;
    }
  }

  const categoryScores = new Map();
  for (const skill of parsedData.skills || []) {
    const weight = (skill.mentions || 0) + ((skill.experience_years || 0) * 2) + ((skill.projects?.length || 0) * 1.5);
    categoryScores.set(skill.category, (categoryScores.get(skill.category) || 0) + weight);
  }

  let bestCategory = "generalist";
  let bestScore = -1;
  for (const [category, score] of categoryScores.entries()) {
    if (score > bestScore) {
      bestCategory = category;
      bestScore = score;
    }
  }

  return bestCategory;
}

function countTokenHits(text, tokens) {
  const haystack = ` ${String(text || "").toLowerCase()} `;
  return tokens.reduce((sum, token) => sum + (haystack.includes(` ${token} `) ? 1 : 0), 0);
}

function makeChunk(type, label, text) {
  return {
    type,
    label,
    text
  };
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#./ -]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function buildNgrams(tokens) {
  const grams = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    grams.push(`${tokens[index]}_${tokens[index + 1]}`);
  }
  return grams;
}

function hashToken(token) {
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = ((hash << 5) - hash) + token.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function normalizeVector(vector) {
  let sumSquares = 0;
  for (const value of vector) {
    sumSquares += value * value;
  }
  if (!sumSquares) {
    return vector;
  }
  const magnitude = Math.sqrt(sumSquares);
  return vector.map((value) => value / magnitude);
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
