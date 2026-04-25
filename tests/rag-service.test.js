import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { buildLocalSemanticProfile } from "../embeddings.js";
import { answerRecruiterQuestion, __resetRagServiceTestDeps, __setRagServiceTestDeps } from "../rag-service.js";

function createParsedData({
  name,
  role,
  summary,
  location,
  skills,
  years,
  projects = [],
  strengths = []
}) {
  return {
    name,
    location,
    summary,
    skills: skills.map((skill) => ({
      name: skill,
      category: role === "integration" ? "tools" : "backend",
      mentions: 4,
      experience_years: years,
      projects: projects.map((project) => project.name)
    })),
    projects: projects.map((project) => ({
      name: project.name,
      description: project.description,
      techStack: project.techStack,
      features: project.features || [],
      complexity: "medium"
    })),
    experience: [
      {
        company: `${name.split(" ")[0]} Labs`,
        role: role === "integration" ? "Integration Developer" : "Backend Developer",
        duration: `${years} years`,
        duration_years: years,
        responsibilities: ["Built services", "Delivered features"],
        techUsed: skills
      }
    ],
    strengths
  };
}

function createCandidateDoc(parsedData, { embeddingStatus = "success" } = {}) {
  const semanticProfile = embeddingStatus === "success" ? buildLocalSemanticProfile(parsedData) : null;
  return {
    _id: new ObjectId(),
    userId: new ObjectId().toString(),
    name: parsedData.name,
    structuredData: parsedData,
    metadata: semanticProfile?.metadata || {
      role: "unknown",
      skills: [],
      experience: 0,
      location: parsedData.location || null
    },
    embedding: semanticProfile?.overviewEmbedding || null,
    semanticProfile,
    embeddingProvider: semanticProfile?.provider || "gemini-gemini-embedding-001",
    embeddingStatus,
    embeddingError: embeddingStatus === "success" ? null : "Embedding provider failed",
    resumeScore: 80,
    skillGapAnalysis: [],
    suggestedImprovements: []
  };
}

function createTestHarness(candidateDocs) {
  let sessionState = {
    sessionId: "session-1",
    userId: "recruiter-1",
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
  const metrics = [];

  __setRagServiceTestDeps({
    getCollections: () => ({
      candidatesCollection: {
        find: () => ({
          toArray: async () => candidateDocs
        })
      },
      retrievalMetricsCollection: {
        insertOne: async (doc) => {
          metrics.push(doc);
          return { acknowledged: true };
        }
      }
    }),
    getSession: async () => ({ ...sessionState }),
    updateSession: async (_sessionId, _userId, updates) => {
      sessionState = {
        ...sessionState,
        ...updates
      };
      return { ...sessionState };
    }
  });

  return {
    getSessionState: () => sessionState,
    getMetrics: () => metrics
  };
}

test.afterEach(() => {
  __resetRagServiceTestDeps();
});

test("answerRecruiterQuestion returns a candidate list for location_filter_search", async () => {
  const docs = [
    createCandidateDoc(createParsedData({
      name: "Ananya Sharma",
      role: "backend",
      summary: "Backend Java developer based in Delhi.",
      location: "Delhi",
      skills: ["Java", "Spring Boot", "SQL"],
      years: 5.2,
      projects: [{ name: "Payments API", description: "Built payment services", techStack: ["Java", "Spring Boot"] }],
      strengths: ["Backend systems", "APIs"]
    })),
    createCandidateDoc(createParsedData({
      name: "Priya Verma",
      role: "backend",
      summary: "Backend Java developer based in Jaipur.",
      location: "Jaipur",
      skills: ["Java", "Microservices"],
      years: 4.3,
      projects: [{ name: "Orders API", description: "Built order services", techStack: ["Java", "Microservices"] }],
      strengths: ["Microservices", "Backend delivery"]
    })),
    createCandidateDoc(createParsedData({
      name: "Rohan Failed",
      role: "backend",
      summary: "Backend developer in Delhi.",
      location: "Delhi",
      skills: ["Java"],
      years: 3.1,
      projects: [{ name: "Legacy API", description: "Worked on APIs", techStack: ["Java"] }],
      strengths: ["APIs"]
    }), { embeddingStatus: "failed" })
  ];
  createTestHarness(docs);

  const result = await answerRecruiterQuestion({
    recruiter: { id: "recruiter-1", name: "Recruiter", role: "recruiter" },
    question: "candidates from Delhi",
    sessionId: "session-1"
  });

  assert.match(result.answer, /strongest matches|closest matches/i);
  assert.doesNotMatch(result.answer, /available in/i);
  assert.ok(result.matchedCandidates.length >= 1);
  assert.ok(result.matchedCandidates.every((candidate) => String(candidate.metadata?.location || "").toLowerCase().includes("delhi")));
  assert.ok(result.matchedCandidates.every((candidate) => candidate.name !== "Rohan Failed"));
});

test("answerRecruiterQuestion returns aggregated text for location_analytics", async () => {
  const docs = [
    createCandidateDoc(createParsedData({
      name: "Manish Sharma",
      role: "integration",
      summary: "Dell Boomi developer in Delhi.",
      location: "Delhi",
      skills: ["Dell Boomi", "REST APIs"],
      years: 6.7,
      projects: [{ name: "Boomi Hub", description: "Built integrations", techStack: ["Dell Boomi", "REST APIs"] }],
      strengths: ["Boomi", "Integrations"]
    })),
    createCandidateDoc(createParsedData({
      name: "Nitin Sharma",
      role: "integration",
      summary: "Dell Boomi developer in Jaipur.",
      location: "Jaipur",
      skills: ["Dell Boomi", "EDI"],
      years: 5.1,
      projects: [{ name: "EDI Flow", description: "Built EDI flows", techStack: ["Dell Boomi", "EDI"] }],
      strengths: ["EDI", "Boomi"]
    }))
  ];
  createTestHarness(docs);

  const result = await answerRecruiterQuestion({
    recruiter: { id: "recruiter-1", name: "Recruiter", role: "recruiter" },
    question: "which locations are available for boomi developers",
    sessionId: "session-1"
  });

  assert.match(result.answer, /available in/i);
  assert.match(result.answer, /Delhi/i);
  assert.match(result.answer, /Jaipur/i);
});

test("answerRecruiterQuestion keeps best-role questions on candidate search", async () => {
  const docs = [
    createCandidateDoc(createParsedData({
      name: "Megha Verma",
      role: "backend",
      summary: "Senior backend Java engineer with API and microservices experience.",
      location: "Delhi",
      skills: ["Java", "Spring Boot", "Microservices"],
      years: 9.8,
      projects: [{ name: "Order Engine", description: "Built distributed order services", techStack: ["Java", "Microservices"] }],
      strengths: ["Backend architecture", "Java"]
    })),
    createCandidateDoc(createParsedData({
      name: "Aman Verma",
      role: "guidewire",
      summary: "Guidewire engineer with ClaimCenter experience.",
      location: "Noida",
      skills: ["Guidewire", "Gosu"],
      years: 4.2,
      projects: [{ name: "Claims Flow", description: "Built claims workflows", techStack: ["Guidewire", "Gosu"] }],
      strengths: ["Guidewire"]
    }))
  ];
  const harness = createTestHarness(docs);

  const result = await answerRecruiterQuestion({
    recruiter: { id: "recruiter-1", name: "Recruiter", role: "recruiter" },
    question: "who is best backend dev",
    sessionId: "session-1"
  });

  assert.match(result.answer, /closest matches/i);
  assert.ok(result.matchedCandidates[0]);
  assert.equal(result.matchedCandidates[0].metadata?.role, "backend");
  assert.equal(harness.getSessionState().lastIntent, "candidate_search");
  assert.ok(harness.getMetrics().length >= 1);
});
