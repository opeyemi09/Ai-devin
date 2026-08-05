# Ai-devin
AI team — agents that can code, run terminal commands, test and much more

# AI Devin — JS scaffold (Node backend + Streamlit UI)

Status: Prototype / early production-minded scaffold

AI Devin is a developer-facing multi-agent platform prototype. It runs a small set of agents (planner, coder, docgen, executor, reviewer, github-agent) orchestrated by a worker queue. Tasks are persisted to MongoDB and processed by a BullMQ worker. A minimal Streamlit UI lets you create tasks and inspect task history and step logs.

This repository is intentionally opinionated but lightweight — it is NOT hardened for running arbitrary untrusted code in production. Treat this as a developer sandbox and follow the security notes below.

Contents
- server.js — Express API (task creation, task listing)
- src/
  - agents/ — agents: planner, coder, docAgent (documentation/comments), executor, reviewer, githubAgent, etc.
  - orchestrator/loop.js — pipeline orchestration and task lifecycle
  - queue/ — BullMQ queue + worker
  - db/mongo.js — Mongo helper (tasks collection)
  - tools/ — file, git, dockerExec (sandbox runner), terminal, github
  - utils/ — logger, llm (OpenAI adapter)
- streamlit-ui/app.py — Python Streamlit app (task creation + history UI)
- docker/docker-compose.yml — local Redis + Mongo for development
- .env.example — environment variables to set
- requirements.txt — Python deps for Streamlit UI
- package.json — Node dependencies & scripts

Requirements
- Node.js >= 18
- Docker & Docker Compose (for local Redis + Mongo, and for sandboxed execution)
- Python 3.11+ and pip (for Streamlit UI)
- (Optional) GitHub CLI `gh` if you want to create a remote repo quickly

Environment
- Copy .env.example to .env and fill values:
  - OPENAI_API_KEY — required for LLM features (Coder, DocAgent)
  - GH_PAT — required for GitHub PR creation (githubAgent)
  - MONGO_URL — MongoDB connection (default: mongodb://localhost:27017/ai_devin)
  - REDIS_HOST / REDIS_PORT — Redis for BullMQ
  - WORKSPACE_ROOT — path to the workspace where agents read/write files (default: ./workspace)
  - DEFAULT_BRANCH — default repo branch (default: main)

Quickstart (local)
1. Install Node deps
   npm install

2. Start local infra (Redis + Mongo)
   docker-compose -f docker/docker-compose.yml up -d

3. Create .env from .env.example and set OPENAI_API_KEY and GH_PAT (if used).

4. Start the API server
   npm start
   - Server default: http://localhost:3000

5. Start the worker in a separate terminal
   npm run worker

6. Start Streamlit UI (optional; Python required)
   pip install -r requirements.txt
   streamlit run streamlit-ui/app.py

Creating a task (API)
- Create (persist + enqueue) a task:
  curl -X POST http://localhost:3000/run \
    -H "Content-Type: application/json" \
    -d '{"prompt":"Fix failing tests in module X", "workspace":"./workspace", "autoCreatePR":false, "meta":{"owner":"your-org","repo":"your-repo"}}'

- List tasks:
  GET http://localhost:3000/tasks

- Get task details:
  GET http://localhost:3000/tasks/<taskId>

Streamlit UI
- UI provides:
  - Task creation form (prompt, repo owner/name, auto PR toggle)
  - Task history list (select a task to view step logs and results)
- By default the UI talks to http://localhost:3000; you can change API_BASE in streamlit secrets or edit the app.

What the pipeline does (current behavior)
- POST /run stores a task document in Mongo and enqueues a BullMQ job with the taskId.
- Worker picks up the job and calls orchestrator(taskId).
- Orchestrator fetches the task and runs pipeline steps in order:
  1. planner (task decomposition — currently a stub)
  2. coder (asks LLM to provide file contents; writes to workspace)
  3. docAgent (asks LLM to add inline comments / docstrings; writes .commented files)
  4. executor (runs tests/commands in a Docker sandbox)
  5. reviewer (runs linters like eslint)
  6. githubAgent (optionally create PR via Octokit if meta.owner & meta.repo provided and autoCreatePR is true)
- Each step result is appended to the task document's `steps` array in Mongo (append-only). The task `status` is updated (queued → running → completed/failed/needs-review).

Important security notes (read carefully)
- The sandbox uses Docker CLI with workspace bind-mounts. Do NOT run untrusted code on hosts where Docker daemon has elevated privileges or access to sensitive host files.
- Limit Docker container caps (cpus/memory) and disable networking for most runs (the executor uses network: false by default).
- Never commit your OPENAI_API_KEY or GH_PAT. Use environment variables or a secret manager.
- For production, use isolated runner hosts, container runtimes that enforce stricter sandboxing (gVisor, Kata), and limit filesystem mounts.

Configuration & Operational tips
- Tune DocAgent.maxFiles to limit LLM call count and cost.
- Ensure workspace path is isolated per task in production (create ephemeral per-task directories).
- Use a dedicated Redis and Mongo service (not local Docker on shared host) for production.
- Add authentication & RBAC on API endpoints before exposing to others.

Development notes / next steps (recommended)
- Improve coder: parse LLM output as unified diffs and apply with git apply; create branch & commit changes.
- Persist audit logs for prompts and LLM responses (append-only) for traceability.
- Add an approval gate in the Streamlit UI to review diffs before auto-creating PRs.
- Replace naive LLM prompting with structured JSON outputs or tool-assisted patch generation to reduce ambiguity.
- Add tests (Jest) for agents and orchestrator; include CI workflow.

Troubleshooting
- Worker doesn't process jobs: ensure Redis is reachable and `npm run worker` is running.
- Server can't connect to Mongo: confirm MONGO_URL and that docker-compose mongo is up.
- LLM errors: ensure OPENAI_API_KEY is set and you have available quota.

License
- MIT — adjust name/year in LICENSE as needed.

Acknowledgements
- Prototype constructed to be a starting point. Modify, harden, and extend to suit your security, scaling, and policy needs.
