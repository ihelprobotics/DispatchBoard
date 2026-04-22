export interface ParsedOrder {
  customer_name: string;
  items: Array<{ product: string; qty: number }>;
  priority: "urgent" | "high" | "normal";
  notes: string;
  confidence: number;
}
