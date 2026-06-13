import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { connectDatabase, getCollections } from "./db.js";
import { requireAuth, requireRole, signUserToken, verifyCredentials, createUser, hydrateUserFromToken, validateAuthConfiguration } from "./auth.js";
import { createOrUpdateCandidateProfile, getCandidateProfileForUser, getCandidatePoolCount } from "./candidate-service.js";
import { answerRecruiterQuestion } from "./rag-service.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnvFile(path.join(__dirname, ".env"));

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "4mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.static(__dirname));

app.post("/auth/signup", async (req, res) => {
  const { name, email, password, role } = req.body ?? {};
  if (!name || !email || !password || !["candidate", "recruiter"].includes(role)) {
    res.status(400).json({ error: "name, email, password, and valid role are required." });
    return;
  }

  try {
    const user = await createUser({ name, email, password, role });
    res.json({ token: signUserToken(user), user });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Signup failed." });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required." });
    return;
  }

  try {
    const user = await verifyCredentials(email, password);
    res.json({ token: signUserToken(user), user });
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : "Invalid email or password." });
  }
});

app.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await hydrateUserFromToken(req.user.id);
    res.json({ user });
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : "Session is no longer valid." });
  }
});

app.post("/candidate/profile", requireAuth, requireRole("candidate"), async (req, res) => {
  const parsedData = req.body?.parsedData;
  if (!parsedData || typeof parsedData !== "object") {
    res.status(400).json({ error: "parsedData is required." });
    return;
  }

  try {
    const candidate = await createOrUpdateCandidateProfile(req.user, parsedData);
    const responseBody = {
      candidateId: candidate.id,
      candidate
    };
    if (candidate.embeddingStatus && candidate.embeddingStatus !== "success") {
      res.status(202).json({
        ...responseBody,
        warning: candidate.embeddingError || "Embedding generation failed. The profile was saved but is not searchable yet."
      });
      return;
    }
    res.json(responseBody);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Candidate profile generation failed." });
  }
});

app.get("/candidate/profile", requireAuth, requireRole("candidate"), async (req, res) => {
  try {
    const candidate = await getCandidateProfileForUser(req.user.id);
    if (!candidate) {
      res.status(404).json({ error: "Candidate profile not found." });
      return;
    }
    res.json({ candidate });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load candidate profile." });
  }
});

app.get("/candidate-pool", requireAuth, requireRole("recruiter"), async (_req, res) => {
  try {
    res.json({ totalCandidates: await getCandidatePoolCount() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load candidate pool." });
  }
});

app.post("/chat", requireAuth, requireRole("recruiter"), async (req, res) => {
  const { question, sessionId } = req.body ?? {};
  if (typeof question !== "string" || !question.trim()) {
    res.status(400).json({ error: "A non-empty question is required." });
    return;
  }

  try {
    const result = await answerRecruiterQuestion({
      recruiter: req.user,
      question,
      sessionId
    });
    res.json(result);
  } catch (error) {
    const normalized = normalizeApiError(error);
    res.status(normalized.status).json({ error: normalized.message });
  }
});

app.get(["/candidate", "/recruiter", "/login", "/signup"], (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

start();

async function start() {
  try {
    validateAuthConfiguration();
    await connectDatabase();
    getCollections();
    app.listen(port, () => {
      console.log(`TalkToResume server running on http://localhost:${port}`);
    });
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const file = fs.readFileSync(filePath, "utf8");
  for (const rawLine of file.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^"|"$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function normalizeApiError(error) {
  const message = error instanceof Error ? error.message : "Unexpected backend error.";
  if (isTransientMongoError(message)) {
    return {
      status: 503,
      message: "The candidate database is temporarily unavailable. Please try again after checking MongoDB Atlas connectivity."
    };
  }

  return {
    status: 500,
    message
  };
}

function isTransientMongoError(message) {
  return /econnreset|replicasetnoprimary|server selection|timed out|mongodb/i.test(String(message || ""));
}
