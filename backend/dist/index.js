import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { fetch } from "undici";
import pg from "pg";
import { simpleParser } from "mailparser";
import { ImapFlow } from "imapflow";
import { PDFParse } from "pdf-parse";
import path from "path";
import { fileURLToPath } from "url";
import { parseInvoicePdf } from "./pdf-parser";
import { createGmailPushService } from "./gmail-push";
import { findSkuByName, skuDefinitions } from "./sku-map";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: true });
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });
const { Pool } = pg;
const parseNumberFromEnv = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_IMAP_POLL_INTERVAL_MS = 300_000;
const DEFAULT_IMAP_SOCKET_TIMEOUT_MS = 120_000;
const MIN_IMAP_POLL_INTERVAL_MS = 15_000;
const MIN_IMAP_SOCKET_TIMEOUT_MS = 15_000;
const IMAP_HOST = process.env.IMAP_HOST ?? "";
const IMAP_USER = process.env.IMAP_USER ?? "";
const IMAP_PASS = process.env.IMAP_PASS ?? "";
const IMAP_PORT = parseNumberFromEnv(process.env.IMAP_PORT, DEFAULT_IMAP_PORT);
const IMAP_SECURE = process.env.IMAP_SECURE && process.env.IMAP_SECURE.trim()
    ? process.env.IMAP_SECURE.toLowerCase() === "true"
    : IMAP_PORT === 993;
const IMAP_POLL_INTERVAL_MS = Math.max(MIN_IMAP_POLL_INTERVAL_MS, parseNumberFromEnv(process.env.IMAP_POLL_INTERVAL_MS, DEFAULT_IMAP_POLL_INTERVAL_MS));
const IMAP_SOCKET_TIMEOUT_MS = Math.max(MIN_IMAP_SOCKET_TIMEOUT_MS, parseNumberFromEnv(process.env.IMAP_SOCKET_TIMEOUT_MS, DEFAULT_IMAP_SOCKET_TIMEOUT_MS));
const hasImapCredentials = () => Boolean(IMAP_HOST && IMAP_USER && IMAP_PASS);
let imapClientInstance = null;
let imapClientPromise = null;
let imapPollRunning = false;
const GMAIL_PUSH_TOPIC = process.env.GMAIL_PUSH_TOPIC ?? "";
const GMAIL_PUSH_CLIENT_ID = process.env.GMAIL_CLIENT_ID ?? "";
const GMAIL_PUSH_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET ?? "";
const GMAIL_PUSH_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN ?? "";
const GMAIL_PUSH_VERIFICATION_TOKEN = process.env.GMAIL_PUSH_VERIFICATION_TOKEN;
const GMAIL_WATCH_RENEW_INTERVAL_MS = parseNumberFromEnv(process.env.GMAIL_WATCH_RENEW_INTERVAL_MS, 6 * 60 * 60 * 1000);
const GMAIL_UNREAD_FETCH_LIMIT = parseNumberFromEnv(process.env.GMAIL_UNREAD_FETCH_LIMIT, 25);
const useGmailPush = Boolean(GMAIL_PUSH_TOPIC && GMAIL_PUSH_CLIENT_ID && GMAIL_PUSH_CLIENT_SECRET && GMAIL_PUSH_REFRESH_TOKEN);
let gmailPushService = null;
function getUnknownSkuItems(items) {
    const invalid = new Set();
    for (const item of items) {
        const name = (item.product || "").trim();
        if (!name)
            continue;
        if (!findSkuByName(name)) {
            invalid.add(name);
        }
    }
    return Array.from(invalid);
}
const skuKeywordSet = new Set(skuDefinitions
    .flatMap((entry) => [entry.instrument, entry.description, ...(entry.aliases ?? [])])
    .map((value) => (value || "").toLowerCase())
    .map((value) => value.replace(/[^a-z0-9]+/g, " ").trim())
    .filter(Boolean));
function containsKnownSku(text) {
    const normalized = text.toLowerCase();
    for (const keyword of skuKeywordSet) {
        if (normalized.includes(keyword)) {
            return true;
        }
    }
    return false;
}
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.post("/", (_req, res) => {
    return res.status(404).json({
        ok: false,
        message: "Use POST /api/twilio-webhook for WhatsApp messages."
    });
});
/* =====================================================================
   DATABASE
   ===================================================================== */
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
/* =====================================================================
   GEMINI — FULL STRUCTURED PARSER
   Handles any message format: WhatsApp natural language, formal PO emails,
   abbreviations, Indian business style, mixed quantity formats.
   ===================================================================== */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5";
const GEMINI_ENDPOINT = process.env.GEMINI_ENDPOINT || `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateText`;
const PARSER_SYSTEM_PROMPT = process.env.PARSER_SYSTEM_PROMPT ||
    "You are a strict JSON extractor for DispatchBoard orders. Return only valid JSON with keys customer_name, items, priority, notes, and confidence. Do not explain yourself.";
const PARSER_TIMEOUT_MS = Number(process.env.PARSER_TIMEOUT_MS || 20000);
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-3-5-sonnet-latest";
/** Email-only parser mode: openrouter (default) | claude_first | openrouter_then_claude */
const ORDER_PARSER_EMAIL_RAW = (process.env.ORDER_PARSER_EMAIL || "openrouter").toLowerCase();
const ORDER_PARSER_EMAIL = ORDER_PARSER_EMAIL_RAW.replace(/gemini/g, "openrouter");
const TWILIO_SID = process.env.TWILIO_SID || "";
const TWILIO_AUTH = process.env.TWILIO_AUTH || "";
function cleanTextForParsing(input) {
    return input
        .replace(/\r/g, "\n")
        .replace(/[|;]/g, "\n")
        .replace(/\t/g, " ")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
const URGENT_KEYWORDS = [
    "urgent",
    "asap",
    "immediate",
    "immediately",
    "same day",
    "today evening",
    "by today",
    "tonight",
    "right now",
    "today itself",
    "by tonight",
    "now only",
    "today morning"
];
const HIGH_KEYWORDS = ["rush", "priority", "fast", "quick", "tomorrow", "earliest", "soon", "by tomorrow", "by noon"];
function inferPriority(text) {
    const normalized = text.toLowerCase();
    if (URGENT_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
        return "urgent";
    }
    if (HIGH_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
        return "high";
    }
    return "normal";
}
function inferCustomerName(text, senderHint) {
    const merged = `${text}\n${senderHint ?? ""}`;
    const startNameMatch = text.match(/^\s*([A-Za-z][A-Za-z0-9&.,\- ]{2,80})\s+(?:by|for|pls|please|needs|toship|delivery)/i);
    if (startNameMatch?.[1]) {
        return startNameMatch[1].trim();
    }
    const namePatterns = [
        /\b(?:for|from|to|customer|party|dealer)\s*[:\-]?\s*([A-Za-z0-9&.,\- ]{3,80})/i,
        /\b([A-Za-z][A-Za-z0-9&.,\- ]{2,80}\s(?:pvt ltd|private limited|traders|electronics|enterprises|distributors|agency|agencies|mart|stores|store|co|and co))\b/i
    ];
    for (const pattern of namePatterns) {
        const match = merged.match(pattern);
        const candidate = match?.[1]?.trim();
        if (candidate)
            return candidate;
    }
    if (senderHint?.trim()) {
        return senderHint.split("<")[0].trim() || senderHint.trim();
    }
    return "Unknown";
}
function parseLineItemsFallback(text) {
    const src = cleanTextForParsing(text);
    const lines = src.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
    const items = [];
    const patterns = [
        /^(.+?)\s*(?:x|×|\*|qty|quantity|nos|pcs|pieces|units)\s*[:\-]?\s*(\d+)$/i,
        /^(\d+)\s*(?:x|×|\*|qty|quantity|nos|pcs|pieces|units)?\s*(?:of)?\s*(.+)$/i,
        /^(.+?)\s*[:\-]\s*(\d+)$/i
    ];
    for (const line of lines) {
        for (const pattern of patterns) {
            const m = line.match(pattern);
            if (!m)
                continue;
            const left = m[1]?.trim() ?? "";
            const right = m[2]?.trim() ?? "";
            const qty = Number(/^\d+$/.test(right) ? right : left);
            const product = /^\d+$/.test(right) ? left : right;
            if (!product || !Number.isFinite(qty) || qty <= 0)
                continue;
            items.push({ product, qty: Math.round(qty) });
            break;
        }
    }
    // Deduplicate similar lines while preserving total quantities.
    const merged = new Map();
    for (const item of items) {
        const key = item.product.toLowerCase();
        merged.set(key, (merged.get(key) ?? 0) + item.qty);
    }
    return Array.from(merged.entries()).map(([key, qty]) => ({
        product: items.find((i) => i.product.toLowerCase() === key)?.product || key,
        qty
    }));
}
function buildFallbackParsedOrder(text, senderHint) {
    const items = parseLineItemsFallback(text);
    return {
        customer_name: inferCustomerName(text, senderHint),
        items,
        priority: inferPriority(text),
        notes: "",
        confidence: items.length ? 0.65 : 0.4
    };
}
function normalizeParsedOrder(parsed) {
    const priority = ["urgent", "high", "normal"].includes(parsed.priority)
        ? parsed.priority
        : "normal";
    const items = (parsed.items || [])
        .map((item) => ({
        product: (item.product || "").trim(),
        qty: Math.round(Number(item.qty) || 0)
    }))
        .filter((item) => item.product && item.qty > 0);
    return {
        customer_name: (parsed.customer_name || "Unknown").trim() || "Unknown",
        items,
        priority,
        notes: parsed.notes || "",
        confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5))
    };
}
function parseJsonPayload(raw) {
    if (!raw) {
        return null;
    }
    const stripped = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) {
        return null;
    }
    try {
        return normalizeParsedOrder(JSON.parse(match[0]));
    }
    catch (err) {
        console.warn("Parser returned invalid JSON:", err);
        return null;
    }
}
function buildOrderPrompt(text, senderHint) {
    const senderContext = senderHint ? `Sender info: ${senderHint}\n` : "";
    return `You are an order parsing assistant for iHelp Robotics / SYSCON Electro Tech, an Indian electronics distributor.

${senderContext}Extract order information from the message below. Return ONLY a valid JSON object with these exact keys:
{
  "customer_name": "string",
  "items": [{"product": "string", "qty": number}],
  "priority": "urgent" | "high" | "normal",
  "notes": "string",
  "confidence": number
}

Rules for customer_name:
- Look for business/company names, "from [name]", "for [name]", "to [name]", dealer names
- Common Indian patterns: "Ravi Electronics", "Kumar & Co", "Sri Balaji Traders", "XYZ Pvt Ltd"
- If sender info is available and no other name found, use the sender name
- Use "Unknown" ONLY if absolutely no name can be identified anywhere in the message

Rules for items (CRITICAL - do not miss any):
- Extract ALL product and quantity pairs
- Handle any format: "50 nos Product A", "Product A x 50", "A-50", "50 units of A", "5 pcs B",
  "Product B qty 30", "30 of Product C", "Product D: 10", "10x Product E", "F A- 20"
- "nos" = numbers, "pcs" = pieces, "qty" = quantity - all mean the same thing
- Keep product names as stated; preserve abbreviations and codes used in the message
- If a line item mentions a quantity and a product name, always include it

Rules for priority:
- "urgent": message says urgent / asap / immediately / today / same day
- "high": rush / fast / by tomorrow / priority / need fast
- "normal": everything else (default)

Rules for confidence (0.0 to 1.0):
- 0.9-1.0: Clear order, identified customer, specific products and quantities
- 0.7-0.9: Order intent clear with minor ambiguity
- 0.5-0.7: Might be an order but some info is missing or unclear
- < 0.5: Probably not an order, or too ambiguous to process

Rules for notes:
- Include PO numbers, reference numbers, delivery addresses, special instructions
- Leave as empty string "" if nothing notable

Message to parse:
${text.slice(0, 9000)}

Return ONLY the JSON object. No markdown, no code fences, no explanation.`;
}
async function parseWithGemini(text, senderHint) {
    if (!GEMINI_API_KEY)
        return null;
    const prompt = buildOrderPrompt(text, senderHint);
    try {
        const res = await fetch(`${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                prompt: {
                    text: prompt
                },
                temperature: 0,
                max_output_tokens: 1200,
                candidate_count: 1,
                top_p: 0.95,
                top_k: 40
            })
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            console.error(`Gemini parser error: ${res.status}`, body);
            return null;
        }
        const data = (await res.json());
        const raw = data?.candidates?.[0]?.content ?? "";
        return parseJsonPayload(raw);
    }
    catch (err) {
        console.error("Gemini parse error:", err);
        return null;
    }
}
async function parseWithClaude(text, senderHint) {
    if (!CLAUDE_API_KEY)
        return null;
    const senderContext = senderHint ? `Sender info: ${senderHint}\n` : "";
    const prompt = `You are an order parsing assistant for an electronics distributor in India.

${senderContext}Extract order information from the email content below.
Return ONLY valid JSON with exact keys:
{
  "customer_name": "string",
  "items": [{"product": "string", "qty": number}],
  "priority": "urgent" | "high" | "normal",
  "notes": "string",
  "confidence": number
}

Rules:
- Parse both formal PO formats and informal free-text requests.
- Capture all line items with quantity.
- If unclear/ambiguous, keep best guess and lower confidence.
- Priority defaults to normal unless urgency words clearly exist.
- Use sender name only if customer is not explicitly present.
- If unknown customer, use "Unknown".
- Return only JSON, no markdown.

Email content:
${text.slice(0, 9000)}`;
    try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": CLAUDE_API_KEY,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model: CLAUDE_MODEL,
                max_tokens: 700,
                temperature: 0,
                messages: [{ role: "user", content: prompt }]
            })
        });
        if (!res.ok) {
            console.error(`Claude API error: ${res.status}`, await res.text());
            return null;
        }
        const data = (await res.json());
        const raw = data?.content?.[0]?.text ?? "";
        return parseJsonPayload(raw);
    }
    catch (err) {
        console.error("Claude parse error:", err);
        return null;
    }
}
async function parseEmailOrder(text, senderHint) {
    const fb = () => buildFallbackParsedOrder(text, senderHint);
    if (ORDER_PARSER_EMAIL === "claude_first") {
        return (await parseWithClaude(text, senderHint)) ?? (await parseWithGemini(text, senderHint)) ?? fb();
    }
    if (ORDER_PARSER_EMAIL === "openrouter_then_claude") {
        return (await parseWithGemini(text, senderHint)) ?? (await parseWithClaude(text, senderHint)) ?? fb();
    }
    if (ORDER_PARSER_EMAIL === "claude_only") {
        return (await parseWithClaude(text, senderHint)) ?? fb();
    }
    return (await parseWithGemini(text, senderHint)) ?? fb();
}
/* =====================================================================
   DATABASE INSERT
   Handles customer upsert, payment gate logic, needs_review flag
   ===================================================================== */
async function insertOrder(parsed, channel) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const customerName = parsed.customer_name.trim();
        const needsReview = parsed.confidence < 0.7;
        let existingCustomer = true;
        // Find existing customer or create new one (default: non_regular = payment required)
        let { rows: customers } = await client.query("SELECT id, payment_required FROM customers WHERE name = $1", [customerName]);
        if (!customers.length) {
            existingCustomer = false;
            const { rows: created } = await client.query("INSERT INTO customers(name, type, payment_required) VALUES($1, 'non_regular', true) RETURNING id, payment_required", [customerName]);
            customers = created;
        }
        const { id: customerId, payment_required } = customers[0];
        // Manual workflow: keep incoming orders in New for operator triage/payment checks.
        // Regular trusted customers can start in fulfillment only when review is not required.
        const status = "new";
        const paymentStatus = payment_required ? "pending" : "paid";
        const { rows: orderRows } = await client.query(`INSERT INTO orders(customer_id, channel, priority, status, payment_status, needs_review, notes)
       VALUES($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [customerId, channel, parsed.priority, status, paymentStatus, needsReview, parsed.notes]);
        const orderId = orderRows[0].id;
        // Insert all line items
        for (const item of parsed.items) {
            const qty = Math.round(Number(item.qty));
            if (!item.product?.trim() || isNaN(qty) || qty <= 0)
                continue;
            await client.query("INSERT INTO order_items(order_id, product_name, qty_ordered) VALUES($1, $2, $3)", [orderId, item.product.trim(), qty]);
        }
        await client.query("COMMIT");
        console.log(`✅ [${channel.toUpperCase()}] Order ${orderId} | Customer: ${customerName} | ` +
            `Items: ${parsed.items.length} | Priority: ${parsed.priority} | ` +
            `Review: ${needsReview} | ExistingCustomer: ${existingCustomer} | Status: ${status}`);
        return orderId;
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("DB insert error:", err);
        throw err;
    }
    finally {
        client.release();
    }
}
const ORDER_KEYWORDS = [
    "order",
    "purchase order",
    "po",
    "quotation",
    "quote",
    "dispatch",
    "delivery",
    "ship",
    "shipment",
    "invoice",
    "awb",
    "items",
    "sku",
    "qty",
    "quantity",
    "pieces",
    "pcs",
    "nos",
    "docket"
];
const NEGATIVE_EMAIL_KEYWORDS = [
    "otp",
    "one time password",
    "verification code",
    "authenticate",
    "security alert",
    "google play",
    "password reset",
    "sign in",
    "login code",
    "2fa",
    "subscription",
    "support",
    "helpdesk",
    "notification",
    "alert",
    "newsletter",
    "receipt",
    "welcome",
    "signup",
    "trial"
];
function isLikelyOrderEmail(subject, text) {
    const src = `${subject}\n${text}`.toLowerCase();
    if (NEGATIVE_EMAIL_KEYWORDS.some((keyword) => src.includes(keyword)))
        return false;
    if (!ORDER_KEYWORDS.some((keyword) => src.includes(keyword)))
        return false;
    if (!containsKnownSku(src))
        return false;
    return true;
}
async function extractAttachmentText(mail) {
    const parts = [];
    for (const att of mail.attachments || []) {
        const filename = (att.filename || "attachment").trim();
        const ctype = (att.contentType || "").toLowerCase();
        const content = att.content;
        if (!content || !Buffer.isBuffer(content))
            continue;
        try {
            if (ctype.includes("pdf") || filename.toLowerCase().endsWith(".pdf")) {
                const parser = new PDFParse({ data: Uint8Array.from(content) });
                const parsed = await parser.getText();
                await parser.destroy();
                const text = (parsed?.text || "").replace(/\s+/g, " ").trim();
                if (text)
                    parts.push(`[PDF ${filename}] ${text.slice(0, 6000)}`);
            }
            else if (ctype.startsWith("text/") ||
                /\.(txt|csv|tsv|log|md)$/i.test(filename)) {
                const text = content.toString("utf8").replace(/\s+/g, " ").trim();
                if (text)
                    parts.push(`[TEXT ${filename}] ${text.slice(0, 4000)}`);
            }
            else {
                parts.push(`[ATTACHMENT ${filename}] content-type=${ctype || "unknown"}`);
            }
        }
        catch (err) {
            console.warn(`Attachment parse failed for ${filename}:`, err);
        }
    }
    return parts.join("\n\n");
}
async function isDuplicateEmailOrder(messageId) {
    if (!messageId.trim())
        return false;
    const needle = `%email_message_id:${messageId}%`;
    const { rows } = await pool.query("SELECT id FROM orders WHERE channel = 'email' AND notes ILIKE $1 LIMIT 1", [needle]);
    return rows.length > 0;
}
async function handleIncomingEmail({ mail, messageId, markAsSeen, subjectOverride, senderHintOverride }) {
    const safeMarkSeen = async () => {
        try {
            await markAsSeen();
        }
        catch (err) {
            console.warn("Failed to mark email as seen:", err);
        }
    };
    try {
        const subject = (subjectOverride ?? mail.subject ?? "").trim();
        const from = mail.from?.value?.[0];
        const fallbackSender = senderHintOverride?.trim() ||
            (from ? (from.name ? `${from.name} <${from.address ?? ""}>` : from.address ?? "") : "");
        let emailText = "";
        if (mail.text) {
            emailText = mail.text.toString();
        }
        else if (mail.html) {
            emailText = mail.html
                .toString()
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
                .replace(/<[^>]+>/g, " ")
                .replace(/&nbsp;/g, " ")
                .replace(/\s+/g, " ")
                .trim();
        }
        const attachmentText = await extractAttachmentText(mail);
        let payloadText = `Subject: ${subject}\n\n${emailText}`;
        if (attachmentText) {
            payloadText += `\n\n${attachmentText}`;
        }
        if (!payloadText.trim()) {
            return;
        }
        if (!isLikelyOrderEmail(subject, payloadText)) {
            console.log(`Skipped email - not an order | Sender: ${fallbackSender}`);
            return;
        }
        if (messageId && (await isDuplicateEmailOrder(messageId))) {
            return;
        }
        const parsed = await parseEmailOrder(payloadText, fallbackSender);
        if (!parsed || !parsed.items.length) {
            console.log(`Skipped email - not an order | Sender: ${fallbackSender}`);
            return;
        }
        const invalidProducts = getUnknownSkuItems(parsed.items);
        if (invalidProducts.length) {
            console.warn(`Skipped email - contains unknown SKUs (${invalidProducts.join(", ")}) | Sender: ${fallbackSender}`);
            return;
        }
        if (!parsed.customer_name || parsed.customer_name === "Unknown") {
            parsed.customer_name = fallbackSender || "Unknown";
        }
        if (messageId) {
            parsed.notes = `${parsed.notes ? `${parsed.notes}\n` : ""}email_message_id:${messageId}`;
        }
        await insertOrder(parsed, "email");
    }
    catch (err) {
        console.error("Email handling error:", err);
    }
    finally {
        await safeMarkSeen();
    }
}
async function resetImapClient() {
    if (!imapClientInstance)
        return;
    try {
        await imapClientInstance.logout();
    }
    catch {
        // ignore logout failures; the client will be recreated on the next poll
    }
    finally {
        imapClientInstance = null;
        imapClientPromise = null;
    }
}
async function ensureImapClient() {
    if (!hasImapCredentials())
        return null;
    if (imapClientInstance)
        return imapClientInstance;
    if (imapClientPromise)
        return imapClientPromise;
    imapClientPromise = (async () => {
        const client = new ImapFlow({
            host: IMAP_HOST,
            port: IMAP_PORT,
            secure: IMAP_SECURE,
            auth: {
                user: IMAP_USER,
                pass: IMAP_PASS
            },
            logger: false,
            socketTimeout: IMAP_SOCKET_TIMEOUT_MS,
            connectionTimeout: IMAP_SOCKET_TIMEOUT_MS
        });
        client.on("error", (err) => {
            console.error("IMAP client error:", err);
            imapClientInstance = null;
            imapClientPromise = null;
        });
        try {
            await client.connect();
            imapClientInstance = client;
            imapClientPromise = null;
            return client;
        }
        catch (err) {
            imapClientInstance = null;
            imapClientPromise = null;
            throw err;
        }
    })();
    return imapClientPromise;
}
/* =====================================================================
   IMAP EMAIL POLLER — polls every 2 minutes per spec
   Processes unseen emails, extracts order info via the AI parser
   ===================================================================== */
async function pollImap() {
    if (!hasImapCredentials()) {
        return; // silently skip if IMAP not configured
    }
    if (imapPollRunning) {
        return;
    }
    imapPollRunning = true;
    let lock = null;
    let shouldResetImapClient = false;
    try {
        const imapClient = await ensureImapClient();
        if (!imapClient) {
            return;
        }
        lock = await imapClient.getMailboxLock("INBOX");
        const unseen = await imapClient.search({ seen: false });
        if (!Array.isArray(unseen) || !unseen.length) {
            return;
        }
        const toFetch = unseen.slice(-200);
        for await (const msg of imapClient.fetch(toFetch, { source: true, uid: true })) {
            if (!msg.source)
                continue;
            const markSeen = async () => {
                if (!msg.uid)
                    return;
                try {
                    await imapClient.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"]);
                }
                catch (err) {
                    console.warn("Failed to mark IMAP message as seen:", err);
                }
            };
            try {
                const mail = await simpleParser(msg.source);
                const messageId = (mail.messageId || "").trim();
                await handleIncomingEmail({
                    mail,
                    messageId,
                    markAsSeen: markSeen,
                    subjectOverride: mail.subject?.trim()
                });
            }
            catch (parseErr) {
                console.error("Email parse error:", parseErr);
                await markSeen();
            }
        }
    }
    catch (err) {
        const code = err?.code;
        if (code === "NoConnection" || code === "ETIMEOUT") {
            console.warn(`IMAP poll warning: ${code}. Will retry next cycle.`);
            shouldResetImapClient = true;
        }
        else {
            console.error("IMAP poll error:", err);
        }
    }
    finally {
        if (lock) {
            try {
                await lock.release();
            }
            catch (releaseErr) {
                console.warn("Failed to release IMAP lock:", releaseErr);
            }
        }
        if (shouldResetImapClient) {
            await resetImapClient();
        }
        imapPollRunning = false;
    }
}
// Run once on startup then every configured interval
if (useGmailPush) {
    gmailPushService = createGmailPushService({
        clientId: GMAIL_PUSH_CLIENT_ID,
        clientSecret: GMAIL_PUSH_CLIENT_SECRET,
        refreshToken: GMAIL_PUSH_REFRESH_TOKEN,
        topicName: GMAIL_PUSH_TOPIC,
        verificationToken: GMAIL_PUSH_VERIFICATION_TOKEN,
        watchRenewalIntervalMs: GMAIL_WATCH_RENEW_INTERVAL_MS,
        maxUnreadFetch: GMAIL_UNREAD_FETCH_LIMIT,
        processMail: ({ mail, messageId, markAsSeen }) => handleIncomingEmail({ mail, messageId, markAsSeen })
    });
    gmailPushService
        .ensureWatch()
        .catch((err) => console.error("Failed to initialize Gmail push watcher", err));
    app.post("/api/gmail-push", gmailPushService.pushHandler);
}
else {
    pollImap();
    setInterval(pollImap, IMAP_POLL_INTERVAL_MS);
}
// Manual trigger for testing email ingestion without waiting 5 minutes.
app.post("/api/email-poll", async (_req, res) => {
    try {
        if (gmailPushService) {
            await gmailPushService.pollUnread();
        }
        else {
            await pollImap();
        }
        return res.json({ ok: true });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Email poll failed";
        return res.status(500).json({ ok: false, error: message });
    }
});
/* =====================================================================
   TWILIO WHATSAPP WEBHOOK
   POST /api/twilio-webhook
   Configure this URL in your Twilio WhatsApp Sandbox / Business settings
   ===================================================================== */
async function tryParsePdfAttachments(form, senderHint) {
    const mediaCount = Number(form.NumMedia ?? form.Num_media ?? "0");
    if (!mediaCount || !TWILIO_SID || !TWILIO_AUTH) {
        return null;
    }
    const authHeader = `Basic ${Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString("base64")}`;
    for (let index = 0; index < mediaCount; index += 1) {
        const mediaUrl = form[`MediaUrl${index}`];
        const mediaType = (form[`MediaContentType${index}`] ?? "").toLowerCase();
        if (!mediaUrl || !mediaType.includes("pdf"))
            continue;
        try {
            const response = await fetch(mediaUrl, {
                headers: {
                    Authorization: authHeader,
                    Accept: "application/pdf"
                }
            });
            if (!response.ok) {
                console.warn(`Failed to download Twilio media ${mediaUrl}: ${response.status}`);
                continue;
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            const parsed = await parseInvoicePdf(buffer, senderHint || "WhatsApp Customer");
            if (parsed && parsed.items.length) {
                return parsed;
            }
        }
        catch (err) {
            console.warn("PDF attachment parse error:", err);
        }
    }
    return null;
}
function isValidTwilioSignature(authToken, signature, url, params) {
    try {
        // Build validation string per Twilio spec: url + sorted params concatenated
        const sortedStr = Object.keys(params)
            .sort()
            .reduce((acc, key) => acc + key + (params[key] ?? ""), url);
        const expected = crypto.createHmac("sha1", authToken).update(sortedStr, "utf8").digest("base64");
        if (!signature)
            return false;
        const encoder = new TextEncoder();
        const a = encoder.encode(signature);
        const b = encoder.encode(expected);
        if (a.length !== b.length)
            return false;
        return crypto.timingSafeEqual(a, b);
    }
    catch {
        return false;
    }
}
async function handleTwilioWebhook(req, res) {
    const twilioAuth = process.env.TWILIO_AUTH;
    const publicUrl = process.env.PUBLIC_URL;
    const webhookUrl = `${publicUrl || ""}/api/twilio-webhook`;
    if (twilioAuth && publicUrl) {
        const sig = req.headers["x-twilio-signature"] || "";
        if (!isValidTwilioSignature(twilioAuth, sig, webhookUrl, req.body)) {
            console.warn("⚠️ Rejected request with invalid Twilio signature");
            return res.status(403).send("Forbidden");
        }
    }
    const messageText = (req.body.Body || "").trim();
    const profileName = (req.body.ProfileName || "").trim();
    const fromRaw = (req.body.From || "").trim();
    const fromNumber = fromRaw.replace("whatsapp:", "");
    const senderHint = profileName || fromNumber;
    const pdfParsed = await tryParsePdfAttachments(req.body, senderHint);
    if (!messageText && !pdfParsed) {
        return res
            .type("text/xml")
            .send(`<Response><Message>Please send your order details, e.g. "50 Product A, 30 Product B for Ravi Electronics".</Message></Response>`);
    }
    try {
        const parsed = pdfParsed ??
            (await parseWithGemini(messageText, senderHint)) ??
            buildFallbackParsedOrder(messageText, senderHint);
        if (pdfParsed) {
            console.log(`[WHATSAPP] Parsed invoice PDF for ${senderHint || "unknown sender"} | Items: ${pdfParsed.items
                .map((item) => `${item.qty}x ${item.product}`)
                .join(", ")}`);
        }
        if (!parsed || !parsed.items.length) {
            return res
                .type("text/xml")
                .send(`<Response><Message>❌ Could not read your order. Please list items and quantities clearly.\nExample: "50 Product A, 30 Product B for Ravi Electronics"</Message></Response>`);
        }
        const invalidProducts = getUnknownSkuItems(parsed.items);
        if (invalidProducts.length) {
            return res
                .type("text/xml")
                .send(`<Response><Message>⚠️ We only accept catalog SKUs. Unknown items: ${invalidProducts.join(", ")}. Please resend using published products like 890 HTM, Reflective tapes, or TM 804 Sensor.</Message></Response>`);
        }
        if (!parsed.customer_name || parsed.customer_name === "Unknown") {
            parsed.customer_name = profileName || fromNumber || "Unknown";
        }
        await insertOrder(parsed, "whatsapp");
        const itemSummary = parsed.items.map((i) => `${i.qty}x ${i.product}`).join(", ");
        return res
            .type("text/xml")
            .send(`<Response><Message>✅ Order received for ${parsed.customer_name}: ${itemSummary}. Tracking will be shared when shipped.</Message></Response>`);
    }
    catch (err) {
        console.error("Twilio webhook error:", err);
        return res
            .type("text/xml")
            .send(`<Response><Message>Sorry, there was an error processing your order. Please try again or contact us directly.</Message></Response>`);
    }
}
app.post("/api/twilio-webhook", handleTwilioWebhook);
app.post("/", handleTwilioWebhook);
// Helpful response when opened in browser directly.
app.get("/api/twilio-webhook", (_req, res) => {
    return res.status(200).json({
        ok: true,
        message: "Twilio webhook endpoint is live. Use POST from Twilio, not GET."
    });
});
/* =====================================================================
   SMART PARSE — POST /api/parse-message
   Called by the frontend "Extract with AI" button.
   ONLY parses and returns structured data — does NOT insert into DB.
   The user reviews in the New Order form before submitting.
   ===================================================================== */
app.post("/api/parse-message", async (req, res) => {
    const { text } = req.body;
    if (!text?.trim()) {
        return res.status(400).json({ ok: false, error: "text is required" });
    }
    try {
        const parsed = (await parseWithGemini(text)) ?? buildFallbackParsedOrder(text);
        parsed.priority = inferPriority(`${text}\n${parsed.notes ?? ""}`);
        if (!parsed) {
            return res.status(422).json({
                ok: false,
                error: "Could not parse message. Try rephrasing with clear product names and quantities."
            });
        }
        // Return in the shape Board.tsx handleRawImport expects
        return res.json({
            ok: true,
            customer_name: parsed.customer_name,
            items: parsed.items.map((i) => ({
                product_name: i.product,
                qty_ordered: Number(i.qty)
            })),
            priority: parsed.priority,
            notes: parsed.notes,
            confidence: parsed.confidence,
            channel: "direct" // user can change in the New Order form
        });
    }
    catch (err) {
        console.error("parse-message error:", err);
        return res.status(500).json({ ok: false, error: "Internal error during parsing." });
    }
});
app.get("/api/sku-products", (_req, res) => {
    const products = skuDefinitions.map((entry) => ({
        sku: entry.sku,
        name: entry.instrument,
        description: entry.description,
        aliases: entry.aliases ?? []
    }));
    return res.json({ ok: true, products });
});
/* =====================================================================
   FUTURE INTEGRATION STUBS — uncomment when ready
   ===================================================================== */
app.post("/api/integrations/sku/resolve", async (_req, res) => {
    return res.status(501).json({
        ok: false,
        code: "NOT_IMPLEMENTED",
        message: "SKU resolver endpoint stub. Wire SKU DB lookup here later."
    });
});
app.post("/api/integrations/amazon/orders", async (_req, res) => {
    return res.status(501).json({
        ok: false,
        code: "NOT_IMPLEMENTED",
        message: "Amazon Seller Partner API endpoint stub. Add auth and order ingest logic later."
    });
});
app.post("/api/integrations/sku/inventory", async (_req, res) => {
    return res.status(501).json({
        ok: false,
        code: "NOT_IMPLEMENTED",
        message: "SKU inventory endpoint stub. Add stock in/out sync and reservation logic here."
    });
});
app.post("/api/integrations/sku/availability", async (_req, res) => {
    return res.status(501).json({
        ok: false,
        code: "NOT_IMPLEMENTED",
        message: "SKU availability endpoint stub. Use for partial shipment quantity recommendations."
    });
});
/* =====================================================================
   START
   ===================================================================== */
const PORT = Number(process.env.PORT) || 4000;
const hasTwilioValidation = Boolean(process.env.TWILIO_AUTH && process.env.PUBLIC_URL);
const server = app.listen(PORT, () => {
    console.log(`🚀 DispatchBoard API running on port ${PORT}`);
    console.log(`📧 IMAP polling: ${process.env.IMAP_HOST
        ? `enabled every 5 min (${process.env.IMAP_USER})`
        : "disabled — set IMAP_HOST, IMAP_USER, IMAP_PASS to enable"}`);
    console.log(`💬 Twilio signature validation: ${hasTwilioValidation ? "ON" : "OFF — set TWILIO_AUTH + PUBLIC_URL to enable"}`);
    if (process.env.TWILIO_AUTH && !process.env.PUBLIC_URL) {
        console.warn("⚠️ TWILIO_AUTH is set but PUBLIC_URL is missing.");
    }
    if (process.env.PUBLIC_URL && !process.env.TWILIO_AUTH) {
        console.warn("⚠️ PUBLIC_URL is set but TWILIO_AUTH is missing.");
    }
    console.log(`🤖 Parser model: ${GEMINI_MODEL}`);
    console.log(`📩 Email parser: ${ORDER_PARSER_EMAIL} (ORDER_PARSER_EMAIL=openrouter | openrouter_then_claude | claude_first | claude_only)`);
});
server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        console.error(`❌ Port ${PORT} is already in use. Stop the existing backend process and retry.`);
        process.exit(1);
    }
    console.error("❌ Server startup error:", err);
    process.exit(1);
});
