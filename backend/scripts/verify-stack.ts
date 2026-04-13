import dotenv from "dotenv";
import crypto from "crypto";
import pg from "pg";
import { ImapFlow } from "imapflow";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: true });

const { Pool } = pg;

const REQUEST_TIMEOUT_MS = 15000;
const PARSER_ENDPOINT = process.env.PARSER_ENDPOINT || "https://openrouter.ai/api/v1/chat/completions";
const PARSER_MODEL = process.env.PARSER_MODEL || "openrouter/auto";
const PARSER_SYSTEM_PROMPT =
  process.env.PARSER_SYSTEM_PROMPT ||
  "You are a strict JSON extractor for DispatchBoard orders. Return only JSON with keys customer_name, items, priority, notes, and confidence. Do not explain yourself.";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

type CheckResult = {
  name: string;
  ok: boolean;
  details: string;
};

function ok(name: string, details: string): CheckResult {
  return { name, ok: true, details };
}

function fail(name: string, details: string): CheckResult {
  return { name, ok: false, details };
}

async function checkDatabase(): Promise<CheckResult> {
  const name = "Database (Postgres)";
  if (!process.env.DATABASE_URL) return fail(name, "Missing DATABASE_URL");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const res = await pool.query("select now() as now");
    return ok(name, `Connected. Server time: ${res.rows[0]?.now ?? "unknown"}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(name, msg);
  } finally {
    await pool.end();
  }
}

async function checkOpenRouter(): Promise<CheckResult> {
  const name = "OpenRouter parser";
  if (!OPENROUTER_API_KEY) return fail(name, "Missing OPENROUTER_API_KEY");
  try {
    const res = await fetch(PARSER_ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: PARSER_MODEL,
        temperature: 0,
        max_tokens: 400,
        messages: [
          { role: "system", content: PARSER_SYSTEM_PROMPT },
          { role: "user", content: 'Return EXACTLY {"ok":true}' }
        ]
      })
    });
    if (!res.ok) {
      const text = await res.text();
      return fail(name, `HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => ({}));
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return fail(name, "No content returned");
    return ok(name, `Response received from ${PARSER_MODEL}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(name, msg);
  }
}

async function checkImap(): Promise<CheckResult> {
  const name = "Email IMAP";
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!host || !user || !pass) {
    return fail(name, "Missing IMAP_HOST/IMAP_USER/IMAP_PASS");
  }
  const port = Number(process.env.IMAP_PORT || 993);
  const secure = process.env.IMAP_SECURE
    ? process.env.IMAP_SECURE.toLowerCase() === "true"
    : port === 993;
  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    logger: false
  });
  try {
    await client.connect();
    const box = await client.mailboxOpen("INBOX");
    return ok(name, `Connected. INBOX messages: ${box.exists}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(name, msg);
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }
}

async function checkParseEndpoint(baseUrl: string): Promise<CheckResult> {
  const name = "Backend /api/parse-message";
  try {
    const res = await fetch(`${baseUrl}/api/parse-message`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "50 nos relay module, 20 plc connector for Ravi Electronics urgent" })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      return fail(name, `HTTP ${res.status} ${JSON.stringify(data).slice(0, 220)}`);
    }
    return ok(name, `Parsed ${Array.isArray(data.items) ? data.items.length : 0} items`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(name, msg);
  }
}

function buildTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + (params[key] ?? ""), url);
  return crypto.createHmac("sha1", authToken).update(sorted, "utf8").digest("base64");
}

async function checkTwilioWebhook(baseUrl: string): Promise<CheckResult> {
  const name = "Twilio WhatsApp webhook";
  const auth = process.env.TWILIO_AUTH;
  const publicUrl = process.env.PUBLIC_URL;
  if (!auth) return fail(name, "Missing TWILIO_AUTH");
  if (!publicUrl) return fail(name, "Missing PUBLIC_URL");

  const params = {
    Body: "Need 15 relay cards and 2 control panels for Sri Balaji Traders asap",
    ProfileName: "Balaji Buyer",
    From: "whatsapp:+919999999999"
  };
  const sig = buildTwilioSignature(auth, `${publicUrl}/api/twilio-webhook`, params);

  try {
    const body = new URLSearchParams(params);
    const res = await fetch(`${baseUrl}/api/twilio-webhook`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-twilio-signature": sig
      },
      body
    });
    const text = await res.text();
    if (!res.ok) return fail(name, `HTTP ${res.status}: ${text.slice(0, 220)}`);
    if (!text.includes("<Response>")) return fail(name, "No TwiML response body");
    if (!text.includes("Order received") && !text.includes("Could not read your order")) {
      return fail(name, `Unexpected TwiML: ${text.slice(0, 220)}`);
    }
    return ok(name, "Webhook accepted and returned TwiML");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(name, msg);
  }
}

async function main() {
  const baseUrl = process.env.TEST_BASE_URL || "http://localhost:4000";
  const results: CheckResult[] = [];

  results.push(await checkDatabase());
  results.push(await checkOpenRouter());
  results.push(await checkImap());
  results.push(await checkParseEndpoint(baseUrl));
  results.push(await checkTwilioWebhook(baseUrl));

  console.log("\n=== DispatchBoard stack verification ===");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} | ${r.name} | ${r.details}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nResult: ${failed.length ? "FAILED" : "PASSED"} (${results.length - failed.length}/${results.length} checks passed)`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Fatal:", msg);
  process.exit(1);
});
