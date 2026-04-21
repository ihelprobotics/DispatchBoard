"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDrag } from "@use-gesture/react";
import { supabase } from "../lib/supabaseClient";

/* ============================================================
   TYPES
   ============================================================ */

type OrderItem = {
  id?: string;
  product_name: string;
  qty_ordered: number;
};

type Order = {
  id: string;
  customer_name: string;
  suffix?: string | null;
  priority: "urgent" | "high" | "normal";
  status: "new" | "payment" | "fulfillment" | "shipped" | "done";
  payment_status: "pending" | "paid";
  needs_review: boolean;
  notes?: string | null;
  items: OrderItem[];
};

type Customer = {
  id: string;
  name: string;
  payment_required: boolean;
  type: string;
};

type Shipment = {
  id: string;
  awb: string | null;
  courier: string | null;
  shipped_at: string;
  shipment_items: Array<{ product_name: string; qty_shipped: number }>;
};

type ProductMapping = {
  id: string;
  marketplace: string;
  external_sku: string;
  product_name: string;
};

type Profile = {
  id: string;
  role: "admin" | "staff";
};

type FulfillmentState = {
  order: Order;
  qtyByProduct: Record<string, number>;
  awb: string;
  courier: string;
};

type NewOrderState = {
  customerName: string;
  channel: string;
  priority: Order["priority"];
  paymentRequired: boolean;
  items: Array<{ product_name: string; qty_ordered: number }>;
  notes: string;
};

type QueueAction =
  | { type: "mark_paid"; orderId: string }
  | { type: "update_status"; orderId: string; status: Order["status"] }
  | { type: "ship_partial"; payload: { orderId: string; items: any[]; awb: string | null; courier: string | null } };

/* ============================================================
   CONSTANTS
   ============================================================ */

const COLUMNS = [
  { key: "new",         label: "New" },
  { key: "payment",     label: "Payment" },
  { key: "fulfillment", label: "Fulfillment" },
  { key: "shipped",     label: "Shipped" },
  { key: "done",        label: "Done" },
] as const;

const STATUS_ORDER = ["new", "payment", "fulfillment", "shipped", "done"] as const;

const QUEUE_KEY = "dispatchboard_queue";

const SAMPLE_CARDS: Order[] = [
  {
    id: "1",
    customer_name: "Ravi Electronics, Mumbai",
    priority: "urgent",
    status: "new",
    payment_status: "pending",
    needs_review: false,
    items: [
      { product_name: "TM 803+ Sensor", qty_ordered: 50 },
      { product_name: "890 HTM", qty_ordered: 10 },
    ],
  },
  {
    id: "2",
    customer_name: "Suresh Traders, Pune",
    priority: "normal",
    status: "fulfillment",
    payment_status: "paid",
    needs_review: false,
    items: [{ product_name: "TM 804 Sensor alone", qty_ordered: 20 }],
  },
];

/* ============================================================
   AUDIO — module-level so hooks can reference it safely
   urgent  = 3 short beeps (880 Hz)
   high    = 2 medium beeps (660 Hz)
   tv/any  = 1 beep (540 Hz)
   ============================================================ */

function playAudioCue(type: "urgent" | "high" | "any") {
  try {
    const ctx = new AudioContext();
    const configs =
      type === "urgent" ? [880, 880, 880] :
      type === "high"   ? [660, 660] :
                          [540];

    configs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.4, ctx.currentTime + i * 0.22);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.22 + 0.18);
      osc.start(ctx.currentTime + i * 0.22);
      osc.stop(ctx.currentTime + i * 0.22 + 0.2);
    });
  } catch {
    // AudioContext blocked before user interaction — silent fail
  }
}

/* ============================================================
   OFFLINE QUEUE HELPERS
   ============================================================ */

const readQueue = (): QueueAction[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueueAction[]) : [];
  } catch { return []; }
};

const writeQueue = (actions: QueueAction[]) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(QUEUE_KEY, JSON.stringify(actions));
};

/* ============================================================
   HELPERS
   ============================================================ */

const formatPayment = (status: Order["payment_status"]) =>
  status === "paid" ? "Credit — N/A" : "Payment Pending";

const getPriorityStyles = (p: Order["priority"]) =>
  p === "urgent" ? "bg-red-500 text-white" :
  p === "high"   ? "bg-amber-500 text-white" :
                   "bg-mint text-ink";

const canMoveForward = (order: Order) =>
  order.status !== "done" &&
  !(order.status === "payment" && order.payment_status !== "paid");

const nextStatus = (s: Order["status"]) => {
  const i = STATUS_ORDER.indexOf(s);
  return STATUS_ORDER[Math.min(i + 1, STATUS_ORDER.length - 1)];
};

const prevStatus = (s: Order["status"]) => {
  const i = STATUS_ORDER.indexOf(s);
  return STATUS_ORDER[Math.max(i - 1, 0)];
};

const emptyNewOrder = (): NewOrderState => ({
  customerName: "",
  channel: "direct",
  priority: "normal",
  paymentRequired: true,
  items: [{ product_name: "", qty_ordered: 1 }],
  notes: "",
});

/* ============================================================
   useOrders — realtime hook
   playAudioCue is passed in so it's always current
   ============================================================ */

const useOrders = (tvMode: boolean) => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [realtimeActive, setRealtimeActive] = useState(false);

  const hasSupabase = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  const loadOrders = useCallback(async () => {
    if (!hasSupabase) {
      setOrders(SAMPLE_CARDS);
      setLoading(false);
      return;
    }
    try {
      const { data, error } = await supabase
        .from("orders")
        .select(
          "id, customer_id, channel, priority, status, payment_status, needs_review, notes, parent_order_id, suffix, created_at, customers(name), order_items(id, product_name, qty_ordered)"
        )
        .order("created_at", { ascending: false });

      if (error) { setOrders([]); setLoading(false); return; }

      setOrders(
        (data ?? []).map((o: any) => ({
          id: o.id,
          customer_name: o.customers?.name ?? "Unknown",
          priority: o.priority,
          status: o.status,
          payment_status: o.payment_status,
          needs_review: o.needs_review ?? false,
          suffix: o.suffix ?? null,
          notes: (() => {
            const raw = (o.notes ?? "") as string;
            if (!raw) return null;
            const cleaned = raw
              .split(/\s*\|\s*/g)
              .filter((p) => !/^whatsapp sender:/i.test(p.trim()))
              .join(" | ")
              .trim();
            return cleaned || null;
          })(),
          items: o.order_items ?? [],
        })) as Order[]
      );
    } catch {
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, [hasSupabase]);

  // Initial load
  useEffect(() => { loadOrders(); }, [loadOrders]);

  // Realtime subscription — reconnects automatically via Supabase client
  useEffect(() => {
    if (!hasSupabase) return;

    const ch = supabase
      .channel("orders-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "orders" },
        (payload) => {
          loadOrders();
          if (payload.eventType === "INSERT") {
            const p = payload.new?.priority as Order["priority"];
            if (tvMode) {
              playAudioCue("any");
            } else if (p === "urgent") {
              playAudioCue("urgent");
            } else if (p === "high") {
              playAudioCue("high");
            }
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "order_items" },
        () => loadOrders()
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setRealtimeActive(true);
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setRealtimeActive(false);
          // Auto-retry after 3s
          setTimeout(() => ch.subscribe(), 3000);
        }
      });

    return () => { supabase.removeChannel(ch); };
  }, [hasSupabase, tvMode, loadOrders]);

  // Refresh loop: always poll as a safety net so users don't need to refresh.
  useEffect(() => {
    if (!hasSupabase) return;

    const intervalMs = realtimeActive ? 8000 : 4000;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      loadOrders();
    }, intervalMs);

    return () => window.clearInterval(id);
  }, [hasSupabase, realtimeActive, loadOrders]);

  return { orders, loading, reload: loadOrders, hasSupabase };
};

/* ============================================================
   OrderCard
   ============================================================ */

function OrderCard({
  card, tvMode,
  onMoveBack, onMoveForward, onMarkPaid,
  onOpenFulfillment, onOpenHistory, onMarkReviewed,
  isAdmin, onDelete,
}: {
  card: Order; tvMode: boolean;
  onMoveBack: () => void; onMoveForward: () => void; onMarkPaid: () => void;
  onOpenFulfillment: () => void; onOpenHistory: () => void; onMarkReviewed: () => void;
  isAdmin: boolean; onDelete: () => void;
}) {
  const bind = useDrag(
    ({ last, movement: [mx], swipe: [sx] }) => {
      if (!last || tvMode) return;
      if (sx === 1  || mx >  80) onMoveBack();
      if (sx === -1 || mx < -80) onMoveForward();
    },
    { filterTaps: true }
  );

  const isUrgent = card.priority === "urgent";

  return (
    <div
      {...bind()}
      className={`rounded-2xl border bg-white p-4 shadow-sm transition-shadow ${
        isUrgent ? "border-red-300 ring-1 ring-red-200" : "border-ink/10"
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">
            {card.suffix ? `${card.customer_name} — ${card.suffix}` : card.customer_name}
          </p>
          <p className="text-xs text-ink/50">{formatPayment(card.payment_status)}</p>
        </div>
        <span className={`shrink-0 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${getPriorityStyles(card.priority)}`}>
          {card.priority}
        </span>
      </div>

      {/* Admin delete */}
      {isAdmin && (
        <div className="mt-1 flex justify-end">
          <button
            className="rounded-full border border-ink/10 px-2 py-0.5 text-[10px] font-semibold text-ink/40 hover:border-red-300 hover:text-red-500"
            onClick={onDelete}
            disabled={tvMode}
            title="Delete order"
          >✕</button>
        </div>
      )}

      {/* Items */}
      <div className="mt-3 space-y-1">
        {card.items.map((item, i) => (
          <div key={`${item.product_name}-${i}`} className="flex items-center justify-between text-sm">
            <span className="text-ink/80">{item.product_name}</span>
            <span className="font-semibold text-ink">×{item.qty_ordered}</span>
          </div>
        ))}
      </div>

      {/* Notes */}
      {card.notes && (
        <p className="mt-2 text-xs text-ink/50 line-clamp-2">📝 {card.notes}</p>
      )}

      {/* Needs review badge */}
      {card.needs_review && (
        <div className="mt-3 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs font-semibold text-amber-700">
          ⚠ Needs review
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex flex-col gap-2">
        {card.needs_review && (
          <button
            className="w-full rounded-xl border border-ink/10 px-3 py-2 text-xs font-semibold hover:bg-paper"
            onClick={onMarkReviewed}
            disabled={tvMode}
          >Mark reviewed</button>
        )}

        {card.status === "payment" && card.payment_status !== "paid" && (
          <button
            className="w-full rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white"
            onClick={onMarkPaid}
            disabled={tvMode}
          >Mark as Paid</button>
        )}

        {card.status === "fulfillment" && (
          <button
            className="w-full rounded-xl border border-ink/10 bg-paper px-3 py-2 text-xs font-semibold hover:bg-white"
            onClick={onOpenFulfillment}
            disabled={tvMode}
          >Open Fulfillment</button>
        )}

        <button
          className="w-full rounded-xl border border-ink/10 px-3 py-2 text-xs font-semibold hover:bg-paper"
          onClick={onOpenHistory}
        >View shipments</button>

        <div className="flex gap-2 text-xs">
          <button
            className="w-full rounded-xl border border-ink/10 px-2 py-2 font-semibold disabled:opacity-30 hover:bg-paper"
            onClick={onMoveBack}
            disabled={card.status === "new" || tvMode}
          >← Back</button>
          <button
            className="w-full rounded-xl border border-ink/10 px-2 py-2 font-semibold disabled:opacity-30 hover:bg-paper"
            onClick={onMoveForward}
            disabled={!canMoveForward(card) || tvMode}
          >Forward →</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   BOARD (main component)
   ============================================================ */

export function Board({ tvMode }: { tvMode: boolean }) {
  const { orders, loading, reload, hasSupabase } = useOrders(tvMode);

  const [error,         setError]         = useState<string | null>(null);
  const [fulfillment,   setFulfillment]   = useState<FulfillmentState | null>(null);
  const [newOrder,      setNewOrder]      = useState<NewOrderState | null>(null);
  const [customers,     setCustomers]     = useState<Customer[]>([]);
  const [showCustomers, setShowCustomers] = useState(false);
  const [profiles,      setProfiles]      = useState<Profile[]>([]);
  const [showRoles,     setShowRoles]     = useState(false);
  const [shipments,     setShipments]     = useState<Shipment[] | null>(null);
  const [historyOrder,  setHistoryOrder]  = useState<Order | null>(null);
  const [queued,        setQueued]        = useState<QueueAction[]>([]);
  const [search,        setSearch]        = useState("");
  const [priorityFilter, setPriorityFilter] = useState<"all" | Order["priority"]>("all");
  const [statusFilter,   setStatusFilter]   = useState<"all" | Order["status"]>("all");
  const [mappings,      setMappings]      = useState<ProductMapping[]>([]);
  const [showMappings,  setShowMappings]  = useState(false);
  const [mappingForm,   setMappingForm]   = useState({ marketplace: "", external_sku: "", product_name: "" });
  const [isAdmin,       setIsAdmin]       = useState(true);
  const [rawImport,     setRawImport]     = useState<{ text: string; parsing: boolean } | null>(null);

  const columnRef = useRef<HTMLDivElement>(null);

  /* ── Role init ── */
  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const userId = data.session?.user?.id;
        if (!userId) { setIsAdmin(true); return; }
        const { data: p } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
        setIsAdmin(p?.role === "admin");
      } catch { setIsAdmin(true); }
    })();
  }, []);

  /* ── TV auto-scroll ── */
  useEffect(() => {
    if (!tvMode || !columnRef.current) return;
    const container = columnRef.current;
    let dir = 1;
    const iv = setInterval(() => {
      const max = container.scrollWidth - container.clientWidth;
      if (max <= 0) return;
      const next = container.scrollLeft + dir * container.clientWidth;
      if (next >= max) dir = -1;
      if (next <= 0)   dir = 1;
      container.scrollTo({ left: Math.max(0, Math.min(max, next)), behavior: "smooth" });
    }, 9000);
    return () => clearInterval(iv);
  }, [tvMode]);

  /* ── Offline queue init ── */
  useEffect(() => { setQueued(readQueue()); }, []);

  /* ── Online flush ── */
  useEffect(() => {
    const flush = async () => {
      const actions = readQueue();
      if (!actions.length) return;
      const remaining: QueueAction[] = [];
      for (const action of actions) {
        try {
          if (action.type === "mark_paid") {
            const { error: e } = await supabase.from("orders")
              .update({ payment_status: "paid", status: "fulfillment" }).eq("id", action.orderId);
            if (e) throw e;
          }
          if (action.type === "update_status") {
            const { error: e } = await supabase.from("orders")
              .update({ status: action.status }).eq("id", action.orderId);
            if (e) throw e;
          }
          if (action.type === "ship_partial") {
            const { error: e } = await supabase.rpc("ship_partial", {
              p_order_id: action.payload.orderId,
              p_items: action.payload.items,
              p_awb: action.payload.awb,
              p_courier: action.payload.courier,
            });
            if (e) throw e;
          }
        } catch { remaining.push(action); }
      }
      writeQueue(remaining);
      setQueued(remaining);
      if (remaining.length === 0) reload();
    };
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [reload]);

  const enqueue = (action: QueueAction) => {
    const updated = [...readQueue(), action];
    writeQueue(updated);
    setQueued(updated);
  };

  /* ── Actions ── */
  const markPaid = async (orderId: string) => {
    setError(null);
    const { error: e } = await supabase.from("orders")
      .update({ payment_status: "paid", status: "fulfillment" }).eq("id", orderId);
    if (e) { enqueue({ type: "mark_paid", orderId }); setError("Offline — queued."); return; }
    reload();
  };

  const updateStatus = async (order: Order, target: Order["status"]) => {
    if (order.status === "payment" && order.payment_status !== "paid") {
      setError("Payment required before advancing to fulfillment.");
      return;
    }
    setError(null);
    const { error: e } = await supabase.from("orders").update({ status: target }).eq("id", order.id);
    if (e) { enqueue({ type: "update_status", orderId: order.id, status: target }); setError("Offline — queued."); return; }
    reload();
  };

  const openFulfillment = (order: Order) => {
    const qtyByProduct: Record<string, number> = {};
    order.items.forEach((item) => { qtyByProduct[item.product_name] = item.qty_ordered; });
    setFulfillment({ order, qtyByProduct, awb: "", courier: "" });
  };

  const submitFulfillment = async () => {
    if (!fulfillment) return;
    const items = Object.entries(fulfillment.qtyByProduct)
      .filter(([, qty]) => qty > 0)
      .map(([product_name, qty_to_ship]) => ({ product_name, qty_to_ship }));
    if (!items.length) { setError("Select at least one item to ship."); return; }
    setError(null);
    const { error: e } = await supabase.rpc("ship_partial", {
      p_order_id: fulfillment.order.id,
      p_items: items,
      p_awb: fulfillment.awb || null,
      p_courier: fulfillment.courier || null,
    });
    if (e) {
      enqueue({ type: "ship_partial", payload: { orderId: fulfillment.order.id, items, awb: fulfillment.awb || null, courier: fulfillment.courier || null } });
      setError("Offline — queued fulfillment.");
      return;
    }
    setFulfillment(null);
    reload();
  };

  const openHistory = async (order: Order) => {
    setHistoryOrder(order);
    const { data, error: e } = await supabase
      .from("shipments")
      .select("id, awb, courier, shipped_at, shipment_items(product_name, qty_shipped)")
      .eq("order_id", order.id)
      .order("shipped_at", { ascending: false });
    if (e) { setError("Failed to load shipment history."); setShipments([]); return; }
    setShipments((data ?? []) as Shipment[]);
  };

  const deleteShipment = async (id: string) => {
    if (!window.confirm("Delete this shipment record?")) return;
    const { error: e } = await supabase.from("shipments").delete().eq("id", id);
    if (e) { setError(e.message); return; }
    setShipments((prev) => prev?.filter((s) => s.id !== id) ?? prev);
  };

  const deleteOrder = async (id: string) => {
    if (!window.confirm("Delete this order? This cannot be undone.")) return;
    const { error: e } = await supabase.from("orders").delete().eq("id", id);
    if (e) { setError(e.message); return; }
    reload();
  };

  const markReviewed = async (id: string) => {
    const { error: e } = await supabase.from("orders").update({ needs_review: false }).eq("id", id);
    if (e) { setError("Failed to update review status."); return; }
    reload();
  };

  /* ── New order (manual) ── */
  const submitNewOrder = async () => {
    if (!newOrder) return;
    if (!newOrder.customerName.trim()) { setError("Customer name is required."); return; }
    const items = newOrder.items.filter((i) => i.product_name.trim() && i.qty_ordered > 0);
    if (!items.length) { setError("Add at least one line item."); return; }
    setError(null);

    const { data: existing } = await supabase
      .from("customers").select("id, payment_required").eq("name", newOrder.customerName.trim()).maybeSingle();

    let customerId = existing?.id;
    let paymentRequired = existing?.payment_required ?? newOrder.paymentRequired;

    if (!customerId) {
      const { data: created, error: ce } = await supabase
        .from("customers")
        .insert({ name: newOrder.customerName.trim(), type: newOrder.paymentRequired ? "non_regular" : "regular", payment_required: newOrder.paymentRequired })
        .select("id, payment_required").single();
      if (ce || !created) { setError(ce?.message ?? "Failed to create customer."); return; }
      customerId = created.id;
      paymentRequired = created.payment_required;
    }

    // Manual orders also start in "new" — consistent with WhatsApp intake
    const { data: order, error: oe } = await supabase
      .from("orders")
      .insert({
        customer_id: customerId,
        channel: newOrder.channel,
        priority: newOrder.priority,
        status: "new",
        payment_status: paymentRequired ? "pending" : "paid",
        notes: newOrder.notes.trim() || null,
      })
      .select("id").single();
    if (oe || !order) { setError(oe?.message ?? "Failed to create order."); return; }

    const { error: ie } = await supabase.from("order_items").insert(
      items.map((item) => ({ order_id: order.id, product_name: item.product_name.trim(), qty_ordered: Number(item.qty_ordered) }))
    );
    if (ie) { setError(ie.message); return; }

    setNewOrder(null);
    reload();
  };

  /* ── Smart Parse (AI) ── */
  const handleRawImport = async () => {
    if (!rawImport?.text.trim()) return;
    setRawImport({ ...rawImport, parsing: true });
    try {
      const url = (process.env.NEXT_PUBLIC_INTAKE_API_URL ?? "http://localhost:4000");
      const res = await fetch(`${url}/api/parse-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: rawImport.text }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      setRawImport(null);

      let channel = data.channel || "direct";
      if (!["direct", "whatsapp", "email", "marketplace"].includes(channel)) channel = "direct";

      setNewOrder({
        customerName: data.customer_name || "",
        channel,
        priority: data.priority || "normal",
        paymentRequired: true,
        items: data.items?.length
          ? data.items.map((i: any) => ({
              product_name: i.product_name || i.product || "Unknown",
              qty_ordered: Number(i.qty_ordered || i.qty || 1),
            }))
          : [{ product_name: "", qty_ordered: 1 }],
        notes: data.notes || (data.unrecognised_items?.length ? `Unrecognised items: ${data.unrecognised_items.join(", ")}` : ""),
      });
    } catch (err: any) {
      setError(`Parse failed: ${err.message}`);
      setRawImport({ ...rawImport, parsing: false });
    }
  };

  /* ── Customers panel ── */
  const openCustomers = async () => {
    setShowCustomers(true);
    const { data, error: e } = await supabase.from("customers").select("id, name, payment_required, type").order("name");
    if (e) { setError("Failed to load customers."); return; }
    setCustomers((data ?? []) as Customer[]);
  };

  const toggleCustomerPayment = async (c: Customer) => {
    const payment_required = !c.payment_required;
    const { error: e } = await supabase.from("customers")
      .update({ payment_required, type: payment_required ? "non_regular" : "regular" }).eq("id", c.id);
    if (e) { setError("Failed to update customer."); return; }
    setCustomers((prev) => prev.map((x) => x.id === c.id ? { ...x, payment_required, type: payment_required ? "non_regular" : "regular" } : x));
  };

  /* ── Roles panel ── */
  const openRoles = async () => {
    setShowRoles(true);
    const { data, error: e } = await supabase.from("profiles").select("id, role").order("created_at", { ascending: false });
    if (e) { setError(e.message); return; }
    setProfiles((data ?? []) as Profile[]);
  };

  const toggleRole = async (p: Profile) => {
    const nextRole = p.role === "admin" ? "staff" : "admin";
    const { error: e } = await supabase.from("profiles").update({ role: nextRole }).eq("id", p.id);
    if (e) { setError(e.message); return; }
    setProfiles((prev) => prev.map((x) => x.id === p.id ? { ...x, role: nextRole as Profile["role"] } : x));
  };

  /* ── SKU Mappings panel ── */
  const openMappings = async () => {
    setShowMappings(true);
    const { data, error: e } = await supabase.from("product_mappings")
      .select("id, marketplace, external_sku, product_name").order("marketplace");
    if (e) { setError("Failed to load SKU mappings."); return; }
    setMappings((data ?? []) as ProductMapping[]);
  };

  const addMapping = async () => {
    if (!mappingForm.marketplace.trim() || !mappingForm.external_sku.trim() || !mappingForm.product_name.trim()) {
      setError("All fields required."); return;
    }
    const { data, error: e } = await supabase.from("product_mappings")
      .insert({ marketplace: mappingForm.marketplace.trim(), external_sku: mappingForm.external_sku.trim(), product_name: mappingForm.product_name.trim() })
      .select("id, marketplace, external_sku, product_name").single();
    if (e || !data) { setError(e?.message ?? "Failed to add."); return; }
    setMappings((prev) => [data as ProductMapping, ...prev]);
    setMappingForm({ marketplace: "", external_sku: "", product_name: "" });
  };

  const deleteMapping = async (id: string) => {
    if (!window.confirm("Delete this SKU mapping?")) return;
    const { error: e } = await supabase.from("product_mappings").delete().eq("id", id);
    if (e) { setError(e.message); return; }
    setMappings((prev) => prev.filter((m) => m.id !== id));
  };

  /* ── Filtered orders ── */
  const filteredOrders = useMemo(() => {
    const term = search.trim().toLowerCase();
    return orders.filter((o) => {
      const matchSearch = term
        ? o.customer_name.toLowerCase().includes(term) ||
          o.items.some((i) => i.product_name.toLowerCase().includes(term))
        : true;
      const matchPriority = priorityFilter === "all" || o.priority === priorityFilter;
      const matchStatus   = statusFilter   === "all" || o.status   === statusFilter;
      return matchSearch && matchPriority && matchStatus;
    });
  }, [orders, search, priorityFilter, statusFilter]);

  const totals = useMemo(() => {
    const c: Record<string, number> = {};
    COLUMNS.forEach(({ key }) => { c[key] = filteredOrders.filter((o) => o.status === key).length; });
    return c;
  }, [filteredOrders]);

  const needsReviewCount = orders.filter((o) => o.needs_review).length;
  const emptyState = hasSupabase && !loading && orders.length === 0;

  /* ============================================================
     RENDER
     ============================================================ */

  return (
    <div className="min-h-screen">

      {/* ── Header ── */}
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 bg-white/95 backdrop-blur px-4 py-4 shadow-sm sm:px-6">
        <div>
          <h1 className="text-xl font-semibold sm:text-2xl">DispatchBoard</h1>
          <p className="text-xs text-ink/50 sm:text-sm">Order workflow</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {needsReviewCount > 0 && (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
              {needsReviewCount} needs review
            </span>
          )}
          {queued.length > 0 && (
            <button
              className="rounded-xl border border-ink/10 px-3 py-1.5 text-xs font-semibold hover:bg-paper"
              onClick={async () => {
                const actions = readQueue();
                const remaining: QueueAction[] = [];
                for (const action of actions) {
                  try {
                    if (action.type === "mark_paid") await supabase.from("orders").update({ payment_status: "paid", status: "fulfillment" }).eq("id", action.orderId);
                    if (action.type === "update_status") await supabase.from("orders").update({ status: action.status }).eq("id", action.orderId);
                    if (action.type === "ship_partial") await supabase.rpc("ship_partial", { p_order_id: action.payload.orderId, p_items: action.payload.items, p_awb: action.payload.awb, p_courier: action.payload.courier });
                  } catch { remaining.push(action); }
                }
                writeQueue(remaining); setQueued(remaining);
                if (!remaining.length) reload();
              }}
            >Sync {queued.length}</button>
          )}
          {!tvMode && isAdmin && (
            <>
              <button className="rounded-xl border border-ink/10 px-3 py-1.5 text-xs font-semibold hover:bg-paper" onClick={openCustomers}>Customers</button>
              <button className="rounded-xl border border-ink/10 px-3 py-1.5 text-xs font-semibold hover:bg-paper" onClick={openRoles}>Roles</button>
              <button className="rounded-xl border border-ink/10 px-3 py-1.5 text-xs font-semibold hover:bg-paper" onClick={openMappings}>SKU Map</button>
            </>
          )}
          {!tvMode && (
            <>
              <button className="rounded-xl bg-ink/10 px-4 py-1.5 text-xs font-semibold hover:bg-ink/20" onClick={() => setRawImport({ text: "", parsing: false })}>
                Parse Text
              </button>
              <button className="rounded-xl bg-accent px-4 py-1.5 text-xs font-semibold text-white hover:bg-accent/90" onClick={() => setNewOrder(emptyNewOrder())}>
                + New Order
              </button>
            </>
          )}
        </div>
      </header>

      <main className="px-4 py-4 sm:px-6 sm:py-6">

        {/* ── Filter bar ── */}
        {!tvMode && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-ink/10 bg-white/70 px-4 py-3">
            <input
              className="w-full max-w-[200px] rounded-xl border border-ink/10 px-3 py-2 text-sm"
              placeholder="Search customer / product"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select className="rounded-xl border border-ink/10 px-3 py-2 text-sm" value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value as any)}>
              <option value="all">All priorities</option>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
            </select>
            <select className="rounded-xl border border-ink/10 px-3 py-2 text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}>
              <option value="all">All stages</option>
              <option value="new">New</option>
              <option value="payment">Payment</option>
              <option value="fulfillment">Fulfillment</option>
              <option value="shipped">Shipped</option>
              <option value="done">Done</option>
            </select>
          </div>
        )}

        {tvMode && (
          <div className="mb-4 rounded-2xl border border-ink/10 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-widest text-ink/50">
            TV View — Read Only
          </div>
        )}

        {error && (
          <div className="mb-3 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            <span>{error}</span>
            <button className="text-red-400 hover:text-red-600" onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {loading && <p className="mb-3 text-sm text-ink/50">Loading orders…</p>}

        {emptyState && (
          <div className="rounded-3xl border border-dashed border-ink/20 bg-white/70 p-10 text-center">
            <p className="text-lg font-semibold">No orders yet</p>
            <p className="mt-2 text-sm text-ink/50">Create a manual order or send a WhatsApp message to get started.</p>
            <button className="mt-4 rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white" onClick={() => setNewOrder(emptyNewOrder())}>
              Add first order
            </button>
          </div>
        )}

        {/* ── Kanban board ── */}
        <div ref={columnRef} className="grid gap-4 overflow-x-auto pb-4 board-grid" aria-live="polite">
          {COLUMNS.map((col) => (
            <section
              key={col.key}
              className="flex h-[70vh] min-w-[220px] flex-col rounded-2xl border border-ink/10 bg-white/70 p-3"
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-ink/50">{col.label}</h2>
                <span className="rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-ink/40">{totals[col.key]}</span>
              </div>
              <div className="flex-1 space-y-3 overflow-y-auto pb-2">
                {filteredOrders
                  .filter((o) => o.status === col.key)
                  .map((card) => (
                    <OrderCard
                      key={card.id}
                      card={card}
                      tvMode={tvMode}
                      onMoveBack={() => updateStatus(card, prevStatus(card.status))}
                      onMoveForward={() => updateStatus(card, nextStatus(card.status))}
                      onMarkPaid={() => markPaid(card.id)}
                      onOpenFulfillment={() => openFulfillment(card)}
                      onOpenHistory={() => openHistory(card)}
                      onMarkReviewed={() => markReviewed(card.id)}
                      isAdmin={isAdmin}
                      onDelete={() => deleteOrder(card.id)}
                    />
                  ))}
              </div>
            </section>
          ))}
        </div>
      </main>

      {/* ============================================================
          MODALS
          ============================================================ */}

      {/* ── Fulfillment modal ── */}
      {fulfillment && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 sm:items-center px-4 pb-4 sm:pb-0">
          <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-semibold">{fulfillment.order.customer_name}</h3>
                <p className="text-sm text-ink/50">Fulfillment — select quantities to ship</p>
              </div>
              <button className="rounded-full border border-ink/10 px-3 py-1 text-xs" onClick={() => setFulfillment(null)}>Close</button>
            </div>
            <div className="space-y-3">
              {fulfillment.order.items.map((item) => {
                const val = fulfillment.qtyByProduct[item.product_name] ?? 0;
                return (
                  <div key={item.product_name} className="rounded-2xl border border-ink/10 p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{item.product_name}</p>
                        <p className="text-xs text-ink/50">Ordered: {item.qty_ordered}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button className="h-12 w-12 rounded-full border border-ink/10 text-lg font-semibold hover:bg-paper"
                          onClick={() => setFulfillment((p) => p ? { ...p, qtyByProduct: { ...p.qtyByProduct, [item.product_name]: Math.max(0, val - 1) } } : p)}>−</button>
                        <input
                          className="h-12 w-20 rounded-xl border border-ink/10 text-center text-lg font-semibold"
                          type="number" min={0} max={item.qty_ordered} value={val}
                          onChange={(e) => {
                            const n = Math.min(item.qty_ordered, Math.max(0, Number(e.target.value || 0)));
                            setFulfillment((p) => p ? { ...p, qtyByProduct: { ...p.qtyByProduct, [item.product_name]: n } } : p);
                          }}
                        />
                        <button className="h-12 w-12 rounded-full border border-ink/10 text-lg font-semibold hover:bg-paper"
                          onClick={() => setFulfillment((p) => p ? { ...p, qtyByProduct: { ...p.qtyByProduct, [item.product_name]: Math.min(item.qty_ordered, val + 1) } } : p)}>+</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="rounded-xl border border-ink/10 px-4 py-2 text-xs font-semibold hover:bg-paper"
                onClick={() => setFulfillment((p) => p ? { ...p, qtyByProduct: Object.fromEntries(p.order.items.map((i) => [i.product_name, i.qty_ordered])) } : p)}>
                Ship All</button>
              <button className="rounded-xl border border-ink/10 px-4 py-2 text-xs font-semibold hover:bg-paper"
                onClick={() => setFulfillment((p) => p ? { ...p, qtyByProduct: Object.fromEntries(p.order.items.map((i) => [i.product_name, 0])) } : p)}>
                Clear All</button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-semibold text-ink/70">AWB / Tracking
                <input className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2 text-sm" value={fulfillment.awb}
                  onChange={(e) => setFulfillment((p) => p ? { ...p, awb: e.target.value } : p)} />
              </label>
              <label className="text-sm font-semibold text-ink/70">Courier
                <input className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2 text-sm" value={fulfillment.courier}
                  onChange={(e) => setFulfillment((p) => p ? { ...p, courier: e.target.value } : p)} />
              </label>
            </div>
            <div className="mt-6 flex items-center justify-between gap-3">
              <p className="text-xs text-ink/50">Partial shipments create a sub-order for remaining items.</p>
              <button className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white" onClick={submitFulfillment}>Ship</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Smart Parse modal ── */}
      {rawImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4">
          <div className="w-full max-w-2xl rounded-3xl bg-white shadow-xl">
            <div className="p-6">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-xl font-semibold">Smart Parse</h3>
                  <p className="text-sm text-ink/50">Paste WhatsApp / Email text — AI extracts the order</p>
                </div>
                <button className="rounded-full border border-ink/10 px-3 py-1 text-xs" onClick={() => setRawImport(null)} disabled={rawImport.parsing}>Close</button>
              </div>
              <textarea
                className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-3 text-sm"
                rows={7}
                placeholder={`e.g. "100 TM 803 PROX and 50 TM 801 TA for Shyam Sundar by tomorrow"`}
                value={rawImport.text}
                onChange={(e) => setRawImport((p) => p ? { ...p, text: e.target.value } : p)}
                disabled={rawImport.parsing}
              />
              <div className="mt-4 flex items-center justify-between gap-3">
                <p className="text-xs text-ink/50">Only catalog SKUs are accepted. Unrecognised items will be flagged.</p>
                <button
                  className="rounded-xl bg-accent px-6 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  onClick={handleRawImport}
                  disabled={rawImport.parsing || !rawImport.text.trim()}
                >{rawImport.parsing ? "Extracting…" : "Extract with AI"}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── New Order modal ── */}
      {newOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4">
          <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div><h3 className="text-xl font-semibold">New Order</h3><p className="text-sm text-ink/50">Manual entry</p></div>
              <button className="rounded-full border border-ink/10 px-3 py-1 text-xs" onClick={() => setNewOrder(null)}>Close</button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-semibold text-ink/70">Customer name
                <input className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2 text-sm" value={newOrder.customerName}
                  onChange={(e) => setNewOrder((p) => p ? { ...p, customerName: e.target.value } : p)} />
              </label>
              <label className="text-sm font-semibold text-ink/70">Channel
                <select className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2 text-sm" value={newOrder.channel}
                  onChange={(e) => setNewOrder((p) => p ? { ...p, channel: e.target.value } : p)}>
                  <option value="direct">Direct</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">Email / PO</option>
                  <option value="marketplace">Marketplace</option>
                </select>
              </label>
              <label className="text-sm font-semibold text-ink/70">Priority
                <select className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2 text-sm" value={newOrder.priority}
                  onChange={(e) => setNewOrder((p) => p ? { ...p, priority: e.target.value as Order["priority"] } : p)}>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </label>
              <label className="text-sm font-semibold text-ink/70">Payment
                <select className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2 text-sm" value={newOrder.paymentRequired ? "yes" : "no"}
                  onChange={(e) => setNewOrder((p) => p ? { ...p, paymentRequired: e.target.value === "yes" } : p)}>
                  <option value="yes">Required</option>
                  <option value="no">Not required (regular distributor)</option>
                </select>
              </label>
            </div>
            <div className="mt-6">
              <h4 className="text-sm font-semibold text-ink/70">Line items</h4>
              <div className="mt-3 space-y-2">
                {newOrder.items.map((item, idx) => (
                  <div key={idx} className="grid gap-2 grid-cols-[1fr_100px_70px]">
                    <input className="rounded-xl border border-ink/10 px-3 py-2 text-sm" placeholder="Product name" value={item.product_name}
                      onChange={(e) => setNewOrder((p) => { if (!p) return p; const its = [...p.items]; its[idx] = { ...its[idx], product_name: e.target.value }; return { ...p, items: its }; })} />
                    <input className="rounded-xl border border-ink/10 px-3 py-2 text-sm" type="number" min={1} value={item.qty_ordered}
                      onChange={(e) => setNewOrder((p) => { if (!p) return p; const its = [...p.items]; its[idx] = { ...its[idx], qty_ordered: Number(e.target.value || 1) }; return { ...p, items: its }; })} />
                    <button className="rounded-xl border border-ink/10 px-2 py-2 text-xs font-semibold hover:bg-red-50"
                      onClick={() => setNewOrder((p) => { if (!p) return p; const its = p.items.filter((_, i) => i !== idx); return { ...p, items: its.length ? its : [{ product_name: "", qty_ordered: 1 }] }; })}>Remove</button>
                  </div>
                ))}
              </div>
              <button className="mt-3 rounded-xl border border-ink/10 px-4 py-2 text-xs font-semibold hover:bg-paper"
                onClick={() => setNewOrder((p) => p ? { ...p, items: [...p.items, { product_name: "", qty_ordered: 1 }] } : p)}>+ Add item</button>
            </div>
            <label className="mt-5 block text-sm font-semibold text-ink/70">Notes
              <textarea className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2 text-sm" rows={3} value={newOrder.notes}
                onChange={(e) => setNewOrder((p) => p ? { ...p, notes: e.target.value } : p)} />
            </label>
            <div className="mt-6 flex items-center justify-between gap-3">
              <p className="text-xs text-ink/50">Order appears immediately on the board.</p>
              <button className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white" onClick={submitNewOrder}>Create order</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Customers panel ── */}
      {showCustomers && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div><h3 className="text-xl font-semibold">Customers</h3><p className="text-sm text-ink/50">Payment settings</p></div>
              <button className="rounded-full border border-ink/10 px-3 py-1 text-xs" onClick={() => setShowCustomers(false)}>Close</button>
            </div>
            <div className="space-y-3">
              {customers.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink/10 p-4">
                  <div>
                    <p className="text-sm font-semibold">{c.name}</p>
                    <p className="text-xs text-ink/50">{c.payment_required ? "Payment required" : "Credit — no payment needed"}</p>
                  </div>
                  <button className="rounded-xl border border-ink/10 px-3 py-2 text-xs font-semibold hover:bg-paper" onClick={() => toggleCustomerPayment(c)}>
                    {c.payment_required ? "Promote to regular" : "Require payment"}
                  </button>
                </div>
              ))}
              {!customers.length && <p className="text-sm text-ink/50">No customers yet.</p>}
            </div>
          </div>
        </div>
      )}

      {/* ── Roles panel ── */}
      {showRoles && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div><h3 className="text-xl font-semibold">Roles</h3><p className="text-sm text-ink/50">Admin vs staff</p></div>
              <button className="rounded-full border border-ink/10 px-3 py-1 text-xs" onClick={() => setShowRoles(false)}>Close</button>
            </div>
            <div className="space-y-3">
              {profiles.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink/10 p-4">
                  <div><p className="text-xs text-ink/50">User ID</p><p className="text-sm font-mono">{p.id}</p></div>
                  <button className="rounded-xl border border-ink/10 px-3 py-2 text-xs font-semibold hover:bg-paper" onClick={() => toggleRole(p)}>
                    {p.role === "admin" ? "Set staff" : "Set admin"}
                  </button>
                </div>
              ))}
              {!profiles.length && <p className="text-sm text-ink/50">No profiles yet.</p>}
            </div>
          </div>
        </div>
      )}

      {/* ── SKU Mappings panel ── */}
      {showMappings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div><h3 className="text-xl font-semibold">SKU Mapping</h3><p className="text-sm text-ink/50">Marketplace SKU → internal product</p></div>
              <button className="rounded-full border border-ink/10 px-3 py-1 text-xs" onClick={() => setShowMappings(false)}>Close</button>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <input className="rounded-xl border border-ink/10 px-3 py-2 text-sm" placeholder="Marketplace" value={mappingForm.marketplace}
                onChange={(e) => setMappingForm((p) => ({ ...p, marketplace: e.target.value }))} />
              <input className="rounded-xl border border-ink/10 px-3 py-2 text-sm" placeholder="External SKU" value={mappingForm.external_sku}
                onChange={(e) => setMappingForm((p) => ({ ...p, external_sku: e.target.value }))} />
              <input className="rounded-xl border border-ink/10 px-3 py-2 text-sm" placeholder="Product name" value={mappingForm.product_name}
                onChange={(e) => setMappingForm((p) => ({ ...p, product_name: e.target.value }))} />
            </div>
            <button className="mt-3 rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white" onClick={addMapping}>Add mapping</button>
            <div className="mt-5 space-y-3">
              {mappings.map((m) => (
                <div key={m.id} className="rounded-2xl border border-ink/10 p-4 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-semibold">{m.marketplace}</p>
                    {isAdmin && (
                      <button className="rounded-full border border-ink/10 px-2 py-0.5 text-[10px] text-ink/40 hover:text-red-500" onClick={() => deleteMapping(m.id)}>✕</button>
                    )}
                  </div>
                  <p className="text-xs text-ink/50">SKU: {m.external_sku}</p>
                  <p className="text-xs text-ink/50">Product: {m.product_name}</p>
                </div>
              ))}
              {!mappings.length && <p className="text-sm text-ink/50">No mappings yet.</p>}
            </div>
          </div>
        </div>
      )}

      {/* ── Shipment history modal ── */}
      {historyOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div><h3 className="text-xl font-semibold">Shipments</h3><p className="text-sm text-ink/50">{historyOrder.customer_name}</p></div>
              <button className="rounded-full border border-ink/10 px-3 py-1 text-xs" onClick={() => { setHistoryOrder(null); setShipments(null); }}>Close</button>
            </div>
            <div className="space-y-3">
              {(shipments ?? []).map((s) => (
                <div key={s.id} className="rounded-2xl border border-ink/10 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold">AWB: {s.awb || "—"}</p>
                    {isAdmin && (
                      <button className="rounded-full border border-ink/10 px-2 py-0.5 text-[10px] text-ink/40 hover:text-red-500" onClick={() => deleteShipment(s.id)}>✕</button>
                    )}
                    <p className="text-xs text-ink/50">{new Date(s.shipped_at).toLocaleString()}</p>
                  </div>
                  <p className="text-xs text-ink/50">Courier: {s.courier || "—"}</p>
                  <div className="mt-2 space-y-1">
                    {s.shipment_items.map((item, i) => (
                      <div key={i} className="flex items-center justify-between text-sm">
                        <span>{item.product_name}</span>
                        <span className="font-semibold">×{item.qty_shipped}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {shipments?.length === 0 && <p className="text-sm text-ink/50">No shipments yet.</p>}
            </div>
          </div>
        </div>
      )}

      <footer className="px-6 pb-6 pt-2 text-center text-xs text-ink/30">
        © 2026 DispatchBoard
      </footer>
    </div>
  );
}
