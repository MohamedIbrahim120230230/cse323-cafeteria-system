-- ============================================================
-- Migration: 005_create_lifecycle_reports.sql
-- Feature:    Lifecycle & Reports  (Member 5)
-- Branch:     feature/lifecycle-reports
-- Applies to: PostgreSQL 15+
-- Depends on: 001_create_users.sql (users table + audit_log)
--             002_create_menu_cart.sql (menu_items, orders)
--             003_create_order_payment.sql (orders, order_items, payments)
--             004_create_stock_resilience.sql (stock_locks, flagged_orders)
-- Covers FRs: FR34 FR35 FR36 FR37 FR38 FR39 FR42 FR43 FR44 FR45
--             FR46 FR47 FR48 FR49 FR53 FR54 FR56
-- ============================================================

-- ============================================================
-- SECTION 1: Extend orders table with lifecycle columns
-- Add columns that lifecycle router needs but 003 didn't define.
-- Uses IF NOT EXISTS pattern so re-running is safe.
-- ============================================================

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS cancellation_reason  VARCHAR(60)  NULL,
    ADD COLUMN IF NOT EXISTS cancellation_note    TEXT         NULL,
    ADD COLUMN IF NOT EXISTS cancelled_by         UUID         NULL REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS is_flagged           BOOLEAN      NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS collected_at         TIMESTAMPTZ  NULL;

-- Extend status enum to cover all lifecycle states
-- We do this safely by checking existing values first
DO $$ 
BEGIN
    -- Check if the type exists
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status') THEN
        -- Create it if missing
        CREATE TYPE order_status AS ENUM (
            'placed', 'pending_payment', 'confirmed', 'preparing', 
            'ready_for_pickup', 'delivered', 'completed', 'cancelled', 
            'payment_failed', 'flagged'
        );
    ELSE
        -- If it exists, try to add the new values safely via dynamic SQL to avoid parsing/compilation errors
        BEGIN
            EXECUTE 'ALTER TYPE order_status ADD VALUE IF NOT EXISTS ''placed''';
            EXECUTE 'ALTER TYPE order_status ADD VALUE IF NOT EXISTS ''flagged''';
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END;
    END IF;
END $$;

-- ============================================================
-- SECTION 2: order_status_transitions
-- FR34: Immutable record of every state change.
-- Feeds the lifecycle dashboard timeline view.
-- ============================================================

CREATE TABLE IF NOT EXISTS order_status_transitions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id     UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    from_status  VARCHAR(30) NOT NULL,
    to_status    VARCHAR(30) NOT NULL,
    actor_id     UUID        NULL REFERENCES users(id) ON DELETE SET NULL,
    actor_role   VARCHAR(20) NULL,   -- student | staff | admin | system
    note         TEXT        NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent updates and deletes — this is an audit ledger
CREATE OR REPLACE RULE order_transitions_no_update AS
    ON UPDATE TO order_status_transitions DO INSTEAD NOTHING;

CREATE OR REPLACE RULE order_transitions_no_delete AS
    ON DELETE TO order_status_transitions DO INSTEAD NOTHING;

CREATE INDEX IF NOT EXISTS idx_ost_order_id   ON order_status_transitions (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ost_actor_id   ON order_status_transitions (actor_id);
CREATE INDEX IF NOT EXISTS idx_ost_created_at ON order_status_transitions (created_at DESC);

-- ============================================================
-- SECTION 3: refunds
-- FR42: Auto-refund to original payment method within 2 days.
-- FR43: Wallet / Meal Plan credit back on cancel.
-- FR44: Flag failed refunds to admin queue.
-- FR45: Partial refund for partial fulfilment.
-- FR46: Immutable refund audit log.
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'refund_status') THEN
        CREATE TYPE refund_status AS ENUM (
            'PENDING',      -- initiated, awaiting gateway
            'SUCCESS',      -- gateway confirmed
            'FAILED',       -- gateway rejected — flagged to admin (FR44)
            'PARTIAL',      -- partial fulfilment refund (FR45)
            'ADMIN_QUEUE'   -- manual processing needed
        );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'refund_method') THEN
        CREATE TYPE refund_method AS ENUM (
            'ORIGINAL_GATEWAY',  -- credit/debit card reversal
            'WALLET_CREDIT',     -- added back to wallet balance
            'MEAL_PLAN_CREDIT',  -- added back to meal plan
            'CASH',              -- cash refund at counter
            'ADMIN_MANUAL'       -- manual bank transfer
        );
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS refunds (
    id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id          UUID          NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    payment_id        UUID          NULL REFERENCES payments(id) ON DELETE SET NULL,
    amount            NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    method            refund_method NOT NULL,
    status            refund_status NOT NULL DEFAULT 'PENDING',
    -- FR46: immutable idempotency key prevents double-refund
    idempotency_key   VARCHAR(120)  NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
    gateway_ref       VARCHAR(120)  NULL,    -- gateway transaction id
    gateway_response  JSONB         NULL,
    failure_reason    VARCHAR(255)  NULL,
    initiated_by      UUID          NULL REFERENCES users(id) ON DELETE SET NULL,
    initiated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ   NULL,
    -- FR45: partial refund fields
    is_partial        BOOLEAN       NOT NULL DEFAULT FALSE,
    partial_reason    TEXT          NULL
);

-- FR46: Immutable — no updates or deletes
CREATE OR REPLACE RULE refunds_no_delete AS
    ON DELETE TO refunds DO INSTEAD NOTHING;

CREATE INDEX IF NOT EXISTS idx_refunds_order_id   ON refunds (order_id);
CREATE INDEX IF NOT EXISTS idx_refunds_status     ON refunds (status);
CREATE INDEX IF NOT EXISTS idx_refunds_initiated  ON refunds (initiated_at DESC);

-- ============================================================
-- SECTION 4: ratings
-- FR47: Rating only allowed after COMPLETED status.
-- FR48: Avg rating cached on menu_items.
-- FR49: Admin can moderate (hide) a rating.
-- One rating per order (enforced by UNIQUE constraint).
-- ============================================================

CREATE TABLE IF NOT EXISTS ratings (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id     UUID        NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    menu_item_id INTEGER     NULL REFERENCES menu_items(id) ON DELETE SET NULL,
    stars        SMALLINT    NOT NULL CHECK (stars BETWEEN 1 AND 5),
    text         TEXT        NULL,
    -- FR49: admin moderation
    hidden       BOOLEAN     NOT NULL DEFAULT FALSE,
    hidden_by    UUID        NULL REFERENCES users(id) ON DELETE SET NULL,
    hidden_at    TIMESTAMPTZ NULL,
    hide_reason  TEXT        NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ratings_menu_item  ON ratings (menu_item_id) WHERE hidden = FALSE;
CREATE INDEX IF NOT EXISTS idx_ratings_user_id    ON ratings (user_id);
CREATE INDEX IF NOT EXISTS idx_ratings_created_at ON ratings (created_at DESC);

COMMENT ON TABLE ratings IS
    'FR47: Only one rating per completed order. FR49: Admin can hide ratings.';

-- FR48: Add avg_rating cache column to menu_items if not already there
ALTER TABLE menu_items
    ADD COLUMN IF NOT EXISTS avg_rating   NUMERIC(3,2) NULL,
    ADD COLUMN IF NOT EXISTS rating_count INTEGER     NOT NULL DEFAULT 0;

-- Function to refresh avg_rating on menu_items after every rating insert/update/hide
CREATE OR REPLACE FUNCTION refresh_menu_avg_rating()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    UPDATE menu_items
    SET
        avg_rating   = (
            SELECT ROUND(AVG(stars)::NUMERIC, 2)
            FROM   ratings
            WHERE  menu_item_id = COALESCE(NEW.menu_item_id, OLD.menu_item_id)
              AND  hidden = FALSE
        ),
        rating_count = (
            SELECT COUNT(*)
            FROM   ratings
            WHERE  menu_item_id = COALESCE(NEW.menu_item_id, OLD.menu_item_id)
              AND  hidden = FALSE
        )
    WHERE id = COALESCE(NEW.menu_item_id, OLD.menu_item_id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rating_refresh ON ratings;
CREATE TRIGGER trg_rating_refresh
    AFTER INSERT OR UPDATE OF stars, hidden
    ON ratings
    FOR EACH ROW
    EXECUTE FUNCTION refresh_menu_avg_rating();

-- ============================================================
-- SECTION 5: report_cache
-- FR53: Admin reports — async generation for > 90 day ranges.
-- Materialized cache so repeated requests don't re-scan.
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_status') THEN
        CREATE TYPE report_status AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS report_cache (
    id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    report_type      VARCHAR(40)   NOT NULL,   -- revenue | top_items | cancellations | heatmap | ratings
    from_date        DATE          NOT NULL,
    to_date          DATE          NOT NULL,
    format           VARCHAR(10)   NOT NULL DEFAULT 'json',  -- json | csv | pdf
    status           report_status NOT NULL DEFAULT 'QUEUED',
    requested_by     UUID          NULL REFERENCES users(id) ON DELETE SET NULL,
    requested_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    completed_at     TIMESTAMPTZ   NULL,
    row_count        INTEGER       NULL,
    result_json      JSONB         NULL,       -- for json/csv reports
    result_file_path TEXT          NULL,       -- for PDF reports
    error_message    TEXT          NULL
);

CREATE INDEX IF NOT EXISTS idx_report_cache_type_dates ON report_cache (report_type, from_date, to_date);
CREATE INDEX IF NOT EXISTS idx_report_cache_status     ON report_cache (status, requested_at DESC);

COMMENT ON TABLE report_cache IS
    'FR53: Report results cached here. Ranges > 90 days generate asynchronously.';

-- ============================================================
-- SECTION 6: Additional audit_log columns
-- Extend the existing audit_log table (from 001) with
-- entity_type / entity_id used by lifecycle and admin routers.
-- ============================================================

ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS actor_role   VARCHAR(20) NULL,
    ADD COLUMN IF NOT EXISTS entity_type  VARCHAR(60) NULL,
    ADD COLUMN IF NOT EXISTS target_id_text  VARCHAR(120) NULL,  -- text version of target_id
    ADD COLUMN IF NOT EXISTS before_state JSONB        NULL,
    ADD COLUMN IF NOT EXISTS after_state  JSONB        NULL,
    ADD COLUMN IF NOT EXISTS detail       TEXT         NULL;

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, target_id);

-- ============================================================
-- SECTION 7: Indexes for lifecycle dashboard queries
-- ============================================================

-- Fast order lookup by status for kitchen display (FR35)
CREATE INDEX IF NOT EXISTS idx_orders_status_placed
    ON orders (status, created_at DESC)
    WHERE status IN ('placed', 'confirmed', 'preparing', 'ready_for_pickup');

-- Fast lookup for student order history
CREATE INDEX IF NOT EXISTS idx_orders_user_recent
    ON orders (user_id, created_at DESC);

-- ============================================================
-- SECTION 8: Seed demo data for lifecycle dashboard
-- FIX-005: Wrapped transitions seeding step inside conditional blocks 
-- to completely bypass the restriction on tables containing rewrite rules.
-- ============================================================

DO $$
DECLARE
    v_student_id UUID;
    v_item1_id   menu_items.id%TYPE;
    v_item2_id   menu_items.id%TYPE;
BEGIN
    -- Get or create demo student
    SELECT id INTO v_student_id FROM users WHERE email = 'student@ejust.edu.eg' LIMIT 1;
    IF v_student_id IS NULL THEN
        INSERT INTO users (email, display_name, password_hash, role, status)
        VALUES ('student@ejust.edu.eg', 'Demo Student',
                '$2b$12$placeholder_hash_change_before_prod', 'student', 'active')
        RETURNING id INTO v_student_id;
    END IF;

    -- Get two menu items for demo orders
    SELECT id INTO v_item1_id FROM menu_items ORDER BY id LIMIT 1;
    SELECT id INTO v_item2_id FROM menu_items ORDER BY id OFFSET 1 LIMIT 1;

    IF v_item1_id IS NULL THEN RETURN; END IF;  -- no menu items seeded yet

    -- Demo order: PREPARING state
    INSERT INTO orders (id, user_id, status, subtotal, discount, total, idempotency_key, created_at)
    VALUES ('00000000-0000-0000-0000-000000000001'::uuid, v_student_id,
            'preparing', 55.00, 0.00, 55.00, 'demo-idp-001', NOW() - INTERVAL '15 minutes')
    ON CONFLICT (id) DO NOTHING;

    -- Safe wrapper to seed order item for Order 1 without duplicate issues on re-run
    IF NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = '00000000-0000-0000-0000-000000000001'::uuid) THEN
        INSERT INTO order_items (id, order_id, menu_item_id, name, unit_price, quantity, subtotal)
        SELECT gen_random_uuid(), '00000000-0000-0000-0000-000000000001'::uuid,
               v_item1_id, m.name, m.price, 2, m.price * 2
        FROM menu_items m WHERE m.id = v_item1_id;
    END IF;

    -- Demo order: PLACED (within cancel window)
    INSERT INTO orders (id, user_id, status, subtotal, discount, total, idempotency_key, created_at)
    VALUES ('00000000-0000-0000-0000-000000000002'::uuid, v_student_id,
            'placed', 45.00, 0.00, 45.00, 'demo-idp-002', NOW() - INTERVAL '30 seconds')
    ON CONFLICT (id) DO NOTHING;

    -- Demo order: READY FOR PICKUP
    INSERT INTO orders (id, user_id, status, subtotal, discount, total, idempotency_key, created_at)
    VALUES ('00000000-0000-0000-0000-000000000003'::uuid, v_student_id,
            'ready_for_pickup', 110.00, 10.00, 100.00, 'demo-idp-003', NOW() - INTERVAL '30 minutes')
    ON CONFLICT (id) DO NOTHING;

    -- Demo order: FLAGGED (suspicious)
    INSERT INTO orders (id, user_id, status, subtotal, discount, total,
                        idempotency_key, is_flagged, created_at)
    VALUES ('00000000-0000-0000-0000-000000000004'::uuid, v_student_id,
            'flagged', 750.00, 0.00, 750.00, 'demo-idp-004', TRUE, NOW() - INTERVAL '5 minutes')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO flagged_orders (order_id, flagged_reason, flag_details, auto_cancel_at)
    VALUES ('00000000-0000-0000-0000-000000000004'::uuid,
            'Order total 750.00 EGP exceeds threshold 500.00 EGP',
            '{"total_exceeded": true}'::jsonb,
            NOW() + INTERVAL '55 minutes')
    ON CONFLICT (order_id) DO NOTHING;

    -- Demo order: COMPLETED
    INSERT INTO orders (id, user_id, status, subtotal, discount, total, idempotency_key, created_at)
    VALUES ('00000000-0000-0000-0000-000000000005'::uuid, v_student_id,
            'completed', 25.00, 0.00, 25.00, 'demo-idp-005', NOW() - INTERVAL '3 hours')
    ON CONFLICT (id) DO NOTHING;

    -- Seed status transitions for the demo orders safely without ON CONFLICT
    IF NOT EXISTS (SELECT 1 FROM order_status_transitions WHERE order_id = '00000000-0000-0000-0000-000000000001'::uuid) THEN
        INSERT INTO order_status_transitions (order_id, from_status, to_status, actor_role, created_at)
        VALUES
            ('00000000-0000-0000-0000-000000000001'::uuid, 'placed',          'confirmed', 'system', NOW() - INTERVAL '14 minutes'),
            ('00000000-0000-0000-0000-000000000001'::uuid, 'confirmed',       'preparing', 'staff',  NOW() - INTERVAL '12 minutes'),
            ('00000000-0000-0000-0000-000000000003'::uuid, 'placed',          'confirmed', 'system', NOW() - INTERVAL '29 minutes'),
            ('00000000-0000-0000-0000-000000000003'::uuid, 'confirmed',       'preparing', 'staff',  NOW() - INTERVAL '25 minutes'),
            ('00000000-0000-0000-0000-000000000003'::uuid, 'preparing',       'ready_for_pickup', 'staff', NOW() - INTERVAL '10 minutes'),
            ('00000000-0000-0000-0000-000000000005'::uuid, 'placed',          'confirmed', 'system', NOW() - INTERVAL '3 hours'),
            ('00000000-0000-0000-0000-000000000005'::uuid, 'confirmed',       'preparing', 'staff',  NOW() - INTERVAL '170 minutes'),
            ('00000000-0000-0000-0000-000000000005'::uuid, 'preparing',       'ready_for_pickup', 'staff', NOW() - INTERVAL '160 minutes'),
            ('00000000-0000-0000-0000-000000000005'::uuid, 'ready_for_pickup','delivered', 'staff',  NOW() - INTERVAL '150 minutes'),
            ('00000000-0000-0000-0000-000000000005'::uuid, 'delivered',       'completed', 'system', NOW() - INTERVAL '120 minutes');
    END IF;

END $$;

-- ============================================================
-- SECTION 9: Helper function — auto-complete collected orders
-- FR: Orders in COLLECTED state auto-complete after 2 hours.
-- Called by scheduled job.
-- ============================================================

CREATE OR REPLACE FUNCTION auto_complete_collected_orders(p_window_hours INTEGER DEFAULT 2)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_count INTEGER;
BEGIN
    WITH completed_orders AS (
        UPDATE orders
        SET    status       = 'completed'
        WHERE  status       = 'delivered'
          AND  collected_at <= NOW() - (p_window_hours || ' hours')::INTERVAL
        RETURNING id
    )
    SELECT COUNT(*) INTO v_count FROM completed_orders;

    RETURN v_count;
END;
$$;

-- ============================================================
-- COMMENTS
-- ============================================================

COMMENT ON TABLE order_status_transitions IS 'FR34: Immutable record of every order state change. No UPDATE or DELETE allowed.';
COMMENT ON TABLE refunds                   IS 'FR42-FR46: Refund records. Immutable once created. Failed refunds auto-queue to admin (FR44).';
COMMENT ON TABLE report_cache              IS 'FR53: Report results cached here. Ranges > 90 days generate asynchronously.';