class MemoryAgent {
  constructor(dbClient) { this.db = dbClient; }
  async read(key) { return null; }
  async write(key, value) { return true; }
}
module.exports = MemoryAgent;
