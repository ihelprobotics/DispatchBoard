
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDrag } from "@use-gesture/react";
import { supabase } from "../lib/supabaseClient";

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

const columns = [
  { key: "new", label: "New" },
  { key: "payment", label: "Payment" },
  { key: "fulfillment", label: "Fulfillment" },
  { key: "shipped", label: "Shipped" },
  { key: "done", label: "Done" }
] as const;

const sampleCards: Order[] = [
  {
    id: "1",
    customer_name: "Ravi Electronics, Mumbai",
    priority: "urgent",
    status: "payment",
    payment_status: "pending",
    needs_review: false,
    items: [
      { product_name: "Product A", qty_ordered: 50 },
      { product_name: "Product B", qty_ordered: 30 }
    ]
  },
  {
    id: "2",
    customer_name: "Suresh Traders, Pune",
    priority: "normal",
    status: "fulfillment",
    payment_status: "paid",
    needs_review: false,
    items: [{ product_name: "Product C", qty_ordered: 20 }]
  }
];

const statusOrder = ["new", "payment", "fulfillment", "shipped", "done"] as const;

const useOrders = (tvMode: boolean) => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const hasSupabase = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  const loadOrders = async () => {
    if (!hasSupabase) {
      setOrders(sampleCards);
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

      if (error) {
        setOrders([]);
        setLoading(false);
        return;
      }

      const mapped = (data ?? []).map((order: any) => ({
        id: order.id,
        customer_name: order.customers?.name ?? "Unknown",
        priority: order.priority,
        status: order.status,
        payment_status: order.payment_status,
        needs_review: order.needs_review ?? false,
        suffix: order.suffix ?? null,
        notes: order.notes ?? null,
        items: order.order_items ?? []
      })) as Order[];
      setOrders(mapped);
    } catch {
      setOrders([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrders();
  }, []);

  useEffect(() => {
    if (!hasSupabase) return;
    const channel = supabase.channel("orders");
    channel
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => {
        loadOrders();
        if (tvMode) {
          const ctx = new AudioContext();
          const oscillator = ctx.createOscillator();
          oscillator.frequency.value = 880;
          oscillator.connect(ctx.destination);
          oscillator.start();
          oscillator.stop(ctx.currentTime + 0.08);
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "order_items" }, () => {
        loadOrders();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [hasSupabase, tvMode]);

  return { orders, loading, reload: loadOrders, hasSupabase };
};

const formatPayment = (status: Order["payment_status"]) =>
  status === "paid" ? "Credit - N/A" : "Payment Pending";

const getPriorityColor = (value: Order["priority"]) =>
  value === "urgent" ? "bg-accent text-white" : value === "high" ? "bg-steel text-white" : "bg-mint text-ink";

const canMoveForward = (order: Order) =>
  order.status !== "done" && !(order.status === "payment" && order.payment_status !== "paid");

const nextStatus = (status: Order["status"]) => {
  const idx = statusOrder.indexOf(status);
  return statusOrder[Math.min(idx + 1, statusOrder.length - 1)];
};

const prevStatus = (status: Order["status"]) => {
  const idx = statusOrder.indexOf(status);
  return statusOrder[Math.max(idx - 1, 0)];
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

const emptyNewOrder = (): NewOrderState => ({
  customerName: "",
  channel: "direct",
  priority: "normal",
  paymentRequired: true,
  items: [{ product_name: "", qty_ordered: 1 }],
  notes: ""
});

const queueKey = "dispatchboard_queue";

const readQueue = (): QueueAction[] => {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(queueKey);
  return raw ? (JSON.parse(raw) as QueueAction[]) : [];
};

const writeQueue = (actions: QueueAction[]) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(queueKey, JSON.stringify(actions));
};

function OrderCard({
  card,
  tvMode,
  onMoveBack,
  onMoveForward,
  onMarkPaid,
  onOpenFulfillment,
  onOpenHistory,
  onMarkReviewed,
  isAdmin,
  onDelete
}: {
  card: Order;
  tvMode: boolean;
  onMoveBack: () => void;
  onMoveForward: () => void;
  onMarkPaid: () => void;
  onOpenFulfillment: () => void;
  onOpenHistory: () => void;
  onMarkReviewed: () => void;
  isAdmin: boolean;
  onDelete: () => void;
}) {
  const bindSwipe = useDrag(
    ({ last, movement: [mx], swipe: [sx] }) => {
      if (!last || tvMode) return;
      if (sx === 1 || mx > 80) onMoveBack();
      if (sx === -1 || mx < -80) onMoveForward();
    },
    { filterTaps: true }
  );

  return (
    <div {...bindSwipe()} className="rounded-2xl border border-ink/10 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink/60">
            {card.suffix ? `${card.customer_name} - ${card.suffix}` : card.customer_name}
          </p>
          <p className="text-xs text-ink/50">{formatPayment(card.payment_status)}</p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${getPriorityColor(
            card.priority
          )}`}
        >
          {card.priority}
        </span>
      </div>
      {isAdmin ? (
        <div className="mt-2 flex justify-end">
          <button
            className="rounded-full border border-ink/10 px-2 py-1 text-[10px] font-semibold text-ink/60"
            onClick={onDelete}
            disabled={tvMode}
            title="Delete order"
          >
            ✕
          </button>
        </div>
      ) : null}
      <div className="mt-3 space-y-1 text-sm">
        {card.items.map((item) => (
          <div key={item.product_name} className="flex items-center justify-between">
            <span>{item.product_name}</span>
            <span className="font-semibold">x{item.qty_ordered}</span>
          </div>
        ))}
      </div>
      {card.notes ? <p className="mt-2 text-xs text-ink/50">Notes: {card.notes}</p> : null}
      {card.needs_review ? (
        <div className="mt-3 rounded-xl bg-accent/10 px-3 py-2 text-xs font-semibold text-accent">
          Needs review
        </div>
      ) : null}
      <div className="mt-4 flex flex-col gap-2">
        {card.needs_review ? (
          <button
            className="w-full rounded-xl border border-ink/10 px-3 py-2 text-xs font-semibold"
            onClick={onMarkReviewed}
            disabled={tvMode}
          >
            Mark reviewed
          </button>
        ) : null}
        {card.status === "payment" && card.payment_status !== "paid" ? (
          <button
            className="w-full rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white"
            onClick={onMarkPaid}
            disabled={tvMode}
          >
            Mark as Paid
          </button>
        ) : null}
        {card.status === "fulfillment" ? (
          <button
            className="w-full rounded-xl border border-ink/10 bg-paper px-3 py-2 text-xs font-semibold"
            onClick={onOpenFulfillment}
            disabled={tvMode}
          >
            Open Fulfillment
          </button>
        ) : null}
        <button className="w-full rounded-xl border border-ink/10 px-3 py-2 text-xs font-semibold" onClick={onOpenHistory}>
          View shipments
        </button>
        <div className="flex gap-2 text-xs">
          <button
            className="w-full rounded-xl border border-ink/10 px-2 py-2 font-semibold"
            onClick={onMoveBack}
            disabled={card.status === "new" || tvMode}
          >
            Move Back
          </button>
          <button
            className="w-full rounded-xl border border-ink/10 px-2 py-2 font-semibold"
            onClick={onMoveForward}
            disabled={!canMoveForward(card) || tvMode}
          >
            Move Forward
          </button>
        </div>
      </div>
    </div>
  );
}

export function Board({ tvMode }: { tvMode: boolean }) {
  const { orders, loading, reload, hasSupabase } = useOrders(tvMode);
  const [error, setError] = useState<string | null>(null);
  const [fulfillment, setFulfillment] = useState<FulfillmentState | null>(null);
  const [newOrder, setNewOrder] = useState<NewOrderState | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [showCustomers, setShowCustomers] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [showRoles, setShowRoles] = useState(false);
  const [shipments, setShipments] = useState<Shipment[] | null>(null);
  const [historyOrder, setHistoryOrder] = useState<Order | null>(null);
  const [queued, setQueued] = useState<QueueAction[]>([]);
  const [search, setSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<"all" | Order["priority"]>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | Order["status"]>("all");
  const [mappings, setMappings] = useState<ProductMapping[]>([]);
  const [showMappings, setShowMappings] = useState(false);
  const [mappingForm, setMappingForm] = useState({ marketplace: "", external_sku: "", product_name: "" });
  const [isAdmin, setIsAdmin] = useState(true);
  const [rawImport, setRawImport] = useState<{ text: string; parsing: boolean } | null>(null);
  const columnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const initRole = async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const userId = data.session?.user?.id;
        if (!userId) {
          setIsAdmin(true);
          return;
        }
        const { data: profile } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
        setIsAdmin(profile?.role === "admin");
      } catch {
        setIsAdmin(true);
      }
    };
    initRole();
  }, []);

  useEffect(() => {
    if (!columnRef.current) return;
    const container = columnRef.current;
    let direction = 1;
    const interval = setInterval(() => {
      const maxScroll = container.scrollWidth - container.clientWidth;
      if (maxScroll <= 0) return;
      const next = container.scrollLeft + direction * container.clientWidth;
      if (next >= maxScroll) direction = -1;
      if (next <= 0) direction = 1;
      container.scrollTo({ left: Math.max(0, Math.min(maxScroll, next)), behavior: "smooth" });
    }, 9000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setQueued(readQueue());
  }, []);

  const enqueue = (action: QueueAction) => {
    const updated = [...readQueue(), action];
    writeQueue(updated);
    setQueued(updated);
  };

  const flushQueue = async () => {
    const actions = readQueue();
    if (!actions.length) return;
    const remaining: QueueAction[] = [];

    for (const action of actions) {
      try {
        if (action.type === "mark_paid") {
          const { error: updateError } = await supabase
            .from("orders")
            .update({ payment_status: "paid", status: "fulfillment" })
            .eq("id", action.orderId);
          if (updateError) throw updateError;
        }
        if (action.type === "update_status") {
          const { error: updateError } = await supabase
            .from("orders")
            .update({ status: action.status })
            .eq("id", action.orderId);
          if (updateError) throw updateError;
        }
        if (action.type === "ship_partial") {
          const { error: shipError } = await supabase.rpc("ship_partial", {
            p_order_id: action.payload.orderId,
            p_items: action.payload.items,
            p_awb: action.payload.awb,
            p_courier: action.payload.courier
          });
          if (shipError) throw shipError;
        }
      } catch {
        remaining.push(action);
      }
    }

    writeQueue(remaining);
    setQueued(remaining);
    if (remaining.length === 0) reload();
  };

  useEffect(() => {
    const handleOnline = () => flushQueue();
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  const markPaid = async (orderId: string) => {
    setError(null);
    const { error: updateError } = await supabase
      .from("orders")
      .update({ payment_status: "paid", status: "fulfillment" })
      .eq("id", orderId);
    if (updateError) {
      enqueue({ type: "mark_paid", orderId });
      setError("Offline - queued payment update.");
      return;
    }
    reload();
  };

  const updateStatus = async (order: Order, target: Order["status"]) => {
    if (order.status === "payment" && order.payment_status !== "paid") {
      setError("Payment required before fulfillment.");
      return;
    }
    setError(null);
    const { error: updateError } = await supabase.from("orders").update({ status: target }).eq("id", order.id);
    if (updateError) {
      enqueue({ type: "update_status", orderId: order.id, status: target });
      setError("Offline - queued status update.");
      return;
    }
    reload();
  };

  const openFulfillment = (order: Order) => {
    const qtyByProduct: Record<string, number> = {};
    order.items.forEach((item) => {
      qtyByProduct[item.product_name] = item.qty_ordered;
    });
    setFulfillment({ order, qtyByProduct, awb: "", courier: "" });
  };

  const openHistory = async (order: Order) => {
    setHistoryOrder(order);
    const { data, error } = await supabase
      .from("shipments")
      .select("id, awb, courier, shipped_at, shipment_items(product_name, qty_shipped)")
      .eq("order_id", order.id)
      .order("shipped_at", { ascending: false });

    if (error) {
      setError("Failed to load shipment history.");
      setShipments([]);
      return;
    }

    setShipments((data ?? []) as Shipment[]);
  };

  const deleteShipment = async (shipmentId: string) => {
    const confirmDelete = window.confirm("Delete this shipment record?");
    if (!confirmDelete) return;
    const { error: deleteError } = await supabase.from("shipments").delete().eq("id", shipmentId);
    if (deleteError) {
      setError(deleteError.message || "Failed to delete shipment.");
      return;
    }
    setShipments((prev) => (prev ? prev.filter((item) => item.id !== shipmentId) : prev));
  };

  const deleteOrder = async (orderId: string) => {
    const confirmDelete = window.confirm("Delete this order? This cannot be undone.");
    if (!confirmDelete) return;
    const { error: deleteError } = await supabase.from("orders").delete().eq("id", orderId);
    if (deleteError) {
      setError(deleteError.message || "Failed to delete order.");
      return;
    }
    reload();
  };

  const submitFulfillment = async () => {
    if (!fulfillment) return;
    const items = Object.entries(fulfillment.qtyByProduct)
      .filter(([, qty]) => qty > 0)
      .map(([product_name, qty_to_ship]) => ({ product_name, qty_to_ship }));
    if (!items.length) {
      setError("Select at least one item to ship.");
      return;
    }
    setError(null);
    const { error: shipError } = await supabase.rpc("ship_partial", {
      p_order_id: fulfillment.order.id,
      p_items: items,
      p_awb: fulfillment.awb || null,
      p_courier: fulfillment.courier || null
    });
    if (shipError) {
      enqueue({
        type: "ship_partial",
        payload: { orderId: fulfillment.order.id, items, awb: fulfillment.awb || null, courier: fulfillment.courier || null }
      });
      setError("Offline - queued fulfillment update.");
      return;
    }
    setFulfillment(null);
    reload();
  };

  const openNewOrder = () => {
    setNewOrder(emptyNewOrder());
  };

  const openRawImport = () => {
    setRawImport({ text: "", parsing: false });
  };

  const handleRawImport = async () => {
    if (!rawImport || !rawImport.text.trim()) return;
    setRawImport({ ...rawImport, parsing: true });
    try {
      const url = process.env.NEXT_PUBLIC_INTAKE_API_URL ?? "http://localhost:4000";
      const res = await fetch(`${url}/api/parse-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: rawImport.text })
      });
      const data = await res.json();
      setRawImport(null);
      
      let channel = data.channel || "direct";
      if (!["direct", "whatsapp", "email", "marketplace", "amazon", "flipkart"].includes(channel)) channel = "direct";
      if (channel === "amazon" || channel === "flipkart") channel = "marketplace";
      
      const items = data.items?.length
        ? data.items.map((i: any) => ({
            product_name: i.product || i.product_name || "Unknown Product",
            qty_ordered: Number(i.qty || i.qty_ordered || 1)
          }))
        : [{ product_name: "", qty_ordered: 1 }];

      setNewOrder({
        customerName: data.customer_name || "Unknown",
        channel,
        priority: data.priority || "normal",
        paymentRequired: true,
        items,
        notes: data.notes || ""
      });
    } catch {
      setError("Failed to parse message text.");
      setRawImport({ ...rawImport, parsing: false });
    }
  };

  const updateNewItem = (index: number, key: "product_name" | "qty_ordered", value: string | number) => {
    setNewOrder((prev) => {
      if (!prev) return prev;
      const items = [...prev.items];
      items[index] = { ...items[index], [key]: value };
      return { ...prev, items };
    });
  };

  const addNewItem = () => {
    setNewOrder((prev) => (prev ? { ...prev, items: [...prev.items, { product_name: "", qty_ordered: 1 }] } : prev));
  };

  const removeNewItem = (index: number) => {
    setNewOrder((prev) => {
      if (!prev) return prev;
      const items = prev.items.filter((_, i) => i !== index);
      return { ...prev, items: items.length ? items : [{ product_name: "", qty_ordered: 1 }] };
    });
  };

  const submitNewOrder = async () => {
    if (!newOrder) return;
    if (!newOrder.customerName.trim()) {
      setError("Customer name is required.");
      return;
    }
    const items = newOrder.items.filter((item) => item.product_name.trim() && item.qty_ordered > 0);
    if (!items.length) {
      setError("Add at least one line item.");
      return;
    }

    setError(null);
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("id, payment_required")
      .eq("name", newOrder.customerName.trim())
      .maybeSingle();

    if (customerError) {
      setError(customerError.message || "Failed to look up customer.");
      return;
    }

    let customerId = customer?.id;
    let paymentRequired = customer?.payment_required ?? newOrder.paymentRequired;

    if (!customerId) {
      const { data: created, error: createError } = await supabase
        .from("customers")
        .insert({
          name: newOrder.customerName.trim(),
          type: newOrder.paymentRequired ? "non_regular" : "regular",
          payment_required: newOrder.paymentRequired
        })
        .select("id, payment_required")
        .single();

      if (createError || !created) {
        setError(createError?.message || "Failed to create customer.");
        return;
      }
      customerId = created.id;
      paymentRequired = created.payment_required;
    }

    const status = paymentRequired ? "payment" : "fulfillment";
    const paymentStatus = paymentRequired ? "pending" : "paid";

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert({
        customer_id: customerId,
        channel: newOrder.channel,
        priority: newOrder.priority,
        status,
        payment_status: paymentStatus,
        notes: newOrder.notes.trim() || null
      })
      .select("id")
      .single();

    if (orderError || !order) {
      setError(orderError?.message || "Failed to create order.");
      return;
    }

    const itemsPayload = items.map((item) => ({
      order_id: order.id,
      product_name: item.product_name.trim(),
      qty_ordered: Number(item.qty_ordered)
    }));

    const { error: itemsError } = await supabase.from("order_items").insert(itemsPayload);
    if (itemsError) {
      setError(itemsError.message || "Failed to add order items.");
      return;
    }

    setNewOrder(null);
    reload();
  };

  const openCustomers = async () => {
    setShowCustomers(true);
    const { data, error } = await supabase
      .from("customers")
      .select("id, name, payment_required, type")
      .order("name", { ascending: true });
    if (error) {
      setError("Failed to load customers.");
      setCustomers([]);
      return;
    }
    setCustomers((data ?? []) as Customer[]);
  };

  const openRoles = async () => {
    setShowRoles(true);
    setError(null);
    const { data, error } = await supabase.from("profiles").select("id, role").order("created_at", { ascending: false });
    if (error) {
      setError(error.message || "Failed to load roles.");
      setProfiles([]);
      return;
    }
    setProfiles((data ?? []) as Profile[]);
  };

  const toggleRole = async (profile: Profile) => {
    const nextRole = profile.role === "admin" ? "staff" : "admin";
    const { error } = await supabase.from("profiles").update({ role: nextRole }).eq("id", profile.id);
    if (error) {
      setError(error.message || "Failed to update role.");
      return;
    }
    setProfiles((prev) => prev.map((item) => (item.id === profile.id ? { ...item, role: nextRole } : item)));
  };

  const openMappings = async () => {
    setShowMappings(true);
    const { data, error } = await supabase
      .from("product_mappings")
      .select("id, marketplace, external_sku, product_name")
      .order("marketplace", { ascending: true });
    if (error) {
      setError("Failed to load SKU mappings.");
      setMappings([]);
      return;
    }
    setMappings((data ?? []) as ProductMapping[]);
  };

  const deleteMapping = async (mappingId: string) => {
    const confirmDelete = window.confirm("Delete this SKU mapping?");
    if (!confirmDelete) return;
    const { error: deleteError } = await supabase.from("product_mappings").delete().eq("id", mappingId);
    if (deleteError) {
      setError(deleteError.message || "Failed to delete SKU mapping.");
      return;
    }
    setMappings((prev) => prev.filter((item) => item.id !== mappingId));
  };

  const addMapping = async () => {
    if (!mappingForm.marketplace.trim() || !mappingForm.external_sku.trim() || !mappingForm.product_name.trim()) {
      setError("All SKU mapping fields are required.");
      return;
    }
    const { data, error } = await supabase
      .from("product_mappings")
      .insert({
        marketplace: mappingForm.marketplace.trim(),
        external_sku: mappingForm.external_sku.trim(),
        product_name: mappingForm.product_name.trim()
      })
      .select("id, marketplace, external_sku, product_name")
      .single();
    if (error || !data) {
      setError(error?.message || "Failed to add SKU mapping.");
      return;
    }
    setMappings((prev) => [data as ProductMapping, ...prev]);
    setMappingForm({ marketplace: "", external_sku: "", product_name: "" });
  };

  const toggleCustomerPayment = async (customer: Customer) => {
    const payment_required = !customer.payment_required;
    const type = payment_required ? "non_regular" : "regular";
    const { error: updateError } = await supabase
      .from("customers")
      .update({ payment_required, type })
      .eq("id", customer.id);
    if (updateError) {
      setError("Failed to update customer.");
      return;
    }
    setCustomers((prev) => prev.map((item) => (item.id === customer.id ? { ...item, payment_required, type } : item)));
  };

  const markReviewed = async (orderId: string) => {
    const { error: updateError } = await supabase.from("orders").update({ needs_review: false }).eq("id", orderId);
    if (updateError) {
      setError("Failed to update review status.");
      return;
    }
    reload();
  };

  const filteredOrders = useMemo(() => {
    const term = search.trim().toLowerCase();
    return orders.filter((order) => {
      const matchesSearch = term
        ? order.customer_name.toLowerCase().includes(term) ||
          order.items.some((item) => item.product_name.toLowerCase().includes(term))
        : true;
      const matchesPriority = priorityFilter === "all" ? true : order.priority === priorityFilter;
      const matchesStatus = statusFilter === "all" ? true : order.status === statusFilter;
      return matchesSearch && matchesPriority && matchesStatus;
    });
  }, [orders, search, priorityFilter, statusFilter]);

  const totals = useMemo(() => {
    const counts: Record<string, number> = {};
    columns.forEach((column) => {
      counts[column.key] = filteredOrders.filter((card) => card.status === column.key).length;
    });
    return counts;
  }, [filteredOrders]);

  const emptyState = hasSupabase && !loading && orders.length === 0;

  const needsReviewCount = orders.filter((order) => order.needs_review).length;

  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center justify-between gap-4 bg-white px-6 py-5 shadow-sm">
        <div>
          <h1 className="text-2xl font-semibold">DispatchBoard</h1>
          <p className="text-sm text-ink/60">Order workflow for dispatch and fulfillment</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {needsReviewCount > 0 ? (
            <span className="rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
              {needsReviewCount} needs review
            </span>
          ) : null}
          {queued.length ? (
            <button
              className="rounded-xl border border-ink/10 px-3 py-2 text-xs font-semibold"
              onClick={flushQueue}
            >
              Sync {queued.length}
            </button>
          ) : null}
          <button
            className="rounded-xl border border-ink/10 px-3 py-2 text-xs font-semibold"
            onClick={openCustomers}
            disabled={tvMode || !isAdmin}
          >
            Customers
          </button>
          <button
            className="rounded-xl border border-ink/10 px-3 py-2 text-xs font-semibold"
            onClick={openRoles}
            disabled={tvMode || !isAdmin}
          >
            Roles
          </button>
          <button
            className="rounded-xl border border-ink/10 px-3 py-2 text-xs font-semibold"
            onClick={openMappings}
            disabled={tvMode || !isAdmin}
          >
            SKU Map
          </button>
          <button
            className="rounded-xl bg-ink/10 px-4 py-2 text-sm font-semibold text-ink"
            onClick={openRawImport}
            disabled={tvMode}
          >
            Parse Text
          </button>
          <button
            className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white"
            onClick={openNewOrder}
            disabled={tvMode}
          >
            + New Order
          </button>
        </div>
      </header>

      <main className="px-6 py-6">
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-ink/10 bg-white/70 px-4 py-3">
          <input
            className="w-full max-w-xs rounded-xl border border-ink/10 px-3 py-2 text-sm"
            placeholder="Search customer or product"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            className="rounded-xl border border-ink/10 px-3 py-2 text-sm"
            value={priorityFilter}
            onChange={(event) => setPriorityFilter(event.target.value as typeof priorityFilter)}
          >
            <option value="all">All priorities</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
          </select>
          <select
            className="rounded-xl border border-ink/10 px-3 py-2 text-sm"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          >
            <option value="all">All stages</option>
            <option value="new">New</option>
            <option value="payment">Payment</option>
            <option value="fulfillment">Fulfillment</option>
            <option value="shipped">Shipped</option>
            <option value="done">Done</option>
          </select>
        </div>
        {tvMode ? (
          <div className="mb-4 rounded-2xl border border-ink/10 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink/60">
            TV View - read only
          </div>
        ) : null}
        {error ? <p className="mb-3 text-sm text-accent">{error}</p> : null}
        {loading ? <p className="mb-3 text-sm text-ink/60">Loading orders...</p> : null}
        {emptyState ? (
          <div className="rounded-3xl border border-dashed border-ink/20 bg-white/70 p-8 text-center">
            <h2 className="text-lg font-semibold">No orders yet</h2>
            <p className="mt-2 text-sm text-ink/60">Create a manual order to get started.</p>
            <button
              className="mt-4 rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white"
              onClick={openNewOrder}
            >
              Add first order
            </button>
          </div>
        ) : null}
        <div ref={columnRef} className="grid gap-4 overflow-x-auto pb-4 board-grid" aria-live="polite">
          {columns.map((column) => (
            <section
              key={column.key}
              className="flex h-[70vh] min-w-[220px] flex-col rounded-2xl border border-ink/10 bg-white/70 p-3"
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/60">{column.label}</h2>
                <span className="rounded-full bg-paper px-2 py-1 text-xs font-semibold text-ink/50">
                  {totals[column.key]}
                </span>
              </div>
              <div className="flex-1 space-y-3 overflow-y-auto pb-2">
                {filteredOrders
                  .filter((card) => card.status === column.key)
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

      {fulfillment ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-semibold">{fulfillment.order.customer_name}</h3>
                <p className="text-sm text-ink/50">Fulfillment</p>
              </div>
              <button className="rounded-full border border-ink/10 px-3 py-1 text-xs" onClick={() => setFulfillment(null)}>
                Close
              </button>
            </div>

            <div className="space-y-3">
              {fulfillment.order.items.map((item) => {
                const value = fulfillment.qtyByProduct[item.product_name] ?? 0;
                return (
                  <div key={item.product_name} className="rounded-2xl border border-ink/10 p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold">{item.product_name}</p>
                        <p className="text-xs text-ink/50">Ordered {item.qty_ordered}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          className="h-12 w-12 rounded-full border border-ink/10 text-lg font-semibold"
                          onClick={() =>
                            setFulfillment((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    qtyByProduct: {
                                      ...prev.qtyByProduct,
                                      [item.product_name]: Math.max(0, value - 1)
                                    }
                                  }
                                : prev
                            )
                          }
                        >
                          -
                        </button>
                        <input
                          className="h-12 w-20 rounded-xl border border-ink/10 text-center text-lg font-semibold"
                          value={value}
                          onChange={(event) => {
                            const next = Math.min(item.qty_ordered, Number(event.target.value || 0));
                            setFulfillment((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    qtyByProduct: { ...prev.qtyByProduct, [item.product_name]: next }
                                  }
                                : prev
                            );
                          }}
                        />
                        <button
                          className="h-12 w-12 rounded-full border border-ink/10 text-lg font-semibold"
                          onClick={() =>
                            setFulfillment((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    qtyByProduct: {
                                      ...prev.qtyByProduct,
                                      [item.product_name]: Math.min(item.qty_ordered, value + 1)
                                    }
                                  }
                                : prev
                            )
                          }
                        >
                          +
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex flex-wrap gap-3">
              <button
                className="rounded-xl border border-ink/10 px-4 py-2 text-xs font-semibold"
                onClick={() =>
                  setFulfillment((prev) =>
                    prev
                      ? {
                          ...prev,
                          qtyByProduct: Object.fromEntries(
                            prev.order.items.map((item) => [item.product_name, item.qty_ordered])
                          )
                        }
                      : prev
                  )
                }
              >
                Ship All
              </button>
              <button
                className="rounded-xl border border-ink/10 px-4 py-2 text-xs font-semibold"
                onClick={() =>
                  setFulfillment((prev) =>
                    prev
                      ? {
                          ...prev,
                          qtyByProduct: Object.fromEntries(prev.order.items.map((item) => [item.product_name, 0]))
                        }
                      : prev
                  )
                }
              >
                Clear All
              </button>
            </div>

            <div className="mt-6 grid gap-3 md:grid-cols-2">
              <label className="text-sm font-semibold text-ink/70">
                AWB / Tracking
                <input
                  className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2"
                  value={fulfillment.awb}
                  onChange={(event) =>
                    setFulfillment((prev) => (prev ? { ...prev, awb: event.target.value } : prev))
                  }
                />
              </label>
              <label className="text-sm font-semibold text-ink/70">
                Courier
                <input
                  className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2"
                  value={fulfillment.courier}
                  onChange={(event) =>
                    setFulfillment((prev) => (prev ? { ...prev, courier: event.target.value } : prev))
                  }
                />
              </label>
            </div>

            <div className="mt-6 flex items-center justify-between gap-3">
              <p className="text-xs text-ink/50">
                Partial shipments will automatically create a sub-order for remaining items.
              </p>
              <button
                className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white"
                onClick={submitFulfillment}
              >
                Ship Partial
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {rawImport ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4">
          <div className="w-full max-w-2xl overflow-hidden rounded-3xl bg-white shadow-xl">
            <div className="p-6">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-xl font-semibold">Smart Parse</h3>
                  <p className="text-sm text-ink/50">Paste raw WhatsApp or Email body</p>
                </div>
                <button
                  className="rounded-full border border-ink/10 px-3 py-1 text-xs"
                  onClick={() => setRawImport(null)}
                  disabled={rawImport.parsing}
                >
                  Close
                </button>
              </div>

              <textarea
                className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-3 text-sm"
                rows={8}
                placeholder="e.g. Hi, please deliver 5 boxes of Product A and 2 boxes of Product B. Urgent."
                value={rawImport.text}
                onChange={(e) => setRawImport((prev) => (prev ? { ...prev, text: e.target.value } : prev))}
                disabled={rawImport.parsing}
              />

              <div className="mt-6 flex items-center justify-between gap-3">
                <p className="text-xs text-ink/50">AI will safely extract line items and auto-fill the order form.</p>
                <button
                  className="rounded-xl bg-ink px-6 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  onClick={handleRawImport}
                  disabled={rawImport.parsing || !rawImport.text.trim()}
                >
                  {rawImport.parsing ? "Extracting..." : "Extract with AI"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {newOrder ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-semibold">New Order</h3>
                <p className="text-sm text-ink/50">Manual entry</p>
              </div>
              <button className="rounded-full border border-ink/10 px-3 py-1 text-xs" onClick={() => setNewOrder(null)}>
                Close
              </button>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm font-semibold text-ink/70">
                Customer name
                <input
                  className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2"
                  value={newOrder.customerName}
                  onChange={(event) => setNewOrder((prev) => (prev ? { ...prev, customerName: event.target.value } : prev))}
                />
              </label>
              <label className="text-sm font-semibold text-ink/70">
                Channel
                <select
                  className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2"
                  value={newOrder.channel}
                  onChange={(event) => setNewOrder((prev) => (prev ? { ...prev, channel: event.target.value } : prev))}
                >
                  <option value="direct">Direct</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">Email/PO</option>
                  <option value="marketplace">Marketplace</option>
                </select>
              </label>
              <label className="text-sm font-semibold text-ink/70">
                Priority
                <select
                  className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2"
                  value={newOrder.priority}
                  onChange={(event) =>
                    setNewOrder((prev) => (prev ? { ...prev, priority: event.target.value as Order["priority"] } : prev))
                  }
                >
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </label>
              <label className="text-sm font-semibold text-ink/70">
                Payment required
                <select
                  className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2"
                  value={newOrder.paymentRequired ? "yes" : "no"}
                  onChange={(event) =>
                    setNewOrder((prev) => (prev ? { ...prev, paymentRequired: event.target.value === "yes" } : prev))
                  }
                >
                  <option value="yes">Yes</option>
                  <option value="no">No (Regular distributor)</option>
                </select>
              </label>
            </div>

            <div className="mt-6">
              <h4 className="text-sm font-semibold text-ink/70">Line items</h4>
              <div className="mt-3 space-y-3">
                {newOrder.items.map((item, index) => (
                  <div key={`${item.product_name}-${index}`} className="grid gap-3 md:grid-cols-[1fr_120px_80px]">
                    <input
                      className="rounded-xl border border-ink/10 px-3 py-2"
                      placeholder="Product name"
                      value={item.product_name}
                      onChange={(event) => updateNewItem(index, "product_name", event.target.value)}
                    />
                    <input
                      className="rounded-xl border border-ink/10 px-3 py-2"
                      type="number"
                      min={1}
                      value={item.qty_ordered}
                      onChange={(event) => updateNewItem(index, "qty_ordered", Number(event.target.value || 0))}
                    />
                    <button
                      className="rounded-xl border border-ink/10 px-3 py-2 text-xs font-semibold"
                      onClick={() => removeNewItem(index)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <button
                className="mt-3 rounded-xl border border-ink/10 px-4 py-2 text-xs font-semibold"
                onClick={addNewItem}
              >
                + Add item
              </button>
            </div>

            <label className="mt-6 block text-sm font-semibold text-ink/70">
              Notes
              <textarea
                className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2"
                rows={3}
                value={newOrder.notes}
                onChange={(event) => setNewOrder((prev) => (prev ? { ...prev, notes: event.target.value } : prev))}
              />
            </label>

            <div className="mt-6 flex items-center justify-between gap-3">
              <p className="text-xs text-ink/50">Orders will appear immediately on the board.</p>
              <button
                className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white"
                onClick={submitNewOrder}
              >
                Create order
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showCustomers ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-semibold">Customers</h3>
                <p className="text-sm text-ink/50">Payment rules</p>
              </div>
              <button className="rounded-full border border-ink/10 px-3 py-1 text-xs" onClick={() => setShowCustomers(false)}>
                Close
              </button>
            </div>
            <div className="space-y-3">
              {customers.map((customer) => (
                <div key={customer.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink/10 p-4">
                  <div>
                    <p className="text-sm font-semibold">{customer.name}</p>
                    <p className="text-xs text-ink/50">{customer.payment_required ? "Payment required" : "Credit enabled"}</p>
                  </div>
                  <button
                    className="rounded-xl border border-ink/10 px-3 py-2 text-xs font-semibold"
                    onClick={() => toggleCustomerPayment(customer)}
                  >
                    {customer.payment_required ? "Promote to regular" : "Require payment"}
                  </button>
                </div>
              ))}
              {customers.length === 0 ? (
                <p className="text-sm text-ink/50">No customers yet.</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {showRoles ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-semibold">Roles</h3>
                <p className="text-sm text-ink/50">Admin vs staff</p>
              </div>
              <button className="rounded-full border border-ink/10 px-3 py-1 text-xs" onClick={() => setShowRoles(false)}>
                Close
              </button>
            </div>
            <div className="space-y-3">
              {profiles.map((profile) => (
                <div key={profile.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink/10 p-4">
                  <div>
                    <p className="text-xs text-ink/50">User ID</p>
                    <p className="text-sm font-semibold">{profile.id}</p>
                  </div>
                  <button
                    className="rounded-xl border border-ink/10 px-3 py-2 text-xs font-semibold"
                    onClick={() => toggleRole(profile)}
                  >
                    {profile.role === "admin" ? "Set staff" : "Set admin"}
                  </button>
                </div>
              ))}
              {profiles.length === 0 ? <p className="text-sm text-ink/50">No profiles yet.</p> : null}
            </div>
          </div>
        </div>
      ) : null}

      {showMappings ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-semibold">SKU Mapping</h3>
                <p className="text-sm text-ink/50">Marketplace SKU to internal product</p>
              </div>
              <button className="rounded-full border border-ink/10 px-3 py-1 text-xs" onClick={() => setShowMappings(false)}>
                Close
              </button>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <input
                className="rounded-xl border border-ink/10 px-3 py-2 text-sm"
                placeholder="Marketplace"
                value={mappingForm.marketplace}
                onChange={(event) => setMappingForm((prev) => ({ ...prev, marketplace: event.target.value }))}
              />
              <input
                className="rounded-xl border border-ink/10 px-3 py-2 text-sm"
                placeholder="External SKU"
                value={mappingForm.external_sku}
                onChange={(event) => setMappingForm((prev) => ({ ...prev, external_sku: event.target.value }))}
              />
              <input
                className="rounded-xl border border-ink/10 px-3 py-2 text-sm"
                placeholder="Product name"
                value={mappingForm.product_name}
                onChange={(event) => setMappingForm((prev) => ({ ...prev, product_name: event.target.value }))}
              />
            </div>
            <button className="mt-3 rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white" onClick={addMapping}>
              Add mapping
            </button>
            <div className="mt-5 space-y-3">
              {mappings.map((mapping) => (
                <div key={mapping.id} className="rounded-2xl border border-ink/10 p-4 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-semibold">{mapping.marketplace}</p>
                    {isAdmin ? (
                      <button
                        className="rounded-full border border-ink/10 px-2 py-1 text-[10px] font-semibold text-ink/60"
                        onClick={() => deleteMapping(mapping.id)}
                        title="Delete mapping"
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                  <p className="text-xs text-ink/50">SKU: {mapping.external_sku}</p>
                  <p className="text-xs text-ink/50">Product: {mapping.product_name}</p>
                </div>
              ))}
              {mappings.length === 0 ? <p className="text-sm text-ink/50">No mappings yet.</p> : null}
            </div>
          </div>
        </div>
      ) : null}

      {historyOrder ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-semibold">Shipments</h3>
                <p className="text-sm text-ink/50">{historyOrder.customer_name}</p>
              </div>
              <button
                className="rounded-full border border-ink/10 px-3 py-1 text-xs"
                onClick={() => {
                  setHistoryOrder(null);
                  setShipments(null);
                }}
              >
                Close
              </button>
            </div>
            <div className="space-y-3">
              {(shipments ?? []).map((shipment) => (
                <div key={shipment.id} className="rounded-2xl border border-ink/10 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold">AWB {shipment.awb || "-"}</p>
                    {isAdmin ? (
                      <button
                        className="rounded-full border border-ink/10 px-2 py-1 text-[10px] font-semibold text-ink/60"
                        onClick={() => deleteShipment(shipment.id)}
                        title="Delete shipment"
                      >
                        ✕
                      </button>
                    ) : null}
                    <p className="text-xs text-ink/50">{new Date(shipment.shipped_at).toLocaleString()}</p>
                  </div>
                  <p className="text-xs text-ink/50">Courier: {shipment.courier || "-"}</p>
                  <div className="mt-2 space-y-1 text-sm">
                    {shipment.shipment_items.map((item, index) => (
                      <div key={`${item.product_name}-${index}`} className="flex items-center justify-between">
                        <span>{item.product_name}</span>
                        <span className="font-semibold">x{item.qty_shipped}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {shipments && shipments.length === 0 ? (
                <p className="text-sm text-ink/50">No shipments yet.</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      <footer className="px-6 pb-6 text-xs text-ink/40">
        © 2026 DispatchBoard
      </footer>
    </div>
  );
}
