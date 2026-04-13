import { PDFParse } from "pdf-parse";
import { matchSku } from "./sku-map";
import type { ParsedOrder } from "./types";

const PRICE_QUANTITY_REGEX = /₹[\d,]+(?:\.\d+)?\s+(\d+)\s+₹/;

const normalizeLine = (line: string) => line.replace(/\s+/g, " ").trim();

function findQuantity(line: string): number {
  const qtyMatch = line.match(PRICE_QUANTITY_REGEX);
  if (qtyMatch) {
    const parsed = Number(qtyMatch[1]);
    return Number.isFinite(parsed) ? Math.max(1, parsed) : 1;
  }
  const fallback = line.match(/\bQty\s*[:\-]?\s*(\d+)/i);
  if (fallback) {
    const parsed = Number(fallback[1]);
    return Number.isFinite(parsed) ? Math.max(1, parsed) : 1;
  }
  return 1;
}

function findPriceLine(lines: string[], start: number): string | null {
  for (let offset = 0; offset < 5 && start + offset < lines.length; offset += 1) {
    const candidate = lines[start + offset];
    if (candidate.includes("₹")) {
      return normalizeLine(candidate);
    }
  }
  return null;
}

function buildItems(lines: string[]): Array<{ product: string; qty: number }> {
  const tally = new Map<string, number>();
  lines.forEach((line, idx) => {
    const entry = matchSku(line);
    if (!entry) return;
    const productName = entry.description || entry.instrument;
    const priceLine = findPriceLine(lines, idx + 1);
    const qty = priceLine ? findQuantity(priceLine) : 1;
    const current = tally.get(productName) ?? 0;
    tally.set(productName, current + qty);
  });
  return Array.from(tally.entries()).map(([product, qty]) => ({ product, qty }));
}

const SOLD_BY_PATTERN = /\bsold\s*by\b/i;
const ADDRESS_PATTERNS = [/(billing address|bill to)/i, /(shipping address|ship to)/i];
const FIELD_PATTERN = /^(?:customer(?: name)?|sold to|bill to|ship to|buyer)\s*[:\-]\s*(.+)/i;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function sanitizeCustomerName(candidate: string | null | undefined): string | null {
  const text = candidate?.trim();
  if (!text) return null;
  if (SOLD_BY_PATTERN.test(text)) return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  const [firstSegment] = cleaned.split(/[,:;|]/);
  return firstSegment?.trim() || null;
}

function extractAddressCandidate(lines: string[], idx: number, labelText: string): string | null {
  const line = lines[idx];
  const inlineValue = line.split(":").slice(1).join(":").trim();
  const inlineCandidate = sanitizeCustomerName(inlineValue);
  if (inlineCandidate) return inlineCandidate;

  const labelRegex = new RegExp(escapeRegExp(labelText), "i");
  const fallbackFromLabel = line.replace(labelRegex, "").replace(/[:\-]+/, " ").trim();
  const labelCandidate = sanitizeCustomerName(fallbackFromLabel);
  if (labelCandidate) return labelCandidate;

  for (let offset = 1; offset <= 2; offset += 1) {
    const neighbor = lines[idx + offset];
    if (!neighbor) continue;
    const neighborCandidate = sanitizeCustomerName(neighbor);
    if (neighborCandidate) return neighborCandidate;
  }

  return null;
}

function findAddressBasedName(lines: string[]): string | null {
  for (const pattern of ADDRESS_PATTERNS) {
    for (let idx = 0; idx < lines.length; idx += 1) {
      const match = lines[idx].match(pattern);
      if (!match) continue;
      const candidate = extractAddressCandidate(lines, idx, match[0]);
      if (candidate) return candidate;
    }
  }
  return null;
}

function extractCustomer(lines: string[], fallback?: string): string | null {
  const addressName = findAddressBasedName(lines);
  if (addressName) return addressName;

  for (const line of lines) {
    const match = line.match(FIELD_PATTERN);
    if (match?.[1]) {
      const candidate = sanitizeCustomerName(match[1]);
      if (candidate) return candidate;
    }
  }

  const forLine = lines.find((line) => /^For\s+/i.test(line));
  if (forLine) {
    const candidate = sanitizeCustomerName(forLine.replace(/^For\s+/i, ""));
    if (candidate) return candidate;
  }
  return fallback ?? null;
}

function extractField(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function toUint8Array(input: Buffer): Uint8Array {
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

export async function parseInvoicePdf(
  buffer: Buffer,
  fallbackCustomer?: string
): Promise<ParsedOrder | null> {
  const parser = new PDFParse({ data: toUint8Array(buffer) });
  const result = await parser.getText();
  const text = typeof result === "string" ? result : result?.text ?? "";
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const items = buildItems(lines);
  if (!items.length) return null;

  const customerName = extractCustomer(lines, fallbackCustomer) ?? fallbackCustomer ?? "WhatsApp Customer";
  const orderNumber = extractField(text, /Order Number[:\s\-]+([A-Z0-9-]+)/i);
  const invoiceNumber = extractField(text, /Invoice Number\s*[:\-]?\s*([A-Z0-9-]+)/i);

  const notesParts: string[] = [];
  if (orderNumber) notesParts.push(`order_number:${orderNumber}`);
  if (invoiceNumber) notesParts.push(`invoice_number:${invoiceNumber}`);

  return {
    customer_name: customerName,
    items,
    priority: "normal",
    notes: notesParts.length ? notesParts.join("\n") : "Parsed from invoice PDF",
    confidence: 0.82
  };
}
