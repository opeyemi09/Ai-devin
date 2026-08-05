// Simple secret scanner with common patterns. Extend as needed.
const patterns = [
  { name: "AWS Access Key", re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "AWS Secret Key", re: /\b([A-Za-z0-9\/+=]{40})\b/g }, // very general — may produce false positives
  { name: "Private Key Block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "GitHub Token", re: /\bghp_[A-Za-z0-9_]{36,}\b/g },
  { name: "Slack Token", re: /\bxox[bsiap]-[A-Za-z0-9-]+\b/g },
  { name: "Generic API Key", re: /(?<![A-Za-z0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9])/g }
];

function scanTextForSecrets(text) {
  const findings = [];
  if (!text) return findings;
  for (const p of patterns) {
    const matches = [];
    let m;
    while ((m = p.re.exec(text)) !== null) {
      matches.push(m[0]);
      // avoid runaway loops for zero-length matches
      if (m.index === p.re.lastIndex) p.re.lastIndex++;
    }
    if (matches.length) {
      findings.push({ type: p.name, matches: Array.from(new Set(matches)).slice(0, 5) });
    }
    // reset lastIndex for safety
    p.re.lastIndex = 0;
  }
  return findings;
}

module.exports = { scanTextForSecrets };
