"""
FastAPI application entry point.
Initialises DB, seeds config defaults, mounts all routers.
"""
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from models.database import init_db, AsyncSessionLocal
from models.orm import SystemConfig, User, UserRole, MenuItem, Order, OrderItem, OrderStatus
from routers.lifecycle import router as lifecycle_router
from routers.admin import router as admin_router


DEFAULT_CONFIG = [
    ("load_threshold",          "150",  "Max concurrent orders before HTTP 503"),
    ("suspicious_order_ceiling","500",  "Order total (EGP) above which order is flagged"),
    ("stock_lock_ttl_minutes",  "10",   "Minutes before an unpaid stock lock expires"),
    ("payment_timeout_seconds", "10",   "Seconds before payment is considered timed out"),
    ("cancel_window_minutes",   "2",    "Minutes after placement student may self-cancel"),
    ("auto_complete_hours",     "2",    "Hours after COLLECTED before auto-COMPLETED"),
    ("max_items_per_order",     "10",   "Max quantity of any single item per order"),
    ("flagged_review_timeout",  "60",   "Minutes before unreviewed flagged order auto-cancels"),
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await _seed_defaults()
    yield


async def _seed_defaults():
    async with AsyncSessionLocal() as db:
        # Seed system config
        for key, value, description in DEFAULT_CONFIG:
            from sqlalchemy import select
            result = await db.execute(select(SystemConfig).where(SystemConfig.key == key))
            if not result.scalar_one_or_none():
                db.add(SystemConfig(key=key, value=value, description=description))

        # Seed demo users
        from sqlalchemy import select
        result = await db.execute(select(User).where(User.email == "student@university.edu"))
        if not result.scalar_one_or_none():
            student = User(id="user-student-1", email="student@university.edu",
                          name="Ali Ahmed", role=UserRole.STUDENT)
            staff   = User(id="user-staff-1",   email="staff@university.edu",
                          name="Sara Staff",    role=UserRole.STAFF)
            admin_u = User(id="user-admin-1",   email="admin@university.edu",
                          name="Admin User",    role=UserRole.ADMIN)
            db.add_all([student, staff, admin_u])

        # Seed demo menu items
        result = await db.execute(select(MenuItem).where(MenuItem.name == "Koshary"))
        if not result.scalar_one_or_none():
            items = [
                MenuItem(id="item-1", name="Koshary",       price_egp=25.0,  category="Meals",     stock_qty=50, avg_rating=4.5),
                MenuItem(id="item-2", name="Falafel Wrap",  price_egp=30.0,  category="Meals",     stock_qty=30, avg_rating=4.2),
                MenuItem(id="item-3", name="Mango Juice",   price_egp=20.0,  category="Beverages", stock_qty=40, avg_rating=4.8),
                MenuItem(id="item-4", name="Chocolate Bar", price_egp=15.0,  category="Snacks",    stock_qty=100, avg_rating=3.9),
                MenuItem(id="item-5", name="Grilled Chicken",price_egp=80.0, category="Meals",     stock_qty=20, avg_rating=4.6),
            ]
            db.add_all(items)

        # Seed demo orders in various states
        result = await db.execute(select(Order).where(Order.id == "order-demo-1"))
        if not result.scalar_one_or_none():
            now = datetime.now(timezone.utc)
            orders = [
                Order(id="order-demo-1", user_id="user-student-1", status=OrderStatus.PREPARING,
                      total_egp=55.0, payment_method="WALLET",
                      placed_at=now - timedelta(minutes=15)),
                Order(id="order-demo-2", user_id="user-student-1", status=OrderStatus.PLACED,
                      total_egp=45.0, placed_at=now - timedelta(seconds=30)),
                Order(id="order-demo-3", user_id="user-student-1", status=OrderStatus.READY,
                      total_egp=110.0, payment_method="ONLINE",
                      placed_at=now - timedelta(minutes=30)),
                Order(id="order-demo-4", user_id="user-student-1", status=OrderStatus.FLAGGED,
                      total_egp=750.0, placed_at=now - timedelta(minutes=5),
                      is_flagged=True),
                Order(id="order-demo-5", user_id="user-student-1", status=OrderStatus.COMPLETED,
                      total_egp=25.0, payment_method="MEAL_PLAN",
                      placed_at=now - timedelta(hours=3)),
            ]
            db.add_all(orders)
            await db.flush()

            # Add items to each order
            order_items = [
                OrderItem(order_id="order-demo-1", item_id="item-1", name="Koshary",
                          quantity=2, unit_price_egp=25.0, subtotal_egp=50.0),
                OrderItem(order_id="order-demo-1", item_id="item-4", name="Chocolate Bar",
                          quantity=1, unit_price_egp=5.0, subtotal_egp=5.0),
                OrderItem(order_id="order-demo-2", item_id="item-3", name="Mango Juice",
                          quantity=1, unit_price_egp=20.0, subtotal_egp=20.0),
                OrderItem(order_id="order-demo-2", item_id="item-4", name="Chocolate Bar",
                          quantity=1, unit_price_egp=15.0, subtotal_egp=15.0),
                OrderItem(order_id="order-demo-2", item_id="item-2", name="Falafel Wrap",
                          quantity=1, unit_price_egp=30.0, subtotal_egp=30.0),  # fixed total
                OrderItem(order_id="order-demo-3", item_id="item-5", name="Grilled Chicken",
                          quantity=1, unit_price_egp=80.0, subtotal_egp=80.0),
                OrderItem(order_id="order-demo-3", item_id="item-3", name="Mango Juice",
                          quantity=1, unit_price_egp=20.0, subtotal_egp=20.0),
                OrderItem(order_id="order-demo-4", item_id="item-5", name="Grilled Chicken",
                          quantity=9, unit_price_egp=80.0, subtotal_egp=720.0),
                OrderItem(order_id="order-demo-5", item_id="item-1", name="Koshary",
                          quantity=1, unit_price_egp=25.0, subtotal_egp=25.0),
            ]
            db.add_all(order_items)

        await db.commit()


app = FastAPI(
    title      ="Cafeteria Lifecycle & Reports API",
    description="feature/lifecycle-reports — CSE323 vertical slice",
    version    ="1.0.0",
    lifespan   =lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(lifecycle_router)
app.include_router(admin_router)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "lifecycle-reports"}
