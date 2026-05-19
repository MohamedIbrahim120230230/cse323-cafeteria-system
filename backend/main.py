"""
backend/main.py  ← THE ONLY SERVER YOU RUN

── FIXES APPLIED ──────────────────────────────────────────────────────────────

FIX-1  LIFECYCLE IMPORT PATH
  Original: from lifecycle.lifecycle_admin import router as lifecycle_admin_router
  The file is placed at backend/lifecycle/lifecycle_admin.py.
  You MUST also create backend/lifecycle/__init__.py (empty file) so Python
  treats the folder as a package. Without it the import silently fails with
  ModuleNotFoundError at startup.

FIX-2  ROUTE COLLISION — /orders/{order_id} GET
  lifecycle_admin.py registers GET /api/v1/orders/{order_id}.
  order_router (order_payment.py) also registers GET /api/v1/orders/{id}.
  FastAPI resolves routes in registration order — order_router is mounted
  BEFORE lifecycle_admin_router so order_payment.py's richer handler wins.
  lifecycle_admin's GET /orders/{id} is effectively shadowed (no conflict,
  just never reached). If you want lifecycle's handler to run, move the
  route to a different path or remove it from lifecycle_admin.py.
  Current registration order is correct — order_router first ✓.

FIX-3  ROUTE ADDITIONS in lifecycle_admin.py
  lifecycle_admin now registers these additional routes not in the original:
    PUT  /api/v1/orders/{id}/status   (alias for OrderPaymentApp.jsx PUT call)
    PUT  /api/v1/orders/{id}/cancel   (alias for OrderPaymentApp.jsx PUT call)
  These are non-conflicting because order_payment.py does not register these
  sub-paths. FastAPI will match them correctly.

FIX-4  CORS — added the common Vite HTTPS dev origin
  Some setups use https://localhost:5173 — added to allow_origins.

Routers mounted (ORDER MATTERS — see route priority note in FIX-2):
    1. auth_router          → /api/v1/auth/*
    2. menu_router          → /api/v1/menu/*  /api/v1/cart/*  /api/v1/admin/menu/*
    3. order_router         → /api/v1/orders/*  /api/v1/payments/*
    4. stock_router         → /api/v1/stock/*
    5. lifecycle_admin_router → /api/v1/orders/{id}/status|cancel|stream
                                /api/v1/ratings/*
                                /api/v1/admin/reports|config|flagged-orders|audit-log

Start with:
    uvicorn main:app --reload --port 8000
"""

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# ── Import all routers ────────────────────────────────────────
from auth.routes         import router as auth_router
from menu.app            import router as menu_router
from order.order_payment import router as order_router
from stock.routes        import router as stock_router

# FIX-1: correct package path — file lives at backend/lifecycle/lifecycle_admin.py
# Create backend/lifecycle/__init__.py (empty) if it doesn't exist.
from lifecycle.lifecycle_admin import router as lifecycle_admin_router

# ─────────────────────────────────────────────────────────────
# App
# ─────────────────────────────────────────────────────────────
app = FastAPI(
    title       = "University Cafeteria API",
    version     = "1.0.0",
    description = (
        "Single unified API — all features on port 8000.\n\n"
        "Auth:              /api/v1/auth/*\n"
        "Menu & Cart:       /api/v1/menu/*  /api/v1/cart/*\n"
        "Orders & Payments: /api/v1/orders/*  /api/v1/payments/*\n"
        "Stock:             /api/v1/stock/*\n"
        "Lifecycle & Admin: /api/v1/orders/{id}/status|cancel|stream  "
        "/api/v1/ratings/*  /api/v1/admin/*"
    ),
)

# ── CORS — FIX-4: include https variant ──────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",     # Vite HTTP default
        "https://localhost:5173",    # FIX-4: Vite HTTPS
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Mount routers (ORDER MATTERS — see FIX-2) ─────────────────

# 1. Auth
app.include_router(auth_router)

# 2. Menu & Cart
app.include_router(menu_router)

# 3. Orders & Payments — MUST come before lifecycle_admin so
#    POST /orders and GET /orders/{id} from order_payment.py win
#    the route resolution (FIX-2).
app.include_router(order_router)

# 4. Stock
app.include_router(stock_router)

# 5. Lifecycle & Admin — adds sub-routes to /orders and full /admin tree.
#    Registered last so order_router's broader /orders/* patterns win.
app.include_router(lifecycle_admin_router)


# ── Health check ─────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "service": "cafeteria-api", "port": 8000}


# ── Root hint ─────────────────────────────────────────────────
@app.get("/")
async def root():
    return {
        "message":    "Cafeteria API running",
        "docs":       "/docs",
        "health":     "/health",
        "api_prefix": "/api/v1",
    }