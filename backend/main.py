import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import psycopg2
import psycopg2.extras
import os

from auth.routes              import router as auth_router
from order.order_payment      import router as order_router
from stock.routes             import router as stock_router
from lifecycle.lifecycle_admin import router as lifecycle_admin_router

app = FastAPI(title="University Cafeteria API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://campus-bite-ys9d.vercel.app"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth_router)
app.include_router(order_router)
app.include_router(stock_router)
app.include_router(lifecycle_admin_router)

def get_db():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        database=os.getenv("DB_NAME", "cafeteria"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD", "postgres123"),
        port=os.getenv("DB_PORT", "5432")
    )

# ── Menu Routes ───────────────────────────────────────────────
@app.get("/api/v1/menu/items")
def get_menu_items(category: str = None, search: str = None):
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT id, name, category, price, stock_qty, max_order_qty, active
        FROM menu_items
        WHERE active = TRUE
          AND (%s IS NULL OR category = %s)
          AND (%s IS NULL OR name ILIKE '%%' || %s || '%%')
        ORDER BY category, name
    """, (category, category, search, search))
    items = cur.fetchall()
    cur.close(); conn.close()
    return {"items": [dict(i) for i in items], "total": len(items)}

# ── Admin Menu Routes ─────────────────────────────────────────
@app.get("/api/v1/admin/menu")
def admin_get_menu():
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM menu_items ORDER BY id")
    items = cur.fetchall()
    cur.close(); conn.close()
    return {"items": [dict(i) for i in items]}

@app.post("/api/v1/admin/menu")
def admin_create_item(data: dict):
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        INSERT INTO menu_items (name, category, price, stock_qty, active)
        VALUES (%s, %s, %s, %s, %s) RETURNING *
    """, (data["name"], data["category"], data["price"],
          data.get("stock_qty", 0), data.get("active", True)))
    item = cur.fetchone()
    conn.commit(); cur.close(); conn.close()
    return dict(item)

@app.put("/api/v1/admin/menu/{item_id}")
def admin_update_item(item_id: int, data: dict):
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        UPDATE menu_items
        SET name=%s, category=%s, price=%s, stock_qty=%s, active=%s, updated_at=NOW()
        WHERE id=%s RETURNING *
    """, (data["name"], data["category"], data["price"],
          data.get("stock_qty", 0), data.get("active", True), item_id))
    item = cur.fetchone()
    conn.commit(); cur.close(); conn.close()
    return dict(item)

@app.delete("/api/v1/admin/menu/{item_id}")
def admin_delete_item(item_id: int):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("UPDATE menu_items SET active = FALSE WHERE id = %s", (item_id,))
    conn.commit(); cur.close(); conn.close()
    return {"message": "Item deactivated"}

# ── Cart Routes ───────────────────────────────────────────────
@app.post("/api/v1/cart/add")
def cart_add(data: dict):
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM menu_items WHERE id = %s::int AND active = TRUE", (data["item_id"],))
    item = cur.fetchone()
    cur.close(); conn.close()
    if not item:
        return {"error": "Item not found"}
    return {"message": "Item added to cart"}

@app.post("/api/v1/cart/voucher")
def cart_voucher(data: dict):
    code = (data.get("code") or "").strip().upper()
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM vouchers WHERE code = %s AND expires_at > NOW()", (code,))
    voucher = cur.fetchone()
    cur.close(); conn.close()

    if not voucher:
        raise HTTPException(
            status_code=400,
            detail={"code": "VOUCHER_NOT_FOUND", "message": "Invalid or expired voucher code."},
        )
    if voucher["used_by"] is not None:
        raise HTTPException(
            status_code=400,
            detail={"code": "VOUCHER_ALREADY_USED", "message": "Voucher has already been used by your account."},
        )

    return {
        "discount":       float(voucher["discount"]),
        "discount_egp":   float(voucher["discount"]),
        "discount_type":  voucher["discount_type"],
        "discount_value": float(voucher["discount_value"]),
        "min_order":      float(voucher["min_order"]),
        "voucher_code":   code,
    }

@app.post("/api/v1/cart/lock")
def cart_lock():
    return {"message": "Cart locked"}

# ── Admin Voucher Routes ──────────────────────────────────────
@app.get("/api/v1/admin/vouchers")
def admin_list_vouchers():
    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM vouchers ORDER BY created_at DESC")
    rows = cur.fetchall()
    cur.close(); conn.close()
    return {"vouchers": [dict(r) for r in rows]}

@app.post("/api/v1/admin/vouchers")
def admin_create_voucher(data: dict):
    code           = (data.get("code") or "").strip().upper()
    discount_type  = data.get("discount_type", "flat")
    discount_value = float(data.get("discount_value", 0))
    min_order      = float(data.get("min_order", 0))
    max_uses       = int(data.get("max_uses", 1))
    expires_at     = data.get("expires_at")          # ISO string from frontend

    if not code:
        raise HTTPException(status_code=400, detail={"code": "MISSING_CODE", "message": "Voucher code is required."})
    if discount_type not in ("flat", "percent", "free_delivery"):
        raise HTTPException(status_code=400, detail={"code": "INVALID_TYPE", "message": "Invalid discount type."})
    if not expires_at:
        raise HTTPException(status_code=400, detail={"code": "MISSING_EXPIRY", "message": "Expiry date is required."})

    # For percentage vouchers the discount column stores the % value (e.g. 50 for 50%)
    discount_col = discount_value if discount_type in ("flat", "percent") else 0

    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cur.execute(
            """INSERT INTO vouchers
                   (code, discount_type, discount_value, discount, min_order, max_uses, expires_at, is_active)
               VALUES (%s, %s, %s, %s, %s, %s, %s::timestamptz, TRUE)
               RETURNING *""",
            (code, discount_type, discount_value, discount_col, min_order, max_uses, expires_at)
        )
        row = cur.fetchone()
        conn.commit()
    except Exception as exc:
        conn.rollback()
        if "unique" in str(exc).lower():
            raise HTTPException(status_code=400, detail={"code": "DUPLICATE_CODE", "message": f"Voucher code '{code}' already exists."})
        raise HTTPException(status_code=500, detail={"code": "DB_ERROR", "message": str(exc)})
    finally:
        cur.close(); conn.close()

    return {"voucher": dict(row)}

@app.delete("/api/v1/admin/vouchers/{code}")
def admin_delete_voucher(code: str):
    conn = get_db()
    cur  = conn.cursor()
    cur.execute("UPDATE vouchers SET is_active = FALSE WHERE code = %s", (code.upper(),))
    conn.commit(); cur.close(); conn.close()
    return {"message": "Voucher deactivated."}

# ── Health ────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/")
async def root():
    return {"message": "Cafeteria API running", "docs": "/docs"}
