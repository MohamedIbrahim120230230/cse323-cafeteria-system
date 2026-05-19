-- ============================================================
-- Migration: 003_create_order_payment.sql
-- Feature:   Order & Payment (Member 3)
-- Branch:    feature/order-payment
-- Applies to: PostgreSQL 15+
-- Dependencies: 001_create_users.sql, 002_create_menu_cart.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── CARTS (Member 3 normalized version) ─────────────────────
CREATE TABLE IF NOT EXISTS carts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_carts_user ON carts(user_id);

CREATE TABLE IF NOT EXISTS cart_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id         UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
    menu_item_id    INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE, -- Type fixed to INTEGER
    quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_cart_items_lookup ON cart_items(cart_id, menu_item_id);

-- ── ORDERS & TYPE DEFINITIONS ───────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status') THEN
        CREATE TYPE order_status AS ENUM (
            'placed', 'pending_payment', 'confirmed', 'preparing', 
            'ready_for_pickup', 'delivered', 'completed', 'cancelled', 
            'payment_failed', 'payment_timeout', 'flagged'
        );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_method') THEN
        CREATE TYPE payment_method AS ENUM (
            'online', 'cash', 'wallet', 'meal_plan'
        );
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS orders (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key  VARCHAR(100) NOT NULL UNIQUE, -- FR31
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status           order_status NOT NULL DEFAULT 'pending_payment',
    payment_method   payment_method NULL,
    subtotal         NUMERIC(10,2) NOT NULL CHECK (subtotal >= 0),
    discount         NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
    total            NUMERIC(10,2) NOT NULL CHECK (total >= 0),
    voucher_id       INTEGER NULL REFERENCES vouchers(id) ON DELETE SET NULL, -- Type fixed to INTEGER
    voucher_code     VARCHAR(50) NULL,
    notes            TEXT NULL,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    confirmed_at     TIMESTAMPTZ NULL,
    cancelled_at     TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_order_user   ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_order_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id    INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT, -- Type fixed to INTEGER
    name            VARCHAR(120) NOT NULL,
    unit_price      NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    subtotal        NUMERIC(10,2) NOT NULL CHECK (subtotal >= 0)
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- ── PAYMENTS ──────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_status') THEN
        CREATE TYPE payment_status AS ENUM (
            'pending', 'success', 'failed', 'timeout', 'refunded', 'indeterminate'
        );
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS payments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    method           payment_method NOT NULL,
    status           payment_status NOT NULL DEFAULT 'pending',
    amount           NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
    transaction_id   VARCHAR(120) UNIQUE NULL,
    gateway_response JSONB NULL,
    failure_reason   VARCHAR(255) NULL,
    refund_amount    NUMERIC(10,2) NULL,
    refund_ref       VARCHAR(120) NULL,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    timeout_at       TIMESTAMPTZ NULL -- FR24: deadline
);

CREATE INDEX IF NOT EXISTS idx_payment_order   ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_status  ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payment_timeout ON payments(timeout_at) WHERE status = 'pending';

-- ── IDEMPOTENT SEED DATA VIA SECURE BLOCKS ────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM menu_items WHERE name = 'Beef Burger') THEN
        INSERT INTO menu_items (name, description, price, category, active, stock_qty)
        VALUES
            ('Beef Burger',       'Grilled beef patty with fresh toppings', 45.00, 'Main',    TRUE,  50),
            ('Veggie Burger',     'Plant-based patty with cheese',          38.00, 'Main',    TRUE,  30),
            ('Salad Bowl',        'Mixed greens with olive oil dressing',   25.00, 'Salads',  TRUE,  40),
            ('Salad Wrap',        'Grilled chicken in tortilla wrap',       30.00, 'Salads',  TRUE,  35),
            ('Water Bottle',      'Still mineral water 500ml',               5.00, 'Drinks',  TRUE,  200),
            ('Orange Juice',      'Fresh squeezed orange juice',            20.00, 'Drinks',  TRUE,  60),
            ('Fish Sandwich',     'Crispy fish with tartar sauce',          40.00, 'Main',    FALSE, 0),
            ('Grilled Chicken',   'Herb-marinated grilled chicken breast',  50.00, 'Main',    TRUE,  25);
    END IF;
END $$;

-- Populate both mirrored columns to support member 2 & member 3 queries
INSERT INTO vouchers (code, discount_type, discount_value, discount, min_order, max_uses, expires_at, is_active)
VALUES
    ('SAVE20',    'flat',          20.00, 20.00, 50.00,  100, NOW() + INTERVAL '30 days', TRUE),
    ('HALF50',    'percent',       50.00, 50.00, 100.00, 50,  NOW() + INTERVAL '30 days', TRUE),
    ('FREESHIP',  'free_delivery', 0.00,  0.00,  0.00,   500, NOW() + INTERVAL '60 days', TRUE)
ON CONFLICT (code) DO NOTHING;