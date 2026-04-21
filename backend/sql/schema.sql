CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  type text NOT NULL DEFAULT 'non_regular',
  payment_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  channel text NOT NULL DEFAULT 'direct',
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'new',
  payment_status text NOT NULL DEFAULT 'pending',
  needs_review boolean NOT NULL DEFAULT false,
  notes text,
  parent_order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
  suffix text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_name text NOT NULL,
  qty_ordered integer NOT NULL CHECK (qty_ordered > 0)
);

CREATE TABLE IF NOT EXISTS shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  awb text,
  courier text,
  shipped_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shipment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  order_item_id uuid REFERENCES order_items(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  qty_shipped integer NOT NULL CHECK (qty_shipped > 0)
);

CREATE TABLE IF NOT EXISTS product_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace text NOT NULL,
  external_sku text NOT NULL,
  product_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace, external_sku)
);

CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'staff',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes text;

CREATE OR REPLACE FUNCTION ship_partial(
  p_order_id uuid,
  p_items jsonb,
  p_awb text,
  p_courier text
)
RETURNS TABLE (shipment_id uuid, sub_order_id uuid) AS $$
DECLARE
  v_shipment_id uuid;
  v_sub_order_id uuid;
  v_customer_id uuid;
  v_channel text;
  v_priority text;
  v_next_suffix text;
  v_root_order_id uuid;
  v_current_parent uuid;
  v_remaining_count integer := 0;
BEGIN
  SELECT customer_id, channel, priority, parent_order_id
  INTO v_customer_id, v_channel, v_priority, v_current_parent
  FROM orders WHERE id = p_order_id FOR UPDATE;

  v_root_order_id := COALESCE(v_current_parent, p_order_id);

  INSERT INTO shipments (order_id, awb, courier)
  VALUES (p_order_id, p_awb, p_courier)
  RETURNING id INTO v_shipment_id;

  INSERT INTO shipment_items (shipment_id, order_item_id, product_name, qty_shipped)
  SELECT v_shipment_id, oi.id, oi.product_name, (item->>'qty_to_ship')::int
  FROM order_items oi
  JOIN jsonb_array_elements(p_items) AS item
    ON item->>'product_name' = oi.product_name
  WHERE oi.order_id = p_order_id;

  CREATE TEMP TABLE tmp_remaining (product_name text, remaining_qty integer);

  INSERT INTO tmp_remaining (product_name, remaining_qty)
  SELECT oi.product_name,
         oi.qty_ordered - COALESCE(ship.sum_qty, 0) AS remaining_qty
  FROM order_items oi
  LEFT JOIN (
    SELECT si.product_name, SUM(si.qty_shipped) AS sum_qty
    FROM shipment_items si
    JOIN shipments s ON s.id = si.shipment_id
    WHERE s.order_id = p_order_id
    GROUP BY si.product_name
  ) ship ON ship.product_name = oi.product_name
  WHERE oi.order_id = p_order_id;

  SELECT COUNT(*) INTO v_remaining_count FROM tmp_remaining WHERE remaining_qty > 0;

  IF v_remaining_count > 0 THEN
    SELECT MAX(suffix)
    INTO v_next_suffix
    FROM orders
    WHERE parent_order_id = v_root_order_id;

    IF v_next_suffix IS NULL OR v_next_suffix = '' THEN
      v_next_suffix := 'A';
    ELSE
      v_next_suffix := chr(ASCII(v_next_suffix) + 1);
    END IF;

    INSERT INTO orders (customer_id, channel, priority, status, payment_status, parent_order_id, suffix)
    VALUES (v_customer_id, v_channel, 'high', 'fulfillment', 'paid', v_root_order_id, v_next_suffix)
    RETURNING id INTO v_sub_order_id;

    INSERT INTO order_items (order_id, product_name, qty_ordered)
    SELECT v_sub_order_id, product_name, remaining_qty
    FROM tmp_remaining
    WHERE remaining_qty > 0;
  END IF;

  UPDATE orders SET status = 'shipped' WHERE id = p_order_id;

  DROP TABLE IF EXISTS tmp_remaining;

  shipment_id := v_shipment_id;
  sub_order_id := v_sub_order_id;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customers_read" ON customers;
CREATE POLICY "customers_read" ON customers
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "customers_write" ON customers;
CREATE POLICY "customers_write" ON customers
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "orders_read" ON orders;
CREATE POLICY "orders_read" ON orders
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "orders_write" ON orders;
CREATE POLICY "orders_write" ON orders
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "orders_update" ON orders;
CREATE POLICY "orders_update" ON orders
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "orders_delete" ON orders;
CREATE POLICY "orders_delete" ON orders
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "order_items_read" ON order_items;
CREATE POLICY "order_items_read" ON order_items
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "order_items_write" ON order_items;
CREATE POLICY "order_items_write" ON order_items
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "order_items_update" ON order_items;
CREATE POLICY "order_items_update" ON order_items
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "order_items_delete" ON order_items;
CREATE POLICY "order_items_delete" ON order_items
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "shipments_read" ON shipments;
CREATE POLICY "shipments_read" ON shipments
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "shipments_write" ON shipments;
CREATE POLICY "shipments_write" ON shipments
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "shipments_delete" ON shipments;
CREATE POLICY "shipments_delete" ON shipments
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "shipment_items_read" ON shipment_items;
CREATE POLICY "shipment_items_read" ON shipment_items
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "shipment_items_write" ON shipment_items;
CREATE POLICY "shipment_items_write" ON shipment_items
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "shipment_items_delete" ON shipment_items;
CREATE POLICY "shipment_items_delete" ON shipment_items
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "product_mappings_read" ON product_mappings;
CREATE POLICY "product_mappings_read" ON product_mappings
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "product_mappings_write" ON product_mappings;
CREATE POLICY "product_mappings_write" ON product_mappings
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "product_mappings_update" ON product_mappings;
CREATE POLICY "product_mappings_update" ON product_mappings
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "product_mappings_delete" ON product_mappings;
CREATE POLICY "product_mappings_delete" ON product_mappings
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "profiles_read" ON profiles;
CREATE POLICY "profiles_read" ON profiles
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "profiles_write" ON profiles;
CREATE POLICY "profiles_write" ON profiles
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "profiles_update" ON profiles;
CREATE POLICY "profiles_update" ON profiles
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
