from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
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
    allow_origins=["*"],
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
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM vouchers WHERE code = %s AND expires_at > NOW()", (data["code"],))
    voucher = cur.fetchone()
    cur.close(); conn.close()
    if not voucher or voucher["used_by"] is not None:
        return {"error": "Invalid or expired voucher"}
    return {"discount": float(voucher["discount"])}

@app.post("/api/v1/cart/lock")
def cart_lock():
    return {"message": "Cart locked"}

# ── Health ────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/")
async def root():
    return {"message": "Cafeteria API running", "docs": "/docs"}
