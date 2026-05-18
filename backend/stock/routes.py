"""
backend/stock/routes.py
Stock & Resilience — Member 4
Branch: feature/stock-resilience

Covers:
  FR11  — Out-of-stock indicator on menu
  FR19  — Per-item max order quantity cap
  FR21  — Real-time stock availability check at checkout
  FR22  — Pessimistic stock lock (10-min TTL)
  FR24  — Unrealistic order detection → admin review queue
  FR25  — Circuit breaker: reject orders when load > threshold
  FR40  — Auto-cancel PAYMENT_PENDING orders after 10 min (releases locks)
  FR41  — Stock drift detection & admin notification
  FR54  — Runtime system config (thresholds, TTLs)
  NFR10 — Indexed queries; stock_summary view
  NFR11 — SELECT FOR UPDATE NOWAIT for concurrent lock safety
  NFR22 — ACID transactions for all stock operations
"""

from __future__ import annotations

import json as _json
import os
import uuid
from datetime import datetime, timezone
from typing import List, Optional
from fastapi.encoders import jsonable_encoder
import asyncpg
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

# ─────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres123@localhost:5432/cafeteria",
)

JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret-CHANGE-IN-PRODUCTION")
JWT_ALGO   = "HS256"
UTC        = timezone.utc

# ─────────────────────────────────────────────────────────────
# DB pool
# ─────────────────────────────────────────────────────────────

_pool: Optional[asyncpg.Pool] = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=20)
    return _pool


# ─────────────────────────────────────────────────────────────
# Response envelope
# ─────────────────────────────────────────────────────────────

def ok(data, status=200):
    return JSONResponse({"success": True, "data": jsonable_encoder(data)}, status_code=status)


def err(code: str, message: str, details=None, status: int = 400) -> JSONResponse:
    return JSONResponse(
        {"success": False, "error": {"code": code, "message": message, "details": details}},
        status_code=status,
    )


# ─────────────────────────────────────────────────────────────
# Auth guard (mirrors auth/routes.py pattern)
# ─────────────────────────────────────────────────────────────

import jwt as _jwt


async def _require_role(request: Request, *roles: str):
    header = request.headers.get("Authorization", "")
    token  = header.removeprefix("Bearer ").strip()
    if not token:
        return None, err("TOKEN_INVALID", "Authentication required.", status=401)
    try:
        payload = _jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except _jwt.ExpiredSignatureError:
        return None, err("TOKEN_EXPIRED", "Session expired. Please log in again.", status=401)
    except _jwt.InvalidTokenError:
        return None, err("TOKEN_INVALID", "Invalid token.", status=401)
    if roles and payload.get("role") not in roles:
        return None, err("FORBIDDEN", "You do not have permission for this action.", status=403)
    return payload, None


# ─────────────────────────────────────────────────────────────
# Audit helper
# ─────────────────────────────────────────────────────────────

async def _audit(event_type: str, actor_id, target_id, ip, payload=None) -> None:
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
        print(f"[AUDIT ERROR] {event_type}: {exc}")


# ─────────────────────────────────────────────────────────────
# Config cache (FR54 — live reload within 60 seconds)
# ─────────────────────────────────────────────────────────────

_config_cache: dict = {}
_config_loaded_at: float = 0.0
CONFIG_TTL_SECONDS = 60


async def _get_config(key: str, default=None):
    """Load config from DB, cached for 60 seconds (FR54) with safety fallbacks."""
    import time
    global _config_cache, _config_loaded_at
    if time.time() - _config_loaded_at > CONFIG_TTL_SECONDS:
        try:
            pool = await get_pool()
            async with pool.acquire() as conn:
                rows = await conn.fetch("SELECT key, value FROM system_config")
                _config_cache = {r["key"]: r["value"] for r in rows}
            _config_loaded_at = time.time()
        except Exception:
            # Safety fallback defaults if database table is initializing or unreachable
            _config_cache = {
                "max_concurrent_orders": "150",
                "unrealistic_qty_threshold": "10",
                "unrealistic_total_threshold": "500",
                "stock_lock_ttl_minutes": "10",
                "flagged_order_ttl_minutes": "60"
            }
            _config_loaded_at = time.time()
    return _config_cache.get(key, default)


# ─────────────────────────────────────────────────────────────
# Pydantic schemas
# ─────────────────────────────────────────────────────────────

class LockRequest(BaseModel):
    """Request body for acquiring stock locks at order placement."""
    order_id: str
    items: List[dict]  # [{"menu_item_id": int, "quantity": int}, ...]

    @field_validator("order_id")
    @classmethod
    def validate_uuid(cls, v: str) -> str:
        uuid.UUID(v)  # raises ValueError if invalid
        return v


class ReleaseRequest(BaseModel):
    order_id: str
    deduct: bool = False  # True = payment succeeded; False = failed / cancelled
    reason: str = "PAYMENT_SUCCESS"

    @field_validator("order_id")
    @classmethod
    def validate_uuid(cls, v: str) -> str:
        uuid.UUID(v)
        return v


class RestockRequest(BaseModel):
    quantity: int = Field(gt=0)
    note: Optional[str] = None


class CorrectionRequest(BaseModel):
    new_quantity: int = Field(ge=0)
    note: str = Field(min_length=5, description="Mandatory reason for correction (FR41)")


class ConfigUpdateRequest(BaseModel):
    value: str
    description: Optional[str] = None


class FlaggedOrderReviewRequest(BaseModel):
    action: str = Field(pattern="^(approve|reject)$")
    reason: Optional[str] = None

    @field_validator("reason")
    @classmethod
    def reason_required_for_reject(cls, v, info):
        if info.data.get("action") == "reject" and not v:
            raise ValueError("reason is required when rejecting a flagged order")
        return v


# ─────────────────────────────────────────────────────────────
# Router
# ─────────────────────────────────────────────────────────────

router = APIRouter(prefix="/api/v1/stock", tags=["Stock & Resilience"])


# ══════════════════════════════════════════════════════════════
# GET /api/v1/stock/availability
# Real-time stock summary for menu display (FR11)
# Used by frontend to show out-of-stock badges.
# ══════════════════════════════════════════════════════════════

@router.get("/availability")
async def get_stock_availability(request: Request):
    """
    Returns available_qty for all active menu items.
    Uses the stock_summary view: total_qty minus active lock quantities.
    FR11: items with available_qty <= 0 are shown as out of stock.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT menu_item_id, item_name, total_qty, locked_qty,
                      available_qty, max_order_qty, active
               FROM stock_summary
               WHERE active = TRUE
               ORDER BY item_name"""
        )
    return ok([dict(r) for r in rows])


# ══════════════════════════════════════════════════════════════
# GET /api/v1/stock/availability/{menu_item_id}
# Single item availability check
# ══════════════════════════════════════════════════════════════

@router.get("/availability/{menu_item_id}")
async def get_item_availability(menu_item_id: int, request: Request):
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT menu_item_id, item_name, total_qty, locked_qty,
                      available_qty, max_order_qty, active
               FROM stock_summary WHERE menu_item_id = $1""",
            menu_item_id,
        )
    if not row:
        return err("ITEM_NOT_FOUND", "Menu item not found.", status=404)
    return ok(dict(row))


# ══════════════════════════════════════════════════════════════
# POST /api/v1/stock/check
# FR21: Validate cart items availability before order placement.
# Does NOT acquire locks — call /lock to lock.
# ══════════════════════════════════════════════════════════════

@router.post("/check")
async def check_availability(body: LockRequest, request: Request):
    """
    Checks real-time availability for all items in a prospective order.
    Returns itemised result: each item marked available or not.
    Also checks FR24 thresholds (flags suspicious orders but does not block).
    FR25: circuit breaker check — returns 503 if load threshold exceeded.
    """
    # FR25 — circuit breaker
    max_concurrent = int(await _get_config("max_concurrent_orders", 150))
    pool = await get_pool()
    async with pool.acquire() as conn:
        active_orders = await conn.fetchval(
            """SELECT COUNT(*) FROM orders
               WHERE status IN ('PLACED', 'PAYMENT_PENDING', 'CONFIRMED', 'PREPARING')"""
        ) if await _table_exists(conn, "orders") else 0

    if active_orders >= max_concurrent:
        return JSONResponse(
            {
                "success": False,
                "error": {
                    "code": "SYSTEM_OVERLOADED",
                    "message": "The cafeteria is experiencing high demand. Please try again in a few minutes.",
                    "details": {"active_orders": active_orders, "limit": max_concurrent},
                },
            },
            status_code=503,
            headers={"Retry-After": "30"},
        )

    unrealistic_qty   = int(await _get_config("unrealistic_qty_threshold", 10))
    unrealistic_total = float(await _get_config("unrealistic_total_threshold", 500))

    results    = []
    all_ok     = True
    order_total = 0.0
    flagged    = False
    flag_reasons = []

    async with pool.acquire() as conn:
        for item in body.items:
            mid = item["menu_item_id"]
            qty = item["quantity"]

            row = await conn.fetchrow(
                """SELECT menu_item_id, item_name, total_qty, locked_qty,
                          available_qty, max_order_qty, active
                   FROM stock_summary WHERE menu_item_id = $1""",
                mid,
            )

            if not row:
                results.append({"menu_item_id": mid, "status": "NOT_FOUND", "available": False})
                all_ok = False
                continue

            r = dict(row)

            # FR19: max quantity cap
            if qty > r["max_order_qty"]:
                results.append({
                    "menu_item_id": mid,
                    "item_name":    r["item_name"],
                    "status":       "MAX_QTY_EXCEEDED",
                    "available":    False,
                    "max_order_qty": r["max_order_qty"],
                    "requested_qty": qty,
                })
                all_ok = False
                continue

            if not r["active"]:
                results.append({"menu_item_id": mid, "item_name": r["item_name"],
                                 "status": "UNAVAILABLE", "available": False})
                all_ok = False
                continue

            if qty > r["available_qty"]:
                results.append({
                    "menu_item_id":  mid,
                    "item_name":     r["item_name"],
                    "status":        "INSUFFICIENT_STOCK",
                    "available":     False,
                    "available_qty": r["available_qty"],
                    "requested_qty": qty,
                })
                all_ok = False
                continue

            # FR24: unrealistic qty check
            if qty > unrealistic_qty:
                flagged = True
                flag_reasons.append(f"Item '{r['item_name']}' quantity {qty} exceeds threshold {unrealistic_qty}")

            # Estimate order total (price from menu_items)
            price_row = await conn.fetchrow("SELECT price FROM menu_items WHERE id = $1", mid)
            if price_row:
                order_total += float(price_row["price"]) * qty

            results.append({
                "menu_item_id":  mid,
                "item_name":     r["item_name"],
                "status":        "AVAILABLE",
                "available":     True,
                "available_qty": r["available_qty"],
                "requested_qty": qty,
            })

    # FR24: total amount check
    if order_total > unrealistic_total:
        flagged = True
        flag_reasons.append(f"Order total {order_total:.2f} EGP exceeds threshold {unrealistic_total:.2f} EGP")

    return ok({
        "all_available":     all_ok,
        "items":             results,
        "flagged":           flagged,
        "flag_reasons":      flag_reasons,
        "estimated_total":   order_total,
        "active_order_count": active_orders,
    })


async def _table_exists(conn, table_name: str) -> bool:
    row = await conn.fetchrow(
        "SELECT to_regclass($1::text) AS t", f"public.{table_name}"
    )
    return row["t"] is not None


# ══════════════════════════════════════════════════════════════
# POST /api/v1/stock/lock
# FR22: Acquire pessimistic stock locks for all order items.
# Called at order placement — before payment.
# NFR11: SELECT FOR UPDATE NOWAIT via DB function.
# NFR22: ACID transaction.
# ══════════════════════════════════════════════════════════════

@router.post("/lock")
async def acquire_locks(body: LockRequest, request: Request):
    """
    Atomically acquires pessimistic stock locks for all items in the order.
    If ANY item fails, ALL locks for this order are rolled back (ACID, NFR22).
    Returns lock details including TTL.
    """
    payload, guard = await _require_role(request, "student", "staff", "admin")
    if guard:
        return guard

    lock_ttl = int(await _get_config("stock_lock_ttl_minutes", 10))
    order_id = body.order_id
    pool     = await get_pool()

    # FR24: check thresholds
    unrealistic_qty   = int(await _get_config("unrealistic_qty_threshold", 10))
    unrealistic_total = float(await _get_config("unrealistic_total_threshold", 500))
    flagged      = False
    flag_details = {}
    order_total  = 0.0

    lock_results = []
    failed_items = []

    async with pool.acquire() as conn:
        async with conn.transaction():
            for item in body.items:
                mid = item["menu_item_id"]
                qty = item["quantity"]

                result = await conn.fetchval(
                    "SELECT acquire_stock_lock($1, $2, $3, $4)",
                    mid, uuid.UUID(order_id), qty, lock_ttl,
                )

                if result == "ok":
                    lock_results.append({"menu_item_id": mid, "quantity": qty, "status": "locked"})

                    # Get price for FR24 total check
                    price_row = await conn.fetchrow("SELECT price FROM menu_items WHERE id = $1", mid)
                    if price_row:
                        order_total += float(price_row["price"]) * qty

                    if qty > unrealistic_qty:
                        flagged = True
                        flag_details["max_qty_exceeded"] = True
                else:
                    failed_items.append({
                        "menu_item_id": mid,
                        "quantity":     qty,
                        "reason":       result,
                    })

            if failed_items:
                # Roll back all locks — ACID ensures none were persisted
                raise Exception("LOCK_FAILED")  # triggers transaction rollback

    if failed_items:
        return err(
            "LOCK_FAILED",
            "One or more items could not be locked. Stock may have changed.",
            details={"failed_items": failed_items},
            status=409,
        )

    if order_total > unrealistic_total:
        flagged = True
        flag_details["total_exceeded"] = True

    # FR24: create flagged order record if needed
    if flagged:
        flag_reason = "; ".join([
            k.replace("_", " ").title()
            for k in flag_details
        ])
        flagged_ttl = int(await _get_config("flagged_order_ttl_minutes", 60))
        async with pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO flagged_orders
                       (order_id, flagged_reason, flag_details, auto_cancel_at)
                   VALUES ($1, $2, $3::jsonb, NOW() + ($4 || ' minutes')::INTERVAL)
                   ON CONFLICT (order_id) DO NOTHING""",
                uuid.UUID(order_id),
                flag_reason,
                _json.dumps(flag_details),
                flagged_ttl,
            )

    await _audit(
        "STOCK_LOCKED", payload["user_id"], None,
        request.client.host if request.client else None,
        {"order_id": order_id, "items": lock_results, "flagged": flagged},
    )

    return ok({
        "order_id":    order_id,
        "locked":      lock_results,
        "lock_ttl_min": lock_ttl,
        "flagged":     flagged,
        "flag_details": flag_details,
    })


# ══════════════════════════════════════════════════════════════
# POST /api/v1/stock/release
# FR22: Release stock locks.
# deduct=true  → payment success (permanent stock decrement)
# deduct=false → payment failed / cancelled (lock released, stock restored)
# ══════════════════════════════════════════════════════════════

@router.post("/release")
async def release_locks(body: ReleaseRequest, request: Request):
    """
    Releases all stock locks for the given order.
    If deduct=true, permanently decrements stock_qty (payment succeeded).
    If deduct=false, simply releases the lock (stock remains available).
    """
    payload, guard = await _require_role(request, "student", "staff", "admin")
    if guard:
        return guard

    pool = await get_pool()
    async with pool.acquire() as conn:
        released = await conn.fetchval(
            "SELECT release_stock_lock($1, $2, $3)",
            uuid.UUID(body.order_id), body.deduct, body.reason,
        )

    await _audit(
        "STOCK_RELEASED", payload["user_id"], None,
        request.client.host if request.client else None,
        {"order_id": body.order_id, "deduct": body.deduct, "reason": body.reason, "count": released},
    )

    return ok({
        "order_id":      body.order_id,
        "locks_released": released,
        "deducted":       body.deduct,
        "reason":         body.reason,
    })


# ══════════════════════════════════════════════════════════════
# POST /api/v1/stock/{menu_item_id}/restock
# Admin: add stock to an item
# ══════════════════════════════════════════════════════════════

@router.post("/{menu_item_id}/restock")
async def restock_item(menu_item_id: int, body: RestockRequest, request: Request):
    payload, guard = await _require_role(request, "admin", "staff")
    if guard:
        return guard

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE menu_items
               SET    stock_qty = stock_qty + $1, updated_at = NOW()
               WHERE  id = $2
               RETURNING id, name, stock_qty""",
            body.quantity, menu_item_id,
        )
        if not row:
            return err("ITEM_NOT_FOUND", "Menu item not found.", status=404)

        await conn.execute(
            """INSERT INTO stock_transactions
                   (menu_item_id, actor_id, txn_type, quantity_delta, quantity_before, quantity_after, note)
               VALUES ($1, $2, 'RESTOCK', $3, $4, $5, $6)""",
            menu_item_id,
            uuid.UUID(payload["user_id"]),
            body.quantity,
            row["stock_qty"] - body.quantity,
            row["stock_qty"],
            body.note,
        )

    await _audit(
        "STOCK_RESTOCKED", payload["user_id"], None,
        request.client.host if request.client else None,
        {"menu_item_id": menu_item_id, "quantity_added": body.quantity, "new_total": row["stock_qty"]},
    )
    return ok({"menu_item_id": menu_item_id, "name": row["name"], "new_stock_qty": row["stock_qty"]})


# ══════════════════════════════════════════════════════════════
# POST /api/v1/stock/{menu_item_id}/correction
# FR41: Admin corrects stock drift with mandatory reason.
# ══════════════════════════════════════════════════════════════

@router.post("/{menu_item_id}/correction")
async def correct_stock(menu_item_id: int, body: CorrectionRequest, request: Request):
    """
    FR41: Admin sets stock to an exact quantity after detecting drift.
    Requires mandatory note explaining the discrepancy.
    """
    payload, guard = await _require_role(request, "admin")
    if guard:
        return guard

    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            old_row = await conn.fetchrow(
                "SELECT stock_qty FROM menu_items WHERE id = $1 FOR UPDATE", menu_item_id
            )
            if not old_row:
                return err("ITEM_NOT_FOUND", "Menu item not found.", status=404)

            old_qty = old_row["stock_qty"]
            delta   = body.new_quantity - old_qty

            await conn.execute(
                "UPDATE menu_items SET stock_qty = $1, updated_at = NOW() WHERE id = $2",
                body.new_quantity, menu_item_id,
            )

            await conn.execute(
                """INSERT INTO stock_transactions
                       (menu_item_id, actor_id, txn_type, quantity_delta,
                        quantity_before, quantity_after, note)
                   VALUES ($1, $2, 'CORRECTION', $3, $4, $5, $6)""",
                menu_item_id,
                uuid.UUID(payload["user_id"]),
                delta,
                old_qty,
                body.new_quantity,
                body.note,
            )

    await _audit(
        "STOCK_CORRECTED", payload["user_id"], None,
        request.client.host if request.client else None,
        {"menu_item_id": menu_item_id, "old_qty": old_qty, "new_qty": body.new_quantity, "note": body.note},
    )
    return ok({
        "menu_item_id": menu_item_id,
        "old_qty":      old_qty,
        "new_qty":      body.new_quantity,
        "delta":        delta,
        "note":         body.note,
    })


# ══════════════════════════════════════════════════════════════
# GET /api/v1/stock/transactions/{menu_item_id}
# Admin: stock ledger history for an item
# ══════════════════════════════════════════════════════════════

@router.get("/transactions/{menu_item_id}")
async def get_stock_transactions(
    menu_item_id: int,
    request: Request,
    page: int = 1,
    per_page: int = 50,
):
    payload, guard = await _require_role(request, "admin", "staff")
    if guard:
        return guard

    offset = (page - 1) * per_page
    pool   = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, txn_type, quantity_delta, quantity_before, quantity_after,
                      order_id::text, actor_id::text, note, created_at
               FROM   stock_transactions
               WHERE  menu_item_id = $1
               ORDER BY created_at DESC
               LIMIT $2 OFFSET $3""",
            menu_item_id, per_page, offset,
        )
        total = await conn.fetchval(
            "SELECT COUNT(*) FROM stock_transactions WHERE menu_item_id = $1", menu_item_id
        )

    return ok({
        "menu_item_id": menu_item_id,
        "transactions": [dict(r) for r in rows],
        "total":        total,
        "page":         page,
        "per_page":     per_page,
    })


# ══════════════════════════════════════════════════════════════
# GET /api/v1/stock/locks/active
# Admin: view all currently active locks (debugging / ops)
# ══════════════════════════════════════════════════════════════

@router.get("/locks/active")
async def get_active_locks(request: Request):
    payload, guard = await _require_role(request, "admin", "staff")
    if guard:
        return guard

    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT sl.id::text, sl.menu_item_id, m.name AS item_name,
                      sl.order_id::text, sl.quantity,
                      sl.locked_at, sl.expires_at,
                      EXTRACT(EPOCH FROM (sl.expires_at - NOW()))::int AS seconds_remaining
               FROM   stock_locks sl
               JOIN   menu_items m ON m.id = sl.menu_item_id
               WHERE  sl.released_at IS NULL
                 AND  sl.expires_at > NOW()
               ORDER BY sl.expires_at ASC""",
        )
    # ✅ FIX: Explicitly apply jsonable_encoder to strip datetime instances
    serializable_locks = jsonable_encoder([dict(r) for r in rows])
    return ok({"active_locks": serializable_locks, "count": len(rows)})

# ══════════════════════════════════════════════════════════════
# DELETE /api/v1/stock/locks/{lock_id}/release
# Admin: manually release a single active lock before TTL expires
# ══════════════════════════════════════════════════════════════

@router.delete("/locks/{lock_id}/release")
async def release_single_lock(lock_id: str, request: Request):
    payload, guard = await _require_role(request, "admin", "staff")
    if guard:
        return guard

    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            lock = await conn.fetchrow(
                """SELECT sl.id, sl.menu_item_id, sl.quantity, sl.order_id::text,
                          m.name AS item_name
                   FROM   stock_locks sl
                   JOIN   menu_items m ON m.id = sl.menu_item_id
                   WHERE  sl.id = $1
                     AND  sl.released_at IS NULL""",
                uuid.UUID(lock_id),
            )
            if not lock:
                return err("LOCK_NOT_FOUND", "Lock not found or already released.", status=404)

            await conn.execute(
                "UPDATE stock_locks SET released_at = NOW() WHERE id = $1",
                uuid.UUID(lock_id),
            )
            await conn.execute(
                """UPDATE menu_items
                   SET stock_qty = stock_qty + $1
                   WHERE id = $2""",
                lock["quantity"], lock["menu_item_id"],
            )
            await _audit(
                "LOCK_MANUALLY_RELEASED", payload["user_id"], lock["menu_item_id"],
                request.client.host if request.client else None,
                {"lock_id": lock_id, "order_id": lock["order_id"], "quantity": lock["quantity"]},
            )

    return ok({
        "lock_id":   lock_id,
        "item_name": lock["item_name"],
        "quantity":  lock["quantity"],
        "released":  True,
    })

# ══════════════════════════════════════════════════════════════
# POST /api/v1/stock/locks/expire
# System job: expire stale locks (FR40 — called every minute)
# Protected: system/admin only
# ══════════════════════════════════════════════════════════════

@router.post("/locks/expire")
async def expire_stale_locks(request: Request):
    """
    FR40: Releases all stock locks whose TTL has expired.
    Called by a scheduled job every minute.
    Also auto-cancels flagged orders past their review window (FR56).
    """
    payload, guard = await _require_role(request, "admin")
    if guard:
        return guard

    pool = await get_pool()
    async with pool.acquire() as conn:
        expired_locks = await conn.fetchval("SELECT expire_stale_locks()")

        # FR56: auto-cancel flagged orders past deadline
        # FIX: Fetch IDs and let Python count them, avoiding PostgreSQL's restriction
        cancelled_rows = await conn.fetch(
            """UPDATE flagged_orders
               SET    status = 'AUTO_CANCELLED'
               WHERE  status = 'PENDING'
                 AND  auto_cancel_at <= NOW()
               RETURNING id"""
        )
        auto_cancelled = len(cancelled_rows)

    await _audit(
        "STALE_LOCKS_EXPIRED", payload["user_id"], None,
        request.client.host if request.client else None,
        {"locks_expired": expired_locks, "flagged_orders_cancelled": auto_cancelled},
    )
    return ok({
        "locks_expired":              expired_locks,
        "flagged_orders_cancelled":   auto_cancelled,
    })


# ══════════════════════════════════════════════════════════════
# GET /api/v1/stock/flagged
# FR24 / FR56: Admin view of suspicious order queue
# ══════════════════════════════════════════════════════════════

@router.get("/flagged")
async def get_flagged_orders(request: Request, status: str = "PENDING"):
    payload, guard = await _require_role(request, "admin")
    if guard:
        return guard

    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id::text, order_id::text, flagged_reason, flag_details,
                      status::text, reviewed_by::text, review_reason,
                      flagged_at, reviewed_at, auto_cancel_at
               FROM   flagged_orders
               WHERE  status::text = $1
               ORDER BY flagged_at ASC""",
            status.upper(),
        )
    return ok([dict(r) for r in rows])


# ══════════════════════════════════════════════════════════════
# POST /api/v1/stock/flagged/{flagged_id}/review
# FR56: Admin approves or rejects a flagged order
# ══════════════════════════════════════════════════════════════

@router.post("/flagged/{flagged_id}/review")
async def review_flagged_order(flagged_id: str, body: FlaggedOrderReviewRequest, request: Request):
    payload, guard = await _require_role(request, "admin")
    if guard:
        return guard

    new_status = "APPROVED" if body.action == "approve" else "REJECTED"
    pool       = await get_pool()

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE flagged_orders
               SET    status      = $1::flagged_order_status,
                      reviewed_by  = $2,
                      review_reason = $3,
                      reviewed_at  = NOW()
               WHERE  id::text = $4 AND status = 'PENDING'
               RETURNING id::text, order_id::text, status::text""",
            new_status,
            uuid.UUID(payload["user_id"]),
            body.reason,
            flagged_id,
        )
        if not row:
            return err("NOT_FOUND", "Flagged order not found or already reviewed.", status=404)

    await _audit(
        f"FLAGGED_ORDER_{new_status}", payload["user_id"], None,
        request.client.host if request.client else None,
        {"flagged_id": flagged_id, "order_id": row["order_id"], "reason": body.reason},
    )
    return ok(dict(row))


# ══════════════════════════════════════════════════════════════
# GET /api/v1/stock/config
# FR54: View current system configuration
# ══════════════════════════════════════════════════════════════

@router.get("/config")
async def get_config(request: Request):
    payload, guard = await _require_role(request, "admin")
    if guard:
        return guard

    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT key, value, description, updated_by::text, updated_at FROM system_config ORDER BY key"
        )
    # ✅ FIX: Apply jsonable_encoder to make updated_at datetime payload clean for JSON transfer
    serializable_config = jsonable_encoder([dict(r) for r in rows])
    return ok(serializable_config)


# ══════════════════════════════════════════════════════════════
# PATCH /api/v1/stock/config/{key}
# FR54: Update a configuration parameter (live reload ≤ 60 sec)
# ══════════════════════════════════════════════════════════════

@router.patch("/config/{key}")
async def update_config(key: str, body: ConfigUpdateRequest, request: Request):
    payload, guard = await _require_role(request, "admin")
    if guard:
        return guard

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE system_config
               SET    value = $1, description = COALESCE($2, description),
                      updated_by = $3, updated_at = NOW()
               WHERE  key = $4
               RETURNING key, value, description, updated_at""",
            body.value,
            body.description,
            uuid.UUID(payload["user_id"]),
            key,
        )
        if not row:
            return err("CONFIG_NOT_FOUND", f"Config key '{key}' not found.", status=404)

    # Bust cache immediately
    global _config_loaded_at
    _config_loaded_at = 0.0

    await _audit(
        "CONFIG_UPDATED", payload["user_id"], None,
        request.client.host if request.client else None,
        {"key": key, "new_value": body.value},
    )
    return ok(dict(row))


# ══════════════════════════════════════════════════════════════
# GET /api/v1/stock/health
# NFR29: Health check for this service slice
# ══════════════════════════════════════════════════════════════

@router.get("/health")
async def health():
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return ok({"status": "ok", "db": "connected"})
    except Exception as e:
        return JSONResponse({"status": "degraded", "error": str(e)}, status_code=503)
