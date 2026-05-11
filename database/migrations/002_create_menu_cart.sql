-- Migration: 002_create_menu_cart.sql
-- Owner: Member 2 (Menu & Cart)

-- Menu items table
CREATE TABLE menu_items (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    category    VARCHAR(100) NOT NULL,
    price       NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    stock_qty   INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
    max_order_qty INTEGER NOT NULL DEFAULT 10 CHECK (max_order_qty > 0),
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Vouchers table
CREATE TABLE vouchers (
    id          SERIAL PRIMARY KEY,
    code        VARCHAR(50) NOT NULL UNIQUE,
    discount    NUMERIC(10,2) NOT NULL CHECK (discount > 0),
    min_order   NUMERIC(10,2) NOT NULL DEFAULT 0,
    expires_at  TIMESTAMP NOT NULL,
    used_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Cart sessions table
CREATE TABLE cart_sessions (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    items       JSONB NOT NULL DEFAULT '[]',
    locked_at   TIMESTAMP,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for performance (FR10 — search < 1 second)
CREATE INDEX idx_menu_items_category ON menu_items(category);
CREATE INDEX idx_menu_items_active   ON menu_items(active);
CREATE INDEX idx_cart_sessions_user  ON cart_sessions(user_id);
CREATE UNIQUE INDEX idx_vouchers_code ON vouchers(code);

-- Full-text search index on menu item name (FR10)
CREATE INDEX idx_menu_items_name_fts ON menu_items USING GIN(to_tsvector('english', name));

-- Rollback (down)
-- DROP TABLE IF EXISTS cart_sessions;
-- DROP TABLE IF EXISTS vouchers;
-- DROP TABLE IF EXISTS menu_items;