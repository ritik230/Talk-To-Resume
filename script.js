const SKILL_LIBRARY = [
  { name: "Java", category: "Backend", aliases: ["java"] },
  { name: "Spring Boot", category: "Backend", aliases: ["spring boot", "springboot", "spring"] },
  { name: "Microservices", category: "Backend", aliases: ["microservices", "microservice"] },
  { name: "REST APIs", category: "Backend", aliases: ["rest api", "restful api", "restful", "api"] },
  { name: "Node.js", category: "Backend", aliases: ["node.js", "nodejs"] },
  { name: "Python", category: "Backend", aliases: ["python"] },
  { name: "SQL", category: "Database", aliases: ["sql"] },
  { name: "PostgreSQL", category: "Database", aliases: ["postgresql", "postgres"] },
  { name: "MySQL", category: "Database", aliases: ["mysql"] },
  { name: "MongoDB", category: "Database", aliases: ["mongodb", "mongo db", "mongo"] },
  { name: "Redis", category: "Database", aliases: ["redis"] },
  { name: "Kafka", category: "Tools", aliases: ["kafka", "apache kafka"] },
  { name: "Docker", category: "Tools", aliases: ["docker", "containerization", "containers"] },
  { name: "Kubernetes", category: "Tools", aliases: ["kubernetes", "k8s"] },
  { name: "AWS", category: "Tools", aliases: ["aws", "amazon web services"] },
  { name: "Azure", category: "Tools", aliases: ["azure"] },
  { name: "Git", category: "Tools", aliases: ["git", "github", "gitlab"] },
  { name: "Jenkins", category: "Tools", aliases: ["jenkins"] },
  { name: "CI/CD", category: "Tools", aliases: ["ci/cd", "continuous integration", "continuous delivery"] },
  { name: "Elasticsearch", category: "Tools", aliases: ["elasticsearch", "elastic"] },
  { name: "Grafana", category: "Tools", aliases: ["grafana"] },
  { name: "Communication", category: "Communication", aliases: ["communication", "stakeholder", "collaboration", "cross-functional", "teamwork"] },
  { name: "Leadership", category: "Communication", aliases: ["leadership", "mentoring", "ownership"] }
];

const QUESTION_SUGGESTIONS = [
  "What are his strengths?",
  "Explain backend experience",
  "What projects has he built?",
  "Show only backend skills",
  "How confident are you about Java?"
];

const INTENT_RULES = {
  skills: ["skill", "tools", "database", "technology", "stack", "confident", "confidence"],
  projects: ["project", "built", "build", "portfolio", "implemented", "created"],
  experience: ["experience", "worked", "background", "career", "backend", "role"],
  strengths: ["strength", "strongest", "best", "fit", "good at"],
  general: ["summary", "overview", "candidate", "profile", "who is"]
};

const SECTION_LABELS = {
  experience: ["experience", "work experience", "professional experience", "employment"],
  projects: ["projects", "project experience", "key projects"],
  education: ["education", "academic"],
  skills: ["skills", "technical skills", "technologies", "tech stack"],
  summary: ["summary", "profile", "professional summary", "about"]
};

const EXPERIENCE_HINTS = ["engineer", "developer", "architect", "lead", "manager", "analyst", "consultant", "intern"];
const PROJECT_HINTS = ["project", "platform", "dashboard", "portal", "service", "application", "system"];

const state = {
  uploadedFile: null,
  previewUrl: null,
  resume: null,
  parsedOutput: null,
  activeCategory: "All",
  debug: {
    mode: true,
    lastIntent: "none",
    lastEvidence: [],
    lastLatencyMs: 0,
    lastConfidence: 0
  }
};

const categories = ["All", "Backend", "Database", "Tools", "Communication"];
const candidateName = document.getElementById("candidateName");
const candidateRole = document.getElementById("candidateRole");
const candidateSummary = document.getElementById("candidateSummary");
const metaGrid = document.getElementById("metaGrid");
const experienceList = document.getElementById("experienceList");
const projectGrid = document.getElementById("projectGrid");
const filterChips = document.getElementById("filterChips");
const skillsGrid = document.getElementById("skillsGrid");
const suggestedQuestions = document.getElementById("suggestedQuestions");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const uploadState = document.getElementById("uploadState");
const resumeUpload = document.getElementById("resumeUpload");
const viewResumeButton = document.getElementById("viewResumeButton");
const resumeModal = document.getElementById("resumeModal");
const closeModalButton = document.getElementById("closeModalButton");
const viewerPoints = document.getElementById("viewerPoints");
const modalTitle = document.getElementById("modalTitle");
const voiceButton = document.getElementById("voiceButton");
const resumeFrame = document.getElementById("resumeFrame");
const parsedJsonOutput = document.getElementById("parsedJsonOutput");
const debugOutput = document.getElementById("debugOutput");
const chatApiEndpoint = resolveChatApiEndpoint();

initialize();

function initialize() {
  renderSuggestedQuestions();
  renderFilterChips();
  renderViewerStatus("Upload a PDF to preview the resume and inspect extracted evidence.");
  renderEmptyShell();
  renderParsedOutput();
  renderDebugOutput();
  bindEvents();
  addMessage({
    author: "Resume AI",
    role: "assistant",
    content: "Upload a resume PDF to begin. Chat answers are generated by the backend AI service and grounded only in the parsed resume JSON."
  });
}

function bindEvents() {
  filterChips.addEventListener("click", (event) => {
    const target = event.target.closest("[data-category]");
    if (!target) return;
    state.activeCategory = target.dataset.category;
    renderFilterChips();
    renderSkills();
  });

  suggestedQuestions.addEventListener("click", (event) => {
    const target = event.target.closest("[data-question]");
    if (!target) return;
    chatInput.value = target.dataset.question;
    chatInput.focus();
  });

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = chatInput.value.trim();
    if (!question) return;
    submitQuestion(question);
  });

  resumeUpload.addEventListener("change", handleFileUpload);
  viewResumeButton.addEventListener("click", openResumeModal);
  closeModalButton.addEventListener("click", closeResumeModal);
  resumeModal.addEventListener("click", (event) => {
    if (event.target.dataset.closeModal) closeResumeModal();
  });

  setupVoiceInput();
}

function renderEmptyShell() {
  candidateName.textContent = "Recruiter-ready resume assistant";
  candidateRole.textContent = "Waiting for an uploaded resume";
  candidateSummary.textContent = "Upload a PDF resume to extract structured JSON, compute explainable confidence scores, and enable trustworthy recruiter Q&A.";
  candidateSummary.classList.add("empty-copy");
  metaGrid.innerHTML = createEmptyState("No structured resume data yet", "The app will display cleaned JSON and recruiter-facing summaries after parsing.");
  experienceList.innerHTML = createEmptyState("Experience will appear here", "Roles, durations, and technologies will be normalized from the uploaded resume.");
  projectGrid.innerHTML = createEmptyState("Projects will appear here", "Project entries will list detected technologies and concise descriptions.");
  skillsGrid.innerHTML = createEmptyState("Skill dashboard is waiting for evidence", "Upload a resume to calculate skill confidence from mentions, projects, and experience.");
}

function renderResumeShell() {
  const resume = state.resume;
  candidateName.textContent = resume.name || "Unknown Candidate";
  candidateRole.textContent = resume.title || "Resume parsed from uploaded PDF";
  candidateSummary.textContent = resume.summary || "Resume parsed successfully.";
  candidateSummary.classList.remove("empty-copy");

  const totalYears = resume.experience.reduce((sum, item) => sum + (item.durationYears || 0), 0);
  const meta = [
    ["Experience", totalYears ? `${round(totalYears)} years inferred` : "Duration partially inferred"],
    ["Skills", `${resume.skills.length} normalized skills`],
    ["Projects", `${resume.projects.length} structured entries`],
    ["Education", `${resume.education.length} entries`],
    ["Top skill", resume.skills[0]?.name || "Not enough evidence"]
  ];

  metaGrid.innerHTML = meta.map(([label, value]) => `
    <div class="meta-card">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(value)}</span>
    </div>
  `).join("");

  experienceList.innerHTML = resume.experience.length
    ? resume.experience.map((item) => `
        <article class="timeline-item">
          <header>
            <div>
              <h4>${escapeHtml(item.role || "Experience Entry")}</h4>
              <strong>${escapeHtml(item.company || "Company not identified")}</strong>
            </div>
            <span>${escapeHtml(item.yearsLabel || "Duration unavailable")}</span>
          </header>
          <p>${escapeHtml(item.summary || "This information is not clearly present in the resume.")}</p>
        </article>
      `).join("")
    : createEmptyState("Experience section not clearly detected", "This information is not clearly present in the resume.");

  projectGrid.innerHTML = resume.projects.length
    ? resume.projects.map((project) => `
        <article class="project-card">
          <h4>${escapeHtml(project.name)}</h4>
          <p>${escapeHtml(project.description || "This information is not clearly present in the resume.")}</p>
          <div class="project-stack">${escapeHtml(project.techStack.join(", ") || "Tech stack not clearly present")}</div>
        </article>
      `).join("")
    : createEmptyState("Projects section not clearly detected", "This information is not clearly present in the resume.");

  renderSkills();
  renderParsedOutput();
}

function renderSkills() {
  const skills = state.resume?.skills || [];
  if (!skills.length) {
    skillsGrid.innerHTML = createEmptyState("Skill dashboard is waiting for evidence", "This information is not clearly present in the resume.");
    return;
  }

  const filtered = skills.filter((skill) => state.activeCategory === "All" || skill.category === state.activeCategory);
  if (!filtered.length) {
    skillsGrid.innerHTML = createEmptyState(`No ${state.activeCategory.toLowerCase()} skills found`, "This information is not clearly present in the resume.");
    return;
  }

  skillsGrid.innerHTML = filtered.map((skill) => `
    <article class="skill-card">
      <div class="skill-topline">
        <div>
          <h4>${escapeHtml(skill.name)}</h4>
          <div class="skill-copy">${escapeHtml(skill.category)}</div>
        </div>
        <div class="skill-score">${skill.confidence}%</div>
      </div>
      <div class="skill-progress">
        <div class="skill-progress-fill" style="width:${skill.confidence}%"></div>
      </div>
      <div class="skill-copy">${skill.mentions} mentions | ${skill.projectsUsingSkill} projects | ${skill.yearsLabel}</div>
      <div class="skill-badges">
        <span title="${escapeHtml(skill.explanation)}">Confidence explanation</span>
        <span class="tooltip" title="${escapeHtml(skill.explanation)}">?</span>
      </div>
    </article>
  `).join("");
}

function renderSuggestedQuestions() {
  suggestedQuestions.innerHTML = QUESTION_SUGGESTIONS.map((question) => `
    <button class="suggested-question" type="button" data-question="${escapeHtml(question)}">${escapeHtml(question)}</button>
  `).join("");
}

function renderFilterChips() {
  filterChips.innerHTML = categories.map((category) => `
    <button class="filter-chip ${state.activeCategory === category ? "active" : ""}" type="button" data-category="${category}">
      ${category}
    </button>
  `).join("");
}

function renderParsedOutput() {
  parsedJsonOutput.textContent = state.parsedOutput
    ? JSON.stringify(state.parsedOutput, null, 2)
    : JSON.stringify({
        name: "",
        skills: [],
        projects: [],
        experience: [],
        education: []
      }, null, 2);
}

function renderDebugOutput() {
  debugOutput.textContent = JSON.stringify({
    debugMode: state.debug.mode,
    detectedIntent: state.debug.lastIntent,
    evidenceUsed: state.debug.lastEvidence,
    answerConfidence: state.debug.lastConfidence,
    responseLatencyMs: state.debug.lastLatencyMs
  }, null, 2);
}

async function handleFileUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    addMessage({ author: "Resume AI", role: "assistant", content: "This build currently supports PDF parsing only. Please upload a PDF resume." });
    return;
  }

  state.uploadedFile = file;
  uploadState.textContent = `Parsing ${file.name}...`;
  modalTitle.textContent = file.name;
  setPreview(file);
  renderViewerStatus("Extracting text from the uploaded PDF...");

  try {
    const rawText = await extractTextFromPdf(file);
    const structuredResume = buildStructuredResume(rawText, file.name);
    state.resume = structuredResume;
    state.parsedOutput = buildDisplayJson(structuredResume);
    state.activeCategory = "All";
    uploadState.textContent = `Parsed ${file.name}`;
    renderViewerFromResume(structuredResume);
    renderResumeShell();
    renderFilterChips();
    clearChat();
    updateDebug("parse_complete", [`skills:${structuredResume.skills.length}`, `projects:${structuredResume.projects.length}`, `experience:${structuredResume.experience.length}`], 100, 0);
    addMessage({
      author: "Resume AI",
      role: "assistant",
      content: `Resume parsed successfully for <mark>${escapeHtml(structuredResume.name || file.name)}</mark>. The structured JSON below is now the single source of truth for the app, and chat questions will now be sent to the backend AI endpoint.`,
      confidence: 96
    });
    console.log("Parsed Resume Output", state.parsedOutput);
  } catch (error) {
    state.resume = null;
    state.parsedOutput = null;
    uploadState.textContent = `Could not parse ${file.name}`;
    renderEmptyShell();
    renderParsedOutput();
    updateDebug("parse_error", [String(error.message || error)], 0, 0);
    addMessage({
      author: "Resume AI",
      role: "assistant",
      content: `I could not parse that PDF cleanly. ${escapeHtml(error.message || "The PDF parser runtime may not be loading correctly in this browser context.")}`
    });
  }
}

async function extractTextFromPdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  const typedArray = new Uint8Array(arrayBuffer);
  if (window.pdfjsLib) {
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      const pdf = await pdfjsLib.getDocument({
        data: typedArray,
        useWorkerFetch: true,
        isEvalSupported: true,
        disableFontFace: false,
        verbosity: 0
      }).promise;
      const pages = [];

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const textContent = await page.getTextContent();
        let lastY = null;
        const chunks = [];
        for (const item of textContent.items) {
          if (!("str" in item)) continue;
          const y = item.transform?.[5];
          if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) chunks.push("\n");
          chunks.push(item.str);
          chunks.push(" ");
          lastY = y;
        }
        const pageText = chunks.join("")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n[ \t]+/g, "\n")
          .replace(/[ \t]{2,}/g, " ")
          .trim();
        if (pageText) pages.push(pageText);
      }

      const result = pages.join("\n");
      if (result.trim()) {
        return result;
      }
    } catch (error) {
      state.debug.lastEvidence = [`pdfjs_error:${error?.message || error}`];
      renderDebugOutput();
      console.warn("pdf.js extraction failed, falling back to raw PDF text extraction.", error);
    }
  }

  const fallbackText = extractTextFromPdfFallback(typedArray);
  if (!fallbackText.trim()) {
    throw new Error("The uploaded PDF could not be parsed into readable text.");
  }
  return fallbackText;
}

function buildStructuredResume(rawText, fileName) {
  const normalized = normalizeText(rawText);
  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  const sections = splitSections(lines);
  const name = extractName(lines, fileName);
  const title = extractTitle(lines, name);
  const baseSkills = detectSkills(normalized);
  const projects = parseProjects(sections.projects, lines, baseSkills);
  const experience = parseExperience(sections.experience, lines, baseSkills);
  const education = parseEducation(sections.education, lines);
  const skills = scoreSkills(baseSkills, normalized, projects, experience);
  const summary = buildSummary(name, title, skills, projects, experience);

  return {
    name,
    title,
    summary,
    rawText: normalized,
    skills,
    projects,
    experience,
    education
  };
}

function buildDisplayJson(resume) {
  return {
    name: resume.name || "",
    skills: resume.skills.map((skill) => ({
      name: skill.name,
      mentions: skill.mentions,
      category: skill.category
    })),
    projects: resume.projects.map((project) => ({
      name: project.name,
      techStack: project.techStack,
      description: project.description
    })),
    experience: resume.experience.map((entry) => ({
      role: entry.role,
      years: entry.yearsLabel,
      techUsed: entry.techUsed
    })),
    education: resume.education.map((entry) => entry.label)
  };
}

function extractTextFromPdfFallback(bytes) {
  const binaryText = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  const chunks = [
    ...extractPdfLiteralStrings(binaryText),
    ...extractPrintableRuns(binaryText)
  ]
    .map((value) => cleanFallbackText(value))
    .filter((value) => value.length > 2);

  const unique = [];
  for (const value of chunks) {
    if (!unique.includes(value)) {
      unique.push(value);
    }
  }

  const combined = unique.join("\n");
  if (!isUsableFallbackText(combined)) {
    throw new Error("The PDF uses encoded/compressed text that the fallback extractor cannot decode reliably. Please open the app through a local server so the full PDF parser can run, or export the resume as a text-based PDF.");
  }

  return combined;
}

function extractPdfLiteralStrings(binaryText) {
  const values = [];
  const regex = /\(([^()]|\\\(|\\\)|\\n|\\r|\\t|\\\\){3,}\)/g;
  let match;
  while ((match = regex.exec(binaryText)) !== null) {
    values.push(match[0].slice(1, -1));
  }
  return values;
}

function extractPrintableRuns(binaryText) {
  return binaryText.match(/[A-Za-z0-9@:/&(),.+#\-\s]{4,}/g) || [];
}

function cleanFallbackText(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\\\/g, "\\")
    .replace(/\/[A-Za-z0-9]+/g, " ")
    .replace(/\b(obj|endobj|stream|endstream|Type|Font|Page|Pages|Length|Filter|FlateDecode)\b/g, " ")
    .replace(/[^\x20-\x7E\n]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function isUsableFallbackText(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 8) {
    return false;
  }

  const resumeSignals = lines.filter((line) =>
    /(experience|project|education|skill|engineer|developer|technologies|summary|certification)/i.test(line)
  ).length;

  const wordTokens = text.match(/[A-Za-z]{3,}/g) || [];
  const strangeTokens = text.match(/\b[A-Za-z]{1,2}\s[A-Za-z]{1,2}\s[A-Za-z]{1,2}\b/g) || [];
  const punctuationNoise = text.match(/[{}[\]^`~|]{2,}/g) || [];

  const signalRatio = resumeSignals / lines.length;
  const gibberishRatio = strangeTokens.length / Math.max(wordTokens.length, 1);
  const noiseRatio = punctuationNoise.length / Math.max(lines.length, 1);

  return signalRatio > 0.08 && gibberishRatio < 0.06 && noiseRatio < 0.12;
}

function normalizeText(text) {
  return text
    .replace(/\r/g, "")
    .replace(/\u2022/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function splitSections(lines) {
  const sections = { summary: [], skills: [], projects: [], experience: [], education: [] };
  let current = "summary";
  for (const line of lines) {
    const lower = line.toLowerCase();
    const matched = Object.entries(SECTION_LABELS).find(([, labels]) => labels.some((label) => lower === label || lower.startsWith(`${label} `)));
    if (matched) {
      current = matched[0];
      continue;
    }
    sections[current]?.push(line);
  }
  return sections;
}

function extractName(lines, fileName) {
  return lines.slice(0, 8).find((line) => /^[A-Z][a-z]+(?: [A-Z][a-z]+){1,3}$/.test(line))
    || fileName.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
}

function extractTitle(lines, name) {
  return lines.slice(0, 12).find((line) => line !== name && /(engineer|developer|architect|manager|analyst|consultant|specialist)/i.test(line))
    || "Resume parsed from uploaded PDF";
}

function detectSkills(text) {
  return SKILL_LIBRARY
    .map((skill) => {
      const mentions = countMentions(text, skill.aliases);
      return mentions ? { name: skill.name, category: skill.category, aliases: skill.aliases, mentions } : null;
    })
    .filter(Boolean);
}

function parseProjects(projectLines, allLines, skills) {
  const source = projectLines.length ? projectLines : allLines.filter((line) => PROJECT_HINTS.some((hint) => line.toLowerCase().includes(hint)));
  if (!source.length) return [];

  const groups = groupEntries(source, (line) => looksLikeProjectBoundary(line));
  return groups.slice(0, 8).map((group, index) => {
    const full = group.join(" ");
    const techStack = collectTechnologies(full, skills);
    return {
      name: cleanText(group[0] || `Project ${index + 1}`),
      techStack,
      description: cleanText(group.slice(1).join(" ") || group[0] || "This information is not clearly present in the resume.")
    };
  }).filter((project) => project.name);
}

function parseExperience(experienceLines, allLines, skills) {
  const source = experienceLines.length ? experienceLines : allLines.filter((line) => EXPERIENCE_HINTS.some((hint) => line.toLowerCase().includes(hint)));
  if (!source.length) return [];

  const groups = groupEntries(source, (line) => looksLikeExperienceBoundary(line));
  return groups.slice(0, 10).map((group) => {
    const header = group[0] || "";
    const full = group.join(" ");
    const role = cleanText(group.find((line) => EXPERIENCE_HINTS.some((hint) => line.toLowerCase().includes(hint))) || header || "Role not clearly present");
    const company = cleanText(group.find((line) => /technologies|systems|labs|solutions|inc|llc|company|corp|limited/i.test(line) && line !== role) || "");
    const duration = extractDuration(full);
    return {
      role,
      company,
      durationYears: duration.years,
      durationMonths: duration.months,
      yearsLabel: duration.label,
      techUsed: collectTechnologies(full, skills),
      summary: cleanText(group.slice(1).join(" ") || header || "This information is not clearly present in the resume.")
    };
  }).filter((entry) => entry.role);
}

function parseEducation(educationLines, allLines) {
  const source = educationLines.length ? educationLines : allLines.filter((line) => /bachelor|master|b\.?tech|m\.?tech|university|college|school|institute/i.test(line));
  const groups = groupEntries(source, (line) => /bachelor|master|b\.?tech|m\.?tech|mba|bsc|msc|university|college|school|institute/i.test(line));
  return groups.slice(0, 4).map((group) => ({
    label: cleanText(group.join(" ") || "This information is not clearly present in the resume.")
  })).filter((entry) => entry.label);
}

function scoreSkills(skills, text, projects, experience) {
  return skills.map((skill) => {
    const projectsUsingSkill = projects.filter((project) => project.techStack.includes(skill.name)).length;
    const yearsExperience = round(experience
      .filter((entry) => entry.techUsed.includes(skill.name))
      .reduce((sum, entry) => sum + entry.durationYears, 0));
    const confidence = clamp((projectsUsingSkill * 20) + (yearsExperience * 25) + (skill.mentions * 5), 0, 100);
    const yearsLabel = yearsExperience ? `${yearsExperience} years` : "0 years";
    const explanation = `${skill.name}: ${confidence}% -> ${projectsUsingSkill} projects (${projectsUsingSkill * 20}) + ${yearsExperience} year exp (${yearsExperience * 25}) + mentions (${skill.mentions * 5})`;

    return {
      ...skill,
      projectsUsingSkill,
      yearsExperience,
      yearsLabel,
      confidence,
      explanation
    };
  }).sort((left, right) => right.confidence - left.confidence);
}

function buildSummary(name, title, skills, projects, experience) {
  const topSkills = skills.slice(0, 3).map((skill) => skill.name);
  return `${name || "This candidate"} is identified as ${title || "a technical professional"} with strongest evidence in ${joinList(topSkills)}. The parser found ${projects.length} project entries and ${experience.length} experience entries in the uploaded resume.`;
}

function groupEntries(lines, boundaryFn) {
  const groups = [];
  let current = [];
  for (const line of lines) {
    if (boundaryFn(line) && current.length) {
      groups.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

function looksLikeProjectBoundary(line) {
  return line.length < 90 && (PROJECT_HINTS.some((hint) => line.toLowerCase().includes(hint)) || /^[A-Z][A-Za-z0-9 .:/-]{3,60}$/.test(line));
}

function looksLikeExperienceBoundary(line) {
  return /\b(20\d{2}|19\d{2})\b/.test(line) || line.includes("|") || EXPERIENCE_HINTS.some((hint) => line.toLowerCase().includes(hint));
}

function collectTechnologies(text, skills) {
  return skills.filter((skill) => countMentions(text, skill.aliases) > 0).map((skill) => skill.name);
}

function extractDuration(text) {
  const rangeMatch = text.match(/(20\d{2}|19\d{2})\s*(?:-|to|–)\s*(present|current|20\d{2}|19\d{2})/i);
  if (!rangeMatch) return { years: 0, months: 0, label: "Duration unavailable" };
  const start = Number(rangeMatch[1]);
  const end = /present|current/i.test(rangeMatch[2]) ? new Date().getFullYear() : Number(rangeMatch[2]);
  const months = Math.max((end - start) * 12, 0);
  const years = round(months / 12 || 0);
  return {
    years,
    months,
    label: years ? `${years} years` : `${months} months`
  };
}

function submitQuestion(question) {
  addMessage({ author: "Recruiter", role: "user", content: escapeHtml(question) });
  chatInput.value = "";

  if (!state.resume) {
    addMessage({ author: "Resume AI", role: "assistant", content: "Upload a resume PDF first so I can answer from structured data instead of guessing." });
    return;
  }

  const typingId = addTypingMessage();
  const start = performance.now();
  requestChatAnswer(question)
    .then((result) => {
      const latency = Math.round(performance.now() - start);
      updateDebug("ai_backend", ["endpoint:/chat", "provider:backend-configured-llm", `resume_name:${state.parsedOutput?.name || "unknown"}`], result.confidence, latency);

      const parts = splitAnswerIntoParts(result.answer);
      const thinkingDelay = 500 + Math.min(parts.length * 220, 900);
      window.setTimeout(() => {
        removeTypingMessage(typingId);
        addStreamingMessage({
          author: "Resume AI",
          role: "assistant",
          parts,
          confidence: result.confidence,
          highlightTerms: collectHighlightTerms()
        });
      }, thinkingDelay);
    })
    .catch((error) => {
      const latency = Math.round(performance.now() - start);
      updateDebug("chat_error", [String(error.message || error)], 0, latency);
      removeTypingMessage(typingId);
      addMessage({
        author: "Resume AI",
        role: "assistant",
        content: `The backend chat service could not answer right now. ${escapeHtml(error.message || "Please verify the Node server is running and the configured Gemini or local provider is available.")}`
      });
    });
}

async function requestChatAnswer(question) {
  const response = await fetch(chatApiEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      question,
      resumeData: state.parsedOutput
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Backend request failed.");
  }

  if (typeof payload.answer !== "string") {
    throw new Error("Backend returned an invalid response payload.");
  }

  return {
    answer: payload.answer,
    confidence: Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : 50
  };
}

function resolveChatApiEndpoint() {
  const { protocol, hostname, port } = window.location;
  if (port === "3000") {
    return "/chat";
  }
  return `${protocol}//${hostname}:3000/chat`;
}

function splitAnswerIntoParts(answer) {
  const normalized = answer.replace(/\r/g, "").trim();
  const parts = normalized
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length) {
    return parts;
  }

  return normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function answerQuestion(question) {
  const intent = classifyIntent(question);
  const handlers = {
    skills: handleSkillsIntent,
    projects: handleProjectsIntent,
    experience: handleExperienceIntent,
    strengths: handleStrengthsIntent,
    general: handleGeneralIntent
  };
  return handlers[intent](question, intent);
}

function classifyIntent(question) {
  const normalized = question.toLowerCase();
  const scores = Object.entries(INTENT_RULES).map(([intent, terms]) => ({
    intent,
    score: terms.reduce((sum, term) => sum + (normalized.includes(term) ? 1 : 0), 0)
  }));
  scores.sort((left, right) => right.score - left.score);
  return scores[0].score > 0 ? scores[0].intent : "general";
}

function handleSkillsIntent(question, intent) {
  const relevantSkills = matchSkillsFromQuestion(question);
  const category = matchCategoryFromQuestion(question);
  const selectedSkills = relevantSkills.length
    ? relevantSkills
    : category
      ? state.resume.skills.filter((skill) => skill.category === category)
      : state.resume.skills.slice(0, 5);

  if (!selectedSkills.length) {
    return fallbackResult(intent, "This information is not clearly present in the resume.");
  }

  if (category) {
    state.activeCategory = category;
    renderFilterChips();
    renderSkills();
  }

  const parts = selectedSkills.slice(0, 5).map((skill) => `${skill.name} is scored at ${skill.confidence}%. ${skill.explanation}.`);
  return buildResult(intent, parts, selectedSkills.map((skill) => `skill:${skill.name}`), computeAnswerConfidence(selectedSkills.length, selectedSkills.length, parts.length));
}

function handleProjectsIntent(question, intent) {
  const relevantSkills = matchSkillsFromQuestion(question);
  const projects = relevantSkills.length
    ? state.resume.projects.filter((project) => relevantSkills.some((skill) => project.techStack.includes(skill.name)))
    : state.resume.projects;

  if (!projects.length) {
    return fallbackResult(intent, "This information is not clearly present in the resume.");
  }

  const parts = projects.slice(0, 4).map((project) => `${project.name} used ${joinList(project.techStack)}. ${project.description}`);
  return buildResult(intent, parts, projects.slice(0, 4).map((project) => `project:${project.name}`), computeAnswerConfidence(projects.length, relevantSkills.length || 1, parts.length));
}

function handleExperienceIntent(question, intent) {
  const relevantSkills = matchSkillsFromQuestion(question);
  const category = matchCategoryFromQuestion(question);
  const experience = state.resume.experience.filter((entry) => {
    if (relevantSkills.length) return relevantSkills.some((skill) => entry.techUsed.includes(skill.name));
    if (category) return state.resume.skills.some((skill) => skill.category === category && entry.techUsed.includes(skill.name));
    return true;
  });

  if (!experience.length) {
    return fallbackResult(intent, "This information is not clearly present in the resume.");
  }

  const parts = experience.slice(0, 4).map((entry) => `${entry.role}${entry.company ? ` at ${entry.company}` : ""} shows ${entry.yearsLabel} of evidence using ${joinList(entry.techUsed) || "resume-detected technologies"}. ${entry.summary}`);
  return buildResult(intent, parts, experience.slice(0, 4).map((entry) => `experience:${entry.role}`), computeAnswerConfidence(experience.length, relevantSkills.length || 1, parts.length));
}

function handleStrengthsIntent(question, intent) {
  const relevantSkills = matchSkillsFromQuestion(question);
  const strongest = (relevantSkills.length ? relevantSkills : state.resume.skills.slice(0, 4)).slice(0, 4);
  if (!strongest.length) {
    return fallbackResult(intent, "This information is not clearly present in the resume.");
  }

  const parts = [
    `The strongest evidence in the resume is around ${joinList(strongest.map((skill) => skill.name))}.`,
    ...strongest.map((skill) => `${skill.name} is supported by ${skill.projectsUsingSkill} projects, ${skill.yearsExperience} years of related experience, and ${skill.mentions} mentions.`)
  ];
  return buildResult(intent, parts, strongest.map((skill) => `strength:${skill.name}`), computeAnswerConfidence(strongest.length, strongest.length, parts.length));
}

function handleGeneralIntent(question, intent) {
  const overviewParts = [];
  if (state.resume.skills.length) {
    overviewParts.push(`Top skills detected are ${joinList(state.resume.skills.slice(0, 3).map((skill) => skill.name))}.`);
  }
  if (state.resume.projects.length) {
    overviewParts.push(`Projects parsed include ${joinList(state.resume.projects.slice(0, 2).map((project) => project.name))}.`);
  }
  if (state.resume.experience.length) {
    overviewParts.push(`Experience evidence includes ${joinList(state.resume.experience.slice(0, 2).map((entry) => entry.role))}.`);
  }

  if (!overviewParts.length) {
    return fallbackResult(intent, "This information is not clearly present in the resume.");
  }

  return buildResult(intent, overviewParts, ["overview:skills", "overview:projects", "overview:experience"], computeAnswerConfidence(overviewParts.length, 3, overviewParts.length));
}

function buildResult(intent, parts, evidence, confidence) {
  updateDebug(intent, evidence, confidence, state.debug.lastLatencyMs);
  return { intent, parts, evidence, confidence };
}

function fallbackResult(intent, message) {
  return buildResult(intent, [message], ["fallback:no_clear_data"], 35);
}

function computeAnswerConfidence(dataAvailability, relevanceMatch, completeness) {
  const availabilityScore = clamp((dataAvailability / Math.max(state.resume.skills.length + state.resume.projects.length + state.resume.experience.length, 1)) * 40, 10, 40);
  const relevanceScore = clamp(relevanceMatch * 20, 10, 35);
  const completenessScore = clamp(completeness * 8, 10, 25);
  return Math.round(clamp(availabilityScore + relevanceScore + completenessScore, 0, 100));
}

function matchSkillsFromQuestion(question) {
  const normalized = question.toLowerCase();
  return state.resume.skills.filter((skill) => normalized.includes(skill.name.toLowerCase()) || skill.aliases.some((alias) => normalized.includes(alias.toLowerCase())));
}

function matchCategoryFromQuestion(question) {
  const normalized = question.toLowerCase();
  return categories.find((category) => category !== "All" && normalized.includes(category.toLowerCase())) || null;
}

function collectHighlightTerms() {
  const terms = new Set();
  (state.resume.skills || []).forEach((skill) => terms.add(skill.name));
  (state.resume.projects || []).forEach((project) => {
    terms.add(project.name);
    project.techStack.forEach((item) => terms.add(item));
  });
  (state.resume.experience || []).forEach((entry) => {
    terms.add(entry.role);
    if (entry.company) terms.add(entry.company);
  });
  return Array.from(terms).filter(Boolean).sort((a, b) => b.length - a.length);
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
}

function addStreamingMessage({ author, role, parts, confidence, highlightTerms }) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.innerHTML = `
    <div class="message-avatar"></div>
    <div class="message-body">
      <div class="message-meta">
        <span class="message-author">${escapeHtml(author)}</span>
        <span class="message-time">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      <div class="message-content"></div>
      <div class="answer-confidence">
        <div class="confidence-header">
          <span>Answer Confidence</span>
          <strong class="confidence-value">${confidence}%</strong>
        </div>
        <div class="confidence-track">
          <div class="confidence-fill" style="width:0%"></div>
        </div>
      </div>
    </div>
  `;
  chatMessages.appendChild(article);
  const contentNode = article.querySelector(".message-content");
  const fillNode = article.querySelector(".confidence-fill");
  requestAnimationFrame(() => {
    fillNode.style.width = `${confidence}%`;
  });

  parts.forEach((part, index) => {
    window.setTimeout(() => {
      const line = document.createElement("span");
      line.className = "stream-line";
      line.innerHTML = highlightTermsInText(part, highlightTerms);
      contentNode.appendChild(line);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }, index * 160);
  });
}

function addTypingMessage() {
  const id = `typing-${Date.now()}`;
  addMessage({
    author: "Resume AI",
    role: "assistant",
    content: `<span id="${id}" class="typing-shell">Analyzing structured resume data<span class="typing-dots"><span></span><span></span><span></span></span></span>`
  });
  return id;
}

function removeTypingMessage(id) {
  document.getElementById(id)?.closest(".message")?.remove();
}

function clearChat() {
  chatMessages.innerHTML = "";
}

function openResumeModal() {
  if (!state.uploadedFile) renderViewerStatus("Upload a PDF to preview the resume and inspect extracted evidence.");
  resumeModal.classList.remove("hidden");
  resumeModal.setAttribute("aria-hidden", "false");
}

function closeResumeModal() {
  resumeModal.classList.add("hidden");
  resumeModal.setAttribute("aria-hidden", "true");
}

function renderViewerStatus(message) {
  viewerPoints.innerHTML = `<li>${escapeHtml(message)}</li>`;
}

function renderViewerFromResume(resume) {
  viewerPoints.innerHTML = [
    `${resume.name || "Candidate name"} extracted from the uploaded PDF.`,
    `${resume.skills.length} normalized skills with mention counts.`,
    `${resume.projects.length} projects with technology stacks.`,
    `${resume.experience.length} experience entries with durations and technologies.`
  ].map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function setPreview(file) {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  resumeFrame.src = state.previewUrl;
  resumeFrame.classList.remove("hidden");
  resumeFrame.classList.add("is-ready");
}

function updateDebug(intent, evidence, confidence, latencyMs) {
  state.debug.lastIntent = intent;
  state.debug.lastEvidence = evidence;
  state.debug.lastConfidence = confidence;
  state.debug.lastLatencyMs = latencyMs;
  renderDebugOutput();
}

function countMentions(text, aliases) {
  return aliases.reduce((sum, alias) => {
    const matches = text.match(new RegExp(`\\b${escapeRegExp(alias)}\\b`, "gi"));
    return sum + (matches ? matches.length : 0);
  }, 0);
}

function highlightTermsInText(text, terms) {
  let output = escapeHtml(text);
  for (const term of terms.slice(0, 40)) {
    const safe = escapeRegExp(term);
    output = output.replace(new RegExp(`\\b(${safe})\\b`, "gi"), "<mark>$1</mark>");
  }
  return output;
}

function createEmptyState(title, body) {
  return `<div class="empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span></div>`;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/^[,|:;\- ]+|[,|:;\- ]+$/g, "").trim();
}

function joinList(items) {
  const values = items.filter(Boolean);
  if (!values.length) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setupVoiceInput() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    voiceButton.disabled = true;
    voiceButton.title = "Voice input is not supported in this browser";
    return;
  }

  const recognition = new Recognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;

  voiceButton.addEventListener("click", () => {
    voiceButton.classList.add("listening");
    recognition.start();
  });

  recognition.addEventListener("result", (event) => {
    chatInput.value = event.results[0][0].transcript;
    voiceButton.classList.remove("listening");
  });

  recognition.addEventListener("end", () => {
    voiceButton.classList.remove("listening");
  });

  recognition.addEventListener("error", () => {
    voiceButton.classList.remove("listening");
  });
}
