import "dotenv/config";
import express from "express";
import cors from "cors";
import pg from "pg";
import crypto from "crypto";
import os from "os";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import fetch, { type RequestInit, type Response } from "node-fetch";

const { Pool } = pg;

/* ============================================================
   TYPES
   ============================================================ */

interface ParsedItem {
  product: string; // canonical instrument name from catalog
  sku: string;     // catalog SKU key
  qty: number;
}

interface GeminiRaw {
  customer_name?: string;
  items?: Array<{ product?: string; sku?: string; qty?: number }>;
  priority?: string;
  notes?: string;
  confidence?: number;
  unrecognised_items?: string[];
}

type Priority = "urgent" | "high" | "normal";

type SkuDefinition = {
  sku: string;
  instrument: string;
  description: string;
  aliases: string[];
};

/* ============================================================
   HELPERS
   ============================================================ */

function escapeXml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/* ============================================================
   SKU CATALOG  (single source of truth)
   ============================================================ */

const SKU_CATALOG: SkuDefinition[] = [
  {
    sku: "HTM-890",
    instrument: "890 HTM",
    description: "HTM-890 2-in-1 Contact cum Non Contact Digital Tachometer",
    aliases: ["htm890", "htm 890", "htm-890", "890htm", "890 tachometer"]
  },
  {
    sku: "REFLECTIVE-TAPES",
    instrument: "Reflective tapes",
    description: "Reflective tapes",
    aliases: ["reflective tape", "refl tape", "reflective tapes"]
  },
  {
    sku: "RUBBER-TIPS",
    instrument: "Rubber tips",
    description: "Rubber tips",
    aliases: ["rubber tip", "rubber tips"]
  },
  {
    sku: "HTM-560",
    instrument: "560 HTM",
    description: "HTM-560 Non-Contact Digital Tachometer",
    aliases: ["htm560", "htm 560", "htm-560", "560htm"]
  },
  {
    sku: "HTM-590",
    instrument: "590 HTM",
    description: "HTM-590 Contact Type Digital Tachometer",
    aliases: ["htm590", "htm 590", "htm-590", "590htm"]
  },
  {
    sku: "TS-201",
    instrument: "TS 201",
    description: "TS-201 Temperature and Humidity 2-in-1 Sensor with IoT",
    aliases: ["ts201", "ts-201", "ts 201", "temperature humidity sensor", "temp humidity sensor"]
  },
  {
    sku: "TS-200",
    instrument: "TS 200",
    description: "TS-200 Temperature sensor with IoT",
    aliases: ["ts200", "ts-200", "ts 200", "temperature sensor iot", "temp sensor iot"]
  },
  {
    sku: "TM-804-SENSOR",
    instrument: "TM 804 Sensor alone",
    description: "TM-804 Photo-Reflective Sensor",
    aliases: ["tm804 sensor", "tm 804 sensor", "tm-804-sensor", "804 sensor", "tm804sensor"]
  },
  {
    sku: "TM-802-SENSOR",
    instrument: "TM 802 Sensor alone",
    description: "TM-802 Magnetic Pickup Sensor",
    aliases: ["tm802 sensor", "tm 802 sensor", "tm-802-sensor", "802 sensor", "tm802sensor"]
  },
  {
    sku: "TM-804-PLUS",
    instrument: "TM 804+ Sensor",
    description: "TM 804 Digital Panel Mount Tachometer with Photo-Reflective Sensor",
    aliases: ["tm804+", "tm 804+", "tm804 plus", "tm 804 plus", "tm-804-plus", "tm804plus"]
  },
  {
    sku: "TM-803-PLUS",
    instrument: "TM 803+ Sensor",
    description: "TM 803 Digital Panel Mount Tachometer with Proximity Switch Sensor",
    aliases: ["tm803+", "tm 803+", "tm803 plus", "tm 803 plus", "tm-803-plus", "tm803plus"]
  },
  {
    sku: "TM-802-PLUS",
    instrument: "TM 802+ Sensor",
    description: "TM 802 Digital Panel Mount Tachometer with Magnetic Pick-up Sensor",
    aliases: ["tm802+", "tm 802+", "tm802 plus", "tm 802 plus", "tm-802-plus", "tm802plus"]
  },
  {
    sku: "TM-801-PLUS",
    instrument: "TM 801+ Sensor",
    description: "TM 801 Digital Panel Mount Tachometer with Digital Tachogenerator Sensor",
    aliases: ["tm801+", "tm 801+", "tm801 plus", "tm 801 plus", "tm-801-plus", "tm801plus"]
  },
  {
    sku: "TM-803",
    instrument: "TM 803 Sensor alone",
    description: "TM 803 Sensor",
    aliases: ["tm803 sensor alone", "tm 803 sensor alone", "tm-803", "tm803"]
  },
  {
    sku: "TM-801",
    instrument: "TM 801 Sensor alone",
    description: "TM 801 Sensor",
    aliases: ["tm801 sensor alone", "tm 801 sensor alone", "tm-801", "tm801"]
  },
  {
    sku: "REFLECTIVE-TAPE-ROLL",
    instrument: "High Intensity Reflective Tape",
    description: "High Intensity Reflective Tape - 3 Feet per Roll",
    aliases: ["reflective tape roll", "high intensity reflective tape", "tape roll", "hi reflective tape", "refl tape roll"]
  },
  {
    sku: "RUBBER-TIPS-PREMIUM",
    instrument: "Premium Rubber Tips for Tachometers",
    description: "Premium Rubber Tips - Set of 4 Durable Plastic Nose Tips",
    aliases: ["premium rubber tips", "premium tips", "durable plastic nose tips", "premium rubber tip"]
  },
  {
    sku: "TM-803-PROX",
    instrument: "TM 803 Proximity Pickup Sensor alone",
    description: "TM 803 Proximity Pickup Sensor alone",
    aliases: [
      "tm803 prox", "tm 803 prox", "tm-803-prox", "tm803prox",
      "tm803 proximity", "tm 803 proximity",
      "tm 803 pro",  // common abbreviation - PRO prefix matches PROX
      "tm803 pro",
      "tm-803-pro"
    ]
  },
  {
    sku: "TM-801-TA",
    instrument: "TM 801 Tachogenerator Sensor alone",
    description: "TM 801 Tachogenerator Sensor alone",
    aliases: [
      "tm801 ta", "tm 801 ta", "tm-801-ta", "tm801ta",
      "tm801 tachogenerator", "tm 801 tachogenerator",
      "tm 801 tacho", "tm801 tacho"
    ]
  },
  {
    sku: "TM-DISPLAY",
    instrument: "TM Display",
    description: "Digital Panel Mount Tachometer (Display only)",
    aliases: ["tm display", "panel mount display", "tachometer display", "tm-display"]
  },
  {
    sku: "TM-CARDS",
    instrument: "TM Cards",
    description: "Panel Mount Cards",
    aliases: ["tm card", "panel mount cards", "panel cards", "tm-cards", "tm cards"]
  }
];

/* ============================================================
   SKU MATCHING LOGIC
   Three layers: exact SKU → full keyword match → prefix match
   ============================================================ */

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

// Pre-compute normalised keyword sets for each SKU
const MATCHERS = SKU_CATALOG.map((entry) => ({
  entry,
  normSku: norm(entry.sku),
  keywords: Array.from(
    new Set([entry.sku, entry.instrument, entry.description, ...entry.aliases].map(norm).filter(Boolean))
  )
}));

const STRONG_KEYWORDS_BY_SKU = new Map<string, string[]>(
  MATCHERS.map((m) => [
    m.entry.sku,
    m.keywords.filter((k) => /\d/.test(k) || k.replace(/\s+/g, "").length >= 6)
  ])
);

function findSku(raw: string): SkuDefinition | null {
  const n = norm(raw);
  if (!n) return null;

  // Layer 1: exact SKU match (e.g. "TM-803-PROX")
  for (const m of MATCHERS) {
    if (m.normSku === n) return m.entry;
  }

  // Layer 2: any keyword is contained in input OR input is contained in keyword
  for (const m of MATCHERS) {
    if (m.keywords.some((k) => n.includes(k) || k.includes(n))) return m.entry;
  }

  // Layer 3: prefix matching for abbreviations
  // "tm 803 pro" → PROX  because "tm 803 pro" is a prefix of "tm 803 prox"
  // "tm 801 ta"  → TM-801-TA because "ta" is an alias token
  for (const m of MATCHERS) {
    if (m.keywords.some((k) => k.startsWith(n) || n.startsWith(k.slice(0, Math.max(4, k.length - 2))))) {
      return m.entry;
    }
  }

  // Layer 4: significant token overlap (≥2 tokens of length≥2 must match)
  const nTokens = n.split(" ").filter((t) => t.length >= 2);
  for (const m of MATCHERS) {
    for (const k of m.keywords) {
      const kTokens = k.split(" ").filter((t) => t.length >= 2);
      const shared = nTokens.filter((t) => kTokens.some((kt) => kt === t || kt.startsWith(t) || t.startsWith(kt)));
      if (shared.length >= Math.min(2, nTokens.length) && shared.length >= 1) return m.entry;
    }
  }

  return null;
}

/* ============================================================
   HEURISTIC PARSER (no AI fallback)
   ============================================================ */

function stripCustomerClause(s: string): string {
  return s.replace(/\bfor\b\s+.+$/i, "").trim();
}

function sanitiseProductFragment(fragment: string): string {
  return stripCustomerClause(fragment)
    .replace(/\b(urgent|asap|today|tonight|tomorrow|tmrw|tmw|soon|quick|fast|immediately|right now|by eod|eod)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNonProductChargeText(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return /\b(handling(\s+fee)?|shipping|delivery|freight|packing|packaging|convenience(\s+fee)?|cod|cash\s+on\s+delivery|discount|coupon|offer|promotion|promo|gst|tax|cgst|sgst|igst|subtotal|grand\s+total|total|round\s*off|amount\s+payable|amount\s+in\s+words)\b/.test(
    t
  );
}

function extractCustomerFromText(text: string): string {
  const t = text.trim();
  if (!t) return "";

  const forMatch = t.match(/\bfor\s+([^\n\r]+?)\s*$/i);
  if (forMatch?.[1]) return sanitiseName(forMatch[1]);

  const toMatch = t.match(/\b(?:deliver to|ship to|to)\s+([^\n\r,]+?)(?:\s+\bby\b|\s+\b(today|tomorrow|urgent|asap)\b|$)/i);
  if (toMatch?.[1]) return sanitiseName(toMatch[1]);

  return "";
}

function extractItemsHeuristic(text: string): { items: ParsedItem[]; rejected: string[] } {
  const items: ParsedItem[] = [];
  const rejected: string[] = [];

  // First pass: find repeating "qty + product" groups even when not comma-separated.
  // Examples:
  // - "30 TM 803+ 5 TM-Display for Jai"
  // - "30 TM 803+, 5 TM-Display for Jai"
  const groupRe =
    /(\d{1,6})\s*(?:x|\*|nos|no\.|pcs|pc|units)?\s+(.+?)(?=(?:\s+\d{1,6}\s*(?:x|\*|nos|no\.|pcs|pc|units)?\s+)|$)/gi;

  const fragments: string[] = [];
  for (const m of text.matchAll(groupRe)) {
    const qty = Number(m[1]);
    const product = (m[2] ?? "").trim();
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (!product) continue;
    fragments.push(`${qty} ${product}`);
  }

  const fallbackFragments = text
    .replace(/\n+/g, ",")
    .split(/,|;| and /gi)
    .map((f) => f.trim())
    .filter(Boolean);

  const inputs = fragments.length ? fragments : fallbackFragments;

  for (const fragmentRaw of inputs) {
    const fragment = sanitiseProductFragment(fragmentRaw);
    if (!fragment) continue;

    let qty: number | null = null;
    let product = "";

    const m1 = fragment.match(/^\s*(\d{1,6})\s*(?:x|\*|nos|no\.|pcs|pc|units)?\s+(.*)$/i);
    if (m1) {
      qty = Number(m1[1]);
      product = m1[2] ?? "";
    } else {
      const m2 = fragment.match(/^(.*\S)\s+(\d{1,6})\s*(?:x|\*|nos|no\.|pcs|pc|units)?\s*$/i);
      if (m2) {
        product = m2[1] ?? "";
        qty = Number(m2[2]);
      }
    }

    // e.g. "TM 803+ Sensor Qty: 50"
    if (!qty) {
      const m3 = fragment.match(/\b(?:qty|quantity)\b\s*[:\-]?\s*(\d{1,6})/i);
      if (m3) {
        qty = Number(m3[1]);
        product = fragment.replace(m3[0], "").trim();
      }
    }

    if (!qty || Number.isNaN(qty) || qty <= 0) continue;
    product = sanitiseProductFragment(product);
    if (!product) continue;
    if (isNonProductChargeText(product)) continue;

    const match = findSku(product);
    if (!match) {
      rejected.push(`${qty}x ${product}`);
      continue;
    }

    const existing = items.find((i) => i.sku === match.sku);
    if (existing) existing.qty += Math.round(qty);
    else items.push({ sku: match.sku, product: match.instrument, qty: Math.round(qty) });
  }

  return { items, rejected: Array.from(new Set(rejected)) };
}

function extractSkuOnlyItems(text: string): ParsedItem[] {
  const source = norm(text);
  if (!source) return [];
  const out: ParsedItem[] = [];
  for (const def of SKU_CATALOG) {
    if (skuMentionedInText(source, def)) {
      out.push({ sku: def.sku, product: def.instrument, qty: 1 });
    }
  }
  return out;
}

function extractCustomerFromPdfText(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const nextNonEmptyLine = (startIndex: number): string => {
    for (let i = startIndex + 1; i < lines.length; i++) {
      const cand = lines[i].trim();
      if (!cand) continue;
      if (/^(in|india)$/i.test(cand)) continue;
      if (/^state\/ut\s*code/i.test(cand)) continue;
      if (/^(pan|gst|gstin|order|invoice|place of|payment|whether tax)/i.test(cand)) continue;
      return cand;
    }
    return "";
  };

  // Prefer the name immediately below Billing Address (common in Amazon invoices).
  for (let i = 0; i < lines.length; i++) {
    if (/^billing\s+address\b/i.test(lines[i])) {
      const inline = lines[i].replace(/^billing\s+address\s*[:\-]?\s*/i, "").trim();
      const candidate = inline || nextNonEmptyLine(i);
      const name = sanitiseName(candidate.replace(/,+$/, ""));
      if (name) return name;
    }
  }

  // Next preference: name immediately below Shipping Address.
  for (let i = 0; i < lines.length; i++) {
    if (/^shipping\s+address\b/i.test(lines[i])) {
      const inline = lines[i].replace(/^shipping\s+address\s*[:\-]?\s*/i, "").trim();
      const candidate = inline || nextNonEmptyLine(i);
      const name = sanitiseName(candidate.replace(/,+$/, ""));
      if (name) return name;
    }
  }

  const patterns = [
    /^ship\s*to\s*[:\-]?\s*(.+)$/i,
    /^bill\s*to\s*[:\-]?\s*(.+)$/i,
    /^deliver\s*to\s*[:\-]?\s*(.+)$/i,
    /^customer\s*name\s*[:\-]?\s*(.+)$/i,
    /^buyer\s*[:\-]?\s*(.+)$/i,
    /^consignee\s*[:\-]?\s*(.+)$/i,
    /^recipient\s*[:\-]?\s*(.+)$/i,
    /^customer\s*[:\-]?\s*(.+)$/i
  ];
  for (const line of lines) {
    for (const re of patterns) {
      const m = line.match(re);
      if (m?.[1]) {
        const name = sanitiseName(m[1]);
        if (name) return name;
      }
    }
  }

  // Flipkart-style label:
  // Shipping/Customer address:
  // Name: Rahul Kumar,
  for (let i = 0; i < lines.length; i++) {
    if (/shipping\/customer\s+address/i.test(lines[i])) {
      const next = lines[i + 1] ?? "";
      const m = next.match(/^name\s*:\s*(.+)$/i);
      if (m?.[1]) {
        const name = sanitiseName(m[1].replace(/,+$/, ""));
        if (name) return name;
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (/shipping\s+address/i.test(lines[i])) {
      const candidate = lines[i + 1] ? sanitiseName(lines[i + 1]) : "";
      if (candidate) return candidate;
    }
  }

  // Fallback: regex over whole text (some PDF parsers collapse lines)
  const flat = text.replace(/\s+/g, " ").trim();
  const tryMatch = (re: RegExp) => {
    const m = flat.match(re);
    return m?.[1] ? sanitiseName(String(m[1]).replace(/,+$/, "")) : "";
  };

  const candidates = [
    tryMatch(/\bship\s*to\b\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,60})/i),
    tryMatch(/\bdeliver\s*to\b\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,60})/i),
    tryMatch(/\bshipping\/customer\s+address\b.*?\bname\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,60})/i),
    tryMatch(/\bname\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,60})\s*(?:,|\b(?:phone|mobile|gst|pin|pincode|address)\b)/i),
    tryMatch(/\bcustomer\s*name\b\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,60})/i),
    tryMatch(/\bconsignee\b\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,60})/i),
  ].filter(Boolean);

  if (candidates[0]) return candidates[0];
  return "";
}

function extractItemsFromPdfTables(text: string): ParsedItem[] {
  const items: ParsedItem[] = [];

  const cleanProductName = (raw: string): string => {
    const s = String(raw || "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    // In Amazon invoices the "Description" column often includes " | ASIN (code)" suffix.
    const beforePipe = s.split("|")[0]?.trim() ?? s;
    return beforePipe.replace(/\s+/g, " ").trim();
  };

  const add = (productRaw: string, qtyRaw: number) => {
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty <= 0) return;
    const productStr = sanitiseProductFragment(cleanProductName(productRaw));
    if (!productStr) return;
    if (isNonProductChargeText(productStr)) return;

    const match = findSku(productStr) ?? findSku(productStr.replace(/\|/g, " "));
    if (!match) return;

    const existing = items.find((i) => i.sku === match.sku);
    if (existing) existing.qty += Math.round(qty);
    else items.push({ sku: match.sku, product: match.instrument, qty: Math.round(qty) });
  };

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const extractQtyFromRowRemainder = (rest: string): { product: string; qty: number } | null => {
    const cleaned = rest.replace(/\s+/g, " ").trim();
    if (!cleaned) return null;

    // Prefer explicit "Qty: N" whenever present.
    const explicitQty = cleaned.match(/\bqty\b\s*[:\-]?\s*(\d{1,6})\b/i);
    if (explicitQty?.[1]) {
      const qty = Number(explicitQty[1]);
      const product = cleaned.replace(explicitQty[0], "").trim();
      if (Number.isFinite(qty) && qty > 0 && product) return { product, qty };
    }

    const ints = (cleaned.match(/\b\d{1,6}\b/g) ?? [])
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));

    const looksLikePrice =
      /(?:₹|rs\.?|inr|\bmrp\b|\bprice\b|\btotal\b)/i.test(cleaned) ||
      /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/.test(cleaned) ||
      /\b\d+\.\d{2}\b/.test(cleaned);

    // Primary: last standalone integer on the row, but avoid common "price-at-end" false positives.
    const atEnd = cleaned.match(/\b(\d{1,6})\s*$/);
    if (atEnd?.[1]) {
      const last = Number(atEnd[1]);
      const prev = ints.length >= 2 ? ints[ints.length - 2] : null;

      const lastLooksLikePrice = looksLikePrice || (last >= 250 && prev !== null && prev > 0 && prev <= 50);
      if (lastLooksLikePrice && prev !== null && prev > 0 && prev <= 50) {
        const product = cleaned.replace(new RegExp(`\\b${prev}\\b\\s*\\b${last}\\b\\s*$`), "").trim();
        if (product) return { product, qty: prev };
      }

      const product = cleaned.replace(/\b(\d{1,6})\s*$/, "").trim();
      if (Number.isFinite(last) && last > 0 && product) return { product, qty: last };
    }

    // Secondary: qty appears before a known trailing token (AWB/Order Id/etc).
    const beforeToken = cleaned.match(
      /\b(\d{1,6})\b(?=\s+(?:FMPC\d{6,}|AWB\b|Order\b|Invoice\b|Tax\b|OD[A-Z0-9]{8,}\b)\b)/i
    );
    if (beforeToken?.[1]) {
      const qty = Number(beforeToken[1]);
      const product = cleaned.replace(new RegExp(`\\b${beforeToken[1]}\\b.*$`), "").trim();
      if (Number.isFinite(qty) && qty > 0 && product) return { product, qty };
    }

    return null;
  };

  // Flipkart labels: row typically looks like:
  // "1 B0C62CYP9V | Systems Tech HTM 890 Photo Contact Digital 1"
  // Sometimes the qty ends up on the next line or has AWB appended after it.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\d+\s+[A-Z0-9]{10}\s*\|\s*(.+?)\s*$/);
    if (!m?.[1]) continue;

    const candidate = extractQtyFromRowRemainder(m[1]);
    if (candidate) {
      add(candidate.product, candidate.qty);
      continue;
    }

    // If qty isn't on the same line, check the next non-empty line for a small integer qty.
    const next = lines[i + 1] ?? "";
    const q = next.match(/^\s*(\d{1,6})\s*$/);
    if (q?.[1]) {
      const qty = Number(q[1]);
      if (Number.isFinite(qty) && qty > 0) {
        add(m[1], qty);
      }
    }
  }

  // Amazon invoice style: capture description block until HSN, then parse qty from the ₹amount qty ₹amount pattern.
  // Example:
  // "1 Premium Rubber Tips ... | B0... (\nE7...)\nHSN:90292090\n₹366.10 1 ₹366.10 ..."
  const amazonItemBlockRe =
    /\n\s*\d+\s+([\s\S]+?)\n\s*HSN:[^\n]*\n([\s\S]+?)(?=\n\s*\d+\s+\S|\n\s*TOTAL:|\n\s*Amount in Words:|\n\s*Whether tax is payable|\s*--\s*\d+\s*of\s*\d+\s*--|$)/g;
  for (const m of text.matchAll(amazonItemBlockRe)) {
    const desc = String(m[1] ?? "").replace(/\s+/g, " ").trim();
    const afterHsn = String(m[2] ?? "").replace(/\s+/g, " ").trim();
    if (!desc || !afterHsn) continue;

    // UnitPrice Qty NetAmount appears next to each other (with or without currency symbol).
    const qtyMatch = afterHsn.match(
      /(?:₹|rs\.?)?\s*[\d,]+(?:\.\d+)?\s+(\d{1,6})\s+(?:₹|rs\.?)?\s*[\d,]+(?:\.\d+)?/i
    );
    if (!qtyMatch?.[1]) continue;
    add(desc, Number(qtyMatch[1]));
  }

  // Generic patterns: "Description: ... Qty: N" or "Product: ... Qty: N"
  const genericRe = /\b(?:description|product)\b\s*[:\-]?\s*([^\n\r]+?)\s+\bqty\b\s*[:\-]?\s*(\d{1,6})/gi;
  for (const m of text.matchAll(genericRe)) {
    add(String(m[1] ?? ""), Number(m[2]));
  }

  return items;
}

function skuMentionedInText(sourceText: string, sku: SkuDefinition): boolean {
  const source = norm(sourceText);
  if (!source) return false;

  // Exact SKU mention is always allowed.
  if (source.includes(norm(sku.sku))) return true;

  // Otherwise require a "strong" keyword match to avoid Gemini hallucinations.
  const strong = STRONG_KEYWORDS_BY_SKU.get(sku.sku) ?? [];
  return strong.some((k) => k && source.includes(k));
}

const BUSINESS_WORDS_RE =
  /\b(electronics|traders?|enterprise|enterprises|industr(?:y|ies)|pvt|ltd|limited|company|co|store|stores|agency|agencies|distributors?|wholesale|retail|services|solutions|mechanics|motors|electricals|hardware)\b/i;

function isPlausibleCustomerName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (n.length < 3) return false;

  const tokens = n.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) return true;
  if (BUSINESS_WORDS_RE.test(n)) return true;

  // Single-word names: reject short placeholders like "abcd".
  const only = tokens[0] ?? "";
  return only.length >= 5;
}

function extractDocMetaFromPdfText(text: string): { orderIds: string[]; awbs: string[]; invoiceNos: string[] } {
  const t = text.replace(/\s+/g, " ").trim();
  const uniq = (arr: string[]) => Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));

  const orderIds = uniq([
    ...(t.match(/(?:order\s*(?:id|no|number)\s*[:#-]?\s*)([A-Z0-9-]{6,})/gi) ?? []).map((m) => m.replace(/.*[:#-]\s*/i, "")),
    ...(t.match(/\bOD[A-Z0-9]{8,}\b/gi) ?? []),
  ]);

  const awbs = uniq([
    ...(t.match(/(?:awb|tracking)\s*(?:no|number)?\s*[:#-]?\s*([A-Z0-9-]{6,})/gi) ?? []).map((m) => m.replace(/.*[:#-]\s*/i, "")),
  ]);

  const invoiceNos = uniq([
    ...(t.match(/(?:invoice)\s*(?:no|number)?\s*[:#-]?\s*([A-Z0-9-]{4,})/gi) ?? []).map((m) => m.replace(/.*[:#-]\s*/i, "")),
  ]);

  return { orderIds, awbs, invoiceNos };
}

/* Build catalog text for Gemini prompt */
const CATALOG_FOR_PROMPT = SKU_CATALOG
  .map((d) => `  ${d.sku}: "${d.instrument}" — ${d.description}`)
  .join("\n");

async function extractTextFromPdfBuffer(buffer: Buffer): Promise<string> {
  // NOTE: `pdf-parse@2.x` exports a `PDFParse` class (not a function).
  const pdfModule: any = await import("pdf-parse");
  const PDFParse = pdfModule.PDFParse;
  if (!PDFParse) throw new Error("pdf-parse: PDFParse export not found");

  const parser = new PDFParse({ data: buffer });
  await parser.load();
  const result = await parser.getText();
  const text = typeof result === "string" ? result : String(result?.text ?? "");

  const pdfText = text.trim();
  const ocrEnabled = process.env.OCR_ENABLED === "true";
  const ocrMode = (process.env.OCR_MODE || "auto").trim().toLowerCase(); // auto | compare | combine
  if (!ocrEnabled) return pdfText;
  if (ocrMode === "auto" && pdfText.length >= 30) return pdfText;

  // Optional OCR fallback for scanned PDFs (requires a local tesseract installation).
  const ocrText = (await tryOcrFirstPage(parser).catch(() => "")).trim();
  if (!ocrText) return pdfText;

  const scoreForOrder = (t: string): number => {
    const s = t.trim();
    if (!s) return 0;
    let skuHits = 0;
    for (const def of SKU_CATALOG) {
      if (skuMentionedInText(s, def)) skuHits++;
    }
    const name = extractCustomerFromPdfText(s);
    const nameBonus = name && isPlausibleCustomerName(name) ? 400 : 0;
    const digitHits = (s.match(/\d/g) ?? []).length;
    const qtyWords = (s.match(/\b(qty|quantity|pcs|pc|nos|no\.|units)\b/gi) ?? []).length;
    const invoiceWords = (s.match(/\b(invoice|order|awb|tracking|ship to|bill to|billing|shipping)\b/gi) ?? []).length;
    return skuHits * 1000 + nameBonus + qtyWords * 30 + invoiceWords * 10 + digitHits + Math.min(s.length, 20_000) / 200;
  };

  if (ocrMode === "combine") {
    const uniqLines = (input: string) =>
      Array.from(
        new Set(
          input
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
        )
      ).join("\n");

    const a = uniqLines(pdfText);
    const b = uniqLines(ocrText);
    if (!a) return b;
    return `${a}\n\n--- OCR ---\n${b}`.trim();
  }

  // compare (or auto fallback): choose the text that looks more "order-like"
  const pdfScore = scoreForOrder(pdfText);
  const ocrScore = scoreForOrder(ocrText);
  if (TWILIO_DEBUG) {
    console.log(`PDF text score: pdf=${pdfScore.toFixed(1)} ocr=${ocrScore.toFixed(1)} mode=${ocrMode}`);
  }
  if (!pdfText) return ocrText;
  if (ocrScore > pdfScore * 1.1) return ocrText;
  return pdfText;
}

type OcrEngine = "auto" | "easyocr" | "tesseract";

function getOcrEngine(): OcrEngine {
  const v = (process.env.OCR_ENGINE || "auto").trim().toLowerCase();
  if (v === "easyocr" || v === "tesseract") return v;
  return "auto";
}

async function runEasyOcrOnImageFile(inputPath: string): Promise<string> {
  const pythonCmd = (process.env.PYTHON_CMD || "python").trim();
  const scriptPath = path.join(process.cwd(), "scripts", "ocr_easyocr.py");

  const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve) => {
    const child = spawn(pythonCmd, ["-u", scriptPath, inputPath], { windowsHide: true });
    let stderr = "";
    let stdout = "";
    const timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ code: -1, stderr: "easyocr timeout", stdout });
    }, 60_000);
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ code: -1, stderr: String(err?.message ?? err), stdout });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr, stdout });
    });
  });

  if (result.code !== 0) {
    if (TWILIO_DEBUG && result.stderr) console.warn(`EasyOCR failed: ${result.stderr.slice(0, 200)}`);
    return "";
  }
  return result.stdout.trim();
}

async function runTesseractOnImageFile(inputPath: string, ext: "png" | "jpg" | "jpeg"): Promise<string> {
  const cmd = (process.env.TESSERACT_CMD || "tesseract").trim();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatchboard-ocr-"));
  const outputBase = path.join(tmpDir, "out");

  const args = [inputPath, outputBase, "-l", "eng", "--psm", "6"];
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stderr = "";
    const timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ code: -1, stderr: "tesseract timeout" });
    }, 30_000);
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ code: -1, stderr: String(err?.message ?? err) });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
  });

  if (result.code !== 0) {
    if (TWILIO_DEBUG && result.stderr) console.warn(`Tesseract OCR failed: ${result.stderr.slice(0, 200)}`);
    return "";
  }

  const outTxt = `${outputBase}.txt`;
  const ocr = await fs.readFile(outTxt, "utf8").catch(() => "");
  return ocr.trim();
}

async function tryOcrFirstPage(pdfParser: any): Promise<string> {
  const screenshots = await pdfParser.getScreenshot({ first: 1, scale: 2, imageDataUrl: false, imageBuffer: true });
  const first = screenshots?.pages?.[0];
  const bytes: Uint8Array | undefined = first?.data;
  if (!bytes || !bytes.length) return "";

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatchboard-ocr-"));
  const inputPng = path.join(tmpDir, "page1.png");
  await fs.writeFile(inputPng, Buffer.from(bytes));

  const engine = getOcrEngine();
  if (engine === "easyocr") return await runEasyOcrOnImageFile(inputPng);
  if (engine === "tesseract") return await runTesseractOnImageFile(inputPng, "png");

  // auto: try easyocr first, then tesseract
  const easy = await runEasyOcrOnImageFile(inputPng);
  if (easy) return easy;
  return await runTesseractOnImageFile(inputPng, "png");
}

async function tryOcrImageBuffer(buffer: Buffer, ext: "png" | "jpg" | "jpeg"): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatchboard-ocr-"));
  const input = path.join(tmpDir, `image.${ext}`);
  await fs.writeFile(input, buffer);

  const engine = getOcrEngine();
  if (engine === "easyocr") return await runEasyOcrOnImageFile(input);
  if (engine === "tesseract") return await runTesseractOnImageFile(input, ext);

  const easy = await runEasyOcrOnImageFile(input);
  if (easy) return easy;
  return await runTesseractOnImageFile(input, ext);
}

function extractItemsFromInvoicePdfText(text: string): ParsedItem[] {
  const items: ParsedItem[] = [];

  const getQtyFromContext = (context: string): number | null => {
    const c = context.replace(/\s+/g, " ").trim();
    const qtyMatch =
      c.match(/\bqty\b\s*[:\-]?\s*(\d{1,6})/i) ??
      // common invoice layout: ₹price <qty> ₹price
      c.match(/₹\s*\d[\d,]*\.\d+\s+(\d{1,4})\s+₹/i) ??
      c.match(/\b(\d{1,4})\s*(?:pcs|pc|nos|no\.|units)\b/i);
    if (!qtyMatch) return null;
    const qty = Number(qtyMatch[1]);
    return Number.isFinite(qty) && qty > 0 ? qty : null;
  };

  for (const def of SKU_CATALOG) {
    if (!skuMentionedInText(text, def)) continue;

    const strong = STRONG_KEYWORDS_BY_SKU.get(def.sku) ?? [];
    const lines = text.split(/\r?\n/);
    const matchedLineIndexes: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      const nl = norm(lines[i] || "");
      if (!nl) continue;
      if (strong.some((k) => k && nl.includes(k))) {
        matchedLineIndexes.push(i);
      }
    }

    // If a SKU appears on multiple lines (tables), sum quantities.
    let qtySum = 0;
    const contexts = matchedLineIndexes.length
      ? matchedLineIndexes.map((idx) =>
          [lines[idx], lines[idx + 1], lines[idx + 2], lines[idx + 3]].filter(Boolean).join(" ")
        )
      : [text.slice(0, 2500)];

    for (const ctx of contexts) {
      if (isNonProductChargeText(ctx)) continue;
      let qty = getQtyFromContext(ctx);

      // Flipkart label table rows often end with quantity and include a pipe separator.
      if (!qty && /\|/.test(ctx)) {
        const m = ctx.match(/(\d{1,4})\s*$/);
        if (m?.[1]) {
          const q = Number(m[1]);
          if (Number.isFinite(q) && q > 0 && q <= 999) qty = q;
        }
      }

      qtySum += qty ?? 0;
    }

    const qty = qtySum > 0 ? qtySum : 1;

    const existing = items.find((i) => i.sku === def.sku);
    if (existing) existing.qty += qty;
    else items.push({ sku: def.sku, product: def.instrument, qty });
  }

  return items;
}

/* ============================================================
   EXPRESS
   ============================================================ */

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin: string | undefined, cb: Function) => {
      // No origin = server-to-server (Twilio, Railway health) → allow
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        cb(null, true);
      } else {
        console.warn("CORS blocked:", origin);
        cb(null, false);
      }
    },
    credentials: true
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* ============================================================
   DATABASE
   ============================================================ */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

pool.on("error", (err) => console.error("pg pool error:", err));

/* ============================================================
   GEMINI
   
   User confirmed: GEMINI_MODEL=gemini-1.5 works on the free tier.
   Do NOT change this to gemini-1.5-flash — it fails locally.
   ============================================================ */

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-1.5").trim();
const GEMINI_API_VERSIONS = (process.env.GEMINI_API_VERSIONS || process.env.GEMINI_API_VERSION || "v1,v1beta")
  .split(/[,\s]+/)
  .map((s) => s.trim())
  .filter(Boolean);
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 15_000);

let geminiDisabledReason: string | null = null;
let loggedGeminiDisabledReason = false;

function shouldUseGemini(text: string): boolean {
  // If there's no quantity-like signal, don't waste time calling Gemini for chatty messages like "Hi".
  if (!/\d/.test(text)) return false;
  return true;
}

async function callGemini(text: string): Promise<GeminiRaw | null> {
  if (!GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY not set");
    return null;
  }
  if (geminiDisabledReason) {
    if (!loggedGeminiDisabledReason) {
      console.warn(`Gemini disabled: ${geminiDisabledReason}`);
      loggedGeminiDisabledReason = true;
    }
    return null;
  }
  if (!shouldUseGemini(text)) return null;

  const clippedText =
    text.length > 12_000 ? `${text.slice(0, 12_000)}\n\n[TRUNCATED]` : text;

  const prompt = `You are an order intake assistant for iHelp Robotics Pvt. Ltd.
Parse the WhatsApp message below and return a single JSON object.

PRODUCT CATALOG (only these products are accepted):
${CATALOG_FOR_PROMPT}

EXTRACTION RULES — read carefully:
1. customer_name: The company or person name receiving the order.
   - Look for: "for <Name>", "deliver to <Name>", "to <Name>", or the name at the end.
   - Extract ONLY the name. STOP before any time words (today, tomorrow, urgent, by, next week, asap).
   - Examples: "for Ravi Electronics" → "Ravi Electronics", "deliver to Shyam Sundar by tomorrow" → "Shyam Sundar"
   - If no name found, set to empty string "".

2. items: Map EACH product mentioned to the closest catalog SKU above.
   - If a product clearly matches a catalog item, include it in items[].
   - If a product does NOT match any catalog item, put the raw text in unrecognised_items[].
   - Never invent products. Only use the catalog above.

3. priority: Infer from TIME words in the message:
   - "today", "tonight", "urgent", "asap", "immediately", "right now" → "urgent"
   - "tomorrow", "by tomorrow", "next day", "soon", "quick" → "high"
   - "next week", "no rush", no time word → "normal"

4. confidence: Float 0.0–1.0. Set below 0.7 if you are unsure about customer name or items.

5. unrecognised_items: List of raw product strings from the message that did NOT match any catalog item.

Return ONLY this JSON (no markdown, no explanation, no code fences):
{
  "customer_name": "string",
  "items": [{"product": "catalog instrument name", "sku": "catalog SKU", "qty": number}],
  "priority": "urgent" | "high" | "normal",
  "notes": "string",
  "confidence": number,
  "unrecognised_items": ["string"]
}

MESSAGE:
${clippedText}`;

  try {
    const addUnique = (arr: string[], v: string) => {
      const s = (v || "").trim();
      if (!s) return;
      if (!arr.includes(s)) arr.push(s);
    };

    const candidateModels: string[] = [];
    addUnique(candidateModels, GEMINI_MODEL);
    // "latest" aliases vary by API version/key; try both when it makes sense.
    if (GEMINI_MODEL === "gemini-1.5") {
      addUnique(candidateModels, "gemini-1.5-flash");
      addUnique(candidateModels, "gemini-1.5-flash-latest");
    } else if (GEMINI_MODEL === "gemini-1.5-flash") {
      addUnique(candidateModels, "gemini-1.5-flash-latest");
    } else if (GEMINI_MODEL === "gemini-1.5-pro") {
      addUnique(candidateModels, "gemini-1.5-pro-latest");
    }
    if (GEMINI_MODEL.endsWith("-latest")) {
      addUnique(candidateModels, GEMINI_MODEL.replace(/-latest$/, ""));
    }
    const extraFallbacks = String(process.env.GEMINI_FALLBACK_MODELS || "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const m of extraFallbacks) addUnique(candidateModels, m);

    let lastErrorText = "";
    let data: any | null = null;

    for (const model of candidateModels) {
      const versionsToTry = GEMINI_API_VERSIONS.length ? GEMINI_API_VERSIONS : ["v1", "v1beta"];
      for (const apiVersion of versionsToTry) {
        const res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0, maxOutputTokens: 600 }
            })
          },
          GEMINI_TIMEOUT_MS
        );

        if (res.ok) {
          data = await res.json().catch(() => null);
          if (data) break;
        } else {
          const body = await res.text().catch(() => "");
          lastErrorText = `Gemini HTTP ${res.status} (${apiVersion}, ${model}): ${body.slice(0, 200)}`;
          if (res.status !== 404) {
            console.error(lastErrorText);
            return null;
          }
        }
      }
      if (data) break;
    }

    if (!data) {
      // Disable Gemini after repeated 404s to avoid spamming logs on every message.
      geminiDisabledReason = lastErrorText || "model not available";
      console.warn(`Gemini unavailable, falling back to heuristic parsing. (${geminiDisabledReason})`);
      return null;
    }

    const raw: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!raw) { console.error("Gemini: empty response"); return null; }

    // Strip markdown fences if present
    const cleaned = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) { console.error("Gemini: no JSON in response:", raw.slice(0, 200)); return null; }

    const parsed = JSON.parse(match[0]) as GeminiRaw;
    console.log("Gemini OK:", JSON.stringify(parsed));
    return parsed;
  } catch (err) {
    console.error("Gemini Error:", err);
    return null;
  }
}

/* ============================================================
   PRIORITY INFERENCE  (always runs over raw text as safety net)
   ============================================================ */

function inferPriority(text: string): Priority {
  const t = text.toLowerCase();
  if (/\b(urgent|asap|immediately|right now|today|tonight|by eod|end of day)\b/.test(t)) return "urgent";
  if (/\b(tomorrow|by tomorrow|next day|tmrw|tmw|soon|quick|fast|by morning|weekend|week end|by weekend)\b/.test(t)) return "high";
  if (/\b(next week|no rush|whenever|later|by next|next month)\b/.test(t)) return "normal";
  return "normal";
}

/* ============================================================
   NAME SANITISER
   Strips trailing time / priority words Gemini sometimes appends
   ============================================================ */

const TIME_WORDS_RE = /\b(today|tonight|tomorrow|tmrw|tmw|urgent|asap|soon|quick|fast|immediately|by|next week|next month|eod|morning|evening|delivery|deliver|weekend|week end|please|kindly|regards|thanks|thank you)\b.*/i;

function sanitiseName(raw: string): string {
  if (!raw) return "";
  // Remove trailing punctuation and time/phrase words
  let name = raw.trim().replace(TIME_WORDS_RE, "").trim().replace(/[,.\-]+$/, "").trim();
  // Capitalise each word
  name = name.replace(/\b\w/g, (c) => c.toUpperCase());
  return name || "";
}

/* ============================================================
   SKU VALIDATION
   Returns valid (matched catalog) items and list of rejected raw strings
   ============================================================ */

function validateItems(
  sourceText: string,
  geminiItems: Array<{ product?: string; sku?: string; qty?: number }>
): { valid: ParsedItem[]; rejected: string[] } {
  const valid: ParsedItem[] = [];
  const rejected: string[] = [];

  for (const item of geminiItems ?? []) {
    const qty = Number(item.qty ?? 0);
    const productStr = sanitiseProductFragment((item.product ?? "").trim());
    const skuStr = (item.sku ?? "").trim();

    if (!productStr || isNaN(qty) || qty <= 0) continue;

    // Try by SKU field first (most reliable when Gemini gets it right)
    let match: SkuDefinition | null = null;
    if (skuStr) {
      match = SKU_CATALOG.find((d) => d.sku.toLowerCase() === skuStr.toLowerCase()) ?? null;
    }
    // Fallback: match by product name
    if (!match) match = findSku(productStr);
    // Try combined sku+product
    if (!match && skuStr) match = findSku(`${productStr} ${skuStr}`);

    if (match) {
      if (!skuMentionedInText(sourceText, match)) {
        rejected.push(`${Math.round(qty)}x ${productStr || match.instrument}`);
        continue;
      }
      // Avoid duplicates (merge quantities if same SKU appears twice)
      const existing = valid.find((v) => v.sku === match!.sku);
      if (existing) {
        existing.qty += Math.round(qty);
      } else {
        valid.push({ product: match.instrument, sku: match.sku, qty: Math.round(qty) });
      }
    } else {
      rejected.push(`${qty}x ${productStr}`);
    }
  }

  return { valid, rejected };
}

/* ============================================================
   FULL PARSE PIPELINE
   ============================================================ */

interface PipelineResult {
  customerName: string;
  validItems: ParsedItem[];
  rejectedItems: string[];
  priority: Priority;
  notes: string;
  confidence: number;
  needsReview: boolean;
  usedFallback: boolean;
}

async function runPipeline(rawText: string): Promise<PipelineResult> {
  const text = rawText.trim();
  const inferredPriority = inferPriority(text);

  // Fast path: heuristic-only parse to avoid network latency.
  const heuristicName = extractCustomerFromText(text);
  const heuristic = extractItemsHeuristic(text);
  if (heuristic.items.length > 0 && heuristicName && heuristic.rejected.length === 0) {
    const customerName = heuristicName;
    const validItems = heuristic.items;
    const rejectedItems: string[] = [];
    const confidence = 0.75;
    const notes = "";
    const needsReview = !isPlausibleCustomerName(customerName);
    return {
      customerName,
      validItems,
      rejectedItems,
      priority: inferredPriority,
      notes,
      confidence,
      needsReview,
      usedFallback: true
    };
  }

  const gemini = await callGemini(text);
  let usedFallback = !gemini;

  // Extract and sanitise customer name
  const rawName = gemini?.customer_name ?? "";
  let customerName = sanitiseName(rawName) || "";
  if (!customerName) {
    if (heuristicName) {
      customerName = heuristicName;
      usedFallback = true;
    }
  }

  // Validate items
  const geminiItems = gemini?.items ?? [];
  const { valid: validItems, rejected: fromGeminiValidation } = validateItems(text, geminiItems);

  if (validItems.length === 0) {
    if (heuristic.items.length > 0) {
      const filtered = heuristic.items.filter((it) => {
        const skuDef = SKU_CATALOG.find((d) => d.sku === it.sku);
        return skuDef ? skuMentionedInText(text, skuDef) : false;
      });

      if (filtered.length > 0) {
        validItems.push(...filtered);
      } else {
        // If we matched catalog SKUs but couldn't find "strong" keywords in the text,
        // accept the heuristic parse but force review.
        validItems.push(...heuristic.items);
        usedFallback = true;
      }

      const filteredOut = heuristic.items.filter((it) => !filtered.some((f) => f.sku === it.sku));
      if (filteredOut.length > 0) {
        fromGeminiValidation.push(...filteredOut.map((it) => `${it.qty}x ${it.product}`));
      }

      fromGeminiValidation.push(...heuristic.rejected);
      usedFallback = true;
    }
  }

  // If nothing matched (common: user sends only a SKU/product name with no qty), accept SKU-only with qty=1.
  if (validItems.length === 0) {
    const skuOnly = extractSkuOnlyItems(text);
    if (skuOnly.length > 0) {
      validItems.push(...skuOnly);
      usedFallback = true;
    }
  }

  // Also collect what Gemini itself flagged as unrecognised
  const alsoRejected = (gemini?.unrecognised_items ?? []).filter(Boolean);
  const rejectedItems = [...new Set([...fromGeminiValidation, ...alsoRejected])];

  // Priority: always run inference on raw text and take the stronger signal
  const geminiPriority = (gemini?.priority ?? "normal") as Priority;
  const PRIORITY_RANK: Record<Priority, number> = { urgent: 3, high: 2, normal: 1 };
  const priority: Priority =
    PRIORITY_RANK[inferredPriority] >= PRIORITY_RANK[geminiPriority]
      ? inferredPriority
      : geminiPriority;

  const confidence = gemini?.confidence ?? (usedFallback ? 0.4 : 0);
  const notes = gemini?.notes ?? "";

  const needsReview =
    usedFallback ||
    confidence < 0.7 ||
    !customerName ||
    validItems.length === 0;

  return { customerName, validItems, rejectedItems, priority, notes, confidence, needsReview, usedFallback };
}

/* ============================================================
   INSERT ORDER
   All orders land in "new" — the board swipe advances them.
   Payment gating is enforced by the frontend per customer type.
   ============================================================ */

async function insertOrder(result: PipelineResult, channel: string, extraNotes?: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const name = result.customerName || "Unknown";

    // Look up customer (case-insensitive)
    let custRes = await client.query(
      "SELECT * FROM customers WHERE LOWER(name)=LOWER($1)",
      [name]
    );
    if (!custRes.rows[0]) {
      custRes = await client.query(
        "INSERT INTO customers(name, type, payment_required) VALUES($1, 'non_regular', true) RETURNING *",
        [name]
      );
    }
    const customer = custRes.rows[0];

    const noteParts: string[] = [];
    if (result.notes) noteParts.push(result.notes);
    if (extraNotes) noteParts.push(extraNotes);
    if (result.rejectedItems.length > 0) {
      noteParts.push(`Items not in catalog (excluded): ${result.rejectedItems.join(", ")}`);
    }

    const orderRes = await client.query(
      `INSERT INTO orders(customer_id, channel, priority, status, payment_status, needs_review, notes)
       VALUES($1, $2, $3, 'new', $4, $5, $6)
       RETURNING id`,
      [
        customer.id,
        channel,
        result.priority,
        customer.payment_required ? "pending" : "paid",
        result.needsReview,
        noteParts.join(" | ") || null
      ]
    );

    const orderId: string = orderRes.rows[0].id;

    for (const item of result.validItems) {
      await client.query(
        "INSERT INTO order_items(order_id, product_name, qty_ordered) VALUES($1, $2, $3)",
        [orderId, item.product, item.qty]
      );
    }

    await client.query("COMMIT");
    console.log(`Order ${orderId} | customer: "${name}" | priority: ${result.priority} | review: ${result.needsReview}`);
    return orderId;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("DB insert error:", err);
    throw err;
  } finally {
    client.release();
  }
}

/* ============================================================
   CATALOG SAMPLE (for error replies to customers)
   ============================================================ */

const CATALOG_EXAMPLES = SKU_CATALOG.slice(0, 6).map((d) => d.instrument).join(", ");

/* ============================================================
   ROUTES
   ============================================================ */

/* ── Health ── */
app.get("/health", (_req, res) =>
  res.json({ ok: true, model: GEMINI_MODEL, imap: false })
);

app.get("/", (_req, res) => res.type("text/plain").send("ok"));

app.get("/api/catalog", (_req, res) => {
  res.json(
    SKU_CATALOG.map((d) => ({
      sku: d.sku,
      instrument: d.instrument,
      description: d.description,
      aliases: d.aliases ?? []
    }))
  );
});

/* ── Twilio WhatsApp Webhook ── */
app.post("/api/_twilio-webhook-old", async (req, res) => {
  const body = (req.body.Body ?? "").trim();
  const from = req.body.From ?? "";
  console.log(`\n📱 WA [${from}]: ${body}`);

  const xmlReply = (msg: string) => {
    res.set("Content-Type", "text/xml");
    res.send(`<Response><Message>${msg}</Message></Response>`);
  };

  // Empty message
  if (!body) {
    return xmlReply(
      `❌ We received an empty message.\n` +
      `Please send your order like:\n` +
      `"50 TM 803+ Sensor, 10 890 HTM for Ravi Electronics"`
    );
  }

  try {
    const result = await runPipeline(body);

    // No valid catalog items at all
    if (result.validItems.length === 0) {
      const catalogSample = SKU_CATALOG.map((d) => d.instrument).join(", ");
      if (result.usedFallback) {
        return xmlReply(
          `❌ Could not read your order.\n` +
          `Please list items and quantities clearly.\n` +
          `Example: "50 TM 803+ Sensor, 10 890 HTM for Ravi Electronics"`
        );
      }
      return xmlReply(
        `⚠️ We only accept catalog SKUs.\n` +
        `Unrecognised: ${result.rejectedItems.join(", ")}.\n` +
        `Our products: ${catalogSample}.\n` +
        `Please resend using exact product names.`
      );
    }

    // Some items valid, some not — REJECT the whole order, ask to resend clean
    if (result.rejectedItems.length > 0) {
      return xmlReply(
        `⚠️ Some items not in our catalog: ${result.rejectedItems.join(", ")}.\n` +
        `Valid catalog items: ${CATALOG_EXAMPLES}, etc.\n` +
        `Please resend with only catalog products.`
      );
    }

    // No customer name extracted
    if (!result.customerName) {
      return xmlReply(
        `⚠️ Could not identify the customer name.\n` +
        `Please end your message with "for [Customer Name]".\n` +
        `Example: "50 TM 803+ Sensor for Ravi Electronics"`
      );
    }

    // All good — insert order
    await insertOrder(result, "whatsapp");

    const itemsSummary = result.validItems.map((i) => `${i.qty}x ${i.product}`).join(", ");
    const priorityTag =
      result.priority === "urgent" ? " 🔴 URGENT" :
      result.priority === "high"   ? " 🟡 HIGH PRIORITY" : "";
    const reviewNote = result.needsReview ? "\nOur team will verify and confirm shortly." : "";

    return xmlReply(
      `✅ Order received for ${result.customerName}:\n` +
      `${itemsSummary}${priorityTag}${reviewNote}\n` +
      `Tracking will be shared when shipped.`
    );
  } catch (err) {
    console.error("Webhook error:", err);
    return xmlReply("❌ Server error. Please try again in a moment.");
  }
});

/* ── Smart Parse (frontend "Extract with AI" button) ── */
/* ============================================================
   TWILIO WHATSAPP WEBHOOK (current)
   - Accepts text orders
   - Accepts PDF invoices/bills as media (downloads via Twilio MediaUrlN)
   - Optional request signature validation (TWILIO_AUTH_TOKEN + PUBLIC_URL)
   ============================================================ */

const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH || "").trim();
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID || "").trim();
const TWILIO_WHATSAPP_FROM = (process.env.TWILIO_WHATSAPP_FROM || "").trim(); // e.g. "whatsapp:+14155238886"
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
const TWILIO_DEBUG = process.env.TWILIO_DEBUG === "true";
const DEBUG_ENDPOINTS = process.env.DEBUG_ENDPOINTS === "true";

type TwilioWebhookDebug = {
  at: string;
  from: string;
  profileName: string;
  body: string;
  numMedia: number;
  media: Array<{ contentType: string; hasUrl: boolean }>;
  pdf: { attempted: number; downloaded: number; parsed: number };
};

let lastTwilioWebhookDebug: TwilioWebhookDebug | null = null;

function stripWhatsAppPrefix(from: string): string {
  return String(from || "").replace(/^whatsapp:/i, "");
}

function maskPhone(raw: string): string {
  const s = stripWhatsAppPrefix(raw).trim();
  const digits = s.replace(/[^\d]/g, "");
  const last4 = digits.slice(-4);
  const hasPlus = s.startsWith("+");
  if (!last4) return s;
  return `${hasPlus ? "+" : ""}${"*".repeat(Math.max(0, digits.length - 4))}${last4}`;
}

function formatChatTimestamp(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const hours24 = d.getHours();
  const minutes = d.getMinutes();
  const ampm = hours24 >= 12 ? "pm" : "am";
  const hours12 = ((hours24 + 11) % 12) + 1;
  const day = d.getDate();
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  return `[${hours12}:${pad2(minutes)} ${ampm}, ${pad2(day)}/${pad2(month)}/${year}]`;
}

function logChatLine(who: string, message: string, at: Date = new Date()) {
  console.log(`${formatChatTimestamp(at)} ${who}: ${message}`);
}

function extractWhatsAppFromNotes(notes: string | null | undefined): string {
  const n = String(notes || "");
  const m = n.match(/\bWA_FROM\s*[:=]\s*(whatsapp:\+\d{6,16})\b/i);
  return m?.[1] ? m[1] : "";
}

async function sendWhatsAppMessage(to: string, body: string): Promise<boolean> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) return false;
  const dest = (to || "").trim();
  if (!dest) return false;

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const params = new URLSearchParams();
  params.set("To", dest);
  params.set("From", TWILIO_WHATSAPP_FROM);
  params.set("Body", body);

  const res = await fetchWithTimeout(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    },
    15_000
  );
  if (!res.ok) {
    if (TWILIO_DEBUG) console.warn(`Twilio send failed: HTTP ${res.status}`);
    return false;
  }
  return true;
}

function buildTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + (params[key] ?? ""), url);
  return crypto.createHmac("sha1", authToken).update(sorted, "utf8").digest("base64");
}

function verifyTwilioRequest(req: express.Request): boolean {
  if (!TWILIO_AUTH_TOKEN || !PUBLIC_URL) return true;

  const sig = String(req.header("x-twilio-signature") || "");
  if (!sig) return false;

  const url = `${PUBLIC_URL}${req.originalUrl}`;
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.body ?? {})) {
    if (typeof value === "string") params[key] = value;
  }

  const expected = buildTwilioSignature(TWILIO_AUTH_TOKEN, url, params);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function downloadTwilioMedia(url: string): Promise<Buffer | null> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  try {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const baseInit: RequestInit = {
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
      redirect: "manual"
    };

    const isRedirect = (status: number) => status >= 300 && status < 400;
    const looksLikeJson = (buf: Buffer) => {
      const s = buf.toString("utf8", 0, Math.min(200, buf.length)).trimStart();
      return s.startsWith("{") || s.startsWith("[");
    };

    const tryGet = async (u: string): Promise<{ res: Response; url: string }> => {
      const res = await fetchWithTimeout(u, baseInit, 20_000);
      if (isRedirect(res.status)) {
        const loc = res.headers.get("location") || "";
        if (loc) {
          const next = new URL(loc, u).toString();
          if (TWILIO_DEBUG) console.log(`Twilio media redirect: ${res.status} -> ${next}`);
          const res2 = await fetchWithTimeout(next, baseInit, 20_000);
          return { res: res2, url: next };
        }
      }
      return { res, url: u };
    };

    const first = await tryGet(url);
    if (!first.res.ok) {
      const body = TWILIO_DEBUG ? await first.res.text().catch(() => "") : "";
      console.warn(`Twilio media download failed: HTTP ${first.res.status}`);
      if (TWILIO_DEBUG && body) console.warn(`Twilio media error body: ${body.slice(0, 200)}`);
      return null;
    }

    const ct = first.res.headers.get("content-type") || "";
    const arr = await first.res.arrayBuffer();
    const buf = Buffer.from(arr);
    if (TWILIO_DEBUG) {
      console.log(
        `Twilio media downloaded: bytes=${buf.length} ct="${ct}" sig="${buf.subarray(0, 8).toString("hex")}"`
      );
    }

    // Some Twilio endpoints can return JSON metadata for the media resource. If so, follow `uri` to fetch raw bytes.
    if (ct.includes("application/json") || looksLikeJson(buf)) {
      const jsonText = buf.toString("utf8");
      const meta = JSON.parse(jsonText) as any;
      const uri: string = String(meta?.uri ?? "");
      if (uri) {
        const rawPath = uri.replace(/\.json$/i, "");
        const rawUrl = rawPath.startsWith("http") ? rawPath : `https://api.twilio.com${rawPath}`;
        if (TWILIO_DEBUG) console.log(`Twilio media meta -> rawUrl: ${rawUrl}`);

        const second = await tryGet(rawUrl);
        if (!second.res.ok) {
          console.warn(`Twilio raw media download failed: HTTP ${second.res.status}`);
          return null;
        }

        const ct2 = second.res.headers.get("content-type") || "";
        const arr2 = await second.res.arrayBuffer();
        const buf2 = Buffer.from(arr2);
        if (TWILIO_DEBUG) {
          console.log(
            `Twilio raw media downloaded: bytes=${buf2.length} ct="${ct2}" sig="${buf2.subarray(0, 8).toString("hex")}"`
          );
        }
        return buf2;
      }
    }

    return buf;
  } catch (err) {
    if (TWILIO_DEBUG) console.warn("Twilio media download error:", err);
    return null;
  }
}

function isPdfBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "%PDF";
}

async function extractPdfTextsFromTwilio(reqBody: any): Promise<{
  texts: string[];
  stats: { attempted: number; downloaded: number; parsed: number };
}> {
  const numMedia = Number(reqBody?.NumMedia ?? 0);
  if (!numMedia || Number.isNaN(numMedia) || numMedia <= 0) {
    return { texts: [], stats: { attempted: 0, downloaded: 0, parsed: 0 } };
  }

  const candidateUrls: string[] = [];
  const candidateImages: Array<{ url: string; ext: "png" | "jpg" | "jpeg" }> = [];
  for (let i = 0; i < numMedia; i++) {
    const url = String(reqBody?.[`MediaUrl${i}`] ?? "");
    const ct = String(reqBody?.[`MediaContentType${i}`] ?? "").toLowerCase();
    if (!url) continue;

    // Optional OCR for images (WhatsApp photos / screenshots).
    if (process.env.OCR_ENABLED === "true" && ct.startsWith("image/")) {
      const ext: "png" | "jpg" | "jpeg" =
        ct.includes("png") ? "png" :
        ct.includes("jpeg") ? "jpeg" : "jpg";
      candidateImages.push({ url, ext });
      continue;
    }

    // Twilio sometimes reports PDFs as application/octet-stream; attempt PDF parse for any non-image media.
    if (ct.startsWith("audio/") || ct.startsWith("video/")) continue;
    if (ct.startsWith("image/")) continue;
    if (ct.includes("pdf") || ct.includes("octet-stream") || url.toLowerCase().includes(".pdf") || !ct) {
      if (TWILIO_DEBUG) console.log(`Twilio media candidate: ct="${ct || "(none)"}"`);
      candidateUrls.push(url);
    }
  }
  if (candidateUrls.length === 0 && candidateImages.length === 0) {
    return { texts: [], stats: { attempted: 0, downloaded: 0, parsed: 0 } };
  }

  const texts: string[] = [];
  let attempted = 0;
  let downloaded = 0;
  let parsed = 0;

  for (const img of candidateImages.slice(0, 2)) {
    attempted++;
    const buf = await downloadTwilioMedia(img.url);
    if (!buf) continue;
    downloaded++;
    try {
      const ocr = await tryOcrImageBuffer(buf, img.ext);
      if (ocr.trim().length > 20) {
        texts.push(ocr);
        parsed++;
      }
    } catch {
      // ignore OCR failures
    }
  }

  for (const url of candidateUrls.slice(0, 3)) {
    attempted++;
    const buf = await downloadTwilioMedia(url);
    if (!buf) continue;
    downloaded++;
    try {
      if (!isPdfBuffer(buf)) {
        if (TWILIO_DEBUG) console.warn(`Media is not a PDF (signature="${buf.subarray(0, 8).toString("hex")}")`);
        continue;
      }
      const text = await extractTextFromPdfBuffer(buf);
      if (text.length > 20) {
        texts.push(text);
        parsed++;
      }
    } catch {
      // ignore parse failures
    }
  }
  if (attempted > 0) {
    console.log(`Media PDF extract: attempted=${attempted} downloaded=${downloaded} parsed=${parsed}`);
  }
  return { texts, stats: { attempted, downloaded, parsed } };
}

async function handleTwilioWebhook(req: express.Request, res: express.Response) {
  if (!verifyTwilioRequest(req)) {
    return res.status(403).type("text/plain").send("Invalid Twilio signature");
  }

  const body = String(req.body?.Body ?? "").trim();
  const from = String(req.body?.From ?? "");
  const profileName = String(req.body?.ProfileName ?? "").trim();
  const displayName = profileName || maskPhone(from) || "WhatsApp";

  const xmlReply = (msg: string) => {
    logChatLine("Twilio", msg);
    res.set("Content-Type", "text/xml");
    res.send(`<Response><Message>${escapeXml(msg)}</Message></Response>`);
  };

  const numMedia = Number(req.body?.NumMedia ?? 0);
  const hasIncomingMedia = Number.isFinite(numMedia) && numMedia > 0;
  const media = Array.from({ length: hasIncomingMedia ? numMedia : 0 }, (_, i) => ({
    contentType: String(req.body?.[`MediaContentType${i}`] ?? ""),
    hasUrl: Boolean(String(req.body?.[`MediaUrl${i}`] ?? ""))
  }));

  const pdfRes = await extractPdfTextsFromTwilio(req.body).catch(() => ({
    texts: [] as string[],
    stats: { attempted: 0, downloaded: 0, parsed: 0 }
  }));
  const pdfTexts = pdfRes.texts;
  const pdfHeuristic = pdfTexts.flatMap((t) => extractItemsHeuristic(t).items);
  const pdfTableItems = pdfTexts.flatMap((t) => extractItemsFromPdfTables(t));
  const pdfInvoiceItems = pdfTexts.flatMap((t) => extractItemsFromInvoicePdfText(t));
  const pdfName = pdfTexts.map(extractCustomerFromPdfText).find(Boolean) || "";
  const missingTwilioMediaCreds = hasIncomingMedia && (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN);
  const docMeta = pdfTexts.length ? extractDocMetaFromPdfText(pdfTexts[0]) : { orderIds: [], awbs: [], invoiceNos: [] };

  lastTwilioWebhookDebug = {
    at: new Date().toISOString(),
    from,
    profileName,
    body,
    numMedia: Number.isFinite(numMedia) ? numMedia : 0,
    media,
    pdf: pdfRes.stats
  };

  const catalogSkuList = SKU_CATALOG
    .map((d) => `${d.instrument} (${d.sku})`)
    .join(", ");

  logChatLine(displayName, body || (hasIncomingMedia ? "[media]" : "[no text]"));

  const bodyLooksLikePdfNameOnly = /^\s*[\w\s\-\(\)]+\.(pdf)\s*$/i.test(body);
  if (bodyLooksLikePdfNameOnly && !hasIncomingMedia) {
    return xmlReply(
      `⚠️ I only received the filename, not the PDF file.\n` +
      `Please attach the PDF as a WhatsApp Document and resend.\n` +
      `Or send the order as text: "30 TM-803-PLUS, 5 TM-DISPLAY for Jai"`
    );
  }
  if (TWILIO_DEBUG) {
    console.log(`Twilio webhook: NumMedia=${numMedia} BodyLen=${body.length}`);
    media.forEach((m, i) => console.log(`  Media${i}: ct="${m.contentType}" url=${m.hasUrl ? "(present)" : "(missing)"}`));
    console.log(
      `PDF text pages received=${pdfTexts.length} tableItems=${pdfTableItems.length} heuristicItems=${pdfHeuristic.length}`
    );
    if (docMeta.orderIds.length || docMeta.invoiceNos.length || docMeta.awbs.length) {
      console.log(`PDF meta: orderIds=${docMeta.orderIds.join(",")} invoiceNos=${docMeta.invoiceNos.join(",")} awbs=${docMeta.awbs.join(",")}`);
    }
  }

  if (!body && pdfTexts.length === 0) {
    if (missingTwilioMediaCreds) {
      return xmlReply(
        `⚠️ PDF received but the server can't download it yet (missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN).\n` +
        `Please fix backend env vars and resend.`
      );
    }
    if (hasIncomingMedia) {
      return xmlReply(
        `⚠️ Media received but could not read it as a text PDF.\n` +
        `Please resend as a WhatsApp Document (PDF with selectable text) or include the order as text.\n` +
        `Format: "50 TM-803-PLUS, 2 TM-801-TA for Shyam Sundar"`
      );
    }
    return xmlReply(
      `⚠️ We could not parse that message.\n` +
      `Format: "50 TM-803-PLUS, 2 TM-801-TA for Shyam Sundar"\n` +
      `Available catalog SKUs: ${catalogSkuList}.`
    );
  }

  if (hasIncomingMedia && pdfTexts.length === 0) {
    if (missingTwilioMediaCreds) {
      return xmlReply(
        `⚠️ PDF received but the server can't download it yet (missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN).\n` +
        `Please fix backend env vars and resend.`
      );
    }
    return xmlReply(
      `⚠️ Media received but could not read it as a text PDF.\n` +
      `Media: NumMedia=${numMedia}, attempted=${pdfRes.stats.attempted}, downloaded=${pdfRes.stats.downloaded}, parsed=${pdfRes.stats.parsed}.\n` +
      `If it's a scanned PDF, enable OCR (OCR_ENABLED=true) and install Tesseract, or send the order as text.\n` +
      `Format: "30 TM-803-PLUS, 5 TM-DISPLAY for Jai"`
    );
  }

  try {
    const bodyLooksLikeFilename = /^\s*[\w\s\-\(\)]+\.(pdf|png|jpg|jpeg)\s*$/i.test(body);
    const effectiveBody = bodyLooksLikeFilename ? "" : body;
    // Do NOT feed raw PDF text into the general pipeline: invoices often contain prices (e.g. "1782")
    // that get misread as quantities. We parse PDF attachments separately and only use WA body text here.
    const result = await runPipeline(effectiveBody);

    // Items selection rule:
    // - If we can extract from structured PDF tables, trust that ONLY (avoid double counting).
    // - Otherwise fall back to PDF invoice text, then heuristic text.
    const fromPdf = pdfTableItems.length > 0 ? pdfTableItems : (pdfInvoiceItems.length > 0 ? pdfInvoiceItems : pdfHeuristic);
    if (fromPdf.length > 0) {
      if (pdfTableItems.length > 0) {
        result.validItems = fromPdf;
        result.usedFallback = true;
        result.needsReview = true;
      } else {
        for (const it of fromPdf) {
          const existing = result.validItems.find((v) => v.sku === it.sku);
          // If both WA text and PDF-derived text mention same SKU, do NOT sum (prevents 1+1=2 on invoices).
          if (existing) existing.qty = Math.max(existing.qty, it.qty);
          else result.validItems.push(it);
        }
      }
    }

    if (!result.customerName && pdfName) {
      result.customerName = pdfName;
      result.usedFallback = true;
    }

    // If we successfully extracted items from an attached PDF/table, don't block the order
    // due to "rejectedItems" coming from an unreliable text-only parse.
    if (pdfTableItems.length > 0) {
      // For PDF orders, trust our catalog-mapped extraction over any AI-derived rejections.
      result.usedFallback = true;
      result.needsReview = true;
      result.rejectedItems = [];
    }

    if (result.validItems.length === 0) {
      return xmlReply(
        `⚠️ We could not parse that message. Please format orders as:\n` +
        `Format: "50 TM-803-PLUS, 2 TM-801-TA for Shyam Sundar"\n` +
        `Available catalog SKUs: ${catalogSkuList}.`
      );
    }

    if (result.rejectedItems.length > 0) {
      return xmlReply(
        `⚠️ We only accept catalog SKUs. Unknown items: ${result.rejectedItems.join(", ")}.\n` +
        `Please resend using published products like ${CATALOG_EXAMPLES}.`
      );
    }

    if (!result.customerName) {
      // Don't block the order — fall back to the WhatsApp display name/number and flag for review.
      result.customerName = sanitiseName(profileName) || maskPhone(from) || "WhatsApp Customer";
      result.usedFallback = true;
      result.needsReview = true;
    } else if (!isPlausibleCustomerName(result.customerName)) {
      // Keep order, but force review.
      result.usedFallback = true;
      result.needsReview = true;
    }

    const metaNotes: string[] = [];
    if (docMeta.orderIds.length) metaNotes.push(`OrderId: ${docMeta.orderIds[0]}`);
    if (docMeta.invoiceNos.length) metaNotes.push(`Invoice: ${docMeta.invoiceNos[0]}`);
    if (docMeta.awbs.length) metaNotes.push(`AWB: ${docMeta.awbs[0]}`);
    if (from) metaNotes.push(`WA_FROM:${from}`);
    if (profileName) metaNotes.push(`WA_NAME:${profileName}`);
    await insertOrder(result, "whatsapp", metaNotes.length ? metaNotes.join(" | ") : undefined);

    const itemsSummary = result.validItems.map((i) => `- ${i.qty} x ${i.sku}`).join("\n");
    const priorityTag =
      result.priority === "urgent" ? " [URGENT]" :
      result.priority === "high" ? " [HIGH]" : "";
    const reviewNote = result.needsReview ? "\nOur team will verify and confirm shortly." : "";

    return xmlReply(
      `✅ Order received for ${result.customerName}:\n${itemsSummary}${priorityTag}.${reviewNote}\n` +
      `Tracking will be shared when shipped.`
    );
  } catch (err) {
    console.error("Webhook error:", err);
    return xmlReply("⚠️ Server error. Please try again in a moment.");
  }
}

app.post("/api/twilio-webhook", handleTwilioWebhook);
app.post("/", handleTwilioWebhook);

if (DEBUG_ENDPOINTS) {
  app.get("/debug/last-twilio-webhook", (_req, res) => {
    res.json({ ok: true, last: lastTwilioWebhookDebug });
  });
}

app.post("/api/notify-status-change", async (req, res) => {
  const { order_id, prev_status, new_status, awb, courier } = req.body as {
    order_id?: string;
    prev_status?: string;
    new_status?: string;
    awb?: string;
    courier?: string;
  };
  if (!order_id || !new_status) return res.status(400).json({ ok: false, error: "order_id and new_status are required" });

  const prev = String(prev_status || "").trim().toLowerCase();
  const next = String(new_status || "").trim().toLowerCase();

  const allowed = new Set(["new", "payment", "fulfillment", "shipped", "done"]);
  if (!allowed.has(next)) return res.status(400).json({ ok: false, error: "invalid new_status" });
  if (prev && !allowed.has(prev)) return res.status(400).json({ ok: false, error: "invalid prev_status" });

  const client = await pool.connect();
  try {
    const q = await client.query(
      `select o.id, o.channel, o.notes, c.name as customer_name
       from orders o
       join customers c on c.id = o.customer_id
       where o.id = $1`,
      [order_id]
    );
    const row = q.rows[0] as any;
    if (!row) return res.status(404).json({ ok: false, error: "order not found" });

    const to = extractWhatsAppFromNotes(row.notes);
    if (!to) return res.json({ ok: true, skipped: "no_whatsapp_contact" });

    const customerName = String(row.customer_name || "").trim() || "Customer";

    const statusLabel: Record<string, string> = {
      new: "New",
      payment: "Payment",
      fulfillment: "Fulfillment",
      shipped: "Shipment",
      done: "Done"
    };

    const orderShort = String(order_id).slice(-6);
    const movedText =
      prev && prev !== next ? `moved from ${statusLabel[prev]} → ${statusLabel[next]}` : `is now ${statusLabel[next]}`;

    const parts: string[] = [`🔔 Update: Order ${orderShort} for ${customerName} ${movedText}.`];
    if (next === "shipped") {
      const awbStr = (awb || "").trim();
      const courierStr = (courier || "").trim();
      if (awbStr) parts.push(`AWB: ${awbStr}`);
      if (courierStr) parts.push(`Courier: ${courierStr}`);
    }
    if (next === "done") {
      parts.push("Thank you.");
    }
    const message = parts.join("\n");

    if (!message) return res.json({ ok: true, skipped: "no_message" });

    const sent = await sendWhatsAppMessage(to, message);
    return res.json({ ok: sent });
  } catch (err) {
    console.error("notify-status-change error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  } finally {
    client.release();
  }
});

app.post("/api/parse-message", async (req, res) => {
  const { text } = req.body as { text?: string };
  if (!text?.trim()) return res.status(400).json({ error: "text is required" });

  try {
    const result = await runPipeline(text.trim());
    return res.json({
      customer_name: result.customerName,
      items: result.validItems.map((i) => ({
        product: i.product,
        sku: i.sku,
        qty: i.qty,
        product_name: i.product  // alias Board.tsx expects
      })),
      priority: result.priority,
      notes: result.notes,
      confidence: result.confidence,
      unrecognised_items: result.rejectedItems,
      needs_review: result.needsReview,
      channel: "direct"
    });
  } catch (err) {
    console.error("parse-message error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

/* ── PDF Order Parsing ── */
app.post("/api/parse-pdf", async (req, res) => {
  try {
    // Expect base64-encoded PDF in body: { pdf: "base64string", channel: "email" }
    const { pdf, channel = "email", items_only, compact } = req.body as {
      pdf?: string;
      channel?: string;
      items_only?: boolean;
      compact?: boolean;
    };
    if (!pdf) return res.status(400).json({ error: "pdf (base64) is required" });

    const buffer = Buffer.from(pdf, "base64");
    const text = await extractTextFromPdfBuffer(buffer);

    if (!text || text.length < 10) {
      return res.status(422).json({ error: "Could not extract text from PDF" });
    }

    console.log("PDF text extracted:", text.slice(0, 300));

    // For PDFs, avoid feeding raw invoice text into the main pipeline (prices can look like quantities).
    const tableItems = extractItemsFromPdfTables(text);
    const invoiceTextItems = extractItemsFromInvoicePdfText(text);
    const fallbackHeuristic = extractItemsHeuristic(text);

    // Prefer structured table extraction; fall back to text only if no table items exist.
    const items = tableItems.length > 0 ? tableItems : (invoiceTextItems.length > 0 ? invoiceTextItems : fallbackHeuristic.items);
    if (items.length === 0) {
      return res.status(422).json({
        error: "No catalog items found in PDF",
        unrecognised_items: fallbackHeuristic.rejected
      });
    }

    if (items_only === true || compact === true) {
      // Compact output requested: return items only (no DB insert).
      return res.json(items.map((i) => ({ product_name: i.sku, qty: i.qty })));
    }

    const customerFromPdf = extractCustomerFromPdfText(text);
    const customerName = customerFromPdf || "Unknown";
    const priority = inferPriority(text);
    const notes = "Parsed from PDF";
    const rejectedItems = tableItems.length > 0 ? [] : fallbackHeuristic.rejected;
    const needsReview = !customerFromPdf || !isPlausibleCustomerName(customerName) || tableItems.length === 0;

    const result: PipelineResult = {
      customerName,
      validItems: items,
      rejectedItems,
      priority,
      notes,
      confidence: 0.6,
      needsReview,
      usedFallback: true
    };

    const orderId = await insertOrder(result, channel);
    return res.json({
      order_id: orderId,
      customer_name: result.customerName,
      items: result.validItems,
      priority: result.priority,
      needs_review: result.needsReview,
      rejected_items: result.rejectedItems
    });
  } catch (err) {
    console.error("parse-pdf error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

/* ============================================================
   IMAP — DISABLED
   Set IMAP_ENABLED=true in env to re-enable when ready.
   ============================================================ */

if (process.env.IMAP_ENABLED === "true") {
  (async () => {
    const { simpleParser } = (await import("mailparser")) as any;
    const { ImapFlow } = (await import("imapflow")) as any;

    async function pollImap() {
      const client = new ImapFlow({
        host: process.env.IMAP_HOST!,
        port: Number(process.env.IMAP_PORT || 993),
        secure: process.env.IMAP_SECURE !== "false",
        logger: false,
        auth: { user: process.env.IMAP_USER!, pass: process.env.IMAP_PASS! }
      });
      try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        try {
          for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
            if (!msg.source) continue;
            const mail = await simpleParser(msg.source);
            const text = (mail.text || "").toString().trim();
            if (!text) continue;
            console.log("📧 EMAIL:", text.slice(0, 200));
            const result = await runPipeline(text);
            if (result.validItems.length > 0) {
              await insertOrder(result, "email");
            } else {
              console.log("📧 Skipped — no catalog items found.");
            }
            await client.messageFlagsAdd(msg.uid, ["\\Seen"]);
          }
        } finally { lock.release(); }
        await client.logout();
      } catch (err) {
        console.error("IMAP Error:", err);
        try { await client.logout(); } catch {}
      }
    }

    setInterval(async () => {
      console.log("📥 Checking emails...");
      await pollImap();
    }, 120_000);
    console.log("📧 IMAP enabled.");
  })();
} else {
  console.log("📧 IMAP disabled.");
}

/* ============================================================
   START
   ============================================================ */

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`\n🚀 DispatchBoard API — port ${PORT}`);
  console.log(`   Gemini model : ${GEMINI_MODEL}`);
  console.log(`   Gemini API   : ${(GEMINI_API_VERSIONS.length ? GEMINI_API_VERSIONS : ["v1", "v1beta"]).join(", ")}`);
  if ((process.env.GEMINI_FALLBACK_MODELS || "").trim()) {
    console.log(`   Gemini fb    : ${String(process.env.GEMINI_FALLBACK_MODELS).trim()}`);
  }
  console.log(`   CORS origins : ${allowedOrigins.join(", ")}`);
  console.log(`   IMAP         : ${process.env.IMAP_ENABLED === "true" ? "enabled" : "disabled"}`);
});
