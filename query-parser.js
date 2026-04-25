const ROLE_ALIASES = [
  { role: "backend", terms: ["backend", "java developer", "spring boot", "microservices", "api developer"] },
  { role: "integration", terms: ["integration", "boomi", "middleware", "etl", "soap", "edi"] },
  { role: "guidewire", terms: ["guidewire", "claimcenter", "gosu", "policycenter"] },
  { role: "frontend", terms: ["frontend", "react", "ui developer", "javascript", "typescript"] },
  { role: "sales", terms: ["sales", "sales developer", "sales officer", "crm", "lead generation", "salesforce"] },
  { role: "accounting", terms: ["accounting", "finance", "reconciliation", "ledger", "audit"] },
  { role: "operations", terms: ["operations", "ops", "workflow", "dispatch", "vendor"] },
  { role: "data", terms: ["data engineer", "etl", "sql", "analytics", "reporting"] }
];

const SKILL_ALIASES = [
  ["dell boomi", "Dell Boomi"],
  ["boomi", "Dell Boomi"],
  ["java", "Java"],
  ["spring boot", "Spring Boot"],
  ["microservices", "Microservices"],
  ["sql", "SQL"],
  ["python", "Python"],
  ["guidewire", "Guidewire"],
  ["gosu", "Gosu"],
  ["salesforce", "Salesforce"],
  ["crm", "CRM"],
  ["lead generation", "Lead Generation"],
  ["react", "React"],
  ["node.js", "Node.js"],
  ["etl", "ETL"],
  ["soap", "SOAP"],
  ["edi", "EDI"],
  ["xml", "XML"],
  ["sap", "SAP"]
];

const LOCATIONS = [
  "Jaipur", "Delhi", "Gurugram", "Noida", "Bengaluru", "Bangalore", "Mumbai", "Pune",
  "Hyderabad", "Chennai", "Kolkata", "Ahmedabad", "Indore", "Bhopal", "Chandigarh", "Lucknow",
  "Surat", "Nagpur", "Kochi", "Trivandrum", "Coimbatore", "Mysore", "Gandhinagar"
];

const NCR_LOCATIONS = ["Delhi", "Noida", "Gurugram", "Gurgaon", "Greater Noida", "Faridabad", "Ghaziabad"];

export function parseRecruiterQuery(question, session = {}) {
  const normalized = String(question || "").toLowerCase();
  const exactName = detectExactName(question);
  const locationMatch = detectLocation(question);
  const salary = /\bsalary|ctc|compensation|pay|package\b/i.test(normalized);
  const exclusion = /\b(other|apart from|besides|excluding|except|any other|another|remaining|else)\b/i.test(normalized) && /\b(these|those|them|candidates|profiles|shortlist|two|one|selected)\b/i.test(normalized);
  const comparison = /\b(compare|comparison|vs|versus|which one|among them|between them|between these two|between those two|who is better|who's better)\b/i.test(normalized);
  const explicitSingle = (
    /\b(one|just one|single)\b/i.test(normalized)
    || /\bonly one\b/i.test(normalized)
  ) && !comparison;
  const singularReference = /\b(he|she|him|her|that candidate|this candidate|selected candidate)\b/i.test(normalized);
  const pluralReference = /\b(they|them|their|those candidates|these candidates|both|both of them|these two|those two)\b/i.test(normalized);
  const shortlistReference = /\b(earlier|previous|prior|before|provided earlier|provided before|profiles you provided earlier|shortlist you provided earlier|profiles provided earlier|current shortlist|the shortlist)\b/i.test(normalized);
  const searchAgain = /\b(search again|search once more|search one more time|try again|please search again|do search again)\b/i.test(normalized);
  const followUp = singularReference || pluralReference || shortlistReference;
  const contact = /\b(contact|email|phone|mobile|reach|linkedin|github)\b/i.test(normalized);
  const project = /\b(projects?|worked on|built|build)\b/i.test(normalized);
  const locationAnalytics = /\b(which locations|what locations|where (?:are|is)|locations? (?:are )?available|available locations|cities? (?:are )?available|available in which locations|how many candidates from each city|distribution by location|distribution by city)\b/i.test(normalized);
  const shouldReuseSessionContext = Boolean(session?.filters?.role)
    && (followUp || searchAgain || contact || project || salary || exclusion || comparison || explicitSingle);
  const role = detectRole(normalized) || (shouldReuseSessionContext ? session.filters?.role : null);
  const skills = detectSkills(normalized);
  const experience = detectExperience(normalized);
  const experienceRange = detectExperienceRange(question);
  const location = locationMatch || (shouldReuseSessionContext ? session.filters?.location : null);
  const locations = detectLocations(question, session, shouldReuseSessionContext);
  const locationFilterSearch = Boolean(locationMatch || locations.length)
    && /\b(from|in|based in|located in|belong|belongs|belonging|filter|only)\b/i.test(normalized)
    && /\b(candidate|candidates|profile|profiles|developer|developers)\b/i.test(normalized);
  const inferredCandidateSearch = Boolean(
    role
    || skills.length
    || experience
    || experienceRange
    || location
    || locations.length
    || /\b(best|top|strongest match|shortlist)\b/i.test(normalized)
  );
  const availability = (
    /\b(do we have|any candidate|any profile|available|profiles for|do we have any|show profiles|give me profiles)\b/i.test(normalized)
    || /\b(give me|show me|list|find|need|want|looking for)\b.*\b(profile|profiles|candidate|candidates|developer|developers)\b/i.test(normalized)
    || /\b(multiple|few|several|more than one)\b.*\b(profile|profiles|candidate|candidates|developer|developers)\b/i.test(normalized)
  ) && !project;

  const intent = exactName
    ? "exact_name"
    : salary
    ? "salary"
    : contact
      ? "contact"
      : project
        ? "project"
        : comparison
          ? "comparison"
          : exclusion
            ? "exclusion"
          : locationFilterSearch
            ? "location_filter_search"
          : locationAnalytics
            ? "location_analytics"
          : availability || explicitSingle || inferredCandidateSearch
            ? "candidate_search"
              : "general";

  return {
    role,
    skills,
    experience,
    location,
    locations,
    experienceRange,
    salary,
    exclusion,
    comparison,
    explicitSingle,
    exactNameQuery: Boolean(exactName),
    followUp,
    searchAgain,
    singularReference,
    pluralReference,
    shortlistReference,
    contact,
    project,
    locationFilterSearch,
    locationAnalytics,
    availability,
    intent,
    exactName,
    filters: {
      ...(role ? { role } : {}),
      ...(skills.length ? { skills } : {}),
      ...(experience ? { experience } : {}),
      ...(location ? { location } : {}),
      ...(Array.isArray(locations) && locations.length ? { locations } : {}),
      ...(experienceRange ? { experienceRange } : {})
    }
  };
}

export function mergeFilters(previous = {}, current = {}) {
  const merged = { ...previous, ...current };
  if (Array.isArray(previous.skills) || Array.isArray(current.skills)) {
    const nextSkills = [...new Set([...(previous.skills || []), ...(current.skills || [])])];
    merged.skills = nextSkills;
  }
  return merged;
}

export function isCandidateReference(question) {
  return /\b(he|she|him|her|that candidate|this candidate|them|their)\b/i.test(String(question || "").toLowerCase());
}

export function buildSearchText(question, filters = {}, session = {}, parsed = {}) {
  const parts = [question];
  if (filters.role) parts.push(filters.role);
  if (Array.isArray(filters.skills)) parts.push(...filters.skills);
  if (filters.experience) parts.push(`${filters.experience} years`);
  if (filters.location) parts.push(filters.location);
  if (filters.experienceRange) {
    parts.push(`${filters.experienceRange.min || ""} to ${filters.experienceRange.max || ""} years`);
  }
  if (Array.isArray(filters.locations)) parts.push(...filters.locations);
  if ((parsed.followUp || parsed.comparison || parsed.explicitSingle || parsed.contact || parsed.project || parsed.salary || parsed.exclusion || parsed.searchAgain) && session.lastQuery) {
    parts.push(session.lastQuery);
  }
  if ((parsed.followUp || parsed.comparison || parsed.contact || parsed.project || parsed.salary || parsed.exclusion || parsed.searchAgain) && session.summary) {
    parts.push(session.summary);
  }
  if (parsed.searchAgain && session.searchContext) {
    if (session.searchContext.lastQuery) parts.push(session.searchContext.lastQuery);
    if (session.searchContext.summary) parts.push(session.searchContext.summary);
    if (session.searchContext.role) parts.push(session.searchContext.role);
    if (Array.isArray(session.searchContext.skills)) parts.push(...session.searchContext.skills);
  }
  return parts.filter(Boolean).join(" ");
}

export function shouldReturnSingleCandidate(parsed, session = {}) {
  if (parsed.explicitSingle) return true;
  return /\b(one candidate|one name|just give one|only one|single candidate)\b/i.test(String(session.lastQuery || "").toLowerCase());
}

export function inferMinimumExperience(question) {
  const match = String(question || "").match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:year|years)/i);
  return match ? Number(match[1]) : 0;
}

function detectRole(normalized) {
  for (const entry of ROLE_ALIASES) {
    if (entry.terms.some((term) => normalized.includes(term))) {
      return entry.role;
    }
  }
  return null;
}

function detectSkills(normalized) {
  const matches = [];
  for (const [needle, label] of SKILL_ALIASES) {
    if (normalized.includes(needle)) {
      matches.push(label);
    }
  }
  return [...new Set(matches)];
}

function detectExperience(normalized) {
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:year|years)/i);
  return match ? Number(match[1]) : null;
}

function detectExperienceRange(question) {
  const text = String(question || "").toLowerCase();
  const rangePatterns = [
    /(\d+(?:\.\d+)?)\s*(?:to|-|and)\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)?(?:\s+of\s+experience|\s+experience|\s+exp)?/i,
    /between\s+(\d+(?:\.\d+)?)\s*(?:and|to)\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)?(?:\s+of\s+experience|\s+experience|\s+exp)?/i,
    /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)?(?:\s+of\s+experience|\s+experience|\s+exp)?/i
  ];

  for (const pattern of rangePatterns) {
    const match = text.match(pattern);
    if (match) {
      const min = Number(match[1]);
      const max = Number(match[2]);
      if (Number.isFinite(min) && Number.isFinite(max)) {
        return {
          min: Math.min(min, max),
          max: Math.max(min, max)
        };
      }
    }
  }

  const greaterThan = text.match(/\b(?:more than|over|greater than|above|at least|minimum of)\s+(\d+(?:\.\d+)?)\s*(?:years?|yrs?)?(?:\s+of\s+experience|\s+experience|\s+exp)?/i);
  if (greaterThan) {
    const min = Number(greaterThan[1]);
    if (Number.isFinite(min)) {
      return {
        min: roundToStrictLowerBound(min),
        max: null
      };
    }
  }

  const lessThan = text.match(/\b(?:less than|under|below|up to|max(?:imum)? of|at most)\s+(\d+(?:\.\d+)?)\s*(?:years?|yrs?)?(?:\s+of\s+experience|\s+experience|\s+exp)?/i);
  if (lessThan) {
    const max = Number(lessThan[1]);
    if (Number.isFinite(max)) {
      return {
        min: null,
        max: roundToStrictUpperBound(max)
      };
    }
  }

  return null;
}

function detectLocation(question) {
  const normalized = String(question || "").toLowerCase();
  const found = LOCATIONS.find((city) => normalized.includes(city.toLowerCase()));
  return found || null;
}

function detectLocations(question, session = {}, shouldReuseSessionLocation = false) {
  const normalized = String(question || "").toLowerCase();
  const locations = [];

  if (/\bncr\b/i.test(normalized)) {
    locations.push(...NCR_LOCATIONS);
  }

  for (const city of LOCATIONS) {
    if (normalized.includes(city.toLowerCase())) {
      locations.push(city);
    }
  }

  const sessionLocation = shouldReuseSessionLocation ? session.filters?.location : null;
  if (sessionLocation && !locations.includes(sessionLocation)) {
    locations.push(sessionLocation);
  }

  return [...new Set(locations)];
}

function detectExactName(question) {
  const text = String(question || "").trim();
  if (!text) {
    return null;
  }

  const quoted = text.match(/["“']([^"“”']{3,80})["“”']/);
  if (quoted?.[1]) {
    const candidate = normalizeNameCandidate(quoted[1]);
    if (candidate) {
      return candidate;
    }
  }

  const nameContextPatterns = [
    /\b(?:with name|named|candidate named|profile with name|profile for|profile of|candidate for)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})/i,
    /\b(?:do we have|is there|any profile for|any candidate for|find|search for|get)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\b/i
  ];

  for (const pattern of nameContextPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const candidate = normalizeNameCandidate(match[1]);
      if (candidate) {
        return candidate;
      }
    }
  }

  return null;
}

function normalizeNameCandidate(value) {
  const cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[.]+$/g, "")
    .trim();
  if (!cleaned) {
    return null;
  }

  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens.length < 2) {
    return null;
  }

  return tokens.join(" ");
}

function roundToStrictLowerBound(value) {
  return Math.round((Number(value) + 0.01) * 100) / 100;
}

function roundToStrictUpperBound(value) {
  return Math.round((Number(value) - 0.01) * 100) / 100;
}
