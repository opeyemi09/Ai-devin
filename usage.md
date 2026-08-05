 
Give AI Devin a concise, well‑structured task with context, constraints, and clear acceptance criteria. Use the Streamlit UI or POST /run with a JSON payload containing prompt, meta (repo/owner), workspace options, and runtime constraints. For best results provide reproduction steps, failing tests (or how to run them), and desired branch/commit behavior.
How to instruct AI Devin — a reusable task template Always include these sections in your instruction (use plain text or JSON fields):

How to instruct AI Devin — a reusable task template Always include these sections in your instruction (use plain text or JSON fields):

1 Title / short goal

One-line description of what you want.

2 Context

Which repo / path / files to modify (repoUrl or meta.owner/meta.repo).
Where the workspace is (the system creates per-task workspace automatically).

3 Task (the actual instruction)

Be explicit: "Fix failing test X", "Add endpoint /users to API", "Refactor module foo to remove duplicated code".
4 Constraints & requirements

Language, style, max LOC, performance limits.
Security constraints (no network access, no secrets).
Use existing patterns: "Follow existing project coding style".

5 Acceptance criteria (must be verifiable)

Tests that must pass (name of tests or command), lint rules, behavior examples (input → expected output).
Expected files modified or added.
Whether a PR should be created automatically.



6 Extra metadata (optional)

timeout/testCommand/sandbox image/pull remote repo details/priority/time budget/maxFiles for docgen.


7 Review / Approve workflow

Manual review required (default recommended).
If auto-PR: include PR title/body template and required reviewers.





