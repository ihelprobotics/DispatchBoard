/* eslint-disable no-console */

// Usage:
//   node backend/scripts/analyze-pdfs.cjs
//
// Reads PDF files from repo root (../) and prints extracted customer + (product, qty).

const fs = require("fs");
const path = require("path");

const pdfMod = require("../node_modules/pdf-parse");
const PDFParse = pdfMod.PDFParse || pdfMod.default || pdfMod;

const ROOT = path.resolve(__dirname, "..", "..");

const files = fs
  .readdirSync(ROOT)
  .filter((f) => f.toLowerCase().endsWith(".pdf"))
  .filter((f) => /(invoice|flipkart|shipping|label)/i.test(f));

const lines = (s) =>
  String(s)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

const sanitiseName = (raw) =>
  String(raw || "")
    .trim()
    .replace(
      /\b(today|tonight|tomorrow|tmrw|tmw|urgent|asap|soon|quick|fast|immediately|by|next week|next month|eod|morning|evening|delivery|deliver|weekend|week end|please|kindly|regards|thanks|thank you)\b.*/i,
      ""
    )
    .trim()
    .replace(/[,.\-]+$/, "")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

function pickName(text) {
  const ls = lines(text);
  const nextNonEmptyLine = (startIndex) => {
    for (let i = startIndex + 1; i < ls.length; i++) {
      const cand = ls[i];
      if (!cand) continue;
      if (/^(in|india)$/i.test(cand)) continue;
      if (/^state\/ut\s*code/i.test(cand)) continue;
      if (/^(pan|gst|gstin|order|invoice|place of|payment|whether tax)/i.test(cand)) continue;
      return cand;
    }
    return "";
  };

  for (let i = 0; i < ls.length; i++) {
    if (/^billing\s+address\b/i.test(ls[i])) {
      const inline = ls[i].replace(/^billing\s+address\s*[:\-]?\s*/i, "").trim();
      const candidate = inline || nextNonEmptyLine(i);
      const name = sanitiseName(candidate.replace(/,+$/, ""));
      if (name) return name;
    }
  }
  for (let i = 0; i < ls.length; i++) {
    if (/^shipping\s+address\b/i.test(ls[i])) {
      const inline = ls[i].replace(/^shipping\s+address\s*[:\-]?\s*/i, "").trim();
      const candidate = inline || nextNonEmptyLine(i);
      const name = sanitiseName(candidate.replace(/,+$/, ""));
      if (name) return name;
    }
  }

  const flat = text.replace(/\s+/g, " ").trim();
  const m = flat.match(/shipping\/customer address\s*:\s*name\s*:\s*([a-z][a-z .]{2,60})/i);
  if (m?.[1]) return sanitiseName(m[1]);
  return "";
}

function extractItems(text) {
  const items = [];
  const cleanProduct = (raw) => {
    const s = String(raw || "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    return (s.split("|")[0] || s).trim();
  };

  // Flipkart labels row: "1 B0C62CYP9V | ... 1"
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^\s*\d+\s+[A-Z0-9]{10}\s*\|\s*(.+?)\s*$/);
    if (!m?.[1]) continue;
    const rest = m[1].replace(/\s+/g, " ").trim();
    const qtyMatch = rest.match(/\s(\d{1,4})\s*$/);
    if (!qtyMatch?.[1]) continue;
    const qty = Number(qtyMatch[1]);
    const product = rest.replace(/\s(\d{1,4})\s*$/, "").trim();
    if (product && Number.isFinite(qty) && qty > 0) items.push({ product: cleanProduct(product), qty });
  }

  // Amazon invoice style: "... HSN:... \n ₹... <qty> ₹..."
  const amazonRe =
    /\n\s*\d+\s+([\s\S]+?)\n\s*HSN:[^\n]*\n\s*₹?\s*[\d,]+(?:\.\d+)?\s+(\d{1,4})\s+₹?/g;
  for (const m of text.matchAll(amazonRe)) {
    const product = cleanProduct(String(m[1] || "").replace(/\s+/g, " ").trim());
    const qty = Number(m[2]);
    if (product && Number.isFinite(qty) && qty > 0) items.push({ product, qty });
  }

  return items;
}

(async () => {
  for (const f of files) {
    const full = path.join(ROOT, f);
    const buf = fs.readFileSync(full);

    const parser = new PDFParse({ data: buf });
    await parser.load();
    const result = await parser.getText();
    const text = typeof result === "string" ? result : String(result?.text ?? "");

    const customer = pickName(text);
    const items = extractItems(text);

    console.log(`\n==== ${f} ====`);
    console.log(`Customer: ${customer || "(not found)"}`);
    console.log(`Items: ${items.length ? JSON.stringify(items, null, 2) : "(none)"}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
