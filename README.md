# 🚀 Talk-To-Resume

An AI-powered recruitment assistant that transforms static resume databases into an interactive knowledge base, allowing recruiters to source talent using conversational natural language.

---

## 💡 The Problem
Traditional Applicant Tracking Systems (ATS) rely heavily on rigid keyword matching, forcing recruiters to construct complex boolean strings. This outdated approach causes talent acquisition teams to miss out on exceptional candidates who use different phrasing or synonyms, while manually filtering through hundreds of resumes wastes invaluable hours.

## 🌟 The Solution
**Talk-To-Resume** bridges the gap between raw resume data and intelligent sourcing. By turning a resume database into an interactive conversational interface, recruiters can look for talent just by talking to the bot. It understands context, skills, and experience levels dynamically—acting as an always-on AI recruitment assistant.

---

## 🛠️ Key Features
* **Natural Language Sourcing:** Query your database naturally: *"Find me a frontend developer with 3+ years of React experience who knows Tailwind."*
* **Semantic RAG Engine:** Powered by Retrieval-Augmented Generation (RAG) and vector embeddings to match candidates based on contextual meaning rather than literal keyword hits.
* **Automated Parsing & Ingestion:** Built-in processing modules (`parser.js`) seamlessly break down raw candidate data into structured, queryable profiles.
* **Smart Session Management:** Features multi-turn conversation tracking, allowing recruiters to refine their searches iteratively (e.g., *"Now filter those results for candidates based in New York"*).

---

## 💻 Tech Stack
* **Backend:** Node.js, Express.js
* **AI & LLM Orchestration:** Custom RAG framework, Vector Embeddings, Semantic Search integration
* **Database & Storage:** Structured local storage with automated seeding capabilities (`db.js`, `store.js`)
* **Frontend:** Interactive, responsive Web UI (HTML5, CSS3, JavaScript)

---

## 🚀 Getting Started

Follow these instructions to get a copy of the project up and running on your local machine for development and testing purposes.

### 📋 Prerequisites
Make sure you have the following installed on your machine:
* [Node.js](https://nodejs.org/) (v16.x or higher recommended)
* npm (comes bundled with Node.js)

### 🔧 Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/ritik230/Talk-To-Resume.git](https://github.com/ritik230/Talk-To-Resume.git)
   cd Talk-To-Resume
