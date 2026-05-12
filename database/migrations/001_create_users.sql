-- ============================================================
-- Migration: 001_create_users.sql
-- Feature:   Auth & Identity  (Member 1 — Lead)
-- Branch:    feature/auth-identity
-- Applies to: PostgreSQL 15+
-- ============================================================

-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- ENUM TYPES
-- ============================================================

CREATE TYPE user_role   AS ENUM ('student', 'staff', 'admin');
CREATE TYPE user_status AS ENUM ('active', 'suspended', 'expired');

-- ============================================================
-- TABLE: users
-- Stores university members. Passwords hashed with bcrypt(cost=12).
-- Plaintext passwords NEVER stored (NFR13).
-- ============================================================

CREATE TABLE users (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    email            VARCHAR(255) NOT NULL UNIQUE,          -- university email only
    display_name     VARCHAR(120) NOT NULL,
    password_hash    VARCHAR(72)  NOT NULL,                 -- bcrypt output; max 72 bytes
    role             user_role    NOT NULL DEFAULT 'student',
    status           user_status  NOT NULL DEFAULT 'active',

    -- FR03: lockout mechanism
    failed_attempts  SMALLINT     NOT NULL DEFAULT 0,
    locked_until     TIMESTAMPTZ  NULL,                     -- NULL = not locked

    -- wallet / meal plan balances (owned by auth slice per api-contracts.md)
    wallet_balance   NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    meal_plan_balance NUMERIC(10,2) NOT NULL DEFAULT 0.00,

    -- audit timestamps
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- index for fast login lookups
CREATE INDEX idx_users_email ON users (email);

-- ============================================================
-- TABLE: sessions
-- One row per issued JWT refresh token.
-- Access tokens are stateless; only refresh tokens are tracked.
-- FR05: logout invalidates ALL sessions for the user.
-- ============================================================

CREATE TABLE sessions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   CHAR(64)    NOT NULL UNIQUE,   -- SHA-256 of the refresh token
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at   TIMESTAMPTZ NULL                -- NULL = still valid
);

CREATE INDEX idx_sessions_user_id    ON sessions (user_id);
CREATE INDEX idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);  -- cleanup job

-- ============================================================
-- TABLE: password_reset_tokens
-- FR06: time-limited reset links (TTL = 15 min, single-use).
-- ============================================================

CREATE TABLE password_reset_tokens (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash CHAR(64)    NOT NULL UNIQUE,   -- SHA-256 of the URL token
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ NULL               -- NULL = unused
);

CREATE INDEX idx_prt_user_id    ON password_reset_tokens (user_id);
CREATE INDEX idx_prt_token_hash ON password_reset_tokens (token_hash);

-- ============================================================
-- TABLE: audit_log  (append-only — no UPDATE or DELETE)
-- NFR20, NFR31, NFR32: immutable audit trail for financial auditors.
-- 2-year retention enforced at application level.
-- ============================================================

CREATE TABLE audit_log (
    id          BIGSERIAL    PRIMARY KEY,
    event_type  VARCHAR(80)  NOT NULL,   -- e.g. LOGIN_SUCCESS, ACCOUNT_LOCKED, ROLE_CHANGED
    actor_id    UUID         NULL,       -- NULL for anonymous/system events
    target_id   UUID         NULL,       -- the user or resource affected
    ip_address  INET         NULL,
    user_agent  TEXT         NULL,
    payload     JSONB        NULL,       -- additional context (no passwords/secrets)
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Prevent any modifications to audit rows (trigger-level enforcement)
CREATE OR REPLACE RULE audit_log_no_delete AS
    ON DELETE TO audit_log DO INSTEAD NOTHING;

CREATE OR REPLACE RULE audit_log_no_update AS
    ON UPDATE TO audit_log DO INSTEAD NOTHING;

-- index for time-range queries used by admin reports
CREATE INDEX idx_audit_log_created_at  ON audit_log (created_at DESC);
CREATE INDEX idx_audit_log_actor_id    ON audit_log (actor_id);
CREATE INDEX idx_audit_log_event_type  ON audit_log (event_type);

-- ============================================================
-- FUNCTION: auto-update updated_at on users
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SEED: one admin account for initial setup
-- Password: Admin@1234  — MUST be changed before production
-- bcrypt hash (cost=12) generated offline — never store plaintext
-- ============================================================

INSERT INTO users (email, display_name, password_hash, role, status)
VALUES (
    'admin@university.edu',
    'System Administrator',
    '$2b$12$PLACEHOLDER_CHANGE_BEFORE_PRODUCTION_HASH_HERE_XXXXXX',
    'admin',
    'active'
);

-- ============================================================
-- COMMENTS (data dictionary for auditors)
-- ============================================================

COMMENT ON TABLE  users                      IS 'University members: students, staff, and admins.';
COMMENT ON COLUMN users.password_hash        IS 'bcrypt(cost=12). Plaintext never stored (NFR13).';
COMMENT ON COLUMN users.failed_attempts      IS 'Resets to 0 on successful login (FR03).';
COMMENT ON COLUMN users.locked_until         IS 'Lock duration: 15 minutes per FR03.';

COMMENT ON TABLE  sessions                   IS 'Refresh token registry. Logout invalidates all rows for user_id (FR05).';
COMMENT ON COLUMN sessions.token_hash        IS 'SHA-256 of raw refresh token. Raw token is returned to client once, never stored.';

COMMENT ON TABLE  password_reset_tokens      IS 'Single-use, 15-minute TTL tokens for FR06 password reset flow.';

COMMENT ON TABLE  audit_log                  IS 'Append-only audit trail. UPDATE and DELETE are blocked by rules. Retained 2 years (NFR31).';
