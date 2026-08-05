// src/utils/notifier.js
const fetch = require("node-fetch");
const nodemailer = require("nodemailer");
const { log, err } = require("./logger");

/**
 * Redact matches in text to avoid leaking secrets in notifications.
 * Very conservative: replaces long matches with <REDACTED:type>.
 */
function redactFindings(text, findings) {
  if (!text || !findings || !findings.length) return text;
  let redacted = text;
  for (const f of findings) {
    for (const m of f.matches || []) {
      const safe = `<REDACTED:${f.type.replace(/\s+/g, "_")}>`;
      redacted = redacted.split(m).join(safe);
    }
  }
  return redacted;
}

async function notifySlack(webhookUrl, text, findings) {
  if (!webhookUrl) throw new Error("Missing slack webhook");
  try {
    let bodyText = text;
    if (findings && findings.length) bodyText = redactFindings(bodyText, findings);
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: bodyText })
    });
    if (!resp.ok) {
      err("Slack notify failed", await resp.text());
      return false;
    }
    log("Slack notified");
    return true;
  } catch (e) {
    err("notifySlack failed", e);
    return false;
  }
}

async function notifyEmail(smtpConfig, to, subject, body, findings) {
  if (!smtpConfig) throw new Error("Missing SMTP config");
  try {
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure || false,
      auth: smtpConfig.auth || undefined
    });
    let bodyText = body;
    if (findings && findings.length) bodyText = redactFindings(bodyText, findings);
    await transporter.sendMail({
      from: smtpConfig.auth.user,
      to,
      subject,
      text: bodyText
    });
    log("Email sent to", to);
    return true;
  } catch (e) {
    err("notifyEmail failed", e);
    return false;
  }
}

module.exports = { notifySlack, notifyEmail, redactFindings };
