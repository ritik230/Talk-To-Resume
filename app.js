import { extractResumeText, parseResumeText } from "./parser.js?v=20260411-2";
import { clearAuth, createStore, setAuth } from "./store.js?v=20260411-2";
import { requestChatAnswer, createCandidateProfile, fetchCandidateProfile, fetchCandidatePool, fetchMe, login, signup } from "./ai-client.js?v=20260411-2";

const store = createStore();

const QUESTION_SUGGESTIONS = [
  "Who is best backend developer?",
  "Give me profiles for Boomi developer role",
  "Who worked in insurance domain?",
  "What about his salary?"
];

const topNav = document.getElementById("topNav");
const workspace = document.querySelector(".workspace");
const loginNavButton = document.getElementById("loginNavButton");
const signupNavButton = document.getElementById("signupNavButton");
const logoutButton = document.getElementById("logoutButton");
const loginView = document.getElementById("loginView");
const signupView = document.getElementById("signupView");
const candidateDashboard = document.getElementById("candidateDashboard");
const recruiterDashboard = document.getElementById("recruiterDashboard");
const loginForm = document.getElementById("loginForm");
const signupForm = document.getElementById("signupForm");
const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const signupName = document.getElementById("signupName");
const signupEmail = document.getElementById("signupEmail");
const signupPassword = document.getElementById("signupPassword");
const signupRole = document.getElementById("signupRole");
const resumeUpload = document.getElementById("resumeUpload");
const uploadState = document.getElementById("uploadState");
const candidateSummaryCard = document.getElementById("candidateSummaryCard");
const candidateHighlights = document.getElementById("candidateHighlights");
const matchedCandidates = document.getElementById("matchedCandidates");
const recruiterJsonOutput = document.getElementById("recruiterJsonOutput");
const llmPromptOutput = document.getElementById("llmPromptOutput");
const poolBadge = document.getElementById("poolBadge");
const chatTitle = document.getElementById("chatTitle");
const userBadge = document.getElementById("userBadge");
const suggestedQuestions = document.getElementById("suggestedQuestions");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const debugOutput = document.getElementById("debugOutput");
const chatPanel = document.getElementById("chatPanel");

initialize();

async function initialize() {
  renderSuggestedQuestions();
  bindEvents();
  if (store.token) {
    try {
      const payload = await fetchMe(store.token);
      store.user = payload.user;
    } catch {
      clearAuth(store);
    }
  }
  await bootstrapRoleData();
  render();
}

function bindEvents() {
  window.addEventListener("popstate", handleRouteChange);
  topNav.addEventListener("click", (event) => {
    const route = event.target.closest("[data-route]")?.dataset.route;
    if (!route) return;
    navigate(route);
  });

  logoutButton.addEventListener("click", () => {
    clearAuth(store);
    resetRecruiterWorkspace();
    store.candidateProfile = null;
    navigate("/login");
    render();
  });

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const previousUserId = store.user?.id || null;
      const payload = await login({
        email: loginEmail.value.trim(),
        password: loginPassword.value
      });
      setAuth(store, payload.token, payload.user);
      if (previousUserId !== payload.user.id) {
        resetRecruiterWorkspace();
      }
      await bootstrapRoleData();
      navigate(payload.user.role === "candidate" ? "/candidate" : "/recruiter");
      render();
    } catch (error) {
      addSystemError(error);
    }
  });

  signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const previousUserId = store.user?.id || null;
      const payload = await signup({
        name: signupName.value.trim(),
        email: signupEmail.value.trim(),
        password: signupPassword.value,
        role: signupRole.value
      });
      setAuth(store, payload.token, payload.user);
      if (previousUserId !== payload.user.id) {
        resetRecruiterWorkspace();
      }
      await bootstrapRoleData();
      navigate(payload.user.role === "candidate" ? "/candidate" : "/recruiter");
      render();
    } catch (error) {
      addSystemError(error);
    }
  });

  resumeUpload.addEventListener("change", handleCandidateUpload);

  suggestedQuestions.addEventListener("click", (event) => {
    const question = event.target.closest("[data-question]")?.dataset.question;
    if (!question) return;
    chatInput.value = question;
    chatInput.focus();
  });

  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = chatInput.value.trim();
    if (!question || store.user?.role !== "recruiter") return;
    await submitRecruiterQuestion(question);
  });
}

async function bootstrapRoleData() {
  if (!store.user || !store.token) {
    return;
  }

  if (store.user.role === "candidate") {
    try {
      const payload = await fetchCandidateProfile(store.token);
      store.candidateProfile = payload.candidate;
    } catch {
      store.candidateProfile = null;
    }
  }

  if (store.user.role === "recruiter") {
    try {
      const payload = await fetchCandidatePool(store.token);
      store.poolCount = payload.totalCandidates;
    } catch {
      store.poolCount = 0;
    }
  }
}

async function handleCandidateUpload(event) {
  const file = event.target.files?.[0];
  if (!file || store.user?.role !== "candidate") return;

  uploadState.textContent = `Parsing ${file.name}...`;
  try {
    const rawText = await extractResumeText(file);
    const parsedData = parseResumeText(rawText, file.name);
    const payload = await createCandidateProfile(parsedData, store.token);
    store.candidateProfile = payload.candidate;
    uploadState.textContent = payload.warning || "Profile updated successfully";
    updateDebug("candidate_profile_saved", [`candidate:${payload.candidate.name}`], 100, 0);
    render();
  } catch (error) {
    uploadState.textContent = "Profile update failed";
    addSystemError(error);
  } finally {
    event.target.value = "";
  }
}

async function submitRecruiterQuestion(question) {
  if (store.chatPending) {
    return;
  }

  store.chatPending = true;
  updateChatComposerState();
  addMessage({ author: "Recruiter", role: "user", content: escapeHtml(question) });
  chatInput.value = "";
  const typingId = addTypingMessage();
  const start = performance.now();

  try {
    const payload = await requestChatAnswer(question, store.sessionId, store.token);
    store.sessionId = payload.sessionId || store.sessionId;
    if (store.sessionId) {
      localStorage.setItem("talkToResumeSessionId", store.sessionId);
    }
    store.recruiterMatches = payload.matchedCandidates || [];
    store.decisionMemory = payload.decisionMemory || null;
    store.lastChatDebug = payload.debug || null;
    store.poolCount = payload.totalCandidates || store.poolCount || 0;
    updateDebug(
      "recruiter_chat",
      [
        `matches:${store.recruiterMatches.map((candidate) => candidate.name).join(", ")}`,
        `session:${store.sessionId || "none"}`,
        `pool:${store.poolCount || 0}`,
        `message_count:${chatMessages.childElementCount}`
      ],
      payload.confidence,
      Math.round(performance.now() - start)
    );
    removeTypingMessage(typingId);
    const parts = splitAnswer(payload.answer);
    addStreamingMessage({
      author: "Resume AI",
      role: "assistant",
      parts: parts.length ? parts : ["The recruiter assistant could not generate a response right now."],
      confidence: payload.confidence
    });
    renderRecruiterData();
    renderDebug();
  } catch (error) {
    removeTypingMessage(typingId);
    addSystemError(error);
  } finally {
    store.chatPending = false;
    updateChatComposerState();
  }
}

function render() {
  const route = currentRoute();
  const isLoggedIn = Boolean(store.user && store.token);
  const isRecruiterRoute = route === "/recruiter" && store.user?.role === "recruiter";
  const isCandidateRoute = route === "/candidate" && store.user?.role === "candidate";

  loginNavButton.classList.toggle("hidden", isLoggedIn);
  signupNavButton.classList.toggle("hidden", isLoggedIn);
  logoutButton.classList.toggle("hidden", !isLoggedIn);
  loginView.classList.toggle("hidden", route !== "/login");
  signupView.classList.toggle("hidden", route !== "/signup");
  candidateDashboard.classList.toggle("hidden", !isCandidateRoute);
  recruiterDashboard.classList.toggle("hidden", !isRecruiterRoute);
  chatPanel.classList.toggle("hidden", !isRecruiterRoute);
  workspace.classList.toggle("single-column", !isRecruiterRoute);

  if (!isLoggedIn && !["/login", "/signup"].includes(route)) {
    navigate("/login", true);
    return;
  }

  if (route === "/candidate" && store.user?.role !== "candidate") {
    navigate(store.user ? "/recruiter" : "/login", true);
    return;
  }

  if (route === "/recruiter" && store.user?.role !== "recruiter") {
    navigate(store.user ? "/candidate" : "/login", true);
    return;
  }

  chatTitle.textContent = isRecruiterRoute ? "Recruiter talent search" : "Sign in to continue";
  userBadge.textContent = isLoggedIn ? `${store.user.name} • ${store.user.role}` : "Guest";

  renderCandidateData();
  renderRecruiterData();
  renderDebug();
  updateChatComposerState();
}

function renderCandidateData() {
  if (!store.candidateProfile) {
    candidateSummaryCard.innerHTML = createEmptyState("No profile yet", "Upload a PDF to create your persistent candidate profile.");
    candidateHighlights.innerHTML = createEmptyState("No highlights yet", "Your skills, experience summary, and key strengths will appear after upload.");
    return;
  }

  const candidate = store.candidateProfile;
  candidateSummaryCard.innerHTML = `
    <div class="resume-topline">
      <div>
        <p class="muted-label">Candidate profile</p>
        <h3>${escapeHtml(candidate.name)}</h3>
      </div>
      <div class="upload-state">Resume Score ${candidate.resumeScore}%</div>
    </div>
    <p class="candidate-summary">${escapeHtml(candidate.structuredData.summary || "Summary not clearly available")}</p>
    <div class="meta-grid">
      ${createMetaCard("Skills", String(candidate.structuredData.skills?.length || 0))}
      ${createMetaCard("Projects", String(candidate.structuredData.projects?.length || 0))}
      ${createMetaCard("Experience", String(candidate.structuredData.experience?.length || 0))}
      ${createMetaCard("Role", candidate.metadata?.role || "generalist")}
    </div>
  `;
  candidateHighlights.innerHTML = [
    createHighlightCard("Top Skills", (candidate.metadata?.skills || []).slice(0, 6).join(", ") || "Not clearly available"),
    createHighlightCard("Experience Summary", candidate.structuredData.experience?.slice(0, 2).map((entry) => `${entry.role}${entry.company ? ` at ${entry.company}` : ""}`).join(" | ") || "Not clearly available"),
    createHighlightCard("Key Highlights", (candidate.structuredData.strengths || []).join(", ") || "Not clearly available")
  ].join("");
}

function renderRecruiterData() {
  poolBadge.textContent = `${store.poolCount || 0} candidates indexed`;
  matchedCandidates.innerHTML = store.recruiterMatches.length
    ? store.recruiterMatches.map((candidate) => `
        <article class="candidate-card active">
          <header>
            <div>
              <strong>${escapeHtml(candidate.name)}</strong>
              <div class="candidate-meta">${escapeHtml(candidate.structuredData?.summary || "Summary not clearly available")}</div>
            </div>
          </header>
          <div class="candidate-meta">${escapeHtml((candidate.metadata?.skills || []).slice(0, 4).join(", ") || "Skills not clearly available")}</div>
        </article>
      `).join("")
    : createEmptyState("No matches yet", "Recruiters can ask questions without uploading resumes.");
  recruiterJsonOutput.textContent = JSON.stringify({
    matchedCandidates: store.recruiterMatches,
    decisionMemory: store.decisionMemory || null
  }, null, 2);
  if (llmPromptOutput) {
    llmPromptOutput.textContent = store.lastChatDebug?.llmPrompt || "Prompt preview is available only when DEBUG_MODE=true on the backend.";
  }
}

function renderSuggestedQuestions() {
  suggestedQuestions.innerHTML = QUESTION_SUGGESTIONS.map((question) => `
    <button class="suggested-question" type="button" data-question="${escapeHtml(question)}">${escapeHtml(question)}</button>
  `).join("");
}

function renderDebug() {
  if (!debugOutput) {
    return;
  }

  debugOutput.textContent = JSON.stringify({
    route: currentRoute(),
    user: store.user,
    sessionId: store.sessionId,
    decisionMemory: store.decisionMemory || null,
    lastIntent: store.debug.lastIntent,
    evidenceUsed: store.debug.lastEvidence,
    answerConfidence: store.debug.lastConfidence,
    responseLatencyMs: store.debug.lastLatencyMs
  }, null, 2);
}

function updateDebug(intent, evidence, confidence, latencyMs) {
  store.debug.lastIntent = intent;
  store.debug.lastEvidence = evidence;
  store.debug.lastConfidence = confidence;
  store.debug.lastLatencyMs = latencyMs;
}

function addTypingMessage() {
  const id = `typing-${Date.now()}`;
  addMessage({
    author: "Resume AI",
    role: "assistant",
    content: `<span id="${id}" class="typing-shell">Thinking<span class="typing-dots"><span></span><span></span><span></span></span></span>`
  });
  return id;
}

function removeTypingMessage(id) {
  document.getElementById(id)?.closest(".message")?.remove();
}

function addMessage({ author, role, content, confidence }) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.innerHTML = `
    <div class="message-avatar"></div>
    <div class="message-body">
      <div class="message-meta">
        <span class="message-author">${escapeHtml(author)}</span>
        <span class="message-time">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      <div class="message-content">${content}</div>
      <div class="answer-confidence ${typeof confidence === "number" ? "" : "hidden"}">
        <div class="confidence-header">
          <span>Answer Confidence</span>
          <strong class="confidence-value">${typeof confidence === "number" ? `${confidence}%` : ""}</strong>
        </div>
        <div class="confidence-track">
          <div class="confidence-fill" style="width:${typeof confidence === "number" ? confidence : 0}%"></div>
        </div>
      </div>
    </div>
  `;
  chatMessages.appendChild(article);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  updateDebug(
    store.debug.lastIntent || "chat_render",
    [
      ...(store.debug.lastEvidence || []).filter((item) => !String(item).startsWith("message_count:")),
      `message_count:${chatMessages.childElementCount}`
    ],
    typeof confidence === "number" ? confidence : store.debug.lastConfidence,
    store.debug.lastLatencyMs
  );
}

function addStreamingMessage({ author, role, parts, confidence }) {
  const lines = Array.isArray(parts) && parts.length ? parts : ["The recruiter assistant could not generate a response right now."];
  const content = lines.map((part) => `<span class="stream-line">${escapeHtml(part)}</span>`).join("");
  addMessage({
    author,
    role,
    content,
    confidence
  });
}

function addSystemError(error) {
  addMessage({
    author: "Resume AI",
    role: "assistant",
    content: escapeHtml(normalizeUiErrorMessage(error))
  });
}

function splitAnswer(answer) {
  return String(answer || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{1,}/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function navigate(route, replace = false) {
  if (replace) {
    window.history.replaceState({}, "", route);
  } else {
    window.history.pushState({}, "", route);
  }
  handleRouteChange();
}

function handleRouteChange() {
  store.route = currentRoute();
  render();
}

function currentRoute() {
  return window.location.pathname || "/login";
}

function createMetaCard(label, value) {
  return `<div class="meta-card"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`;
}

function createHighlightCard(title, body) {
  return `<article class="project-card"><h4>${escapeHtml(title)}</h4><p>${escapeHtml(body)}</p></article>`;
}

function createEmptyState(title, body) {
  return `<div class="empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span></div>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resetRecruiterWorkspace() {
  store.recruiterMatches = [];
  store.sessionId = "";
  store.decisionMemory = null;
  store.lastChatDebug = null;
  store.chatPending = false;
  store.debug.lastIntent = "idle";
  store.debug.lastEvidence = [];
  store.debug.lastConfidence = 0;
  store.debug.lastLatencyMs = 0;
  localStorage.removeItem("talkToResumeSessionId");
  if (chatMessages) {
    chatMessages.innerHTML = "";
  }
  updateChatComposerState();
}

function updateChatComposerState() {
  if (!chatForm || !chatInput) {
    return;
  }

  const sendButton = chatForm.querySelector('button[type="submit"]');
  chatInput.disabled = Boolean(store.chatPending);
  if (sendButton) {
    sendButton.disabled = Boolean(store.chatPending);
    sendButton.textContent = store.chatPending ? "Searching..." : "Send";
  }
}

function normalizeUiErrorMessage(error) {
  const message = error?.message || "Something went wrong.";
  if (/econnreset|replicasetnoprimary|server selection|timed out|candidate database is temporarily unavailable/i.test(message)) {
    return "The candidate database is temporarily unavailable. Please check MongoDB Atlas connectivity and try again.";
  }
  return message;
}
