-- ============================================================
-- Migration: 004_create_stock_resilience.sql
-- Feature:   Stock & Resilience  (Member 4)
-- Branch:    feature/stock-resilience
-- Applies to: PostgreSQL 15+
-- Covers FRs: FR11, FR19, FR21, FR22, FR24, FR25, FR40, FR41
-- NFRs: NFR10, NFR11, NFR22
-- ============================================================

-- ============================================================
-- TABLE: stock_locks
-- FR22: Pessimistic stock lock per order item.
-- Lock acquired at order placement, released on payment
-- success/failure/timeout (TTL = 10 min).
-- NFR11: Supports 500 concurrent lock acquisitions/sec via row-level locking.
-- ============================================================

CREATE TABLE IF NOT EXISTS stock_locks (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    menu_item_id    INTEGER      NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    order_id        UUID         NOT NULL,            -- references orders(id) — cross-feature FK
    quantity        INTEGER      NOT NULL CHECK (quantity > 0),
    locked_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ  NOT NULL,            -- locked_at + 10 minutes (FR22 TTL)
    released_at     TIMESTAMPTZ  NULL,                -- NULL = still active
    release_reason  VARCHAR(50)  NULL                 -- PAYMENT_SUCCESS | PAYMENT_FAILED | TTL_EXPIRED | CANCELLED
);

-- Index for fast per-item lock lookup (concurrent order check)
CREATE INDEX IF NOT EXISTS idx_stock_locks_item_active
    ON stock_locks (menu_item_id, released_at)
    WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_stock_locks_order_id  ON stock_locks (order_id);
CREATE INDEX IF NOT EXISTS idx_stock_locks_expires_at ON stock_locks (expires_at)
    WHERE released_at IS NULL;  -- TTL cleanup job only scans active locks

-- ============================================================
-- TABLE: stock_transactions
-- Immutable log of every stock change: decrement, increment, correction.
-- FR41: audit trail for stock drift detection.
-- NFR20: append-only financial-grade log.
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'stock_txn_type') THEN
        CREATE TYPE stock_txn_type AS ENUM (
            'RESERVE',          -- locked at order placement
            'DEDUCT',           -- permanent decrement on payment success
            'RELEASE',          -- lock released without deduction (payment failed / cancelled)
            'RESTOCK',          -- admin manually adds stock
            'CORRECTION',       -- admin adjusts to fix drift (FR41)
            'ADMIN_DEDUCT'      -- admin removes stock manually
        );
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS stock_transactions (
    id              BIGSERIAL    PRIMARY KEY,
    menu_item_id    INTEGER      NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    order_id        UUID         NULL,       -- NULL for manual admin operations
    actor_id        UUID         NULL,       -- admin user id for manual ops
    txn_type        stock_txn_type NOT NULL,
    quantity_delta  INTEGER      NOT NULL,   -- positive = stock increase, negative = decrease
    quantity_before INTEGER      NOT NULL,   -- snapshot before change
    quantity_after  INTEGER      NOT NULL,   -- snapshot after change
    note            TEXT         NULL,       -- mandatory for CORRECTION type
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Prevent modifications — stock ledger is immutable
CREATE OR REPLACE RULE stock_txn_no_update AS
    ON UPDATE TO stock_transactions DO INSTEAD NOTHING;

CREATE OR REPLACE RULE stock_txn_no_delete AS
    ON DELETE TO stock_transactions DO INSTEAD NOTHING;

CREATE INDEX IF NOT EXISTS idx_stock_txn_item_id   ON stock_transactions (menu_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_txn_order_id  ON stock_transactions (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_txn_created   ON stock_transactions (created_at DESC);

-- ============================================================
-- TABLE: flagged_orders
-- FR24: Unrealistic / suspicious orders routed to admin review.
-- Orders exceeding quantity > 10/item or total > 500 EGP are flagged.
-- Auto-cancelled after 60 minutes without admin action (FR56).
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'flagged_order_status') THEN
        CREATE TYPE flagged_order_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'AUTO_CANCELLED');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS flagged_orders (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID         NOT NULL UNIQUE,
    flagged_reason  TEXT         NOT NULL,   -- human-readable reason
    flag_details    JSONB        NULL,       -- e.g. {"max_qty_exceeded": true, "total_exceeded": true}
    status          flagged_order_status NOT NULL DEFAULT 'PENDING',
    reviewed_by     UUID         NULL REFERENCES users(id) ON DELETE SET NULL,
    review_reason   TEXT         NULL,       -- mandatory on REJECTED
    flagged_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    reviewed_at     TIMESTAMPTZ  NULL,
    auto_cancel_at  TIMESTAMPTZ  NOT NULL    -- flagged_at + 60 min
);

CREATE INDEX IF NOT EXISTS idx_flagged_orders_status    ON flagged_orders (status, flagged_at);
CREATE INDEX IF NOT EXISTS idx_flagged_orders_order_id  ON flagged_orders (order_id);
CREATE INDEX IF NOT EXISTS idx_flagged_orders_cancel_at ON flagged_orders (auto_cancel_at)
    WHERE status = 'PENDING';

-- ============================================================
-- TABLE: system_config
-- FR25 / FR54: Runtime-configurable system parameters.
-- Admin can change thresholds without restart (within 60 sec).
-- ============================================================

CREATE TABLE IF NOT EXISTS system_config (
    key         VARCHAR(80)  PRIMARY KEY,
    value       TEXT         NOT NULL,
    description TEXT         NULL,
    updated_by  UUID         NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed default config values safely
INSERT INTO system_config (key, value, description) VALUES
    ('stock_lock_ttl_minutes',      '10',   'FR22: Pessimistic stock lock TTL in minutes'),
    ('max_concurrent_orders',       '150',  'FR25: Max simultaneous active orders before circuit-breaker triggers'),
    ('unrealistic_qty_threshold',   '10',   'FR24: Max quantity per item before order is flagged'),
    ('unrealistic_total_threshold', '500',  'FR24: Max order total (EGP) before order is flagged'),
    ('flagged_order_ttl_minutes',   '60',   'FR56: Minutes before unreviewed flagged order is auto-cancelled'),
    ('payment_timeout_seconds',     '600',  'FR29: Payment pending TTL in seconds (10 min)')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- VIEW: stock_summary
-- Live stock view: available = stock_qty minus all active locks.
-- Used by FR11 (out-of-stock indicator) and FR21 (checkout check).
-- FIX-004: Force view replacement dropping the old definition structure
-- ============================================================

DROP VIEW IF EXISTS stock_summary CASCADE;

CREATE OR REPLACE VIEW stock_summary AS
SELECT
    m.id                AS menu_item_id,
    m.name              AS item_name,
    m.stock_qty         AS total_qty,
    m.max_order_qty     AS max_order_qty,
    m.active,
    COALESCE(SUM(sl.quantity) FILTER (WHERE sl.released_at IS NULL AND sl.expires_at > NOW()), 0)
                        AS locked_qty,
    m.stock_qty - COALESCE(SUM(sl.quantity) FILTER (WHERE sl.released_at IS NULL AND sl.expires_at > NOW()), 0)
                        AS available_qty
FROM menu_items m
LEFT JOIN stock_locks sl ON sl.menu_item_id = m.id
GROUP BY m.id, m.name, m.stock_qty, m.max_order_qty, m.active;

COMMENT ON VIEW stock_summary IS
    'Live available stock = total_qty minus active (non-expired, non-released) lock quantities.';

-- ============================================================
-- FUNCTION: acquire_stock_lock
-- Atomic lock acquisition using SELECT FOR UPDATE NOWAIT.
-- Returns: 'ok' | 'insufficient' | 'max_qty_exceeded' | 'lock_failed'
-- NFR11: Must support 500 concurrent lock acquisitions/sec.
-- ============================================================

CREATE OR REPLACE FUNCTION acquire_stock_lock(
    p_menu_item_id INTEGER,
    p_order_id     UUID,
    p_quantity     INTEGER,
    p_lock_ttl_min INTEGER DEFAULT 10
)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
    v_stock_qty     INTEGER;
    v_max_order_qty INTEGER;
    v_locked_qty    INTEGER;
    v_available     INTEGER;
    v_lock_expires  TIMESTAMPTZ;
BEGIN
    -- Lock the menu_items row to prevent concurrent modification
    SELECT stock_qty, max_order_qty
    INTO   v_stock_qty, v_max_order_qty
    FROM   menu_items
    WHERE  id = p_menu_item_id AND active = TRUE
    FOR UPDATE NOWAIT;

    IF NOT FOUND THEN
        RETURN 'item_unavailable';
    END IF;

    -- FR19: max order quantity check
    IF p_quantity > v_max_order_qty THEN
        RETURN 'max_qty_exceeded';
    END IF;

    -- Calculate locked quantity from active locks (TTL not expired)
    SELECT COALESCE(SUM(quantity), 0)
    INTO   v_locked_qty
    FROM   stock_locks
    WHERE  menu_item_id = p_menu_item_id
      AND  released_at IS NULL
      AND  expires_at  > NOW();

    v_available := v_stock_qty - v_locked_qty;

    -- FR21: real-time availability check
    IF p_quantity > v_available THEN
        RETURN 'insufficient';
    END IF;

    -- Acquire the lock
    v_lock_expires := NOW() + (p_lock_ttl_min || ' minutes')::INTERVAL;

    INSERT INTO stock_locks (menu_item_id, order_id, quantity, expires_at)
    VALUES (p_menu_item_id, p_order_id, p_quantity, v_lock_expires);

    -- Log the reservation in the stock ledger
    INSERT INTO stock_transactions (
        menu_item_id, order_id, txn_type, quantity_delta,
        quantity_before, quantity_after
    ) VALUES (
        p_menu_item_id, p_order_id, 'RESERVE', -p_quantity,
        v_stock_qty, v_stock_qty  -- stock_qty itself not changed; available_qty changes via lock
    );

    RETURN 'ok';
END;
$$;

-- ============================================================
-- FUNCTION: release_stock_lock
-- Releases all locks for an order. Optionally permanently deducts stock.
-- Called on: payment success (deduct=true), failure/cancel (deduct=false).
-- ============================================================

CREATE OR REPLACE FUNCTION release_stock_lock(
    p_order_id UUID,
    p_deduct   BOOLEAN DEFAULT FALSE,
    p_reason   VARCHAR DEFAULT 'PAYMENT_SUCCESS'
)
RETURNS INTEGER   -- number of locks released
LANGUAGE plpgsql AS $$
DECLARE
    v_lock      RECORD;
    v_released  INTEGER := 0;
BEGIN
    FOR v_lock IN
        SELECT id, menu_item_id, quantity
        FROM   stock_locks
        WHERE  order_id    = p_order_id
          AND  released_at IS NULL
        FOR UPDATE NOWAIT
    LOOP
        -- Mark lock as released
        UPDATE stock_locks
        SET    released_at   = NOW(),
               release_reason = p_reason
        WHERE  id = v_lock.id;

        IF p_deduct THEN
            -- FR22: Permanently decrement stock on payment success
            UPDATE menu_items
            SET    stock_qty = stock_qty - v_lock.quantity
            WHERE  id        = v_lock.menu_item_id;

            INSERT INTO stock_transactions (
                menu_item_id, order_id, txn_type, quantity_delta,
                quantity_before, quantity_after
            )
            SELECT
                v_lock.menu_item_id,
                p_order_id,
                'DEDUCT',
                -v_lock.quantity,
                stock_qty + v_lock.quantity,  -- before the update
                stock_qty                     -- after
            FROM menu_items WHERE id = v_lock.menu_item_id;
        ELSE
            -- Release without deduction (payment failed / cancelled)
            INSERT INTO stock_transactions (
                menu_item_id, order_id, txn_type, quantity_delta,
                quantity_before, quantity_after
            )
            SELECT
                v_lock.menu_item_id,
                p_order_id,
                'RELEASE',
                v_lock.quantity,    -- positive: capacity returned
                stock_qty,
                stock_qty
            FROM menu_items WHERE id = v_lock.menu_item_id;
        END IF;

        v_released := v_released + 1;
    END LOOP;

    RETURN v_released;
END;
$$;

-- ============================================================
-- FUNCTION: expire_stale_locks
-- FR40: Auto-releases locks where expires_at has passed.
-- Called by a scheduled job every minute.
-- ============================================================

CREATE OR REPLACE FUNCTION expire_stale_locks()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_count INTEGER;
BEGIN
    WITH expired AS (
        UPDATE stock_locks
        SET    released_at    = NOW(),
               release_reason = 'TTL_EXPIRED'
        WHERE  released_at IS NULL
          AND  expires_at  <= NOW()
        RETURNING id, menu_item_id, quantity, order_id
    ),
    txn_insert AS (
        INSERT INTO stock_transactions (
            menu_item_id, order_id, txn_type, quantity_delta,
            quantity_before, quantity_after
        )
        SELECT
            e.menu_item_id,
            e.order_id,
            'RELEASE',
            e.quantity,
            m.stock_qty,
            m.stock_qty
        FROM expired e
        JOIN menu_items m ON m.id = e.menu_item_id
    )
    SELECT COUNT(*) INTO v_count FROM expired;

    RETURN v_count;
END;
$$;

-- ============================================================
-- COMMENTS
-- ============================================================

COMMENT ON TABLE stock_locks        IS 'FR22: Pessimistic stock locks. Active when released_at IS NULL and expires_at > NOW().';
COMMENT ON TABLE stock_transactions IS 'Immutable stock ledger. Every change recorded. No UPDATE/DELETE allowed.';
COMMENT ON TABLE flagged_orders     IS 'FR24: Suspicious orders pending admin review. Auto-cancelled after 60 min.';
COMMENT ON TABLE system_config      IS 'FR54: Runtime-configurable thresholds. Applied within 60s of admin change.';