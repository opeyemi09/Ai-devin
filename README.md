# AI Devin — JS scaffold (Node backend + Streamlit UI)

Status: Prototype / developer scaffold

AI Devin is an AI-assisted developer platform prototype. It runs a small set of agents (planner, coder, docgen, executor, reviewer, github-agent) orchestrated by a worker queue. Tasks are persisted to MongoDB and processed by a BullMQ worker. A Streamlit UI provides task creation, template management, a file manager/editor, side-by-side diffs, an approval flow (push + PR), undo, and realtime task logs.

This README explains what’s included, how to run it locally, key APIs, and operational/security notes.

Contents
- server.js — Express API (task creation, task listing, templates, file and action endpoints)
- src/
  - agents/ — agents: planner, coder, docAgent, executor, reviewer, githubAgent, etc.
  - orchestrator/loop.js — pipeline orchestration, notifications, realtime
  - queue/ — BullMQ queue + worker
  - db/mongo.js — Mongo helpers (tasks, templates)
  - routes/ — files.js, actions.js, templates.js
  - realtime/wsServer.js — WebSocket broadcaster for live events
  - tools/ — file, git, dockerExec (sandbox runner), terminal, github
  - utils/ — logger, llm (OpenAI adapter), notifier, security scanner
- streamlit-ui/app.py — Streamlit control UI (templates, file manager, diff, approve, undo, live events)
- docker/docker-compose.yml — local Redis + Mongo for development
- .env.example — environment variables to set
- package.json — Node dependencies & scripts
- requirements.txt — Python deps for Streamlit UI

Key capabilities
- Task persistence in MongoDB and queueing with BullMQ.
- Per-task ephemeral workspace: WORKSPACE_ROOT/tasks/<taskId> (cloned from repoUrl or git init).
- Agents: planner, coder (writes code from LLM), docAgent (adds comments/docs), executor (runs tests inside Docker), reviewer (linters), githubAgent.
- Orchestrator: planner → coder → docgen → executor → reviewer → (optional) githubAgent.
- File manager + in-browser code editor using Streamlit + streamlit-ace.
- Git integration: per-task branch ai/task-<shortid>, git add & commit on save.
- Diff preview: unified and side-by-side per-file diff (difflib).
- Approval flow: diff scan for secrets, push branch to origin, create PR with Octokit.
- Undo: revert branch to base and create a backup branch.
- Secret scanning: regex-based detection; blocks auto-push unless explicitly overridden.
- Realtime Broadcast: task events emitted over WebSocket (/ws).
- Notifications: Slack and email (with redaction) for failures.
- LLM diagnostic: on failing tests, an LLM produces troubleshooting suggestions stored as a step.
- Task Templates: CRUD API + UI to store and reuse prompt templates.

Environment variables (.env)
Copy .env.example → .env and fill values:

Required for basic operation
- MONGO_URL=mongodb://localhost:27017/ai_devin
- REDIS_HOST=127.0.0.1
- REDIS_PORT=6379
- WORKSPACE_ROOT=./workspace

Optional but recommended
- OPENAI_API_KEY=sk-...        (LLM features: coder, docAgent, diagnostics)
- GH_PAT=ghp_...               (push & PR creation via Octokit)
- API_KEY=your_api_key         (protect /api endpoints)
- DEFAULT_BRANCH=main

Notifications (optional)
- SLACK_WEBHOOK_URL=https://hooks.slack.com/...
- ADMIN_EMAIL=you@example.com
- SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE

Quickstart (local)
1. Install Node deps
   npm install

2. Start development infra (Redis + Mongo)
   docker-compose -f docker/docker-compose.yml up -d

3. Configure .env
   cp .env.example .env
   # Edit .env and set required vars (MONGO_URL, WORKSPACE_ROOT). Add OPENAI_API_KEY and GH_PAT if using LLM and PR features.

4. Start backend & worker
   npm start
   npm run worker

5. Install Python deps and start the UI
   pip install -r requirements.txt
   pip install streamlit-ace
   streamlit run streamlit-ui/app.py

6. Open the Streamlit UI in your browser (it usually opens automatically). If headless mode is needed:
   streamlit run streamlit-ui/app.py --server.headless true --server.port 8501

Using the UI
- Create Task: fill prompt, owner/repo or repo clone URL (repoUrl), optional template. This creates a task record and a per-task workspace under WORKSPACE_ROOT/tasks/<taskId>.
- File Manager: browse/edit files in the selected workspace. Saving while a task workspace is selected will create/checkout branch ai/task-<shortid>, git add, and git commit the change.
- Diff Preview: view unified diffs and side-by-side file diffs between base branch and the task branch.
- Scan: run secret heuristic scan on diff; if secrets are found, approve/push will be blocked unless override is checked.
- Approve & Create PR: pushes branch (server uses GH_PAT) and creates a PR via Octokit; PR link returned and stored in task.
- Undo: reverts the task branch to base, creates a backup branch for safety.
- Live events: WebSocket log panel shows step broadcasts as agents run.
- Templates: save/reuse task prompt templates from the Create Task form.

API endpoints (select)
- POST /run
  - Body: { prompt, meta: { owner, repo, repoUrl }, autoCreatePR, ... }
  - Creates task and enqueues job.
- GET /tasks
- GET /tasks/:id
- File APIs (under /api)
  - GET /api/files?path=&taskId=
  - GET /api/file?path=&taskId=
  - POST /api/file { path, content, taskId, commitMessage }
  - POST /api/folder { path, taskId }
  - DELETE /api/file?path=&taskId=
- Actions (under /api/actions)
  - GET /api/actions/diff?taskId=&base=
  - GET /api/actions/file-diff?taskId=&filePath=&base=
  - GET /api/actions/scan?taskId=&base=
  - POST /api/actions/approve { taskId, title, body, base?, overrideSecrets? }
  - POST /api/actions/undo { taskId, base? }
- Templates (under /api/templates)
  - GET /api/templates
  - GET /api/templates/:id
  - POST /api/templates { name, prompt, meta, defaultFields }
  - PUT /api/templates/:id
  - DELETE /api/templates/:id

Developer notes & best practices
- Workspace isolation: per-task workspaces are created under WORKSPACE_ROOT/tasks/<taskId>. Clean up old workspaces periodically.
- Protect the API: set API_KEY in .env and pass it in UI via X-API-KEY header to prevent unauthorized access.
- GH push: server uses GH_PAT to push. For production, prefer a GitHub App or deploy key with least privileges instead of a user PAT in env vars.
- Sandbox: the executor runs Docker with workspace bind mounts. Do not run arbitrary untrusted code on hosts where Docker has privileged access. Consider gVisor/Kata for stronger isolation.
- Secret scanning: the current scanner is regex-based and may have false positives/negatives. For stronger checks, integrate tools like gitleaks.
- Notifications: notifier redacts detected secret matches in messages, but still be cautious about what gets sent.

Troubleshooting
- Worker not processing: ensure Redis is reachable and `npm run worker` is running.
- Server can't connect to Mongo: verify MONGO_URL and that Mongo container is running.
- LLM errors: ensure OPENAI_API_KEY is set and you have quota.
- PR creation fails: ensure GH_PAT is set and task.meta contains owner/repo or repoUrl parsable to owner/repo.

Next recommended improvements
- Replace GH_PAT push flow with a GitHub App or deploy key for production.
- Integrate gitleaks for robust secret detection.
- Add approval audit trail (who approved, timestamp) in Mongo.
- Add RBAC / authentication for Streamlit UI (SSO/OAuth).
- Add CI and integration tests for agents and orchestrator.

License
- MIT — adapt as needed.

Acknowledgements
- Prototype built to be a starting point; harden and review security before exposing externally.
