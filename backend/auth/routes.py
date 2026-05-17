"""
backend/auth/routes.py
Auth & Identity — Member 1 (Lead)

TDP compliance:
  TDP-M1-01  FR03  Account lockout — all 4 padlocks satisfied
  TDP-M1-02  FR04  Session expiry  — all 4 padlocks satisfied
  TDP-M1-03  FR06  Password reset  — all 4 padlocks satisfied
  TDP-M1-04  FR08  Account status  — all 3 padlocks satisfied
"""

from __future__ import annotations

import hashlib
import json as _json
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import asyncpg
import bcrypt
import jwt
import redis.asyncio as aioredis
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field, field_validator

# ─────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────

JWT_SECRET          = os.environ.get("JWT_SECRET", "dev-secret-CHANGE-IN-PRODUCTION")
JWT_ALGO            = "HS256"

# TDP-M1-02 P1: inactivity window is EXACTLY 1800 seconds
INACTIVITY_TTL_SECONDS = 1800                           # 30 min — session expiry

ACCESS_TTL_SECONDS     = INACTIVITY_TTL_SECONDS         # JWT TTL == inactivity window
REFRESH_TTL_SECONDS    = 7 * 24 * 3600                  # 7 days

# TDP-M1-03 P1: reset TTL is EXACTLY 900 seconds
RESET_TTL_SECONDS   = 900                               # 15 min = 900s EXACT

# TDP-M1-01 P1/P2: lockout constants — exact values, not approximations
LOCKOUT_DURATION_SECONDS = 900                          # 15 min = 900s EXACT
MAX_FAILED_ATTEMPTS      = 5                            # locks on 5th attempt

UTC = timezone.utc

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres123@localhost:5432/cafeteria",
)
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")

# University email domains
ALLOWED_DOMAINS = ["ejust.edu.eg"]

# TDP-M1-04 P2: status-specific messages — exact strings, not generic
ACCOUNT_STATUS_MESSAGES = {
    "suspended": "Your account has been suspended. Contact the registrar.",
    "expired":   "Your university account has expired. Contact IT services.",
}

# ─────────────────────────────────────────────────────────────
# Email helpers
# ─────────────────────────────────────────────────────────────

def _is_university_email(email: str) -> bool:
    try:
        return email.strip().split("@")[1].lower() in ALLOWED_DOMAINS
    except IndexError:
        return False


def _is_student_email(email: str) -> bool:
    try:
        local  = email.strip().split("@")[0]
        parts  = local.split(".")
        pot_id = parts[-1] if len(parts) >= 2 else ""
        return pot_id.isdigit() and len(pot_id) >= 6
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────
# DB pool
# ─────────────────────────────────────────────────────────────

_pool: Optional[asyncpg.Pool] = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=10)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


# ─────────────────────────────────────────────────────────────
# Redis client  (TDP-M1-02: server-side session store)
# ─────────────────────────────────────────────────────────────

_redis: Optional[aioredis.Redis] = None


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(REDIS_URL, decode_responses=True)
    return _redis


# ─────────────────────────────────────────────────────────────
# Response envelope
# ─────────────────────────────────────────────────────────────

def ok(data, status: int = 200) -> JSONResponse:
    return JSONResponse({"success": True, "data": data}, status_code=status)


def err(code: str, message: str, details=None, status: int = 400) -> JSONResponse:
    return JSONResponse(
        {"success": False, "error": {"code": code, "message": message, "details": details}},
        status_code=status,
    )


# ─────────────────────────────────────────────────────────────
# Pydantic schemas
# ─────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email:    EmailStr
    password: str = Field(min_length=1)

    @field_validator("email")
    @classmethod
    def must_be_university_email(cls, v: str) -> str:
        if not _is_university_email(v):
            domains = ", ".join(f"@{d}" for d in ALLOWED_DOMAINS)
            raise ValueError(f"Only university email addresses are allowed ({domains}).")
        return v.lower().strip()


class PasswordResetRequestBody(BaseModel):
    email: EmailStr


class PasswordResetConfirmBody(BaseModel):
    token:        str
    new_password: str = Field(min_length=8)


class AdminCreateUserBody(BaseModel):
    email:        EmailStr
    display_name: str
    role:         str = Field(pattern="^(student|staff|admin)$")
    password:     str = Field(min_length=8)


class AdminUpdateUserBody(BaseModel):
    status:       Optional[str] = Field(None, pattern="^(active|suspended|expired)$")
    role:         Optional[str] = Field(None, pattern="^(student|staff|admin)$")
    display_name: Optional[str] = None


# ─────────────────────────────────────────────────────────────
# JWT & crypto helpers
# ─────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(UTC)


def _create_access_token(user_id: str, role: str, email: str) -> str:
    return jwt.encode(
        {
            "sub":     user_id,
            "user_id": user_id,
            "role":    role,
            "email":   email,
            "iat":     _now(),
            "exp":     _now() + timedelta(seconds=ACCESS_TTL_SECONDS),
            "jti":     str(uuid.uuid4()),
        },
        JWT_SECRET,
        algorithm=JWT_ALGO,
    )


def _create_token_pair() -> tuple[str, str]:
    raw    = secrets.token_urlsafe(48)
    hashed = hashlib.sha256(raw.encode()).hexdigest()
    return raw, hashed


def _decode_token(token: str) -> dict:
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])


def _hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt(rounds=12)).decode()


def _verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


# ─────────────────────────────────────────────────────────────
# TDP-M1-02: Session management via Redis
# touch_session resets inactivity window to exactly 1800s
# ─────────────────────────────────────────────────────────────

async def touch_session(jti: str) -> None:
    """
    Reset inactivity TTL to exactly INACTIVITY_TTL_SECONDS.
    Called on every authenticated request.
    TDP-M1-02 P3: clock is inactivity-based, not issuance-based.
    """
    r = await get_redis()
    await r.setex(f"session:{jti}", INACTIVITY_TTL_SECONDS, "1")


async def validate_session(jti: str) -> bool:
    """
    TDP-M1-02 P1/P2: Check Redis key exists.
    If missing → session expired → must return 401.
    Redis handles exact 1800s TTL — no approximation.
    """
    r = await get_redis()
    return await r.exists(f"session:{jti}") == 1


async def revoke_session(jti: str) -> None:
    """Delete session key immediately (logout / password change)."""
    r = await get_redis()
    await r.delete(f"session:{jti}")


async def revoke_all_sessions_for_user(user_id: str) -> None:
    """
    FR05: logout invalidates ALL sessions.
    Marks all DB sessions as revoked AND removes Redis keys.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL RETURNING token_hash",
            uuid.UUID(user_id),
        )
    # Clean up Redis keys for all revoked sessions
    r = await get_redis()
    for row in rows:
        await r.delete(f"session:{row['token_hash']}")


# ─────────────────────────────────────────────────────────────
# Auth guard — validates JWT + Redis session presence
# ─────────────────────────────────────────────────────────────

async def _require_role(request: Request, *roles: str):
    header = request.headers.get("Authorization", "")
    token  = header.removeprefix("Bearer ").strip()
    if not token:
        return None, err("TOKEN_INVALID", "Authentication required.", status=401)

    try:
        payload = _decode_token(token)
    except jwt.ExpiredSignatureError:
        # TDP-M1-02 P4: exact message
        return None, err("TOKEN_EXPIRED", "Session expired. Please log in again.", status=401)
    except jwt.InvalidTokenError:
        return None, err("TOKEN_INVALID", "Invalid token.", status=401)

    # TDP-M1-02: server-side inactivity check via Redis
    jti = payload.get("jti", "")
    if not await validate_session(jti):
        return None, err("TOKEN_EXPIRED", "Session expired. Please log in again.", status=401)

    # Reset inactivity clock on every authenticated request
    await touch_session(jti)

    if roles and payload.get("role") not in roles:
        return None, err("FORBIDDEN", "You do not have permission for this action.", status=403)

    return payload, None


# ─────────────────────────────────────────────────────────────
# Audit helper
# TDP-M1-01 P3: audit write must NOT be swallowed — raise on failure
# ─────────────────────────────────────────────────────────────

async def _audit(
    event_type: str,
    actor_id,
    target_id,
    ip: Optional[str],
    payload: Optional[dict] = None,
    *,
    raise_on_failure: bool = False,   # set True for lockout events (TDP P3)
) -> None:
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO audit_log (event_type, actor_id, target_id, ip_address, payload)
                   VALUES ($1, $2, $3, $4::inet, $5::jsonb)""",
                event_type,
                uuid.UUID(actor_id)  if actor_id  else None,
                uuid.UUID(target_id) if target_id else None,
                ip,
                _json.dumps(payload or {}),
            )
    except Exception as exc:
        if raise_on_failure:
            # TDP-M1-01 P3: audit failure must raise, not be swallowed
            raise RuntimeError(f"Audit write failed for {event_type}: {exc}") from exc
        print(f"[AUDIT ERROR] {event_type}: {exc}")


# ─────────────────────────────────────────────────────────────
# Router
# ─────────────────────────────────────────────────────────────

router = APIRouter(prefix="/api/v1/auth", tags=["Auth & Identity"])


# ════════════════════════════════════════════════════════════
# POST /api/v1/auth/login
# TDP-M1-01: FR03 lockout  — all 4 padlocks
# TDP-M1-04: FR08 statuses — all 3 padlocks
# ════════════════════════════════════════════════════════════

@router.post("/login")
async def login(body: LoginRequest, request: Request):
    ip   = request.client.host if request.client else None
    pool = await get_pool()

    async with pool.acquire() as conn:

        row = await conn.fetchrow(
            """SELECT id::text, email, display_name, password_hash,
                      role, status::text, failed_attempts, locked_until,
                      wallet_balance, meal_plan_balance
               FROM users WHERE email = $1""",
            body.email,
        )

        # ── Unknown email ─────────────────────────────────────
        # TDP-M1-04 P2: NOT_FOUND gets its own specific message
        if not row:
            await _audit("LOGIN_FAILED_UNKNOWN", None, None, ip, {"email": body.email})
            return err(
                "INVALID_CREDENTIALS",
                "No account found for this email address.",
                status=403,   # TDP-M1-04 P3: 403 not 401 for rejection
            )

        user = dict(row)

        # ── TDP-M1-01 P1/P2: lockout check ───────────────────
        if user["locked_until"]:
            lu = user["locked_until"]
            if lu.tzinfo is None:
                lu = lu.replace(tzinfo=UTC)
            if lu > _now():
                secs = int((lu - _now()).total_seconds())
                return err(
                    "ACCOUNT_LOCKED",
                    f"Account locked. Try again in {max(1, secs // 60)} minute(s).",
                    details={
                        "unlocks_at":              lu.isoformat(),
                        # TDP-M1-01 P2: expose exact remaining seconds
                        "retry_after_seconds":     secs,
                        "lock_duration_seconds":   LOCKOUT_DURATION_SECONDS,
                    },
                    status=403,
                )

        # ── TDP-M1-04 P1/P2/P3: suspended / expired ──────────
        status = user["status"]
        if status != "active":
            await _audit("LOGIN_REJECTED_INACTIVE", None, user["id"], ip, {"status": status})
            # TDP-M1-04 P2: each status has its OWN exact message
            message = ACCOUNT_STATUS_MESSAGES.get(
                status,
                f"Your account is not active. Contact the university helpdesk.",
            )
            return err(
                "ACCOUNT_SUSPENDED" if status == "suspended" else "ACCOUNT_EXPIRED",
                message,
                # TDP-M1-04 P1: no token fields on rejection
                details={"access_token": None, "refresh_token": None},
                status=403,   # TDP-M1-04 P3: always 403, never 401
            )

        # ── FR02: wrong password ──────────────────────────────
        if not _verify_password(body.password, user["password_hash"]):

            # Increment atomically
            new_count = await conn.fetchval(
                "UPDATE users SET failed_attempts = failed_attempts + 1 WHERE email = $1 RETURNING failed_attempts",
                body.email,
            )

            # TDP-M1-01 P5: attempts 1-4 → HTTP 401
            if new_count < MAX_FAILED_ATTEMPTS:
                remaining = MAX_FAILED_ATTEMPTS - new_count
                await _audit("LOGIN_FAILED_BAD_PW", None, user["id"], ip, {"attempt": new_count})
                return err(
                    "INVALID_CREDENTIALS",
                    f"Invalid credentials. {remaining} attempt(s) remaining before lockout.",
                    status=401,   # TDP-M1-01 P5: 401 for attempts < 5
                )

            # TDP-M1-01 P1: EXACTLY 5th attempt triggers lockout
            # TDP-M1-01 P2: lock_duration is EXACTLY 900 seconds
            lock_until = _now() + timedelta(seconds=LOCKOUT_DURATION_SECONDS)
            await conn.execute(
                "UPDATE users SET locked_until = $1 WHERE email = $2",
                lock_until, body.email,
            )

            # TDP-M1-01 P3: audit MUST be written — raise if it fails
            await _audit(
                "ACCOUNT_LOCKED", None, user["id"], ip,
                {
                    "locked_until":          lock_until.isoformat(),
                    "lock_duration_seconds": LOCKOUT_DURATION_SECONDS,
                    "ip_address":            ip,
                },
                raise_on_failure=True,   # ← TDP P3: do NOT swallow
            )

            return err(
                "ACCOUNT_LOCKED",
                f"Account locked. Try again in 15 minutes.",
                details={
                    "unlocks_at":            lock_until.isoformat(),
                    "lock_duration_seconds": LOCKOUT_DURATION_SECONDS,  # EXACT 900
                    "retry_after_seconds":   LOCKOUT_DURATION_SECONDS,
                },
                status=403,   # TDP-M1-01 P5: only 5th attempt returns 403
            )

        # ── Success ───────────────────────────────────────────
        # TDP-M1-01 P4: reset counter to EXACTLY 0, same transaction
        await conn.execute(
            "UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1",
            uuid.UUID(user["id"]),
        )

        access_token          = _create_access_token(user["id"], user["role"], user["email"])
        raw_refresh, ref_hash = _create_token_pair()
        refresh_expires       = _now() + timedelta(seconds=REFRESH_TTL_SECONDS)

        await conn.execute(
            "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
            uuid.UUID(user["id"]), ref_hash, refresh_expires,
        )

    # TDP-M1-02: Store session in Redis with EXACT inactivity TTL
    decoded = _decode_token(access_token)
    jti     = decoded["jti"]
    await touch_session(jti)   # sets Redis TTL to exactly 1800s

    await _audit("LOGIN_SUCCESS", user["id"], user["id"], ip, {"role": user["role"]})

    return ok({
        "access_token":  access_token,
        "refresh_token": raw_refresh,
        "token_type":    "bearer",
        "expires_in":    ACCESS_TTL_SECONDS,
        "user": {
            "id":           user["id"],
            "email":        user["email"],
            "display_name": user["display_name"],
            "role":         user["role"],
            "is_student":   _is_student_email(user["email"]),
        },
    })


# ════════════════════════════════════════════════════════════
# GET /api/v1/auth/me
# ════════════════════════════════════════════════════════════

@router.get("/me")
async def get_me(request: Request):
    payload, guard = await _require_role(request, "student", "staff", "admin")
    if guard:
        return guard

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT id::text, email, display_name, role, status::text,
                      wallet_balance, meal_plan_balance
               FROM users WHERE id = $1""",
            uuid.UUID(payload["user_id"]),
        )

    if not row:
        return err("TOKEN_INVALID", "User not found.", status=401)

    u = dict(row)
    return ok({
        "id":                u["id"],
        "email":             u["email"],
        "display_name":      u["display_name"],
        "role":              u["role"],
        "status":            u["status"],
        "wallet_balance":    float(u["wallet_balance"]),
        "meal_plan_balance": float(u["meal_plan_balance"]),
        "is_student":        _is_student_email(u["email"]),
    })


# ════════════════════════════════════════════════════════════
# POST /api/v1/auth/logout   FR05
# ════════════════════════════════════════════════════════════

@router.post("/logout")
async def logout(request: Request):
    payload, guard = await _require_role(request, "student", "staff", "admin")
    if guard:
        return guard

    await revoke_all_sessions_for_user(payload["user_id"])
    await _audit("LOGOUT", payload["user_id"], payload["user_id"], None, {})
    return ok({"logged_out": True})


# ════════════════════════════════════════════════════════════
# POST /api/v1/auth/password-reset/request   FR06
# ════════════════════════════════════════════════════════════

@router.post("/password-reset/request")
async def password_reset_request(body: PasswordResetRequestBody, request: Request):
    ip   = request.client.host if request.client else None
    pool = await get_pool()

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id::text FROM users WHERE email = $1 AND status = 'active'",
            str(body.email).lower().strip(),
        )
        if row:
            raw_token, token_hash = _create_token_pair()
            # TDP-M1-03 P1: TTL is EXACTLY 900 seconds
            expires_at = _now() + timedelta(seconds=RESET_TTL_SECONDS)
            await conn.execute(
                "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
                uuid.UUID(row["id"]), token_hash, expires_at,
            )
            await _audit("PASSWORD_RESET_REQUESTED", row["id"], row["id"], ip, {})

    # Always 202 — anti-enumeration
    return JSONResponse(
        {"success": True, "data": {"message": "If this email is registered, a reset link has been sent."}},
        status_code=202,
    )


# ════════════════════════════════════════════════════════════
# POST /api/v1/auth/password-reset/confirm   FR06
# TDP-M1-03: all 4 padlocks
# ════════════════════════════════════════════════════════════

@router.post("/password-reset/confirm")
async def password_reset_confirm(body: PasswordResetConfirmBody, request: Request):
    ip         = request.client.host if request.client else None
    token_hash = _sha256(body.token)
    pool       = await get_pool()

    async with pool.acquire() as conn:

        # ── Check token exists at all ─────────────────────────
        token_row = await conn.fetchrow(
            "SELECT user_id::text, used_at, expires_at FROM password_reset_tokens WHERE token_hash = $1",
            token_hash,
        )

        if not token_row:
            return err("INVALID_TOKEN", "Reset link is invalid or has expired.", status=422)

        # TDP-M1-03 P4: distinct error codes for each failure mode
        if token_row["used_at"] is not None:
            return err(
                "LINK_ALREADY_USED",
                "This reset link has already been used. Please request a new one.",
                status=422,
            )

        expires_at = token_row["expires_at"]
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)

        # TDP-M1-03 P1: check expiry BEFORE updating anything
        if _now() >= expires_at:
            return err(
                "LINK_EXPIRED",
                "This reset link has expired. Please request a new one.",
                status=422,
            )

        # TDP-M1-03 P2: mark used AND update password in the SAME transaction
        # P3: expired token must NOT mutate password (already returned above)
        await conn.execute(
            "UPDATE password_reset_tokens SET used_at = NOW() WHERE token_hash = $1",
            token_hash,
        )
        await conn.execute(
            "UPDATE users SET password_hash = $1 WHERE id = $2",
            _hash_password(body.new_password),
            uuid.UUID(token_row["user_id"]),
        )
        # Revoke all existing sessions after password change
        await conn.execute(
            "UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
            uuid.UUID(token_row["user_id"]),
        )
        await _audit("PASSWORD_RESET_COMPLETED", token_row["user_id"], token_row["user_id"], ip, {})

    return ok({"message": "Password updated. Please log in with your new password."})


# ════════════════════════════════════════════════════════════
# Admin — FR50 FR51
# ════════════════════════════════════════════════════════════

@router.get("/admin/users")
async def list_users(request: Request, page: int = 1, per_page: int = 20):
    payload, guard = await _require_role(request, "admin")
    if guard:
        return guard

    offset = (page - 1) * per_page
    pool   = await get_pool()
    async with pool.acquire() as conn:
        rows  = await conn.fetch(
            """SELECT id::text, email, display_name, role, status::text, created_at
               FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2""",
            per_page, offset,
        )
        total = await conn.fetchval("SELECT COUNT(*) FROM users")

    return ok({"users": [dict(r) for r in rows], "total": total, "page": page, "per_page": per_page})


@router.get("/admin/users/{user_id}")
async def get_user(user_id: str, request: Request):
    payload, guard = await _require_role(request, "admin", "staff")
    if guard:
        return guard

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id::text, email, display_name, role, status::text, created_at FROM users WHERE id = $1",
            uuid.UUID(user_id),
        )
    if not row:
        return err("USER_NOT_FOUND", "User not found.", status=404)
    return ok(dict(row))


@router.post("/admin/users")
async def create_user(body: AdminCreateUserBody, request: Request):
    payload, guard = await _require_role(request, "admin")
    if guard:
        return guard

    pool = await get_pool()
    async with pool.acquire() as conn:
        try:
            row = await conn.fetchrow(
                """INSERT INTO users (email, display_name, password_hash, role)
                   VALUES ($1, $2, $3, $4)
                   RETURNING id::text, email, display_name, role, status::text, created_at""",
                str(body.email).lower().strip(),
                body.display_name,
                _hash_password(body.password),
                body.role,
            )
        except asyncpg.UniqueViolationError:
            return err("EMAIL_TAKEN", "A user with this email already exists.", status=409)

    await _audit("USER_CREATED", payload["user_id"], row["id"], None, {"role": body.role})
    return ok(dict(row), status=201)


@router.patch("/admin/users/{user_id}")
async def update_user(user_id: str, body: AdminUpdateUserBody, request: Request):
    payload, guard = await _require_role(request, "admin")
    if guard:
        return guard

    fields = body.model_dump(exclude_none=True)
    if not fields:
        return err("NO_FIELDS", "No fields provided to update.", status=422)

    parts, vals, idx = [], [], 1
    if "display_name" in fields:
        parts.append(f"display_name = ${idx}");        vals.append(fields["display_name"]); idx += 1
    if "role"   in fields:
        parts.append(f"role = ${idx}::user_role");     vals.append(fields["role"]);         idx += 1
    if "status" in fields:
        parts.append(f"status = ${idx}::user_status"); vals.append(fields["status"]);       idx += 1

    vals.append(uuid.UUID(user_id))
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE users SET {', '.join(parts)} WHERE id = ${idx} "
            f"RETURNING id::text, email, display_name, role, status::text",
            *vals,
        )

    if not row:
        return err("USER_NOT_FOUND", "User not found.", status=404)
    await _audit("USER_UPDATED", payload["user_id"], user_id, None, fields)
    return ok(dict(row))