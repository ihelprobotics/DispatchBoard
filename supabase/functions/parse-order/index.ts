/// <reference lib="deno.ns" />
/// <reference lib="deno.unstable" />

import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const geminiApiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
const geminiModel = Deno.env.get("GEMINI_MODEL") ?? "gemini-1.5-flash";

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const parseWithGemini = async (text: string) => {
  if (!geminiApiKey) return null;

  const prompt = `Extract structured order data from the message. Return JSON only with keys: customer_name, items (array of {product, qty}), priority (urgent|high|normal), notes, confidence (0-1). Message: ${text}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 }
      })
    }
  );

  if (!res.ok) return null;

  const data = await res.json();
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!content) return null;

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
};

const parseLineItems = (text: string) => {
  const lines = text.split(/\n|,/).map((line) => line.trim()).filter(Boolean);
  const items: { product: string; qty: number }[] = [];

  for (const line of lines) {
    const match =
      line.match(/(.+?)\s*(?:x|\*)\s*(\d+)/i) ||
      line.match(/(\d+)\s*(.+)/i);

    if (match) {
      if (match[2]) {
        const product = match[1].trim();
        const qty = Number(match[2]);
        if (product && Number.isFinite(qty)) items.push({ product, qty });
      } else {
        const qty = Number(match[1]);
        const product = match[2]?.trim();
        if (product && Number.isFinite(qty)) items.push({ product, qty });
      }
    }
  }

  return items;
};

const insertOrder = async (parsed: any, channel: string) => {
  const customerName = String(parsed.customer_name ?? "Unknown");

  const { data: customer } = await supabase
    .from("customers")
    .select("id, payment_required")
    .eq("name", customerName)
    .maybeSingle();

  let customerId = customer?.id;
  let paymentRequired = customer?.payment_required ?? true;

  if (!customerId) {
    const { data: created } = await supabase
      .from("customers")
      .insert({ name: customerName, type: "non_regular", payment_required: true })
      .select("id, payment_required")
      .single();

    customerId = created?.id;
    paymentRequired = created?.payment_required ?? true;
  }

  const status = paymentRequired ? "payment" : "fulfillment";
  const paymentStatus = paymentRequired ? "pending" : "paid";
  const needsReview = Number(parsed.confidence ?? 0) < 0.7;

  const { data: order } = await supabase
    .from("orders")
    .insert({
      customer_id: customerId,
      channel,
      priority: parsed.priority ?? "normal",
      status,
      payment_status: paymentStatus,
      needs_review: needsReview,
      notes: parsed.notes ?? ""
    })
    .select("id")
    .single();

  const items = Array.isArray(parsed.items) ? parsed.items : [];

  const orderItems = items
    .filter((item: any) => item?.product && item?.qty)
    .map((item: any) => ({
      order_id: order?.id,
      product_name: String(item.product),
      qty_ordered: Number(item.qty)
    }));

  if (orderItems.length) {
    await supabase.from("order_items").insert(orderItems);
  }

  return { order_id: order?.id, needs_review: needsReview };
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();

    const text = String(body?.text ?? "");
    const customerName = String(body?.customer_name ?? "Unknown");
    const channel = String(body?.channel ?? "manual");

    const parsed =
      (await parseWithGemini(text)) ?? {
        customer_name: customerName,
        items: parseLineItems(text),
        priority: "normal",
        notes: body?.notes ?? "",
        confidence: 0.5
      };

    const result = await insertOrder(parsed, channel);

    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to ingest order.";

    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});