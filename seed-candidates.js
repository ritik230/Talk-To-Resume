import "dotenv/config";
import bcrypt from "bcryptjs";
import { connectDatabase, closeDatabase, getCollections } from "./db.js";
import { buildCandidateStoragePayload } from "./candidate-service.js";

const DEFAULT_COUNT = 80;
const DEFAULT_PASSWORD = "Candidate@123";
const SEED_FLAG = true;
const SEED_DOMAIN = "seed-talktoresume.dev";

const FIRST_NAMES = [
  "Rohan", "Priya", "Aman", "Sneha", "Kunal", "Neha", "Arjun", "Simran", "Harsh", "Pooja",
  "Nitin", "Ananya", "Saurabh", "Kriti", "Vikas", "Aarti", "Rahul", "Ishita", "Mayank", "Nidhi",
  "Varun", "Megha", "Siddharth", "Riya", "Manish", "Tanya", "Ayush", "Shreya", "Abhishek", "Kashish",
  "Mohit", "Sakshi", "Ankit", "Mansi", "Vivek", "Palak", "Yash", "Khushi", "Deepak", "Sanjana"
];

const LAST_NAMES = [
  "Sharma", "Verma", "Gupta", "Singh", "Agarwal", "Rajput", "Mishra", "Yadav", "Bansal", "Arora",
  "Jain", "Saxena", "Soni", "Pandey", "Srivastava", "Tiwari", "Nanda", "Kapoor", "Malhotra", "Chawla"
];

const COMPANIES = {
  backend: ["TuringByte Labs", "BluePeak Systems", "NordicPay Tech", "Acme Digital", "ScaleOrbit"],
  integration: ["FlowBridge Solutions", "Axis Integrations", "Orbit Middleware", "CloudSync Works", "InterOp Labs"],
  guidewire: ["ClaimSphere Tech", "InsureStack Systems", "PolicyMesh Digital", "FinSure Logic", "CoreClaims Pvt Ltd"],
  frontend: ["PixelMint Studio", "NorthStar Commerce", "BrandOrbit", "Vista UI Labs", "ShopGrid"],
  data: ["DataHarbor Analytics", "MetricForge", "InsightSpring", "Lakehouse Works", "QuantVista"],
  sales: ["RevenuePilot", "LeadBridge CRM", "VelocitySales", "PipelineLoop", "CustomerOrbit"],
  accounting: ["LedgerPoint", "FinEdge Advisory", "TaxSprint", "AccrualHive", "BalanceCore"],
  operations: ["SupplyMesh", "OpsTrack", "RouteForge", "FleetBridge", "FulfillCore"]
};

const TEMPLATE_SEQUENCE = [
  "integration", "backend", "guidewire", "backend", "integration", "frontend", "data", "sales", "accounting", "operations"
];

const LOCATIONS = [
  "Jaipur", "Delhi", "Gurugram", "Noida", "Bengaluru", "Pune", "Mumbai", "Hyderabad",
  "Chennai", "Kolkata", "Ahmedabad", "Indore", "Bhopal", "Chandigarh", "Lucknow", "Surat"
];

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const count = normalizeCount(process.argv[2]);
  await connectDatabase();

  try {
    const { usersCollection, candidatesCollection } = getCollections();
    await usersCollection.deleteMany({ seeded: SEED_FLAG });
    await candidatesCollection.deleteMany({ seeded: SEED_FLAG });

    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
    const now = new Date();
    let created = 0;

    for (let index = 0; index < count; index += 1) {
      const profile = buildSeedCandidate(index);
      const email = `${slugify(profile.name)}.${index + 1}@${SEED_DOMAIN}`;

      const userResult = await usersCollection.insertOne({
        name: profile.name,
        email,
        passwordHash,
        role: "candidate",
        seeded: SEED_FLAG,
        createdAt: now
      });

      const parsedData = {
        ...profile.parsedData,
        contactDetails: {
          email,
          phone: profile.phone,
          linkedin: `linkedin.com/in/${slugify(profile.name)}`,
          github: `github.com/${slugify(profile.name)}`
        }
      };

      const payload = await buildCandidateStoragePayload({
        userId: userResult.insertedId.toString(),
        parsedData,
        name: profile.name
      });

      await candidatesCollection.insertOne({
        ...payload,
        seeded: SEED_FLAG,
        createdAt: now
      });

      created += 1;
    }

    console.log(`Seeded ${created} candidate profiles.`);
    console.log(`Default seeded candidate password: ${DEFAULT_PASSWORD}`);
    console.log(`Sample login email: ${slugify(buildSeedCandidate(0).name)}.1@${SEED_DOMAIN}`);
  } finally {
    await closeDatabase();
  }
}

function buildSeedCandidate(index) {
  const name = `${FIRST_NAMES[index % FIRST_NAMES.length]} ${LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length]}`;
  const templateKey = TEMPLATE_SEQUENCE[index % TEMPLATE_SEQUENCE.length];
  const years = 1.5 + ((index % 7) * 0.8);
  const phone = `+91 9${String(100000000 + index * 7913).slice(0, 9)}`;
  return buildTemplateCandidate(templateKey, { index, name, years, phone });
}

function buildTemplateCandidate(templateKey, context) {
  switch (templateKey) {
    case "integration":
      return buildIntegrationCandidate(context);
    case "guidewire":
      return buildGuidewireCandidate(context);
    case "frontend":
      return buildFrontendCandidate(context);
    case "data":
      return buildDataCandidate(context);
    case "sales":
      return buildSalesCandidate(context);
    case "accounting":
      return buildAccountingCandidate(context);
    case "operations":
      return buildOperationsCandidate(context);
    case "backend":
    default:
      return buildBackendCandidate(context);
  }
}

function buildIntegrationCandidate({ index, name, years, phone }) {
  const roleName = index % 2 === 0 ? "Boomi Developer" : "Integration Developer";
  const primaryProject = `Enterprise Boomi Integration Suite ${index + 1}`;
  const secondaryProject = `Insurance Policy Sync Platform ${index + 1}`;
  const location = pickLocation(index, ["Jaipur", "Delhi", "Gurugram", "Noida", "Bengaluru", "Pune"]);
  return {
    name,
    phone,
    parsedData: {
      name,
      location,
      summary: `${roleName} with ${roundOne(years)} years of experience building Dell Boomi integrations, API orchestration, and enterprise data flows across insurance, ERP, and CRM systems.`,
      skills: [
        skill("Dell Boomi", "tools", 5 + (index % 3), years, [primaryProject, secondaryProject]),
        skill("Integration Development", "backend", 4 + (index % 4), years, [primaryProject, secondaryProject]),
        skill("REST APIs", "backend", 4, roundOne(years - 0.3), [primaryProject]),
        skill("SOAP", "backend", 3, roundOne(years - 0.5), [secondaryProject]),
        skill("EDI", "tools", 2 + (index % 2), roundOne(years - 0.8), [primaryProject]),
        skill("XML", "other", 3, years, [primaryProject, secondaryProject]),
        skill("SQL", "database", 2, roundOne(years - 0.4), [secondaryProject])
      ],
      projects: [
        project(
          primaryProject,
          "Built Boomi processes to connect CRM, ERP, and finance systems for near real-time order, invoice, and customer synchronization.",
          ["Dell Boomi", "REST APIs", "EDI", "SQL"],
          ["Partner onboarding", "Order sync", "Retry handling", "Monitoring dashboards"],
          "high"
        ),
        project(
          secondaryProject,
          "Implemented policy and claims integrations for a UK insurance program using API and SOAP-based data exchanges.",
          ["Dell Boomi", "SOAP", "XML", "SQL"],
          ["Claims sync", "Policy updates", "Error alerting", "Transformation rules"],
          "high"
        )
      ],
      experience: [
        experience(
          pick(COMPANIES.integration, index),
          roleName,
          `${roundOne(years)} years`,
          years,
          ["Designed integration workflows", "Built reusable connector templates", "Handled production support and root-cause analysis"],
          ["Dell Boomi", "REST APIs", "SOAP", "SQL", "XML"]
        ),
        experience(
          pick(COMPANIES.integration, index + 2),
          "Associate Integration Engineer",
          `${roundOne(Math.max(0.8, years - 1.1))} years`,
          roundOne(Math.max(0.8, years - 1.1)),
          ["Mapped source-target transformations", "Created process documentation", "Worked with business and QA teams"],
          ["Boomi", "XML", "EDI"]
        )
      ],
      education: [education("B.Tech in Computer Science", "AKTU", 2018 + (index % 5))],
      strengths: ["Dell Boomi", "Integration architecture", "Production support", "Insurance domain"]
    }
  };
}

function buildBackendCandidate({ index, name, years, phone }) {
  const primaryProject = `Scalable Payment API Platform ${index + 1}`;
  const secondaryProject = `Microservices Order Engine ${index + 1}`;
  const location = pickLocation(index, ["Bengaluru", "Hyderabad", "Pune", "Noida", "Chennai", "Delhi"]);
  return {
    name,
    phone,
    parsedData: {
      name,
      location,
      summary: `Backend developer with ${roundOne(years)} years of experience in Java, Spring Boot, SQL, and microservices-oriented API development.`,
      skills: [
        skill("Java", "backend", 5 + (index % 3), years, [primaryProject, secondaryProject]),
        skill("Spring Boot", "backend", 5, roundOne(years - 0.2), [primaryProject, secondaryProject]),
        skill("Microservices", "backend", 4, roundOne(years - 0.4), [secondaryProject]),
        skill("SQL", "database", 4, years, [primaryProject, secondaryProject]),
        skill("REST APIs", "backend", 4, years, [primaryProject, secondaryProject]),
        skill("Docker", "tools", 2 + (index % 2), roundOne(years - 0.5), [secondaryProject])
      ],
      projects: [
        project(
          primaryProject,
          "Developed secure APIs for payment operations, account statements, and reconciliation workflows.",
          ["Java", "Spring Boot", "SQL", "REST APIs"],
          ["JWT auth", "Rate limiting", "Audit logs", "Role-based access"],
          "high"
        ),
        project(
          secondaryProject,
          "Split order processing into resilient services with messaging, retries, and observability.",
          ["Java", "Spring Boot", "Microservices", "Docker"],
          ["Service decomposition", "Retry queues", "Tracing", "Health monitoring"],
          "high"
        )
      ],
      experience: [
        experience(
          pick(COMPANIES.backend, index),
          "Software Engineer",
          `${roundOne(years)} years`,
          years,
          ["Built backend APIs", "Optimized SQL queries", "Participated in design reviews"],
          ["Java", "Spring Boot", "SQL", "REST APIs"]
        ),
        experience(
          pick(COMPANIES.backend, index + 1),
          "Junior Backend Developer",
          `${roundOne(Math.max(0.9, years - 1.2))} years`,
          roundOne(Math.max(0.9, years - 1.2)),
          ["Implemented service endpoints", "Fixed production bugs", "Wrote unit and integration tests"],
          ["Java", "Spring Boot", "Docker"]
        )
      ],
      education: [education("B.Tech in Information Technology", "UPTU", 2017 + (index % 6))],
      strengths: ["Java", "Spring Boot", "API design", "Database performance"]
    }
  };
}

function buildGuidewireCandidate({ index, name, years, phone }) {
  const primaryProject = `Guidewire ClaimCenter Enhancement ${index + 1}`;
  const secondaryProject = `PolicyCenter Integration Program ${index + 1}`;
  const location = pickLocation(index, ["Jaipur", "Delhi", "Pune", "Mumbai", "Hyderabad", "Bengaluru"]);
  return {
    name,
    phone,
    parsedData: {
      name,
      location,
      summary: `Insurance platform engineer with ${roundOne(years)} years of experience in Guidewire ClaimCenter, Gosu, Java, and XML-driven implementation work.`,
      skills: [
        skill("Guidewire", "backend", 5, years, [primaryProject, secondaryProject]),
        skill("ClaimCenter", "backend", 4, roundOne(years - 0.1), [primaryProject]),
        skill("Gosu", "backend", 4, years, [primaryProject, secondaryProject]),
        skill("Java", "backend", 3, roundOne(years - 0.3), [secondaryProject]),
        skill("XML", "other", 3, years, [primaryProject, secondaryProject]),
        skill("REST APIs", "backend", 2, roundOne(years - 0.7), [secondaryProject])
      ],
      projects: [
        project(
          primaryProject,
          "Enhanced claims lifecycle workflows and validation rules inside Guidewire ClaimCenter for insurance operations.",
          ["Guidewire", "ClaimCenter", "Gosu", "XML"],
          ["FNOL flow", "Rule customization", "UI enhancements", "Batch processing"],
          "high"
        ),
        project(
          secondaryProject,
          "Connected policy modules with external systems for document and customer data synchronization.",
          ["Guidewire", "Java", "REST APIs", "XML"],
          ["Policy sync", "Document handling", "Data validation", "Error monitoring"],
          "medium"
        )
      ],
      experience: [
        experience(
          pick(COMPANIES.guidewire, index),
          "Guidewire Developer",
          `${roundOne(years)} years`,
          years,
          ["Customized ClaimCenter", "Developed Gosu rules", "Worked with insurance SMEs"],
          ["Guidewire", "Gosu", "XML", "Java"]
        ),
        experience(
          pick(COMPANIES.guidewire, index + 1),
          "Software Engineer",
          `${roundOne(Math.max(0.8, years - 1))} years`,
          roundOne(Math.max(0.8, years - 1)),
          ["Maintained policy workflows", "Supported releases", "Resolved production defects"],
          ["Guidewire", "ClaimCenter", "REST APIs"]
        )
      ],
      education: [education("B.E. in Computer Engineering", "RTU", 2016 + (index % 7))],
      strengths: ["Guidewire", "Insurance domain", "ClaimCenter", "Gosu"]
    }
  };
}

function buildFrontendCandidate({ index, name, years, phone }) {
  const primaryProject = `Commerce Frontend Revamp ${index + 1}`;
  const secondaryProject = `Analytics Dashboard UI ${index + 1}`;
  const location = pickLocation(index, ["Bengaluru", "Pune", "Mumbai", "Noida", "Delhi", "Chennai"]);
  return {
    name,
    phone,
    parsedData: {
      name,
      location,
      summary: `Frontend engineer with ${roundOne(years)} years of experience building responsive React applications, dashboards, and component systems.`,
      skills: [
        skill("React", "frontend", 5, years, [primaryProject, secondaryProject]),
        skill("JavaScript", "frontend", 5, years, [primaryProject, secondaryProject]),
        skill("TypeScript", "frontend", 3, roundOne(years - 0.4), [secondaryProject]),
        skill("Node.js", "backend", 2, roundOne(years - 0.5), [primaryProject]),
        skill("CSS", "frontend", 4, years, [primaryProject, secondaryProject]),
        skill("Figma", "tools", 2, roundOne(years - 0.6), [secondaryProject])
      ],
      projects: [
        project(
          primaryProject,
          "Built an e-commerce storefront with reusable components, account flows, and cart performance optimizations.",
          ["React", "JavaScript", "CSS", "Node.js"],
          ["Cart UX", "Checkout flow", "Lazy loading", "Responsive design"],
          "medium"
        ),
        project(
          secondaryProject,
          "Developed an operations dashboard with filterable charts and role-specific access views.",
          ["React", "TypeScript", "CSS", "Figma"],
          ["KPI widgets", "Role access", "Interactive charts", "Theme system"],
          "medium"
        )
      ],
      experience: [
        experience(
          pick(COMPANIES.frontend, index),
          "Frontend Developer",
          `${roundOne(years)} years`,
          years,
          ["Built reusable UI components", "Collaborated with designers", "Improved page performance"],
          ["React", "JavaScript", "CSS"]
        )
      ],
      education: [education("BCA", "Delhi University", 2018 + (index % 5))],
      strengths: ["React", "Component systems", "Responsive design", "UI delivery"]
    }
  };
}

function buildDataCandidate({ index, name, years, phone }) {
  const primaryProject = `Data Pipeline Optimizer ${index + 1}`;
  const secondaryProject = `BI Reporting Hub ${index + 1}`;
  const location = pickLocation(index, ["Hyderabad", "Bengaluru", "Pune", "Noida", "Delhi", "Chennai"]);
  return {
    name,
    phone,
    parsedData: {
      name,
      location,
      summary: `Data engineer with ${roundOne(years)} years of experience in ETL pipelines, SQL, Python, and reporting automation.`,
      skills: [
        skill("Python", "backend", 4, years, [primaryProject]),
        skill("SQL", "database", 5, years, [primaryProject, secondaryProject]),
        skill("ETL", "tools", 4, years, [primaryProject]),
        skill("Power BI", "tools", 3, roundOne(years - 0.5), [secondaryProject]),
        skill("Data Modeling", "database", 3, roundOne(years - 0.4), [primaryProject, secondaryProject])
      ],
      projects: [
        project(
          primaryProject,
          "Improved daily ingestion workflows and data validation for multiple business datasets.",
          ["Python", "SQL", "ETL"],
          ["Pipeline scheduling", "Validation rules", "Alerting", "Load optimization"],
          "high"
        ),
        project(
          secondaryProject,
          "Created self-serve BI dashboards for finance and operations stakeholders.",
          ["SQL", "Power BI", "Data Modeling"],
          ["KPI dashboards", "Data marts", "Automated refresh", "Access control"],
          "medium"
        )
      ],
      experience: [
        experience(
          pick(COMPANIES.data, index),
          "Data Engineer",
          `${roundOne(years)} years`,
          years,
          ["Managed ETL jobs", "Designed reporting datasets", "Worked with analysts and business teams"],
          ["Python", "SQL", "ETL", "Power BI"]
        )
      ],
      education: [education("B.Tech in Data Science", "GLA University", 2017 + (index % 6))],
      strengths: ["SQL", "ETL", "Reporting", "Data quality"]
    }
  };
}

function buildSalesCandidate({ index, name, years, phone }) {
  const primaryProject = `Lead Funnel Automation ${index + 1}`;
  const secondaryProject = `CRM Territory Planning ${index + 1}`;
  const location = pickLocation(index, ["Jaipur", "Delhi", "Gurugram", "Noida", "Mumbai", "Pune"]);
  return {
    name,
    phone,
    parsedData: {
      name,
      location,
      summary: `Sales operations specialist with ${roundOne(years)} years of experience in CRM process design, lead management, and pipeline reporting.`,
      skills: [
        skill("CRM", "tools", 5, years, [primaryProject, secondaryProject]),
        skill("Lead Generation", "other", 4, years, [primaryProject]),
        skill("Salesforce", "tools", 4, roundOne(years - 0.4), [primaryProject, secondaryProject]),
        skill("Communication", "other", 5, years, [primaryProject, secondaryProject]),
        skill("Reporting", "tools", 3, roundOne(years - 0.3), [secondaryProject])
      ],
      projects: [
        project(
          primaryProject,
          "Automated lead routing and qualification workflows across sales and marketing teams.",
          ["Salesforce", "CRM", "Reporting"],
          ["Lead scoring", "Routing rules", "SLA tracking", "Email automation"],
          "medium"
        ),
        project(
          secondaryProject,
          "Built territory and opportunity dashboards to improve forecast accuracy.",
          ["CRM", "Salesforce", "Reporting"],
          ["Territory views", "Quota tracking", "Forecast dashboards", "Pipeline hygiene"],
          "medium"
        )
      ],
      experience: [
        experience(
          pick(COMPANIES.sales, index),
          "Sales Operations Analyst",
          `${roundOne(years)} years`,
          years,
          ["Maintained CRM hygiene", "Supported lead-to-opportunity workflows", "Built performance dashboards"],
          ["CRM", "Salesforce", "Reporting"]
        )
      ],
      education: [education("MBA in Marketing", "Amity University", 2016 + (index % 6))],
      strengths: ["CRM operations", "Lead management", "Reporting", "Cross-team coordination"]
    }
  };
}

function buildAccountingCandidate({ index, name, years, phone }) {
  const primaryProject = `Month-End Close Optimizer ${index + 1}`;
  const secondaryProject = `Accounts Reconciliation Tracker ${index + 1}`;
  const location = pickLocation(index, ["Delhi", "Mumbai", "Jaipur", "Ahmedabad", "Pune", "Indore"]);
  return {
    name,
    phone,
    parsedData: {
      name,
      location,
      summary: `Accounting professional with ${roundOne(years)} years of experience in reconciliation, reporting, and ERP-based financial operations.`,
      skills: [
        skill("Accounting", "other", 5, years, [primaryProject, secondaryProject]),
        skill("Excel", "tools", 5, years, [primaryProject, secondaryProject]),
        skill("SAP", "tools", 3, roundOne(years - 0.5), [secondaryProject]),
        skill("Reconciliation", "other", 4, years, [primaryProject, secondaryProject]),
        skill("Reporting", "tools", 3, roundOne(years - 0.4), [primaryProject])
      ],
      projects: [
        project(
          primaryProject,
          "Improved monthly close workflows with tighter checklists and variance tracking.",
          ["Excel", "Reporting", "Accounting"],
          ["Variance review", "Close tracker", "Escalation workflow", "Quality checks"],
          "medium"
        ),
        project(
          secondaryProject,
          "Built structured reconciliation templates for balance sheet and vendor accounts.",
          ["SAP", "Excel", "Reconciliation"],
          ["Vendor matching", "Ledger cleanup", "Exception tracking", "Audit support"],
          "medium"
        )
      ],
      experience: [
        experience(
          pick(COMPANIES.accounting, index),
          "Accounts Executive",
          `${roundOne(years)} years`,
          years,
          ["Handled reconciliations", "Prepared reports", "Supported audits and month-end close"],
          ["Accounting", "Excel", "SAP"]
        )
      ],
      education: [education("B.Com", "Lucknow University", 2016 + (index % 8))],
      strengths: ["Reconciliation", "ERP exposure", "Reporting discipline", "Audit support"]
    }
  };
}

function buildOperationsCandidate({ index, name, years, phone }) {
  const primaryProject = `Dispatch Workflow Control Tower ${index + 1}`;
  const secondaryProject = `Vendor SLA Tracker ${index + 1}`;
  const location = pickLocation(index, ["Delhi", "Gurugram", "Noida", "Mumbai", "Pune", "Chandigarh"]);
  return {
    name,
    phone,
    parsedData: {
      name,
      location,
      summary: `Operations coordinator with ${roundOne(years)} years of experience in workflow monitoring, vendor coordination, and service-level tracking.`,
      skills: [
        skill("Operations", "other", 5, years, [primaryProject, secondaryProject]),
        skill("Communication", "other", 5, years, [primaryProject, secondaryProject]),
        skill("Excel", "tools", 4, years, [secondaryProject]),
        skill("Reporting", "tools", 3, roundOne(years - 0.3), [primaryProject, secondaryProject]),
        skill("Process Improvement", "other", 3, roundOne(years - 0.5), [primaryProject])
      ],
      projects: [
        project(
          primaryProject,
          "Improved dispatch visibility and issue escalation across daily operations.",
          ["Operations", "Reporting", "Excel"],
          ["Escalation matrix", "SLA dashboard", "Workflow tracking", "Incident notes"],
          "medium"
        ),
        project(
          secondaryProject,
          "Created a vendor management tracker to monitor delivery and issue resolution timelines.",
          ["Excel", "Reporting", "Communication"],
          ["Vendor SLA", "Status reporting", "Issue tracking", "Performance review"],
          "low"
        )
      ],
      experience: [
        experience(
          pick(COMPANIES.operations, index),
          "Operations Executive",
          `${roundOne(years)} years`,
          years,
          ["Coordinated daily workflows", "Tracked SLAs", "Prepared weekly operational reports"],
          ["Operations", "Excel", "Communication"]
        )
      ],
      education: [education("BBA", "CSJMU", 2017 + (index % 5))],
      strengths: ["Workflow coordination", "Reporting", "Process discipline", "Stakeholder communication"]
    }
  };
}

function skill(name, category, mentions, experienceYears, projects) {
  return {
    name,
    category,
    mentions,
    experience_years: roundOne(Math.max(0.5, experienceYears)),
    projects
  };
}

function project(name, description, techStack, features, complexity) {
  return { name, description, techStack, features, complexity };
}

function experience(company, role, duration, durationYears, responsibilities, techUsed) {
  return {
    company,
    role,
    duration,
    duration_years: roundOne(durationYears),
    responsibilities,
    techUsed
  };
}

function education(degree, institution, graduationYear) {
  return {
    degree,
    institution,
    graduationYear
  };
}

function normalizeCount(rawValue) {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_COUNT;
  }
  return Math.max(50, Math.min(100, parsed));
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

function pick(values, index) {
  return values[index % values.length];
}

function roundOne(value) {
  return Math.round(Number(value) * 10) / 10;
}

function pickLocation(index, options) {
  return options[index % options.length] || LOCATIONS[index % LOCATIONS.length];
}
