-- ============================================================
-- Migration: 002_create_menu_cart.sql
-- Feature:   Menu & Cart (Member 2)
-- Branch:    feature/menu-cart
-- Applies to: PostgreSQL 15+
-- Synchronized with Member 3, 4, and 5 schemas
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Unified Menu Items Table (Shared with 003, 004, 005)
CREATE TABLE IF NOT EXISTS menu_items (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    description     TEXT NULL,                       -- Added for Member 3
    category        VARCHAR(100) NOT NULL,
    price           NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    stock_qty       INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
    max_order_qty   INTEGER NOT NULL DEFAULT 10 CHECK (max_order_qty > 0),
    active          BOOLEAN NOT NULL DEFAULT TRUE,   -- Unified name (is_available mapped here)
    image_url       VARCHAR(255) NULL,               -- Added for Member 3
    reserved_count  INTEGER NOT NULL DEFAULT 0,      -- Added for Member 3
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unified Vouchers Table (Shared with 003)
DROP TABLE IF EXISTS vouchers CASCADE;
CREATE TABLE vouchers (
    id              SERIAL PRIMARY KEY,
    code            VARCHAR(50) NOT NULL UNIQUE,
    discount_type   VARCHAR(20) NOT NULL DEFAULT 'flat',
    discount_value  NUMERIC(10,2) NOT NULL DEFAULT 0,
    discount        NUMERIC(10,2) NOT NULL DEFAULT 0,
    min_order       NUMERIC(10,2) NOT NULL DEFAULT 0,
    max_uses        INTEGER NOT NULL DEFAULT 1,
    used_count      INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_by         UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cart sessions table (Member 2 version)
CREATE TABLE IF NOT EXISTS cart_sessions (
    id              SERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    items           JSONB NOT NULL DEFAULT '[]',
    locked_at       TIMESTAMPTZ NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Performance Indexes (FR10 — search < 1 second)
CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category);
CREATE INDEX IF NOT EXISTS idx_menu_items_active   ON menu_items(active);
CREATE INDEX IF NOT EXISTS idx_cart_sessions_user  ON cart_sessions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers(code);

-- Full-text search index on menu item name (FR10)
CREATE INDEX IF NOT EXISTS idx_menu_items_name_fts ON menu_items USING GIN(to_tsvector('english', name));