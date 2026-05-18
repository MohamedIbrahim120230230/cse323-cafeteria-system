"""
order/order_payment.py  — Member 3: Order & Payment (FastAPI version)
"""

import os
import uuid
import threading
import time
import json
import psycopg2
import psycopg2.extras
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Request

# ─────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────
PAYMENT_TIMEOUT_SECONDS = 600
CANCELLATION_WINDOW_MIN = 15
MAX_CONCURRENT_ORDERS   = 150
IDEMPOTENCY_WINDOW_SEC  = 60
MAX_ITEM_QUANTITY       = 20

router = APIRouter()   # FastAPI router — imported by main.py


def get_db():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        database=os.getenv("DB_NAME", "cafeteria"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD", "postgres123"),
        port=os.getenv("DB_PORT", "5432"),
    )


def gen_uuid():
    return str(uuid.uuid4())


# ─────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────
def _is_prepaid(method):
    return method in ["online", "wallet", "meal_plan"]


def _release_stock(cur, order_id):
    cur.execute(
        "SELECT menu_item_id, quantity FROM order_items WHERE order_id = %s", (order_id,)
    )
    for item in cur.fetchall():
        cur.execute(
            "UPDATE menu_items SET stock_qty = stock_qty + %s WHERE id = %s",
            (item["quantity"], item["menu_item_id"]),
        )

def _initiate_refund(cur, order_id, total, full=True, percent=1.0):
    amount = float(total) if full else round(float(total) * percent, 2)
    cur.execute(
        "SELECT id FROM payments WHERE order_id = %s ORDER BY created_at DESC LIMIT 1",
        (order_id,),
    )
    payment = cur.fetchone()
    if payment:
        refund_ref = f"REF-{uuid.uuid4().hex[:10].upper()}"
        cur.execute(
            "UPDATE payments SET refund_amount = %s, refund_ref = %s WHERE id = %s",
            (amount, refund_ref, payment["id"]),
        )
        return {"refund_amount": amount, "refund_ref": refund_ref, "eta_days": "3-5 business days"}
    return {"refund_amount": amount, "message": "Refund will be processed manually"}


# ════════════════════════════════════════════════════════════
# ORDER ROUTES
# ════════════════════════════════════════════════════════════

@router.post("/api/v1/orders")
async def place_order(request: Request):
    d = await request.json()

    user_id         = d.get("user_id", "guest-user")
    idempotency_key = (
        d.get("idempotency_key")
        or request.headers.get("X-Idempotency-Key")
        or f"AUTO-{uuid.uuid4().hex}"
    )
    voucher_code = (d.get("voucher_code") or "").strip().upper() or None
    notes        = d.get("notes", "")

    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    try:
        # ── Idempotency ──────────────────────────────────────
        cur.execute("SELECT * FROM orders WHERE idempotency_key = %s", (idempotency_key,))
        existing = cur.fetchone()
        if existing:
            age = (
                datetime.now(timezone.utc)
                - existing["created_at"].replace(tzinfo=timezone.utc)
            ).total_seconds()
            if age <= IDEMPOTENCY_WINDOW_SEC:
                cur.execute("SELECT * FROM order_items WHERE order_id = %s", (existing["id"],))
                items = [dict(r) for r in cur.fetchall()]
                return {"success": True, "duplicate": True, "order": {**dict(existing), "items": items}}

        # ── Concurrency limit ────────────────────────────────
        cur.execute(
            "SELECT COUNT(*) as count FROM orders WHERE status IN ('pending_payment','confirmed','preparing')"
        )
        if cur.fetchone()["count"] >= MAX_CONCURRENT_ORDERS:
            raise HTTPException(
                status_code=503,
                detail={"code": "SYSTEM_OVERLOADED", "message": "Service temporarily busy.", "retry_after": 30},
            )

        # ── Resolve cart items ───────────────────────────────
        cart_items_data = d.get("items", [])
        if not cart_items_data:
            try:
                # ✅ FIX: Removed '::uuid' type cast to avoid string mismatch failures
                cur.execute(
                    "SELECT items FROM cart_sessions WHERE user_id = %s", (user_id,)
                )
                cart_row = cur.fetchone()
                if cart_row and cart_row["items"]:
                    raw = cart_row["items"]
                    cart_items_data = raw if isinstance(raw, list) else json.loads(raw)
            except Exception:
                pass

        if not cart_items_data:
            raise HTTPException(
                status_code=400,
                detail={"code": "EMPTY_CART", "message": "Cart is empty"},
            )

        subtotal           = 0.0
        order_items_insert = []

        for ci in cart_items_data:
            item_id  = ci.get("menu_item_id") or ci.get("id") or ci.get("item_id")
            quantity = int(ci.get("qty") or ci.get("quantity") or 1)

            if quantity > MAX_ITEM_QUANTITY:
                conn.rollback()
                raise HTTPException(
                    status_code=400,
                    detail={"code": "MAX_QTY_EXCEEDED", "message": f"Max {MAX_ITEM_QUANTITY} units per item"},
                )

            # ✅ FIX: Updated columns from 'is_available, stock_count' to 'stock_qty, active'
            cur.execute(
                "SELECT id, name, price, stock_qty, active FROM menu_items WHERE id = %s FOR UPDATE NOWAIT",
                (item_id,),
            )
            item = cur.fetchone()

            if not item or not item["active"]:
                conn.rollback()
                raise HTTPException(
                    status_code=409,
                    detail={"code": "ITEM_UNAVAILABLE", "message": "Item is no longer available"},
                )

            if item["stock_qty"] < quantity:
                conn.rollback()
                raise HTTPException(
                    status_code=409,
                    detail={"code": "OVERSELL_PREVENTED", "message": f"'{item['name']}' is out of stock."},
                )

            line_total = float(item["price"]) * quantity
            subtotal  += line_total
            order_items_insert.append({
                "menu_item_id": item["id"],
                "name":         item["name"],
                "unit_price":   float(item["price"]),
                "quantity":     quantity,
                "subtotal":     line_total,
            })
            
            # ✅ FIX: Updated target column to stock_qty
            cur.execute(
                "UPDATE menu_items SET stock_qty = stock_qty - %s WHERE id = %s",
                (quantity, item_id),
            )

# ── Voucher ──────────────────────────────────────────
        discount, voucher_id = 0.0, None
        if voucher_code:
            # ✅ Aligned with your 002 migration schema columns
            cur.execute(
                "SELECT id, discount, min_order, expires_at, used_by FROM vouchers WHERE code = %s", (voucher_code,)
            )
            v = cur.fetchone()
            
            if v:
                # Handle timezone validation smoothly without syntax bugs
                expires_aware = None
                if v["expires_at"]:
                    expires_aware = (
                        v["expires_at"]
                        if v["expires_at"].tzinfo
                        else v["expires_at"].replace(tzinfo=timezone.utc)
                    )
                
                not_expired = expires_aware is None or datetime.now(timezone.utc) <= expires_aware
                
                # Check if the voucher has not been used yet, is not expired, and meets min order amount
                if v["used_by"] is None and not_expired and subtotal >= float(v["min_order"]):
                    discount = min(float(v["discount"]), subtotal)
                    voucher_id = v["id"]
                    
                    # Mark the voucher as used by the current user session
                    cur.execute(
                        "UPDATE vouchers SET used_by = %s WHERE id = %s", (user_id, voucher_id)
                    )

        total    = round(subtotal - discount, 2)
        order_id = gen_uuid()

        cur.execute(
            """
            INSERT INTO orders
              (id, idempotency_key, user_id, status, subtotal, discount, total,
               voucher_id, voucher_code, notes, created_at)
            VALUES (%s,%s,%s,'pending_payment',%s,%s,%s,%s,%s,%s,NOW())
            """,
            (order_id, idempotency_key, user_id, subtotal, discount, total,
             voucher_id, voucher_code, notes),
        )

        for oi in order_items_insert:
            cur.execute(
                """
                INSERT INTO order_items
                  (id, order_id, menu_item_id, name, unit_price, quantity, subtotal)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                """,
                (gen_uuid(), order_id, oi["menu_item_id"], oi["name"],
                 oi["unit_price"], oi["quantity"], oi["subtotal"]),
            )

        # Clear cart
        try:
            cur.execute(
                "UPDATE cart_sessions SET items = '[]'::jsonb WHERE user_id = %s", (user_id,)
            )
        except Exception:
            pass

        conn.commit()

        return {
            "success": True,
            "order": {
                "id":           order_id,
                "status":       "pending_payment",
                "subtotal":     subtotal,
                "discount":     discount,
                "total":        total,
                "voucher_code": voucher_code,
                "items":        order_items_insert,
            },
        }

    except HTTPException:
        conn.rollback()
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail={"message": str(e)})
    finally:
        cur.close()
        conn.close()

@router.get("/api/v1/orders/{order_id}")
def get_order(order_id: str):
    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cur.execute("SELECT * FROM orders WHERE id = %s", (order_id,))
        order = cur.fetchone()
        if not order:
            raise HTTPException(status_code=404, detail={"message": "Order not found"})
        order = dict(order)
        cur.execute("SELECT * FROM order_items WHERE order_id = %s", (order_id,))
        order["items"] = [dict(r) for r in cur.fetchall()]
        cur.execute("SELECT * FROM payments WHERE order_id = %s", (order_id,))
        order["payments"] = [dict(r) for r in cur.fetchall()]
        return {"success": True, "order": order}
    finally:
        cur.close()
        conn.close()


@router.put("/api/v1/orders/{order_id}/cancel")
async def cancel_order(order_id: str):
    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    now  = datetime.now(timezone.utc)

    try:
        cur.execute("SELECT * FROM orders WHERE id = %s FOR UPDATE", (order_id,))
        order = cur.fetchone()
        if not order:
            raise HTTPException(status_code=404, detail={"message": "Order not found"})

        if order["status"] == "pending_payment":
            cur.execute(
                "UPDATE orders SET status='cancelled', cancelled_at=NOW() WHERE id=%s", (order_id,)
            )
            _release_stock(cur, order_id)
            conn.commit()
            return {"success": True, "message": "Order cancelled successfully"}

        if order["status"] == "confirmed":
            confirmed_at = (
                order["confirmed_at"]
                if order["confirmed_at"].tzinfo
                else order["confirmed_at"].replace(tzinfo=timezone.utc)
            )
            if now <= confirmed_at + timedelta(minutes=CANCELLATION_WINDOW_MIN):
                cur.execute(
                    "UPDATE orders SET status='cancelled', cancelled_at=NOW() WHERE id=%s", (order_id,)
                )
                _release_stock(cur, order_id)
                refund = (
                    _initiate_refund(cur, order_id, order["total"], full=True)
                    if _is_prepaid(order.get("payment_method", ""))
                    else None
                )
                conn.commit()
                return {"success": True, "message": "Order cancelled with full refund", "refund": refund}

            return {
                "success": False,
                "code":    "CANCELLATION_WINDOW_EXPIRED",
                "message": "Cancellation window has passed. A partial refund may apply.",
            }

        raise HTTPException(
            status_code=409,
            detail={"message": "Order cannot be cancelled at this stage"},
        )

    except HTTPException:
        conn.rollback()
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail={"message": str(e)})
    finally:
        cur.close()
        conn.close()


@router.put("/api/v1/orders/{order_id}/cancel/confirm-partial")
async def confirm_partial_cancel(order_id: str):
    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cur.execute("SELECT * FROM orders WHERE id = %s FOR UPDATE", (order_id,))
        order = cur.fetchone()
        if not order:
            raise HTTPException(status_code=404, detail={"message": "Order not found"})
        cur.execute(
            "UPDATE orders SET status='cancelled', cancelled_at=NOW() WHERE id=%s", (order_id,)
        )
        _release_stock(cur, order_id)
        refund = _initiate_refund(cur, order_id, order["total"], full=False, percent=0.5)
        conn.commit()
        return {"success": True, "refund": refund}
    except HTTPException:
        conn.rollback()
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail={"message": str(e)})
    finally:
        cur.close()
        conn.close()


@router.put("/api/v1/orders/{order_id}/status")
async def update_order_status(order_id: str, request: Request):
    d      = await request.json()
    status = d.get("status")
    valid  = {"confirmed", "preparing", "ready_for_pickup", "delivered", "cancelled"}
    if status not in valid:
        raise HTTPException(
            status_code=400,
            detail={"message": f"Invalid status. Must be one of {valid}"},
        )
    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cur.execute(
            "UPDATE orders SET status=%s WHERE id=%s RETURNING status", (status, order_id)
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail={"message": "Order not found"})
        conn.commit()
        return {"success": True, "status": row["status"]}
    except HTTPException:
        conn.rollback()
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail={"message": str(e)})
    finally:
        cur.close()
        conn.close()


# ════════════════════════════════════════════════════════════
# PAYMENT ROUTES
# ════════════════════════════════════════════════════════════

@router.post("/api/v1/payments/process")
@router.post("/api/v1/payments/initiate")
async def initiate_payment(request: Request):
    d        = await request.json()
    order_id = d.get("order_id")
    raw_pm   = str(d.get("payment_method", "cash")).lower().strip()

    if "card" in raw_pm or "online" in raw_pm:
        pm = "online"
    elif "plan" in raw_pm:
        pm = "meal_plan"
    elif "wallet" in raw_pm:
        pm = "wallet"
    else:
        pm = "cash"

    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    try:
        cur.execute("SELECT * FROM orders WHERE id = %s FOR UPDATE", (order_id,))
        order = cur.fetchone()
        if not order:
            raise HTTPException(status_code=404, detail={"message": "Order not found"})
        if order["status"] != "pending_payment":
            raise HTTPException(status_code=409, detail={"message": "Order is not awaiting payment"})

        # ── Balance checks ───────────────────────────────────
        if pm in ["wallet", "meal_plan"]:
            try:
                cur.execute(
                    "SELECT wallet_balance, meal_plan_balance FROM users WHERE id = %s::uuid",
                    (order["user_id"],),
                )
                user = cur.fetchone()
            except Exception:
                user = None

            if user:
                if pm == "meal_plan" and float(user["meal_plan_balance"]) < float(order["total"]):
                    raise HTTPException(
                        status_code=422,
                        detail={
                            "code":                "INSUFFICIENT_MEAL_PLAN_BALANCE",
                            "message":             "Insufficient Meal Plan balance.",
                            "current_balance_egp": float(user["meal_plan_balance"]),
                            "required_egp":        float(order["total"]),
                            "shortfall_egp":       round(float(order["total"]) - float(user["meal_plan_balance"]), 2),
                        },
                    )
                if pm == "wallet" and float(user["wallet_balance"]) < float(order["total"]):
                    raise HTTPException(
                        status_code=422,
                        detail={
                            "code":                "INSUFFICIENT_WALLET_BALANCE",
                            "message":             "Insufficient Wallet balance.",
                            "current_balance_egp": float(user["wallet_balance"]),
                            "required_egp":        float(order["total"]),
                            "shortfall_egp":       round(float(order["total"]) - float(user["wallet_balance"]), 2),
                        },
                    )
                col = "meal_plan_balance" if pm == "meal_plan" else "wallet_balance"
                cur.execute(
                    f"UPDATE users SET {col} = {col} - %s WHERE id = %s::uuid",
                    (order["total"], order["user_id"]),
                )

        payment_id = gen_uuid()
        
        # Explicit timezone handling for cross-compat database drivers
        now_time   = datetime.now(timezone.utc).replace(tzinfo=None)
        timeout_at = now_time + timedelta(seconds=PAYMENT_TIMEOUT_SECONDS)

        if pm == "online":
            cur.execute(
                """
                INSERT INTO payments (id, order_id, amount, method, status, timeout_at, created_at)
                VALUES (%s,%s,%s,%s,'pending',%s,NOW())
                """,
                (payment_id, order_id, order["total"], pm, timeout_at),
            )
            cur.execute("UPDATE orders SET payment_method=%s WHERE id=%s", (pm, order_id))
            conn.commit()
            return {
                "success":    True,
                "payment_id": payment_id,
                "timeout_at": timeout_at.isoformat() + "Z",
                "method":     pm,
            }

        # Handle automatic instant confirmation for cash/sufficient credit
        cur.execute(
            """
            INSERT INTO payments (id, order_id, amount, method, status, timeout_at, created_at)
            VALUES (%s,%s,%s,%s,'success',NOW(),NOW())
            """,
            (payment_id, order_id, order["total"], pm),
        )
        cur.execute(
            "UPDATE orders SET status='confirmed', payment_method=%s WHERE id=%s",
            (pm, order_id),
        )
        conn.commit()
        return {
            "success":      True,
            "payment_id":   payment_id,
            "message":      "Payment confirmed successfully.",
            "order_status": "confirmed",
        }

    except HTTPException:
        conn.rollback()
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail={"message": str(e)})
    finally:
        cur.close()
        conn.close()


@router.post("/api/v1/payments/{payment_id}/callback")
async def payment_callback(payment_id: str, request: Request):
    d           = await request.json()
    success     = d.get("success", False)
    txn_id      = d.get("transaction_id", f"TXN-{uuid.uuid4().hex[:8].upper()}")
    fail_reason = d.get("failure_reason", "unknown")

    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cur.execute("SELECT * FROM payments WHERE id = %s FOR UPDATE", (payment_id,))
        payment = cur.fetchone()
        if not payment:
            raise HTTPException(status_code=404, detail={"message": "Payment not found"})

        order_id = payment["order_id"]
        if success:
            cur.execute(
                "UPDATE payments SET status='success', transaction_id=%s WHERE id=%s",
                (txn_id, payment_id),
            )
            cur.execute(
                "UPDATE orders SET status='confirmed', confirmed_at=NOW() WHERE id=%s", (order_id,)
            )
            conn.commit()
            return {"success": True, "order_status": "confirmed"}
        else:
            cur.execute(
                "UPDATE payments SET status='failed', failure_reason=%s WHERE id=%s",
                (fail_reason, payment_id),
            )
            conn.commit()
            return {"success": False, "failure_reason": fail_reason}

    except HTTPException:
        conn.rollback()
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail={"message": str(e)})
    finally:
        cur.close()
        conn.close()


@router.post("/api/v1/payments/{payment_id}/retry")
async def retry_payment(payment_id: str):
    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cur.execute("SELECT * FROM payments WHERE id = %s", (payment_id,))
        payment = cur.fetchone()
        if not payment:
            raise HTTPException(status_code=404, detail={"message": "Payment not found"})

        cur.execute(
            "SELECT COUNT(*) as cnt FROM payments WHERE order_id = %s", (payment["order_id"],)
        )
        if cur.fetchone()["cnt"] >= 4:
            raise HTTPException(
                status_code=409,
                detail={"code": "MAX_RETRIES_EXCEEDED", "message": "Maximum retry attempts reached."},
            )

        new_id     = gen_uuid()
        timeout_at = datetime.now(timezone.utc) + timedelta(seconds=PAYMENT_TIMEOUT_SECONDS)
        cur.execute(
            """
            INSERT INTO payments (id, order_id, method, status, amount, timeout_at, created_at)
            VALUES (%s,%s,%s,'pending',%s,%s,NOW())
            """,
            (new_id, payment["order_id"], payment["method"], payment["amount"], timeout_at),
        )
        cur.execute(
            "UPDATE orders SET status='pending_payment' WHERE id=%s AND status IN ('payment_failed','payment_timeout')",
            (payment["order_id"],),
        )
        conn.commit()
        return {"success": True, "payment_id": new_id}

    except HTTPException:
        conn.rollback()
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail={"message": str(e)})
    finally:
        cur.close()
        conn.close()


# ─────────────────────────────────────────────────────────────
# BACKGROUND: expire timed-out payments every 60 s
# ─────────────────────────────────────────────────────────────
def _stock_lock_cleanup_job():
    while True:
        time.sleep(60)
        try:
            conn = get_db()
            cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(
                "SELECT id, order_id FROM payments WHERE status='pending' AND timeout_at <= NOW()"
            )
            expired = cur.fetchall()
            for p in expired:
                cur.execute("UPDATE payments SET status='timeout' WHERE id=%s", (p["id"],))
                cur.execute(
                    "SELECT status FROM orders WHERE id=%s FOR UPDATE", (p["order_id"],)
                )
                order = cur.fetchone()
                if order and order["status"] == "pending_payment":
                    cur.execute(
                        "UPDATE orders SET status='payment_timeout' WHERE id=%s", (p["order_id"],)
                    )
                    _release_stock(cur, p["order_id"])
            if expired:
                conn.commit()
            cur.close()
            conn.close()
        except Exception:
            pass


threading.Thread(target=_stock_lock_cleanup_job, daemon=True).start()