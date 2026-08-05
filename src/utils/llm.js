const { Configuration, OpenAIApi } = require("openai");
const { log } = require("./logger");

const apiKey = process.env.OPENAI_API_KEY;
let client = null;
if (apiKey) {
  const configuration = new Configuration({ apiKey });
  client = new OpenAIApi(configuration);
} else {
  log("OPENAI_API_KEY not set. LLM features will fail until set.");
}

/**
 * complete(prompt, opts)
 * returns { text, raw }
 */
async function complete(prompt, opts = {}) {
  if (!client) throw new Error("OpenAI client not configured");
  const model = opts.model || "gpt-4o-mini";
  try {
    const resp = await client.createChatCompletion({
      model,
      messages: [
        { role: "system", content: "You are a concise assistant that returns helpful code diffs when asked." },
        { role: "user", content: prompt }
      ],
      max_tokens: opts.maxTokens || 800,
      temperature: opts.temperature ?? 0.2
    });
    const text = resp.data.choices?.[0]?.message?.content || "";
    log("LLM response length:", text.length);
    return { text, raw: resp.data };
  } catch (e) {
    log("LLM error:", e.message || e);
    throw e;
  }
}

module.exports = { complete };
