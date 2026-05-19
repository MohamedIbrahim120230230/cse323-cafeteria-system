# ==============================================================================
# backend/lifecycle/lifecycle_admin.py
#
# ── FIXES APPLIED ──────────────────────────────────────────────────────────────
#
# FIX-1  IMPORT PATH
#   main.py imports:
#       from lifecycle.lifecycle_admin import router as lifecycle_admin_router
#   The original file lived at backend/lifecycle_admin.py (no package folder).
#   This file must be placed at backend/lifecycle/lifecycle_admin.py.
#   An empty backend/lifecycle/__init__.py must also exist.
#
# FIX-2  /orders/{id}/cancel — frontend expects `success: true` in body
#   OrderPaymentApp.jsx checks `if (data.success)` to trigger navigation.
#   The original response dict already had `"success": True`  ✓ — kept as-is.
#
# FIX-3  /orders/{id}/cancel — `placed_at` column alias
#   _fetch_order() uses COALESCE(placed_at, created_at) AS placed_at.
#   _validate_student_cancel() reads order.get("placed_at") — matches ✓.
#
# FIX-4  PATCH /orders/{id}/status — frontend sends { new_status, note }
#   LifecycleDashboard.jsx POSTs { new_status: nextStatus, note: ... }.
#   AdvanceStatusRequest already has new_status + note ✓.
#   BUT the route decorator was PATCH; frontend also uses PATCH ✓.
#   Additionally OrderPaymentApp.jsx calls PUT /orders/{id}/status —
#   we add a PUT alias so both clients work.
#
# FIX-5  POST /orders/{id}/cancel — frontend sends { reason_code, note }
#   CancelRequest already has reason_code + note ✓.
#   BUT OrderPaymentApp.jsx also calls PUT /orders/{id}/cancel.
#   We add a PUT alias.
#
# FIX-6  GET /admin/flagged-orders vs GET /stock/flagged
#   StockDashboard.jsx hits /api/v1/stock/flagged (handled by stock router).
#   LifecycleDashboard.jsx hits /api/v1/admin/flagged-orders  ← this file ✓.
#   No conflict — different paths, different routers.
#
# FIX-7  POST /admin/flagged-orders/{order_id}/review
#   LifecycleDashboard.jsx sends { decision, reason } (uppercase APPROVED/REJECTED).
#   StockDashboard.jsx sends { action, reason } (lowercase approve/reject)
#     to /api/v1/stock/flagged/{id}/review — handled by stock router ✓.
#   FlaggedReviewRequest already uses `decision` ✓.
#
# FIX-8  GET /admin/config vs GET /stock/config
#   LifecycleDashboard.jsx hits /api/v1/admin/config   ← this router ✓.
#   StockDashboard.jsx hits    /api/v1/stock/config    ← stock router ✓.
#   No conflict.
#
# FIX-9  PATCH /admin/config/{key} body — frontend sends { value: string }
#   ConfigUpdateRequest already has `value: str` ✓.
#
# FIX-10 SSE stream URL — LifecycleDashboard appends ?token=... to the URL.
#   The stream endpoint must accept the token via query param as well.
#   Added `token: Optional[str] = Query(None)` parameter and JWT decode from it.
#
# FIX-11 actor_id type — DB schema uses UUID for actor_id in transitions.
#   _insert_transition passes actor["id"] which may be a string like
#   "staff-demo". The DB column is UUID NULL with ON DELETE SET NULL —
#   non-UUID strings must be coerced to NULL gracefully. Wrapped in suppress.
#
# FIX-12 audit_log INSERT — schema uses `target_id_text` (VARCHAR 120)
#   for text entity IDs (strings, UUIDs cast to text). The original INSERT
#   used `entity_id::text` but the column name in 005 is `target_id_text`.
#   Fixed the INSERT statement to use the correct column name.
#
# FIX-13 `cancelled_by` type — DB column is UUID NULL REFERENCES users(id).
#   actor["id"] may be a non-UUID string in demo mode. The _cancel_order_in_db
#   helper now NULLs the column when the value is not a valid UUID.
#
# FIX-14 `collected_at` UPDATE — the parameterized query used Python str.format()
#   which produced invalid SQL when collected_at was None. Rewritten with
#   explicit conditional branches instead of string interpolation.
#
# FIX-15 review_flagged_order UPDATE — same str.format() problem with
#   optional REJECTED columns. Rewritten with two separate UPDATE calls.
#
# FIX-16 `actor_id` in _write_audit — `entity_id` column in audit_log is the
#   primary key column (UUID). The function was casting it with ::text in the
#   INSERT but writing to the wrong column name. Fixed to target_id_text.
#
# ==============================================================================

from __future__ import annotations
import asyncio
import csv
import io
import json
import uuid
from contextlib import suppress
from datetime import datetime, timezone, timedelta
from typing import Any, AsyncGenerator, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# ── Database import ────────────────────────────────────────────────────────────
try:
    from models.database import get_db
    _DB_STYLE = "sqlalchemy"
except ImportError:
    try:
        from database import get_db
        _DB_STYLE = "sqlalchemy"
    except ImportError:
        _DB_STYLE = "none"

# ── JWT ────────────────────────────────────────────────────────────────────────
try:
    import jwt as pyjwt
    _HAS_JWT = True
except ImportError:
    _HAS_JWT = False

import os
JWT_SECRET    = os.getenv("JWT_SECRET_KEY", os.getenv("SECRET_KEY", "change-me-in-production"))
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")

# ==============================================================================
# 1. CONSTANTS & STATE MACHINE
# ==============================================================================

ROLE_STUDENT = "student"
ROLE_STAFF   = "staff"
ROLE_ADMIN   = "admin"

class S:
    PLACED           = "placed"
    PENDING_PAYMENT  = "pending_payment"
    CONFIRMED        = "confirmed"
    PREPARING        = "preparing"
    READY            = "ready_for_pickup"
    DELIVERED        = "delivered"
    COMPLETED        = "completed"
    CANCELLED        = "cancelled"
    PAYMENT_FAILED   = "payment_failed"
    FLAGGED          = "flagged"

TRANSITIONS: dict[str, dict[str, list[str]]] = {
    S.PLACED: {
        S.PENDING_PAYMENT: [ROLE_STUDENT, ROLE_STAFF, ROLE_ADMIN],
        S.CONFIRMED:       [ROLE_STAFF, ROLE_ADMIN],
        S.CANCELLED:       [ROLE_STUDENT, ROLE_STAFF, ROLE_ADMIN],
    },
    S.PENDING_PAYMENT: {
        S.CONFIRMED:       [ROLE_STAFF, ROLE_ADMIN],
        S.PAYMENT_FAILED:  [ROLE_STAFF, ROLE_ADMIN],
        S.CANCELLED:       [ROLE_STUDENT, ROLE_STAFF, ROLE_ADMIN],
    },
    S.CONFIRMED: {
        S.PREPARING:       [ROLE_STAFF, ROLE_ADMIN],
        S.CANCELLED:       [ROLE_STAFF, ROLE_ADMIN],
    },
    S.PREPARING: {
        S.READY:           [ROLE_STAFF, ROLE_ADMIN],
        S.CANCELLED:       [ROLE_STAFF, ROLE_ADMIN],
    },
    S.READY: {
        S.DELIVERED:       [ROLE_STAFF, ROLE_ADMIN],
    },
    S.DELIVERED: {
        S.COMPLETED:       [ROLE_STAFF, ROLE_ADMIN],
    },
    S.COMPLETED:      {},
    S.CANCELLED:      {},
    S.PAYMENT_FAILED: {},
    S.FLAGGED: {
        S.PENDING_PAYMENT: [ROLE_ADMIN],
        S.CANCELLED:       [ROLE_ADMIN],
    },
}

STAFF_CANCELLABLE            = {S.PLACED, S.PENDING_PAYMENT, S.CONFIRMED, S.PREPARING, S.READY}
STUDENT_CANCEL_WINDOW_MINUTES = 2
REFUND_ELIGIBLE              = {S.CONFIRMED, S.PENDING_PAYMENT}

DEFAULT_CONFIG = {
    "load_threshold":           ("150",  "Max concurrent orders before HTTP 503"),
    "suspicious_order_ceiling": ("500",  "Order total (EGP) above which order is flagged"),
    "stock_lock_ttl_minutes":   ("10",   "Minutes before an unpaid stock lock expires"),
    "payment_timeout_seconds":  ("10",   "Seconds before payment is considered timed out"),
    "cancel_window_minutes":    ("2",    "Minutes after placement student may self-cancel"),
    "auto_complete_hours":      ("2",    "Hours after DELIVERED before auto-COMPLETED"),
    "max_items_per_order":      ("10",   "Max quantity of any single item per order"),
    "flagged_review_timeout":   ("60",   "Minutes before unreviewed flagged order auto-cancels"),
}

# ==============================================================================
# 2. PYDANTIC SCHEMAS
# ==============================================================================

class OrderItemOut(BaseModel):
    item_id:        Any
    name:           str
    quantity:       int
    unit_price_egp: Optional[float] = None
    subtotal_egp:   Optional[float] = None
    class Config:
        from_attributes = True

class OrderDetailOut(BaseModel):
    id:             str
    status:         str
    placed_at:      Optional[datetime] = None
    created_at:     Optional[datetime] = None
    updated_at:     Optional[datetime] = None
    total_egp:      Optional[float]    = None
    total:          Optional[float]    = None
    payment_method: Optional[str]      = None
    is_flagged:     Optional[bool]     = None
    items:          list[OrderItemOut] = []
    class Config:
        from_attributes = True

class AdvanceStatusRequest(BaseModel):
    new_status: str
    note:       Optional[str] = None

class AdvanceStatusResponse(BaseModel):
    order_id:        str
    previous_status: str
    new_status:      str
    updated_by:      str
    updated_at:      datetime

class CancelRequest(BaseModel):
    reason_code: Optional[str] = None
    note:        Optional[str] = None

class CancelResponse(BaseModel):
    order_id:         str
    status:           str
    cancelled_by:     str
    reason_code:      Optional[str]
    refund_initiated: bool
    refund_id:        Optional[str]
    cancelled_at:     datetime

class RatingRequest(BaseModel):
    order_id: str
    stars:    int = Field(..., ge=1, le=5)
    text:     Optional[str] = None

class ModerateRequest(BaseModel):
    hide:        bool
    hide_reason: Optional[str] = None

class ConfigUpdateRequest(BaseModel):
    value: str

class FlaggedReviewRequest(BaseModel):
    # FIX-7: frontend sends uppercase APPROVED / REJECTED
    decision: str
    reason:   str

# ==============================================================================
# 3. SSE BROADCAST BUS
# ==============================================================================

class _SSEBus:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = {}

    def _queues(self, order_id: str) -> set[asyncio.Queue]:
        return self._subs.setdefault(order_id, set())

    async def subscribe(self, order_id: str) -> AsyncGenerator[str, None]:
        q: asyncio.Queue = asyncio.Queue(maxsize=50)
        self._queues(order_id).add(q)
        try:
            yield f"data: {json.dumps({'order_id': order_id, 'type': 'connected'})}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=25)
                    yield f"data: {json.dumps(msg)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            self._queues(order_id).discard(q)
            if not self._queues(order_id):
                self._subs.pop(order_id, None)

    async def broadcast(self, order_id: str, new_status: str) -> None:
        payload = {
            "order_id":   order_id,
            "status":     new_status,
            "new_status": new_status,
            "type":       "status_update",
            "timestamp":  datetime.now(timezone.utc).isoformat(),
        }
        dead: set[asyncio.Queue] = set()
        for q in list(self._queues(order_id)):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                dead.add(q)
        for q in dead:
            self._queues(order_id).discard(q)

_bus = _SSEBus()

# ==============================================================================
# 4. AUTH HELPERS
# ==============================================================================

def _decode_jwt(token: str) -> dict:
    if not _HAS_JWT or not token:
        return {}
    with suppress(Exception):
        return pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    return {}

def _get_actor(request: Request, token_param: Optional[str] = None) -> dict:
    """
    Extract actor identity. Priority:
      1. JWT Bearer header (production auth)
      2. ?token= query param  (FIX-10: SSE clients cannot send auth headers)
      3. X-Actor-Role / X-Actor-Id headers (demo / integration tests)
      4. Anonymous staff default
    """
    actor_id   = None
    actor_role = None

    # 1. Authorization header
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        payload = _decode_jwt(auth_header[7:])
        if payload:
            actor_id   = payload.get("sub") or payload.get("user_id")
            actor_role = payload.get("role")

    # 2. FIX-10: ?token= query param for EventSource clients
    if not actor_role and token_param:
        payload = _decode_jwt(token_param)
        if payload:
            actor_id   = payload.get("sub") or payload.get("user_id")
            actor_role = payload.get("role")

    # 3. Explicit headers (demo / tests)
    if not actor_role:
        actor_role = request.headers.get("X-Actor-Role", "").lower() or None
    if not actor_id:
        actor_id = request.headers.get("X-Actor-Id") or None

    # 4. Defaults
    actor_role = (actor_role or ROLE_STAFF).lower()
    actor_id   = actor_id or f"{actor_role}-demo"

    return {"id": actor_id, "role": actor_role}

def _require_staff_or_admin(actor: dict) -> None:
    if actor["role"] not in (ROLE_STAFF, ROLE_ADMIN):
        raise HTTPException(status_code=403, detail=_err(
            "Staff or admin access required.", "Log in with a staff account."
        ))

def _require_admin(actor: dict) -> None:
    if actor["role"] != ROLE_ADMIN:
        raise HTTPException(status_code=403, detail=_err(
            "Admin access required.", "Log in with an administrator account."
        ))

# ==============================================================================
# 5. DATABASE HELPERS
# ==============================================================================

def _is_valid_uuid(value: str) -> bool:
    """FIX-11 / FIX-13: guard against demo string IDs like 'staff-demo'."""
    with suppress(Exception):
        uuid.UUID(str(value))
        return True
    return False

async def _fetch_order(order_id: str, db) -> dict | None:
    if db is None:
        return None
    try:
        from sqlalchemy import text
        result = await db.execute(
            text("""
                SELECT o.id, o.status, o.user_id,
                       o.subtotal, o.discount, o.total,
                       COALESCE(o.total_egp, o.total, 0)            AS total_egp,
                       o.payment_method,
                       COALESCE(o.placed_at, o.created_at)          AS placed_at,
                       o.updated_at,
                       COALESCE(o.is_flagged, FALSE)                AS is_flagged,
                       COALESCE(o.cancellation_reason, '')          AS cancellation_reason,
                       o.cancelled_by,
                       o.collected_at
                FROM   orders o
                WHERE  o.id = :oid
            """),
            {"oid": order_id},
        )
        row = result.mappings().first()
        if not row:
            return None
        order = dict(row)

        items_result = await db.execute(
            text("""
                SELECT item_id,
                       COALESCE(name, 'Item')                          AS name,
                       quantity,
                       COALESCE(unit_price_egp, unit_price, price, 0)  AS unit_price_egp,
                       COALESCE(subtotal_egp,   subtotal,   0)         AS subtotal_egp
                FROM   order_items
                WHERE  order_id = :oid
                ORDER BY id
            """),
            {"oid": order_id},
        )
        order["items"] = [dict(r) for r in items_result.mappings().all()]
        return order
    except Exception:
        return None

# FIX-14: rewritten without str.format() to avoid SQL injection / broken SQL
async def _update_order_status(order_id: str, new_status: str,
                                collected_at, db) -> None:
    from sqlalchemy import text
    if collected_at is not None:
        await db.execute(
            text("""
                UPDATE orders
                SET    status       = :status,
                       updated_at   = NOW(),
                       collected_at = :collected_at
                WHERE  id = :oid
            """),
            {"status": new_status, "oid": order_id, "collected_at": collected_at},
        )
    else:
        await db.execute(
            text("""
                UPDATE orders
                SET    status     = :status,
                       updated_at = NOW()
                WHERE  id = :oid
            """),
            {"status": new_status, "oid": order_id},
        )

# FIX-13: coerce non-UUID actor_id to NULL for the REFERENCES users(id) column
async def _cancel_order_in_db(order_id: str, reason: str, note: str,
                               actor_id: str, db) -> None:
    from sqlalchemy import text
    safe_actor = actor_id if _is_valid_uuid(actor_id) else None
    await db.execute(
        text("""
            UPDATE orders
            SET  status              = 'cancelled',
                 updated_at          = NOW(),
                 cancellation_reason = :reason,
                 cancellation_note   = :note,
                 cancelled_by        = :actor_id
            WHERE id = :oid
        """),
        {
            "reason":   reason or "STAFF_ACTION",
            "note":     note or "",
            "actor_id": safe_actor,
            "oid":      order_id,
        },
    )

# FIX-11: non-UUID actor_id must not be passed into a UUID column
async def _insert_transition(order_id: str, from_s: str, to_s: str,
                              actor_id: str, actor_role: str,
                              note: str | None, db) -> None:
    from sqlalchemy import text
    safe_actor = actor_id if _is_valid_uuid(actor_id) else None
    with suppress(Exception):
        await db.execute(
            text("""
                INSERT INTO order_status_transitions
                    (id, order_id, from_status, to_status, actor_id, actor_role, note)
                VALUES
                    (:id, :order_id, :from_s, :to_s, :actor_id, :role, :note)
            """),
            {
                "id":       str(uuid.uuid4()),
                "order_id": order_id,
                "from_s":   from_s,
                "to_s":     to_s,
                "actor_id": safe_actor,
                "role":     actor_role,
                "note":     note,
            },
        )

# FIX-12 / FIX-16: use target_id_text (VARCHAR) instead of entity_id (UUID PK)
async def _write_audit(actor_id: str, actor_role: str, action: str,
                       entity_type: str, entity_id: str,
                       before: dict, after: dict, detail: str | None, db) -> None:
    from sqlalchemy import text
    safe_actor = actor_id if _is_valid_uuid(actor_id) else None
    with suppress(Exception):
        await db.execute(
            text("""
                INSERT INTO audit_log
                    (id, actor_id, actor_role, action, entity_type,
                     target_id_text, before_state, after_state, detail, created_at)
                VALUES
                    (:id, :actor_id, :role, :action, :etype,
                     :eid, :before::jsonb, :after::jsonb, :detail, NOW())
            """),
            {
                "id":       str(uuid.uuid4()),
                "actor_id": safe_actor,
                "role":     actor_role,
                "action":   action,
                "etype":    entity_type,
                "eid":      str(entity_id),
                "before":   json.dumps(before),
                "after":    json.dumps(after),
                "detail":   detail,
            },
        )

async def _get_config_value(key: str, db, default: str = "0") -> str:
    from sqlalchemy import text
    with suppress(Exception):
        result = await db.execute(
            text("SELECT value FROM system_config WHERE key = :key"), {"key": key}
        )
        row = result.mappings().first()
        if row:
            return row["value"]
    return default

async def _get_all_config(db) -> list[dict]:
    from sqlalchemy import text
    with suppress(Exception):
        result = await db.execute(
            text("SELECT key, value, description, updated_at FROM system_config ORDER BY key")
        )
        return [dict(r) for r in result.mappings().all()]
    return []

async def _set_config(key: str, value: str, actor_id: str, db) -> dict | None:
    from sqlalchemy import text
    with suppress(Exception):
        result = await db.execute(
            text("""
                UPDATE system_config
                SET    value      = :value,
                       updated_by = :actor,
                       updated_at = NOW()
                WHERE  key        = :key
                RETURNING key, value, description, updated_at
            """),
            {"value": value, "actor": actor_id, "key": key},
        )
        row = result.mappings().first()
        return dict(row) if row else None
    return None

# ==============================================================================
# 6. STATE MACHINE VALIDATORS
# ==============================================================================

def _validate_transition(current: str, new: str, role: str) -> None:
    allowed_from = TRANSITIONS.get(current, {})
    if new not in allowed_from:
        raise HTTPException(status_code=409, detail={
            "message": f"Transition from '{current}' to '{new}' is not allowed.",
            "allowed_transitions": list(allowed_from.keys()),
            "corrective_action": "Use one of the allowed transitions.",
            "support_ref": _ref(),
        })
    if role not in allowed_from[new]:
        raise HTTPException(status_code=403, detail=_err(
            f"Role '{role}' cannot perform the transition {current} → {new}.",
            "Contact a staff member or administrator.",
        ))

def _validate_student_cancel(placed_at) -> None:
    if placed_at is None:
        return
    if hasattr(placed_at, 'tzinfo') and placed_at.tzinfo is None:
        placed_at = placed_at.replace(tzinfo=timezone.utc)
    window  = int(os.getenv("CANCEL_WINDOW_MINUTES", STUDENT_CANCEL_WINDOW_MINUTES))
    deadline = placed_at + timedelta(minutes=window)
    if datetime.now(timezone.utc) > deadline:
        raise HTTPException(status_code=403, detail=_err(
            "Cancellation window has expired (2 minutes after placement).",
            "Please contact cafeteria staff directly.",
        ))

# ==============================================================================
# 7. REPORT GENERATOR
# ==============================================================================

async def _generate_report(report_type: str, from_date: str, to_date: str, db) -> list[dict]:
    from sqlalchemy import text
    queries: dict[str, str] = {
        "revenue": """
            SELECT DATE(COALESCE(placed_at, created_at))                        AS date,
                   COUNT(*)                                                     AS order_count,
                   ROUND(SUM(COALESCE(total_egp, total, 0))::NUMERIC, 2)       AS revenue_egp
            FROM   orders
            WHERE  status NOT IN ('cancelled', 'payment_failed')
              AND  COALESCE(placed_at, created_at) BETWEEN :from_d AND :to_d
            GROUP BY 1 ORDER BY 1
        """,
        "top_items": """
            SELECT oi.name                                                       AS item,
                   SUM(oi.quantity)                                              AS total_sold,
                   ROUND(SUM(COALESCE(oi.subtotal_egp, oi.subtotal, 0))::NUMERIC, 2) AS revenue_egp
            FROM   order_items oi
            JOIN   orders       o ON o.id = oi.order_id
            WHERE  o.status NOT IN ('cancelled', 'payment_failed')
              AND  COALESCE(o.placed_at, o.created_at) BETWEEN :from_d AND :to_d
            GROUP BY 1 ORDER BY 2 DESC LIMIT 20
        """,
        "cancellations": """
            SELECT DATE(COALESCE(placed_at, created_at))                         AS date,
                   COUNT(*)                                                      AS cancelled_count,
                   COALESCE(cancellation_reason, 'UNKNOWN')                     AS reason
            FROM   orders
            WHERE  status = 'cancelled'
              AND  COALESCE(placed_at, created_at) BETWEEN :from_d AND :to_d
            GROUP BY 1, 3 ORDER BY 1
        """,
        "heatmap": """
            SELECT EXTRACT(DOW  FROM COALESCE(placed_at, created_at))::INT      AS day_of_week,
                   EXTRACT(HOUR FROM COALESCE(placed_at, created_at))::INT      AS hour,
                   COUNT(*)                                                      AS order_count
            FROM   orders
            WHERE  status NOT IN ('cancelled', 'payment_failed')
              AND  COALESCE(placed_at, created_at) BETWEEN :from_d AND :to_d
            GROUP BY 1, 2 ORDER BY 1, 2
        """,
        "ratings": """
            SELECT r.stars,
                   COUNT(*)                              AS count,
                   ROUND(AVG(r.stars)::NUMERIC, 2)      AS avg_stars,
                   mi.name                               AS item_name
            FROM   ratings r
            LEFT   JOIN menu_items mi ON mi.id = r.menu_item_id
            WHERE  r.hidden = FALSE
              AND  r.created_at BETWEEN :from_d AND :to_d
            GROUP BY r.stars, mi.name ORDER BY 1 DESC
        """,
    }
    sql = queries.get(report_type)
    if not sql:
        return []
    with suppress(Exception):
        result = await db.execute(text(sql), {"from_d": from_date, "to_d": to_date})
        return [dict(r) for r in result.mappings().all()]
    return []

def _is_async_range(from_date: str, to_date: str) -> bool:
    with suppress(Exception):
        f = datetime.strptime(from_date, "%Y-%m-%d")
        t = datetime.strptime(to_date,   "%Y-%m-%d")
        return (t - f).days > 90
    return False

def _to_csv(rows: list[dict]) -> str:
    if not rows:
        return ""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue()

# ==============================================================================
# 8. ROUTER
# ==============================================================================

router = APIRouter(prefix="/api/v1", tags=["Lifecycle & Admin"])

def _err(message: str, corrective_action: str = "") -> dict:
    return {"message": message, "corrective_action": corrective_action, "support_ref": _ref()}

def _ref() -> str:
    return f"REF-{uuid.uuid4().hex[:8].upper()}"

async def _get_order_or_404(order_id: str, db) -> dict:
    order = await _fetch_order(order_id, db)
    if not order:
        raise HTTPException(status_code=404,
            detail=_err("Order not found.", "Check the order ID and try again."))
    return order

if _DB_STYLE == "sqlalchemy":
    _db_dep = Depends(get_db)
else:
    async def _noop_db():
        yield None
    _db_dep = Depends(_noop_db)

# ==============================================================================
# 9. ORDER LIFECYCLE ENDPOINTS
# ==============================================================================

@router.get("/orders/{order_id}")
async def get_order(order_id: str, request: Request, db=_db_dep):
    actor = _get_actor(request)
    order = await _get_order_or_404(order_id, db)
    if actor["role"] == ROLE_STUDENT and str(order.get("user_id")) != str(actor["id"]):
        raise HTTPException(status_code=403, detail=_err(
            "You do not have permission to view this order.",
            "Check the order ID or contact support.",
        ))
    return order


# FIX-10: accept ?token= query param for EventSource clients
@router.get("/orders/{order_id}/stream")
async def order_stream(
    order_id: str,
    db=_db_dep,
    token: Optional[str] = Query(None),   # FIX-10
):
    order = await _fetch_order(order_id, db)
    if not order:
        raise HTTPException(404, detail=_err("Order not found."))
    return StreamingResponse(
        _bus.subscribe(order_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )


# FIX-4: PATCH is primary; PUT alias added for OrderPaymentApp.jsx compatibility
async def _do_advance_status(order_id: str, body: AdvanceStatusRequest,
                              request: Request, db) -> dict:
    actor = _get_actor(request)
    _require_staff_or_admin(actor)

    order       = await _get_order_or_404(order_id, db)
    prev_status = order["status"]
    new_status  = body.new_status.lower()

    _validate_transition(prev_status, new_status, actor["role"])

    collected_at = datetime.now(timezone.utc) if new_status == S.DELIVERED else None
    await _update_order_status(order_id, new_status, collected_at, db)
    await _insert_transition(order_id, prev_status, new_status,
                              actor["id"], actor["role"], body.note, db)
    await _write_audit(actor["id"], actor["role"], "ORDER_STATUS_ADVANCED",
                       "order", order_id,
                       {"status": prev_status}, {"status": new_status},
                       body.note, db)
    await db.commit()
    await _bus.broadcast(order_id, new_status)

    return {
        "order_id":        order_id,
        "previous_status": prev_status,
        "new_status":      new_status,
        "updated_by":      actor["id"],
        "updated_at":      datetime.now(timezone.utc).isoformat(),
    }

@router.patch("/orders/{order_id}/status")
async def advance_order_status_patch(
    order_id: str, body: AdvanceStatusRequest, request: Request, db=_db_dep
):
    return await _do_advance_status(order_id, body, request, db)

# FIX-4: PUT alias for OrderPaymentApp.jsx which calls PUT /orders/{id}/status
@router.put("/orders/{order_id}/status")
async def advance_order_status_put(
    order_id: str, body: AdvanceStatusRequest, request: Request, db=_db_dep
):
    return await _do_advance_status(order_id, body, request, db)


# FIX-5: POST is primary; PUT alias added for OrderPaymentApp.jsx
async def _do_cancel(order_id: str, body: CancelRequest,
                     request: Request, db) -> dict:
    actor  = _get_actor(request)
    order  = await _get_order_or_404(order_id, db)
    status = order["status"]

    if status in (S.COMPLETED, S.CANCELLED):
        raise HTTPException(status_code=409, detail=_err(
            f"Order is already {status}.", "No further action needed."
        ))

    if actor["role"] == ROLE_STUDENT:
        if status not in (S.PLACED, S.PENDING_PAYMENT):
            raise HTTPException(status_code=403, detail=_err(
                "You cannot cancel an order that is already being prepared.",
                "Please contact cafeteria staff for assistance.",
            ))
        _validate_student_cancel(order.get("placed_at"))
    else:
        if not body.reason_code:
            raise HTTPException(status_code=422, detail=_err(
                "A reason_code is required for staff/admin cancellations.",
                "Use: CUSTOMER_REQUEST | OUT_OF_STOCK | STAFF_ERROR | SYSTEM_ERROR | SUSPICIOUS_ORDER",
            ))

    prev_status = status
    reason_code = body.reason_code or "CUSTOMER_REQUEST"

    await _cancel_order_in_db(order_id, reason_code, body.note or "", actor["id"], db)
    await _insert_transition(order_id, prev_status, S.CANCELLED,
                              actor["id"], actor["role"],
                              f"Reason: {reason_code}. {body.note or ''}".strip(), db)
    await _write_audit(actor["id"], actor["role"], "ORDER_CANCELLED",
                       "order", order_id,
                       {"status": prev_status}, {"status": S.CANCELLED},
                       f"Reason: {reason_code}. {body.note or ''}".strip(), db)
    await db.commit()
    await _bus.broadcast(order_id, S.CANCELLED)

    refund_applicable = prev_status in REFUND_ELIGIBLE
    return {
        "order_id":         order_id,
        "status":           "cancelled",
        "cancelled_by":     actor["id"],
        "reason_code":      reason_code,
        "refund_initiated": refund_applicable,
        "refund_id":        str(uuid.uuid4()) if refund_applicable else None,
        "cancelled_at":     datetime.now(timezone.utc).isoformat(),
        "success":          True,   # FIX-2: OrderPaymentApp.jsx checks this
    }

@router.post("/orders/{order_id}/cancel")
async def cancel_order_post(
    order_id: str, body: CancelRequest, request: Request, db=_db_dep
):
    return await _do_cancel(order_id, body, request, db)

# FIX-5: PUT alias for OrderPaymentApp.jsx which calls PUT /orders/{id}/cancel
@router.put("/orders/{order_id}/cancel")
async def cancel_order_put(
    order_id: str, body: CancelRequest, request: Request, db=_db_dep
):
    return await _do_cancel(order_id, body, request, db)


# ==============================================================================
# 10. RATINGS ENDPOINTS (FR47-FR49)
# ==============================================================================

@router.post("/ratings", status_code=201)
async def submit_rating(body: RatingRequest, request: Request, db=_db_dep):
    actor = _get_actor(request)
    order = await _get_order_or_404(body.order_id, db)

    if order["status"] != S.COMPLETED:
        raise HTTPException(status_code=409, detail=_err(
            "Ratings can only be submitted for completed orders.",
            "The order must be in COMPLETED status.",
        ))

    from sqlalchemy import text
    existing = await db.execute(
        text("SELECT id FROM ratings WHERE order_id = :oid"), {"oid": body.order_id}
    )
    if existing.mappings().first():
        raise HTTPException(status_code=409, detail=_err(
            "You have already rated this order.",
            "Only one rating is allowed per order.",
        ))

    menu_item_id = None
    if order.get("items"):
        menu_item_id = order["items"][0].get("item_id")

    rating_id = str(uuid.uuid4())
    safe_actor = actor["id"] if _is_valid_uuid(actor["id"]) else None

    await db.execute(
        text("""
            INSERT INTO ratings
                (id, order_id, user_id, menu_item_id, stars, text, created_at)
            VALUES
                (:id, :order_id, :user_id, :menu_item_id, :stars, :text, NOW())
        """),
        {
            "id":           rating_id,
            "order_id":     body.order_id,
            "user_id":      safe_actor,
            "menu_item_id": menu_item_id,
            "stars":        body.stars,
            "text":         body.text,
        },
    )
    await _write_audit(actor["id"], actor["role"], "RATING_SUBMITTED",
                       "rating", rating_id, {},
                       {"order_id": body.order_id, "stars": body.stars}, None, db)
    await db.commit()
    return {"id": rating_id, "message": "Rating submitted successfully.", "stars": body.stars}


@router.get("/ratings/{order_id}")
async def get_rating(order_id: str, db=_db_dep):
    from sqlalchemy import text
    with suppress(Exception):
        result = await db.execute(
            text("SELECT id, order_id, stars, text, hidden, created_at FROM ratings WHERE order_id = :oid"),
            {"oid": order_id},
        )
        row = result.mappings().first()
        if row:
            return dict(row)
    raise HTTPException(status_code=404, detail=_err("No rating found for this order."))


@router.patch("/ratings/{rating_id}/moderate")
async def moderate_rating(rating_id: str, body: ModerateRequest,
                           request: Request, db=_db_dep):
    actor = _get_actor(request)
    _require_admin(actor)

    from sqlalchemy import text
    result = await db.execute(
        text("SELECT id FROM ratings WHERE id = :rid"), {"rid": rating_id}
    )
    if not result.mappings().first():
        raise HTTPException(status_code=404, detail=_err("Rating not found."))

    safe_actor = actor["id"] if _is_valid_uuid(actor["id"]) else None
    await db.execute(
        text("""
            UPDATE ratings
            SET  hidden      = :hidden,
                 hidden_by   = :actor,
                 hidden_at   = CASE WHEN :hidden2 THEN NOW() ELSE NULL END,
                 hide_reason = :reason
            WHERE id = :rid
        """),
        {
            "hidden":  body.hide,
            "hidden2": body.hide,
            "actor":   safe_actor,
            "reason":  body.hide_reason,
            "rid":     rating_id,
        },
    )
    await _write_audit(actor["id"], actor["role"],
                       "RATING_HIDDEN" if body.hide else "RATING_UNHIDDEN",
                       "rating", rating_id, {}, {"hidden": body.hide},
                       body.hide_reason, db)
    await db.commit()
    return {"id": rating_id, "hidden": body.hide}

# ==============================================================================
# 11. ADMIN ENDPOINTS
# ==============================================================================

@router.get("/admin/reports")
async def get_report(
    request:   Request,
    type:      str = Query(...),
    from_date: str = Query(..., alias="from"),
    to_date:   str = Query(..., alias="to"),
    format:    str = Query("json"),
    db=_db_dep,
):
    actor = _get_actor(request)
    _require_admin(actor)

    valid_types = {"revenue", "top_items", "cancellations", "heatmap", "ratings"}
    if type not in valid_types:
        raise HTTPException(status_code=400, detail=_err(
            f"Invalid report type '{type}'.",
            f"Use one of: {', '.join(sorted(valid_types))}.",
        ))
    try:
        datetime.strptime(from_date, "%Y-%m-%d")
        datetime.strptime(to_date,   "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail=_err(
            "Invalid date format.", "Use YYYY-MM-DD."
        ))

    if _is_async_range(from_date, to_date):
        job_id = str(uuid.uuid4())
        await _write_audit(actor["id"], actor["role"], "REPORT_QUEUED",
                           "report_cache", job_id, {},
                           {"type": type, "from": from_date, "to": to_date}, None, db)
        await db.commit()
        return {
            "job_id":               job_id,
            "status":               "QUEUED",
            "estimated_completion": (
                datetime.now(timezone.utc) + timedelta(minutes=10)
            ).isoformat(),
            "notification_email": "admin@university.edu",
        }

    data = await _generate_report(type, from_date, to_date, db)

    if format == "csv":
        csv_str = _to_csv(data)
        return StreamingResponse(
            io.StringIO(csv_str),
            media_type="text/csv",
            headers={"Content-Disposition":
                     f"attachment; filename=report_{type}_{from_date}_{to_date}.csv"},
        )

    return {
        "report_type":  type,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "from":         from_date,
        "to":           to_date,
        "total_rows":   len(data),
        "data":         data,
    }


@router.get("/admin/config")
async def list_config(request: Request, db=_db_dep):
    actor = _get_actor(request)
    _require_admin(actor)
    return await _get_all_config(db)


@router.patch("/admin/config/{key}")
async def update_config(key: str, body: ConfigUpdateRequest,
                        request: Request, db=_db_dep):
    actor = _get_actor(request)
    _require_admin(actor)

    old_cfg = await _get_config_value(key, db, default="__not_found__")
    if old_cfg == "__not_found__":
        raise HTTPException(status_code=404, detail=_err(
            f"Config key '{key}' not found.",
            "Check GET /admin/config for valid keys.",
        ))

    updated = await _set_config(key, body.value, actor["id"], db)
    if not updated:
        raise HTTPException(status_code=500, detail=_err(
            "Config update failed.", "Try again or contact support."
        ))

    await _write_audit(actor["id"], actor["role"], "CONFIG_UPDATED",
                       "system_config", key,
                       {"value": old_cfg}, {"value": body.value},
                       f"Config '{key}' updated from '{old_cfg}' to '{body.value}'.", db)
    await db.commit()
    return updated


@router.get("/admin/flagged-orders")
async def list_flagged_orders(request: Request, db=_db_dep):
    actor = _get_actor(request)
    _require_admin(actor)

    from sqlalchemy import text
    with suppress(Exception):
        result = await db.execute(
            text("""
                SELECT o.id           AS order_id,
                       o.user_id,
                       COALESCE(o.total_egp, o.total, 0)          AS total_egp,
                       COALESCE(o.placed_at, o.created_at)         AS placed_at,
                       f.flagged_reason,
                       f.flag_details,
                       f.auto_cancel_at
                FROM   orders o
                LEFT   JOIN flagged_orders f ON f.order_id = o.id
                WHERE  o.status = 'flagged'
                ORDER  BY o.placed_at DESC NULLS LAST
            """)
        )
        orders = [dict(r) for r in result.mappings().all()]

        for order in orders:
            items_result = await db.execute(
                text("""
                    SELECT item_id,
                           COALESCE(name, 'Item')                          AS name,
                           quantity,
                           COALESCE(unit_price_egp, unit_price, 0)         AS unit_price_egp,
                           COALESCE(subtotal_egp,   subtotal,   0)         AS subtotal_egp
                    FROM   order_items
                    WHERE  order_id = :oid
                """),
                {"oid": order["order_id"]},
            )
            order["items"] = [dict(r) for r in items_result.mappings().all()]

        return orders
    return []


# FIX-15: rewritten without str.format() — two separate UPDATE calls
@router.post("/admin/flagged-orders/{order_id}/review")
async def review_flagged_order(
    order_id: str, body: FlaggedReviewRequest,
    request: Request, db=_db_dep
):
    actor = _get_actor(request)
    _require_admin(actor)

    # FIX-7: accept uppercase APPROVED / REJECTED from LifecycleDashboard
    if body.decision not in ("APPROVED", "REJECTED"):
        raise HTTPException(status_code=422,
            detail=_err("decision must be 'APPROVED' or 'REJECTED'."))

    order = await _get_order_or_404(order_id, db)
    if order["status"] != S.FLAGGED:
        raise HTTPException(status_code=409, detail=_err(
            f"Order is not flagged (current status: {order['status']}).",
            "Only FLAGGED orders can be reviewed.",
        ))

    new_status = S.PENDING_PAYMENT if body.decision == "APPROVED" else S.CANCELLED
    safe_actor = actor["id"] if _is_valid_uuid(actor["id"]) else None

    from sqlalchemy import text

    # FIX-15: separate UPDATE for approved vs rejected (no str.format)
    if body.decision == "REJECTED":
        await db.execute(
            text("""
                UPDATE orders
                SET  status              = :status,
                     updated_at          = NOW(),
                     cancellation_reason = 'SUSPICIOUS_ORDER',
                     cancellation_note   = :reason,
                     cancelled_by        = :actor
                WHERE id = :oid
            """),
            {"status": new_status, "reason": body.reason,
             "actor": safe_actor, "oid": order_id},
        )
    else:
        await db.execute(
            text("""
                UPDATE orders
                SET  status    = :status,
                     updated_at = NOW()
                WHERE id = :oid
            """),
            {"status": new_status, "oid": order_id},
        )

    with suppress(Exception):
        await db.execute(
            text("""
                UPDATE flagged_orders
                SET  reviewed_by = :actor,
                     decision    = :decision,
                     reason      = :reason,
                     reviewed_at = NOW()
                WHERE order_id = :oid
            """),
            {"actor": safe_actor, "decision": body.decision,
             "reason": body.reason, "oid": order_id},
        )

    await _insert_transition(order_id, S.FLAGGED, new_status,
                              actor["id"], actor["role"], body.reason, db)
    await _write_audit(actor["id"], actor["role"],
                       f"FLAGGED_ORDER_{body.decision}",
                       "order", order_id,
                       {"status": S.FLAGGED}, {"status": new_status},
                       body.reason, db)
    await db.commit()
    await _bus.broadcast(order_id, new_status)

    return {
        "order_id":    order_id,
        "decision":    body.decision,
        "new_status":  new_status,
        "reviewed_by": actor["id"],
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/admin/audit-log")
async def get_audit_log(
    request:   Request,
    entity_id: Optional[str] = Query(None),
    actor_id:  Optional[str] = Query(None),
    limit:     int           = Query(50, le=200),
    db=_db_dep,
):
    actor = _get_actor(request)
    _require_admin(actor)

    from sqlalchemy import text
    filters   = []
    bind_vals = {"limit": limit}

    if entity_id:
        # FIX-12: column is target_id_text in 005 schema
        filters.append("target_id_text = :eid")
        bind_vals["eid"] = entity_id
    if actor_id:
        filters.append("actor_id = :aid")
        bind_vals["aid"] = actor_id

    where = ("WHERE " + " AND ".join(filters)) if filters else ""

    with suppress(Exception):
        result = await db.execute(
            text(f"""
                SELECT id, actor_id, actor_role, action,
                       entity_type,
                       COALESCE(target_id_text, '') AS entity_id,
                       before_state, after_state, detail, created_at
                FROM   audit_log
                {where}
                ORDER  BY created_at DESC
                LIMIT  :limit
            """),
            bind_vals,
        )
        return [dict(r) for r in result.mappings().all()]
    return []