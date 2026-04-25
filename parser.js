const SKILL_LIBRARY = [
  { name: "Java", category: "backend", aliases: ["java"] },
  { name: "Spring Boot", category: "backend", aliases: ["spring boot", "springboot", "spring"] },
  { name: "Microservices", category: "backend", aliases: ["microservices", "microservice"] },
  { name: "REST APIs", category: "backend", aliases: ["rest api", "restful api", "api"] },
  { name: "Integration Development", category: "backend", aliases: ["integration development", "integration developer", "integration solutions", "system integration", "application integration"] },
  { name: "Dell Boomi", category: "tools", aliases: ["dell boomi", "boomi"] },
  { name: "ETL", category: "tools", aliases: ["etl", "extract transform load"] },
  { name: "SOAP", category: "backend", aliases: ["soap", "soap api", "soap web services"] },
  { name: "XML", category: "other", aliases: ["xml"] },
  { name: "JSON", category: "other", aliases: ["json"] },
  { name: "XSLT", category: "other", aliases: ["xslt"] },
  { name: "EDI", category: "other", aliases: ["edi"] },
  { name: "SAP", category: "tools", aliases: ["sap"] },
  { name: "MuleSoft", category: "tools", aliases: ["mulesoft", "mule soft"] },
  { name: "Node.js", category: "backend", aliases: ["node.js", "nodejs"] },
  { name: "Python", category: "backend", aliases: ["python"] },
  { name: "React", category: "frontend", aliases: ["react"] },
  { name: "JavaScript", category: "frontend", aliases: ["javascript", "js"] },
  { name: "TypeScript", category: "frontend", aliases: ["typescript", "ts"] },
  { name: "SQL", category: "database", aliases: ["sql"] },
  { name: "MySQL", category: "database", aliases: ["mysql"] },
  { name: "PostgreSQL", category: "database", aliases: ["postgresql", "postgres"] },
  { name: "MongoDB", category: "database", aliases: ["mongodb", "mongo db", "mongo"] },
  { name: "Redis", category: "database", aliases: ["redis"] },
  { name: "Docker", category: "tools", aliases: ["docker"] },
  { name: "Kubernetes", category: "tools", aliases: ["kubernetes", "k8s"] },
  { name: "Kafka", category: "tools", aliases: ["kafka"] },
  { name: "AWS", category: "tools", aliases: ["aws", "amazon web services"] },
  { name: "Git", category: "tools", aliases: ["git", "github", "gitlab"] },
  { name: "Jenkins", category: "tools", aliases: ["jenkins"] },
  { name: "CI/CD", category: "tools", aliases: ["ci/cd", "continuous integration", "continuous delivery"] }
];

const FEATURE_LIBRARY = ["JWT", "OAuth", "Microservices", "REST APIs", "RBAC", "Docker", "Kafka", "Redis", "CI/CD", "Dell Boomi", "ETL", "SOAP", "XML", "JSON", "EDI", "SAP"];
const SECTION_LABELS = {
  summary: ["summary", "profile", "professional summary", "about"],
  skills: ["skills", "technical skills", "technologies", "tech stack"],
  projects: ["projects", "project experience", "key projects"],
  experience: ["experience", "work experience", "professional experience", "employment"],
  education: ["education", "academic"]
};

export async function extractResumeText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const typedArray = new Uint8Array(arrayBuffer);

  if (window.pdfjsLib) {
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
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
          chunks.push("\n");
        }
        chunks.push(item.str);
        chunks.push(" ");
        lastY = y;
      }
      const pageText = chunks.join("")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      if (pageText) {
        pages.push(pageText);
      }
    }

    const text = pages.join("\n").trim();
    if (!text) {
      throw new Error("The uploaded PDF does not contain extractable text.");
    }
    return text;
  }

  throw new Error("PDF parser library is unavailable.");
}

export function parseResumeText(rawText, fileName) {
  const normalizedText = normalizeText(rawText);
  const lines = normalizedText.split("\n").map((line) => line.trim()).filter(Boolean);
  const sections = splitSections(lines);
  const detectedSkills = detectSkills(normalizedText);
  const projects = parseProjects(sections.projects, lines, detectedSkills);
  const experience = parseExperience(sections.experience, lines, detectedSkills);
  const ensuredProjects = projects.length ? projects : deriveProjectsFromExperience(experience);
  const skills = enrichSkills(detectedSkills, ensuredProjects, experience);
  const strengths = deriveStrengths(skills);

  return {
    name: extractName(lines, fileName),
    summary: buildSummary(lines, sections.summary, skills, ensuredProjects, experience),
    contactDetails: extractContactDetails(normalizedText),
    skills,
    projects: ensuredProjects,
    experience,
    education: parseEducation(sections.education, lines),
    strengths
  };
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
    const entry = Object.entries(SECTION_LABELS).find(([, labels]) => labels.some((label) => lower === label || lower.startsWith(`${label} `)));
    if (entry) {
      current = entry[0];
      continue;
    }
    sections[current].push(line);
  }

  return sections;
}

function detectSkills(text) {
  return SKILL_LIBRARY
    .map((skill) => {
      const mentions = countMentions(text, skill.aliases);
      if (!mentions) return null;
      return {
        name: skill.name,
        category: skill.category,
        aliases: skill.aliases,
        mentions,
        experience_years: 0,
        projects: []
      };
    })
    .filter(Boolean);
}

function parseProjects(projectLines, allLines, skills) {
  const source = projectLines.length
    ? projectLines
    : allLines.filter((line) => /(project|platform|service|dashboard|portal|application|system)/i.test(line));

  if (!source.length) {
    return [];
  }

  return groupEntries(source, looksLikeProjectBoundary)
    .slice(0, 8)
    .map((group, index) => {
      const text = group.join(" ");
      const techStack = collectSkillNames(text, skills);
      const features = FEATURE_LIBRARY.filter((feature) => new RegExp(`\\b${escapeRegExp(feature)}\\b`, "i").test(text));
      return {
        name: cleanText(group[0] || `Project ${index + 1}`),
        description: cleanText(group.slice(1).join(" ") || group[0] || "This information is not clearly available in the provided resumes."),
        techStack,
        features,
        complexity: inferComplexity(text, techStack, features)
      };
    })
    .filter((project) => project.name);
}

function parseExperience(experienceLines, allLines, skills) {
  const source = experienceLines.length
    ? experienceLines
    : allLines.filter((line) => /(engineer|developer|architect|manager|analyst|consultant|intern|specialist)/i.test(line));

  if (!source.length) {
    return [];
  }

  return groupEntries(source, looksLikeExperienceBoundary)
    .slice(0, 10)
    .map((group) => {
      const text = group.join(" ");
      const role = cleanText(group.find((line) => /(engineer|developer|architect|manager|analyst|consultant|intern)/i.test(line)) || group[0] || "Role not clearly present");
      const company = cleanText(group.find((line) => /(technologies|systems|labs|solutions|inc|llc|corp|limited|company)/i.test(line) && !line.includes(role)) || "");
      const duration = extractDuration(text);
      const responsibilities = group.slice(1, 8).map(cleanText).filter((line) => line && line.length > 10);
      return {
        company,
        role,
        duration: duration.label,
        duration_years: duration.years,
        responsibilities,
        techUsed: collectSkillNames(text, skills)
      };
    })
    .filter((entry) => entry.role);
}

function parseEducation(educationLines, allLines) {
  const source = educationLines.length
    ? educationLines
    : allLines.filter((line) => /(bachelor|master|b\.?tech|m\.?tech|mba|bsc|msc|college|university|school|institute)/i.test(line));

  return groupEntries(source, (line) => /(bachelor|master|b\.?tech|m\.?tech|mba|bsc|msc|college|university|school|institute)/i.test(line))
    .slice(0, 4)
    .map((group) => ({ label: cleanText(group.join(" ")) }))
    .filter((entry) => entry.label);
}

function enrichSkills(skills, projects, experience) {
  return skills
    .map((skill) => {
      const relatedProjects = projects
        .filter((project) => project.techStack.includes(skill.name) || project.features.includes(skill.name))
        .map((project) => project.name);
      const experienceYears = round(
        experience
          .filter((entry) => entry.techUsed.includes(skill.name))
          .reduce((sum, entry) => sum + entry.duration_years, 0)
      );

      return {
        name: skill.name,
        category: skill.category,
        mentions: skill.mentions,
        experience_years: experienceYears,
        projects: relatedProjects
      };
    })
    .sort((left, right) => skillRank(right) - skillRank(left));
}

function deriveStrengths(skills) {
  return skills.slice(0, 5).map((skill) => skill.name);
}

function buildSummary(lines, summaryLines, skills, projects, experience) {
  const explicitSummary = summaryLines.find((line) => line.length > 30);
  if (explicitSummary) {
    return explicitSummary;
  }

  const headline = lines.find((line) => /(engineer|developer|architect|manager|analyst|consultant|specialist)/i.test(line)) || "Technical candidate";
  const topSkills = deriveStrengths(skills).slice(0, 3);
  return `${headline} with strongest evidence in ${joinList(topSkills)}. Parsed ${projects.length} projects and ${experience.length} experience entries for recruiter review.`;
}

function deriveProjectsFromExperience(experience) {
  return experience
    .filter((entry) => entry.responsibilities.length || entry.techUsed.length)
    .slice(0, 6)
    .map((entry, index) => ({
      name: `${entry.role} Workstream ${index + 1}`,
      description: entry.responsibilities.join(" ") || "This information is not clearly available in the provided resumes.",
      techStack: entry.techUsed,
      features: FEATURE_LIBRARY.filter((feature) => new RegExp(`\\b${escapeRegExp(feature)}\\b`, "i").test(entry.responsibilities.join(" "))),
      complexity: inferComplexity(entry.responsibilities.join(" "), entry.techUsed, [])
    }));
}

function extractName(lines, fileName) {
  return lines.slice(0, 8).find((line) => /^[A-Z][a-z]+(?: [A-Z][a-z]+){1,3}$/.test(line))
    || fileName.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
}

function extractContactDetails(text) {
  const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0] || null;
  const phone = text.match(/(?:\+91[\s-]?)?(?:\(?\d{3,5}\)?[\s-]?)?\d{3}[\s-]?\d{3,4}[\s-]?\d{3,4}/)?.[0] || null;
  const linkedin = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[A-Za-z0-9\-_/]+/i)?.[0] || null;
  const github = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9\-_/]+/i)?.[0] || null;
  return {
    email: cleanText(email),
    phone: cleanText(phone),
    linkedin: cleanText(linkedin),
    github: cleanText(github)
  };
}

function collectSkillNames(text, skills) {
  return skills.filter((skill) => skill.aliases ? countMentions(text, skill.aliases) > 0 : countMentions(text, [skill.name]) > 0).map((skill) => skill.name);
}

function inferComplexity(text, techStack, features) {
  const normalized = text.toLowerCase();
  if (techStack.length >= 4 || features.length >= 3 || /(distributed|scalable|orchestration|multi-tenant|high volume)/i.test(normalized)) {
    return "high";
  }
  if (techStack.length >= 2 || features.length >= 1 || normalized.split(" ").length > 24) {
    return "medium";
  }
  return "low";
}

function extractDuration(text) {
  const match = text.match(/(20\d{2}|19\d{2})\s*(?:-|to|–)\s*(present|current|20\d{2}|19\d{2})/i);
  if (!match) {
    return { years: 0, label: "Duration unavailable" };
  }
  const start = Number(match[1]);
  const end = /present|current/i.test(match[2]) ? new Date().getFullYear() : Number(match[2]);
  const years = round(Math.max(end - start, 0));
  return {
    years,
    label: years ? `${years} years` : "Less than 1 year"
  };
}

function looksLikeProjectBoundary(line) {
  return line.length < 90 && (/^[A-Z][A-Za-z0-9 .:/-]{3,60}$/.test(line) || /(project|platform|service|dashboard|application|system)/i.test(line));
}

function looksLikeExperienceBoundary(line) {
  return /\b(20\d{2}|19\d{2})\b/.test(line) || /(engineer|developer|architect|manager|analyst|consultant|intern)/i.test(line);
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

  if (current.length) {
    groups.push(current);
  }

  return groups;
}

function countMentions(text, aliases) {
  return aliases.reduce((sum, alias) => {
    const matches = text.match(new RegExp(`\\b${escapeRegExp(alias)}\\b`, "gi"));
    return sum + (matches ? matches.length : 0);
  }, 0);
}

function skillRank(skill) {
  return skill.mentions + (skill.experience_years * 2) + (skill.projects.length * 1.5);
}

function joinList(items) {
  if (!items.length) return "relevant technical skills";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/^[,|:;\- ]+|[,|:;\- ]+$/g, "").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
