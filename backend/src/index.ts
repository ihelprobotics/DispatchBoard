import "dotenv/config";
import express from "express";
import cors from "cors";
import pg from "pg";
import { simpleParser, ParsedMail } from "mailparser";
import { ImapFlow } from "imapflow";

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================= DB ================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

/* ================= GEMINI ================= */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

async function parseWithGemini(text: string) {
  try {
    const prompt = `
Return ONLY valid JSON.

{
  "customer_name": string,
  "items": [{"product": string, "qty": number}],
  "priority": "urgent" | "high" | "normal",
  "notes": string,
  "confidence": number
}

Message:
${text}
`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0 }
        })
      }
    );

    if (!res.ok) throw new Error("Gemini API failed");

    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!raw) throw new Error("Empty Gemini response");

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Invalid JSON");

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error("Gemini Error:", err);
    return null;
  }
}

/* ================= FALLBACK ================= */

function fallbackParser(text: string) {
  const items: any[] = [];
  const matches = text.match(/(\d+)\s*([A-Za-z]+)/g);

  if (matches) {
    for (const m of matches) {
      const [qty, product] = m.split(" ");
      items.push({ product, qty: Number(qty) });
    }
  }

  return {
    customer_name: "Unknown",
    items,
    priority: "normal",
    notes: "",
    confidence: 0.5
  };
}

/* ================= INSERT ================= */

async function insertOrder(parsed: any, channel: string) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const name = parsed.customer_name || "Unknown";

    let customer = await client.query(
      "SELECT * FROM customers WHERE name=$1",
      [name]
    );

    if (!customer.rows[0]) {
      customer = await client.query(
        "INSERT INTO customers(name,type,payment_required) VALUES($1,'non_regular',true) RETURNING *",
        [name]
      );
    }

    const c = customer.rows[0];
    const status = c.payment_required ? "payment" : "fulfillment";

    const order = await client.query(
      `INSERT INTO orders(customer_id,channel,priority,status,payment_status)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [
        c.id,
        channel,
        parsed.priority || "normal",
        status,
        c.payment_required ? "pending" : "paid"
      ]
    );

    for (const item of parsed.items || []) {
      await client.query(
        "INSERT INTO order_items(order_id,product_name,qty_ordered) VALUES($1,$2,$3)",
        [order.rows[0].id, item.product, item.qty]
      );
    }

    await client.query("COMMIT");
    console.log("✅ Order inserted:", order.rows[0].id);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("DB Error:", err);
  } finally {
    client.release();
  }
}

/* ================= IMAP ================= */

async function pollImap() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST!,
    port: Number(process.env.IMAP_PORT || 993),
    secure: process.env.IMAP_SECURE !== "false",
    auth: {
      user: process.env.IMAP_USER!,
      pass: process.env.IMAP_PASS!
    }
  });

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");

  try {
    for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
      if (!msg.source) continue;

      const parsedMail: ParsedMail = await simpleParser(msg.source as Buffer);
      const text = (parsedMail.text || parsedMail.html || "").toString().trim();

      if (!text) continue;

      console.log("📧 EMAIL:", text);

      let parsed = await parseWithGemini(text);
      if (!parsed) parsed = fallbackParser(text);

      console.log("📦 PARSED:", parsed);

      await insertOrder(parsed, "email");

      await client.messageFlagsAdd(msg.uid, ["\\Seen"]);
    }
  } catch (err) {
    console.error("IMAP Error:", err);
  } finally {
    lock.release();
    await client.logout();
  }
}

/* ================= AUTO POLL ================= */

setInterval(async () => {
  console.log("📥 Checking emails...");
  await pollImap();
}, 120000);

/* ================= WHATSAPP ================= */

app.post("/api/twilio-webhook", async (req, res) => {
  try {
    const message = req.body.Body;
    const from = req.body.From;

    console.log("📱 WHATSAPP:", message);

    if (!message) return res.sendStatus(200);

    let parsed = await parseWithGemini(message);
    if (!parsed) parsed = fallbackParser(message);

    await insertOrder(parsed, "whatsapp");

    res.set("Content-Type", "text/xml");
    res.send(`<Response><Message>Order received ✅</Message></Response>`);
  } catch (err) {
    console.error("Webhook Error:", err);
    res.sendStatus(500);
  }
});

/* ================= BASIC ================= */

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT || 4000);

app.listen(PORT, () => {
  console.log(`🚀 API running on ${PORT}`);
});