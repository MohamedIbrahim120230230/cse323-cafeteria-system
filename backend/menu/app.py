"""
backend/menu/router.py
Menu & Cart — converted from Flask (menu/app.py) to FastAPI router.
Mount this in backend/main.py with:
    app.include_router(menu_router)

All routes keep the same URL paths the frontend already expects.
"""

import json
import os
import psycopg2
import psycopg2.extras
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse

router = APIRouter(tags=["Menu & Cart"])


def get_db():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        database=os.getenv("DB_NAME", "cafeteria"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD", "postgres123"),
        port=os.getenv("DB_PORT", "5432"),
    )


# ── Menu ─────────────────────────────────────────────────────

# FR09 — Browse menu (also handles ?category and ?search)
@router.get("/api/v1/menu/items")
def get_menu_items(category: str = None, search: str = None):
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        """
        SELECT id, name, category, price, stock_qty, max_order_qty, active
        FROM menu_items
        WHERE active = TRUE
          AND (%s IS NULL OR category = %s)
          AND (%s IS NULL OR name ILIKE '%%' || %s || '%%')
        ORDER BY category, name
        """,
        (category, category, search, search),
    )
    items = cur.fetchall()
    cur.close()
    conn.close()
    return {"items": [dict(i) for i in items], "total": len(items)}


# FR10 — Full-text search
@router.get("/api/v1/menu/search")
def search_menu(q: str = ""):
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        """
        SELECT id, name, category, price, stock_qty, max_order_qty, active
        FROM menu_items
        WHERE active = TRUE
          AND to_tsvector('english', name) @@ plainto_tsquery('english', %s)
        """,
        (q,),
    )
    items = cur.fetchall()
    cur.close()
    conn.close()
    return {"items": [dict(i) for i in items], "total": len(items)}


# ── Cart ──────────────────────────────────────────────────────

# FR11 — Add item to cart
@router.post("/api/v1/cart/add")
async def cart_add(request: Request):
    data = await request.json()
    item_id = data.get("item_id")
    qty = int(data.get("qty", 1))

    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute(
        "SELECT * FROM menu_items WHERE id = %s AND active = TRUE", (item_id,)
    )
    item = cur.fetchone()
    if not item:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail={"code": "ITEM_NOT_FOUND", "message": "Item not found or unavailable."})

    # FR19 — max quantity cap
    if qty > item["max_order_qty"]:
        cur.close()
        conn.close()
        raise HTTPException(
            status_code=400,
            detail={"code": "MAX_QTY_EXCEEDED", "message": f"Maximum order quantity is {item['max_order_qty']}."},
        )

    # FR11 — stock check
    if item["stock_qty"] < qty:
        cur.close()
        conn.close()
        raise HTTPException(status_code=400, detail={"code": "INSUFFICIENT_STOCK", "message": "Not enough stock."})

    cur.close()
    conn.close()
    return {"message": "Item added to cart", "item_id": item_id, "qty": qty}


# FR13–FR16 — Apply voucher
@router.post("/api/v1/cart/voucher")
async def cart_voucher(request: Request):
    data = await request.json()
    code = (data.get("code") or "").strip().upper()

    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute(
        "SELECT * FROM vouchers WHERE code = %s AND expires_at > NOW()", (code,)
    )
    voucher = cur.fetchone()

    if not voucher:
        cur.close()
        conn.close()
        raise HTTPException(
            status_code=400,
            detail={"code": "VOUCHER_EXPIRED", "message": "Voucher has expired."},
        )

    if voucher["used_by"] is not None:
        cur.close()
        conn.close()
        raise HTTPException(
            status_code=400,
            detail={"code": "VOUCHER_ALREADY_USED", "message": "Voucher has already been used by your account."},
        )

    cur.close()
    conn.close()

    return {
        "discount":      float(voucher["discount"]),
        "discount_egp":  float(voucher["discount"]),
        "min_order":     float(voucher.get("min_order", 0)),
        "voucher_code":  code,
    }


# FR17 — Lock cart at checkout
@router.post("/api/v1/cart/lock")
async def cart_lock(request: Request):
    """
    Called by MenuPage before navigating to OrderPaymentApp.
    Returns a simple success envelope; the real stock lock is
    handled by stock/routes.py during order placement.
    """
    return {"message": "Cart locked", "order": None, "warnings": []}


# ── Admin menu CRUD ───────────────────────────────────────────

@router.get("/api/v1/admin/menu")
def admin_get_menu():
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM menu_items ORDER BY id")
    items = cur.fetchall()
    cur.close()
    conn.close()
    return {"items": [dict(i) for i in items]}


@router.post("/api/v1/admin/menu")
async def admin_create_item(request: Request):
    data = await request.json()
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        """
        INSERT INTO menu_items (name, category, price, stock_qty, max_order_qty, active)
        VALUES (%s, %s, %s, %s, %s, %s) RETURNING *
        """,
        (
            data["name"],
            data["category"],
            data["price"],
            data.get("stock_qty", 0),
            data.get("max_order_qty", 10),
            data.get("active", True),
        ),
    )
    item = cur.fetchone()
    conn.commit()
    cur.close()
    conn.close()
    return dict(item)


@router.put("/api/v1/admin/menu/{item_id}")
async def admin_update_item(item_id: int, request: Request):
    data = await request.json()
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        """
        UPDATE menu_items
        SET name=%s, category=%s, price=%s,
            stock_qty=%s, max_order_qty=%s, active=%s, updated_at=NOW()
        WHERE id=%s RETURNING *
        """,
        (
            data["name"],
            data["category"],
            data["price"],
            data.get("stock_qty", 0),
            data.get("max_order_qty", 10),
            data.get("active", True),
            item_id,
        ),
    )
    item = cur.fetchone()
    conn.commit()
    cur.close()
    conn.close()
    if not item:
        raise HTTPException(status_code=404, detail={"message": "Item not found."})
    return dict(item)


@router.delete("/api/v1/admin/menu/{item_id}")
def admin_delete_item(item_id: int):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("UPDATE menu_items SET active = FALSE WHERE id = %s", (item_id,))
    conn.commit()
    cur.close()
    conn.close()
    return {"message": "Item deactivated"}