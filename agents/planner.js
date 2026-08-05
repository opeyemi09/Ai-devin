class PlannerAgent {
  async run(task = {}) {
    // Basic decomposition; in prod this uses LLM + heuristics
    return { success: true, output: ["analyze", "code", "test", "review"] };
  }
}

module.exports = PlannerAgent;
