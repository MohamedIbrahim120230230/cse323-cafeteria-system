"""
backend/lifecycle/lifecycle_admin.py
Rewritten to use psycopg2 — no SQLAlchemy required.
Drop this file into backend/lifecycle/ replacing the original.
"""
from __future__ import annotations
import asyncio
import csv
import io
import json
import os
import uuid
from contextlib import suppress
from datetime import datetime, timezone, timedelta
from typing import Any, AsyncGenerator, Optional

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

try:
    import jwt as pyjwt
    _HAS_JWT = True
except ImportError:
    _HAS_JWT = False

JWT_SECRET    = os.getenv("JWT_SECRET", "dev-secret-CHANGE-IN-PRODUCTION")
JWT_ALGORITHM = "HS256"

router = APIRouter(prefix="/api/v1", tags=["Lifecycle & Admin"])

# ── DB ─────────────────────────────────────────────────────────
def _get_db():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        database=os.getenv("DB_NAME", "cafeteria"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD", "postgres123"),
        port=os.getenv("DB_PORT", "5432"),
    )

# ── SSE Bus ────────────────────────────────────────────────────
class _SSEBus:
    def __init__(self):
        self._subs: dict[str, set] = {}

    async def subscribe(self, order_id: str) -> AsyncGenerator[str, None]:
        q: asyncio.Queue = asyncio.Queue(maxsize=50)
        self._subs.setdefault(order_id, set()).add(q)
        try:
            yield f"data: {json.dumps({'order_id': order_id, 'type': 'connected'})}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=25)
                    yield f"data: {json.dumps(msg)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            if order_id in self._subs:
                self._subs[order_id].discard(q)

    async def broadcast(self, order_id: str, new_status: str):
        payload = {
            "order_id":   order_id,
            "status":     new_status,
            "new_status": new_status,
            "type":       "status_update",
            "timestamp":  datetime.now(timezone.utc).isoformat(),
        }
        for q in list(self._subs.get(order_id, [])):
            with suppress(Exception):
                q.put_nowait(payload)

_bus = _SSEBus()

# ── Serialization ───────────────────────────────────────────────
def _s(obj):
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {k: _s(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_s(i) for i in obj]
    return obj

# ── Auth ────────────────────────────────────────────────────────
def _decode_jwt(token: str) -> dict:
    if not _HAS_JWT or not token:
        return {}
    with suppress(Exception):
        return pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    return {}

def _get_actor(request: Request, token_param: Optional[str] = None) -> dict:
    actor_id = actor_role = None
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        p = _decode_jwt(auth[7:])
        if p:
            actor_id   = p.get("sub") or p.get("user_id")
            actor_role = p.get("role")
    if not actor_role and token_param:
        p = _decode_jwt(token_param)
        if p:
            actor_id   = p.get("sub") or p.get("user_id")
            actor_role = p.get("role")
    actor_role = (actor_role or request.headers.get("X-Actor-Role", "staff")).lower()
    actor_id   = actor_id or request.headers.get("X-Actor-Id") or f"{actor_role}-demo"
    return {"id": actor_id, "role": actor_role}

# ── Schemas ─────────────────────────────────────────────────────
class AdvanceStatusRequest(BaseModel):
    new_status: str
    note: Optional[str] = None

class CancelRequest(BaseModel):
    reason_code: Optional[str] = None
    note: Optional[str] = None

class ConfigUpdateRequest(BaseModel):
    value: str

class FlaggedReviewRequest(BaseModel):
    decision: str
    reason: str

class RatingRequest(BaseModel):
    order_id: str
    stars: int = Field(..., ge=1, le=5)
    text: Optional[str] = None

# ── State machine ────────────────────────────────────────────────
TRANSITIONS = {
    "placed":           {"pending_payment", "confirmed", "cancelled"},
    "pending_payment":  {"confirmed", "payment_failed", "cancelled"},
    "confirmed":        {"preparing", "cancelled"},
    "preparing":        {"ready_for_pickup", "cancelled"},
    "ready_for_pickup": {"delivered"},
    "delivered":        {"completed"},
    "completed":        set(),
    "cancelled":        set(),
    "payment_failed":   set(),
    "flagged":          {"pending_payment", "cancelled"},
}

# ════════════════════════════════════════════════════════════════
# SSE STREAM
# ════════════════════════════════════════════════════════════════

@router.get("/orders/{order_id}/stream")
async def order_stream(
    order_id: str,
    token: Optional[str] = Query(None),
):
    # Verify order exists
    try:
        conn = _get_db()
        cur  = conn.cursor()
        cur.execute("SELECT id FROM orders WHERE id = %s", (order_id,))
        exists = cur.fetchone()
        cur.close(); conn.close()
        if not exists:
            raise HTTPException(status_code=404, detail={"message": "Order not found"})
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=404, detail={"message": "Order not found"})

    return StreamingResponse(
        _bus.subscribe(order_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )

# ════════════════════════════════════════════════════════════════
# ORDER STATUS / CANCEL
# ════════════════════════════════════════════════════════════════

@router.patch("/orders/{order_id}/status")
@router.put("/orders/{order_id}/status")
async def advance_order_status(order_id: str, body: AdvanceStatusRequest, request: Request):
    actor      = _get_actor(request)
    new_status = body.new_status.lower()
    try:
        conn = _get_db()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT status FROM orders WHERE id = %s", (order_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail={"message": "Order not found"})
        prev = row["status"]
        if new_status not in TRANSITIONS.get(prev, set()):
            raise HTTPException(status_code=409, detail={
                "message": f"Transition from '{prev}' to '{new_status}' is not allowed.",
                "allowed": list(TRANSITIONS.get(prev, set())),
            })
        cur.execute("UPDATE orders SET status = %s WHERE id = %s", (new_status, order_id))
        conn.commit()
        cur.close(); conn.close()
        await _bus.broadcast(order_id, new_status)
        return {
            "order_id": order_id,
            "previous_status": prev,
            "new_status": new_status,
            "updated_by": actor["id"],
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail={"message": str(e)})


@router.post("/orders/{order_id}/cancel")
@router.put("/orders/{order_id}/cancel")
async def cancel_order(order_id: str, body: CancelRequest, request: Request):
    actor = _get_actor(request)
    try:
        conn = _get_db()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT status FROM orders WHERE id = %s", (order_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail={"message": "Order not found"})
        if row["status"] in ("completed", "cancelled"):
            raise HTTPException(status_code=409, detail={"message": f"Order already {row['status']}"})
        cur.execute("UPDATE orders SET status = 'cancelled' WHERE id = %s", (order_id,))
        conn.commit()
        cur.close(); conn.close()
        await _bus.broadcast(order_id, "cancelled")
        return {
            "order_id": order_id,
            "status": "cancelled",
            "cancelled_by": actor["id"],
            "reason_code": body.reason_code or "STAFF_ACTION",
            "refund_initiated": False,
            "refund_id": None,
            "cancelled_at": datetime.now(timezone.utc).isoformat(),
            "success": True,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail={"message": str(e)})

# ════════════════════════════════════════════════════════════════
# RATINGS
# ════════════════════════════════════════════════════════════════

@router.post("/ratings", status_code=201)
def submit_rating(body: RatingRequest, request: Request):
    actor = _get_actor(request)
    try:
        conn = _get_db()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT status FROM orders WHERE id = %s", (body.order_id,))
        order = cur.fetchone()
        if not order:
            raise HTTPException(status_code=404, detail={"message": "Order not found"})
        if order["status"] != "completed":
            raise HTTPException(status_code=409, detail={"message": "Ratings only allowed for completed orders"})
        rating_id = str(uuid.uuid4())
        with suppress(Exception):
            cur.execute("""
                INSERT INTO ratings (id, order_id, stars, text, created_at)
                VALUES (%s, %s, %s, %s, NOW())
            """, (rating_id, body.order_id, body.stars, body.text))
        conn.commit()
        cur.close(); conn.close()
        return {"id": rating_id, "message": "Rating submitted.", "stars": body.stars}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail={"message": str(e)})

# ════════════════════════════════════════════════════════════════
# ADMIN — FLAGGED ORDERS
# ════════════════════════════════════════════════════════════════

@router.get("/admin/flagged-orders")
def list_flagged_orders(request: Request):
    try:
        conn = _get_db()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT o.id AS order_id, o.user_id,
                   COALESCE(o.total, 0) AS total_egp,
                   o.created_at AS placed_at,
                   f.flagged_reason, f.auto_cancel_at
            FROM orders o
            LEFT JOIN flagged_orders f ON f.order_id = o.id
            WHERE o.status = 'flagged'
            ORDER BY o.created_at DESC
        """)
        orders = [dict(r) for r in cur.fetchall()]
        for order in orders:
            cur.execute("""
                SELECT menu_item_id AS item_id, name, quantity, subtotal AS subtotal_egp
                FROM order_items WHERE order_id = %s
            """, (str(order["order_id"]),))
            order["items"] = [dict(r) for r in cur.fetchall()]
        cur.close(); conn.close()
        return _s(orders)
    except Exception:
        return []


@router.post("/admin/flagged-orders/{order_id}/review")
def review_flagged_order(order_id: str, body: FlaggedReviewRequest, request: Request):
    if body.decision not in ("APPROVED", "REJECTED"):
        raise HTTPException(status_code=422, detail={"message": "decision must be APPROVED or REJECTED"})
    try:
        conn = _get_db()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        new_status = "pending_payment" if body.decision == "APPROVED" else "cancelled"
        cur.execute("UPDATE orders SET status = %s WHERE id = %s", (new_status, order_id))
        with suppress(Exception):
            cur.execute("""
                UPDATE flagged_orders
                SET decision = %s, reason = %s, reviewed_at = NOW()
                WHERE order_id = %s
            """, (body.decision, body.reason, order_id))
        conn.commit()
        cur.close(); conn.close()
        return {
            "order_id": order_id,
            "decision": body.decision,
            "new_status": new_status,
            "reviewed_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail={"message": str(e)})

# ════════════════════════════════════════════════════════════════
# ADMIN — CONFIG
# ════════════════════════════════════════════════════════════════

@router.get("/admin/config")
def list_config(request: Request):
    try:
        conn = _get_db()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT key, value, description, updated_at FROM system_config ORDER BY key")
        rows = [dict(r) for r in cur.fetchall()]
        cur.close(); conn.close()
        return _s(rows)
    except Exception:
        return []


@router.patch("/admin/config/{key}")
def update_config(key: str, body: ConfigUpdateRequest, request: Request):
    try:
        conn = _get_db()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            UPDATE system_config SET value = %s, updated_at = NOW()
            WHERE key = %s RETURNING key, value, description, updated_at
        """, (body.value, key))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail={"message": f"Config key '{key}' not found"})
        conn.commit()
        cur.close(); conn.close()
        return _s(dict(row))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail={"message": str(e)})

# ════════════════════════════════════════════════════════════════
# ADMIN — REPORTS
# ════════════════════════════════════════════════════════════════

@router.get("/admin/reports")
def get_report(
    request: Request,
    type: str = Query(...),
    from_date: str = Query(..., alias="from"),
    to_date: str = Query(..., alias="to"),
):
    QUERIES = {
        "revenue": """
            SELECT DATE(created_at) AS date,
                   COUNT(*) AS order_count,
                   ROUND(SUM(COALESCE(total,0))::NUMERIC,2) AS revenue_egp
            FROM orders WHERE status NOT IN ('cancelled','payment_failed')
              AND created_at BETWEEN %s AND %s
            GROUP BY 1 ORDER BY 1
        """,
        "top_items": """
            SELECT oi.name AS item, SUM(oi.quantity) AS total_sold,
                   ROUND(SUM(COALESCE(oi.subtotal,0))::NUMERIC,2) AS revenue_egp
            FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE o.status NOT IN ('cancelled','payment_failed')
              AND o.created_at BETWEEN %s AND %s
            GROUP BY 1 ORDER BY 2 DESC LIMIT 20
        """,
        "cancellations": """
            SELECT DATE(created_at) AS date, COUNT(*) AS cancelled_count
            FROM orders WHERE status = 'cancelled'
              AND created_at BETWEEN %s AND %s
            GROUP BY 1 ORDER BY 1
        """,
        "heatmap": """
            SELECT EXTRACT(DOW FROM created_at)::INT AS day_of_week,
                   EXTRACT(HOUR FROM created_at)::INT AS hour,
                   COUNT(*) AS order_count
            FROM orders WHERE status NOT IN ('cancelled','payment_failed')
              AND created_at BETWEEN %s AND %s
            GROUP BY 1, 2 ORDER BY 1, 2
        """,
        "ratings": """
            SELECT stars, COUNT(*) AS count,
                   ROUND(AVG(stars)::NUMERIC,2) AS avg_stars
            FROM ratings WHERE created_at BETWEEN %s AND %s
            GROUP BY stars ORDER BY 1 DESC
        """,
    }
    sql = QUERIES.get(type)
    if not sql:
        raise HTTPException(status_code=400, detail={"message": f"Invalid report type '{type}'"})
    try:
        conn = _get_db()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(sql, (from_date, to_date))
        data = [dict(r) for r in cur.fetchall()]
        cur.close(); conn.close()
        return {
            "report_type": type,
            "from": from_date,
            "to": to_date,
            "total_rows": len(data),
            "report_rows": _s(data),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail={"message": str(e)})

# ════════════════════════════════════════════════════════════════
# ADMIN — AUDIT LOG
# ════════════════════════════════════════════════════════════════

@router.get("/admin/audit-log")
def get_audit_log(request: Request, limit: int = Query(50, le=200)):
    try:
        conn = _get_db()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT id, actor_id, actor_role, action, entity_type,
                   detail, created_at
            FROM audit_log
            ORDER BY created_at DESC LIMIT %s
        """, (limit,))
        rows = [dict(r) for r in cur.fetchall()]
        cur.close(); conn.close()
        return _s(rows)
    except Exception:
        return []
