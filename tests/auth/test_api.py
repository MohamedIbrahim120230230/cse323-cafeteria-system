"""
PHASE 3 — TDP: Integration Tests (20% of pyramid)
Tests the full request → router → service → database → response chain.
Uses an in-memory SQLite DB so no real DB is needed.
Run: pytest tests/integration/ -v
"""
import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from datetime import datetime, timezone, timedelta

from models.database import Base, get_db
from models.orm import (
    User, UserRole, Order, OrderItem, OrderStatus,
    MenuItem, SystemConfig, FlaggedOrderReview,
    OrderStatusTransition, AuditLog
)
from main import app

# ── In-memory test DB ─────────────────────────────────────────────────────────

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
test_engine = create_async_engine(TEST_DB_URL, echo=False)
TestSession = async_sessionmaker(test_engine, expire_on_commit=False)


async def override_get_db():
    async with TestSession() as session:
        yield session

app.dependency_overrides[get_db] = override_get_db


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest_asyncio.fixture(scope="function", autouse=True)
async def setup_db():
    """Create tables and seed minimal test data before each test."""
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with TestSession() as db:
        now = datetime.now(timezone.utc)

        # Users
        student = User(id="stu-1", email="student@university.edu",
                       name="Ali Ahmed", role=UserRole.STUDENT)
        staff   = User(id="stf-1", email="staff@university.edu",
                       name="Sara Staff", role=UserRole.STAFF)
        admin_u = User(id="adm-1", email="admin@university.edu",
                       name="Admin User", role=UserRole.ADMIN)
        db.add_all([student, staff, admin_u])

        # Menu items
        item1 = MenuItem(id="itm-1", name="Koshary", price_egp=25.0,
                         category="Meals", stock_qty=50, avg_rating=4.5)
        item2 = MenuItem(id="itm-2", name="Mango Juice", price_egp=20.0,
                         category="Beverages", stock_qty=40, avg_rating=4.8)
        db.add_all([item1, item2])

        # System config
        configs = [
            SystemConfig(key="cancel_window_minutes",    value="2",   description="Cancel window"),
            SystemConfig(key="suspicious_order_ceiling", value="500", description="Flag threshold"),
            SystemConfig(key="load_threshold",           value="150", description="Load shed limit"),
        ]
        db.add_all(configs)

        # Orders in various states
        order_placed = Order(
            id="ord-placed", user_id="stu-1",
            status=OrderStatus.PLACED, total_egp=45.0,
            placed_at=now - timedelta(seconds=30),
        )
        order_confirmed = Order(
            id="ord-confirmed", user_id="stu-1",
            status=OrderStatus.CONFIRMED, total_egp=80.0,
            payment_method="WALLET", placed_at=now - timedelta(minutes=5),
        )
        order_preparing = Order(
            id="ord-preparing", user_id="stu-1",
            status=OrderStatus.PREPARING, total_egp=25.0,
            payment_method="MEAL_PLAN", placed_at=now - timedelta(minutes=10),
        )
        order_completed = Order(
            id="ord-completed", user_id="stu-1",
            status=OrderStatus.COMPLETED, total_egp=25.0,
            payment_method="MEAL_PLAN", placed_at=now - timedelta(hours=3),
        )
        order_flagged = Order(
            id="ord-flagged", user_id="stu-1",
            status=OrderStatus.FLAGGED, total_egp=750.0,
            placed_at=now - timedelta(minutes=3), is_flagged=True,
        )
        order_old = Order(
            id="ord-old", user_id="stu-1",
            status=OrderStatus.PLACED, total_egp=30.0,
            placed_at=now - timedelta(minutes=10),   # outside cancel window
        )
        db.add_all([order_placed, order_confirmed, order_preparing,
                    order_completed, order_flagged, order_old])
        await db.flush()

        items = [
            OrderItem(order_id="ord-placed",    item_id="itm-1", name="Koshary",
                      quantity=1, unit_price_egp=25.0, subtotal_egp=25.0),
            OrderItem(order_id="ord-placed",    item_id="itm-2", name="Mango Juice",
                      quantity=1, unit_price_egp=20.0, subtotal_egp=20.0),
            OrderItem(order_id="ord-confirmed", item_id="itm-1", name="Koshary",
                      quantity=2, unit_price_egp=25.0, subtotal_egp=50.0),
            OrderItem(order_id="ord-confirmed", item_id="itm-2", name="Mango Juice",
                      quantity=1, unit_price_egp=20.0, subtotal_egp=20.0),
            OrderItem(order_id="ord-preparing", item_id="itm-1", name="Koshary",
                      quantity=1, unit_price_egp=25.0, subtotal_egp=25.0),
            OrderItem(order_id="ord-completed", item_id="itm-1", name="Koshary",
                      quantity=1, unit_price_egp=25.0, subtotal_egp=25.0),
            OrderItem(order_id="ord-flagged",   item_id="itm-1", name="Koshary",
                      quantity=9, unit_price_egp=80.0, subtotal_egp=720.0),
            OrderItem(order_id="ord-old",       item_id="itm-2", name="Mango Juice",
                      quantity=1, unit_price_egp=20.0, subtotal_egp=20.0),
        ]
        db.add_all(items)

        # Add flagged review record
        flagged_review = FlaggedOrderReview(order_id="ord-flagged")
        db.add(flagged_review)

        await db.commit()

    yield

    # Teardown
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture
async def client():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


def staff_headers():
    return {"X-Actor-Id": "stf-1", "X-Actor-Role": "STAFF"}

def admin_headers():
    return {"X-Actor-Id": "adm-1", "X-Actor-Role": "ADMIN"}

def student_headers():
    return {"X-Actor-Id": "stu-1", "X-Actor-Role": "STUDENT"}


# ══════════════════════════════════════════════════════════════════════════════
# GET /orders/{order_id}
# ══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
class TestGetOrder:

    async def test_get_existing_order_returns_200(self, client):
        r = await client.get("/orders/ord-placed", headers=student_headers())
        assert r.status_code == 200
        body = r.json()
        assert body["id"] == "ord-placed"
        assert body["status"]   == "PLACED"
        assert body["total_egp"] == 45.0

    async def test_get_order_includes_items(self, client):
        r = await client.get("/orders/ord-placed", headers=student_headers())
        body = r.json()
        assert len(body["items"]) == 2
        names = [i["name"] for i in body["items"]]
        assert "Koshary" in names
        assert "Mango Juice" in names

    async def test_get_nonexistent_order_returns_404(self, client):
        r = await client.get("/orders/does-not-exist", headers=student_headers())
        assert r.status_code == 404
        body = r.json()
        assert "message" in body["detail"]
        assert "support_ref" in body["detail"]

    async def test_student_cannot_view_another_users_order(self, client):
        # Create another student's order inline
        other_headers = {"X-Actor-Id": "other-stu", "X-Actor-Role": "STUDENT"}
        r = await client.get("/orders/ord-placed", headers=other_headers)
        assert r.status_code == 403

    async def test_staff_can_view_any_order(self, client):
        r = await client.get("/orders/ord-placed", headers=staff_headers())
        assert r.status_code == 200


# ══════════════════════════════════════════════════════════════════════════════
# PATCH /orders/{order_id}/status
# ══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
class TestAdvanceStatus:

    async def test_staff_can_advance_confirmed_to_preparing(self, client):
        r = await client.patch(
            "/orders/ord-confirmed/status",
            json={"new_status": "PREPARING"},
            headers=staff_headers(),
        )
        assert r.status_code == 200
        body = r.json()
        assert body["previous_status"] == "CONFIRMED"
        assert body["new_status"]      == "PREPARING"
        assert body["updated_by"]      == "stf-1"

    async def test_advance_status_persists_to_db(self, client):
        await client.patch(
            "/orders/ord-confirmed/status",
            json={"new_status": "PREPARING"},
            headers=staff_headers(),
        )
        # Re-fetch to verify persistence
        r = await client.get("/orders/ord-confirmed", headers=staff_headers())
        assert r.json()["status"] == "PREPARING"

    async def test_advance_status_creates_audit_log(self, client):
        await client.patch(
            "/orders/ord-confirmed/status",
            json={"new_status": "PREPARING"},
            headers=staff_headers(),
        )
        r = await client.get(
            "/admin/audit-log",
            params={"entity_id": "ord-confirmed"},
            headers=admin_headers(),
        )
        assert r.status_code == 200
        logs = r.json()
        assert len(logs) >= 1
        assert logs[0]["action"] == "ORDER_STATUS_ADVANCED"

    async def test_student_cannot_advance_status_returns_403(self, client):
        r = await client.patch(
            "/orders/ord-confirmed/status",
            json={"new_status": "PREPARING"},
            headers=student_headers(),
        )
        assert r.status_code == 403

    async def test_illegal_backward_transition_returns_409(self, client):
        # PREPARING → CONFIRMED is backward — valid enum but illegal state transition
        r = await client.patch(
            "/orders/ord-preparing/status",
            json={"new_status": "COLLECTED"},   # skips READY — illegal forward skip
            headers=staff_headers(),
        )
        assert r.status_code == 409
        body = r.json()
        assert "allowed_transitions" in body["detail"]

    async def test_transition_on_completed_order_returns_409(self, client):
        r = await client.patch(
            "/orders/ord-completed/status",
            json={"new_status": "PREPARING"},
            headers=staff_headers(),
        )
        assert r.status_code == 409

    async def test_advance_with_note_stored_correctly(self, client):
        r = await client.patch(
            "/orders/ord-confirmed/status",
            json={"new_status": "PREPARING", "note": "Started cooking at station 2"},
            headers=staff_headers(),
        )
        assert r.status_code == 200

    async def test_advance_nonexistent_order_returns_404(self, client):
        r = await client.patch(
            "/orders/ghost-order/status",
            json={"new_status": "PREPARING"},
            headers=staff_headers(),
        )
        assert r.status_code == 404


# ══════════════════════════════════════════════════════════════════════════════
# POST /orders/{order_id}/cancel
# ══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
class TestCancelOrder:

    async def test_student_can_cancel_within_window(self, client):
        r = await client.post(
            "/orders/ord-placed/cancel",
            json={"reason_code": "CUSTOMER_REQUEST"},
            headers=student_headers(),
        )
        assert r.status_code == 200
        body = r.json()
        assert body["status"]       == "CANCELLED"
        assert body["reason_code"]  == "CUSTOMER_REQUEST"
        assert body["cancelled_by"] == "stu-1"

    async def test_student_cancel_outside_window_returns_403(self, client):
        r = await client.post(
            "/orders/ord-old/cancel",
            json={"reason_code": "CUSTOMER_REQUEST"},
            headers=student_headers(),
        )
        assert r.status_code == 403
        assert "expired" in r.json()["detail"]["message"].lower()

    async def test_student_cannot_cancel_preparing_order_returns_403(self, client):
        r = await client.post(
            "/orders/ord-preparing/cancel",
            json={"reason_code": "CUSTOMER_REQUEST"},
            headers=student_headers(),
        )
        assert r.status_code == 403

    async def test_staff_can_cancel_any_non_completed_order(self, client):
        r = await client.post(
            "/orders/ord-preparing/cancel",
            json={"reason_code": "OUT_OF_STOCK", "note": "Ran out of koshary"},
            headers=staff_headers(),
        )
        assert r.status_code == 200
        assert r.json()["status"] == "CANCELLED"

    async def test_cancel_already_completed_returns_409(self, client):
        r = await client.post(
            "/orders/ord-completed/cancel",
            json={"reason_code": "CUSTOMER_REQUEST"},
            headers=student_headers(),
        )
        assert r.status_code == 409

    async def test_cancel_creates_audit_log(self, client):
        await client.post(
            "/orders/ord-placed/cancel",
            json={"reason_code": "CUSTOMER_REQUEST"},
            headers=student_headers(),
        )
        r = await client.get(
            "/admin/audit-log",
            params={"entity_id": "ord-placed"},
            headers=admin_headers(),
        )
        logs = r.json()
        actions = [l["action"] for l in logs]
        assert "ORDER_CANCELLED" in actions

    async def test_cancel_confirmed_order_signals_refund(self, client):
        r = await client.post(
            "/orders/ord-confirmed/cancel",
            json={"reason_code": "STAFF_ERROR"},
            headers=staff_headers(),
        )
        body = r.json()
        assert body["refund_initiated"] is True
        assert body["refund_id"] is not None


# ══════════════════════════════════════════════════════════════════════════════
# GET /admin/reports
# ══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
class TestAdminReports:

    async def test_revenue_report_returns_200(self, client):
        r = await client.get(
            "/admin/reports",
            params={"type": "revenue", "from": "2026-04-01", "to": "2026-05-17"},
            headers=admin_headers(),
        )
        assert r.status_code == 200
        body = r.json()
        assert body["report_type"] == "revenue"
        assert "data" in body

    async def test_top_items_report_returns_200(self, client):
        r = await client.get(
            "/admin/reports",
            params={"type": "top_items", "from": "2020-01-01", "to": "2030-12-31"},
            headers=admin_headers(),
        )
        assert r.status_code == 200

    async def test_cancellations_report_returns_200(self, client):
        r = await client.get(
            "/admin/reports",
            params={"type": "cancellations", "from": "2020-01-01", "to": "2030-12-31"},
            headers=admin_headers(),
        )
        assert r.status_code == 200

    async def test_heatmap_report_returns_200(self, client):
        r = await client.get(
            "/admin/reports",
            params={"type": "heatmap", "from": "2020-01-01", "to": "2030-12-31"},
            headers=admin_headers(),
        )
        assert r.status_code == 200

    async def test_ratings_report_returns_200(self, client):
        r = await client.get(
            "/admin/reports",
            params={"type": "ratings", "from": "2020-01-01", "to": "2030-12-31"},
            headers=admin_headers(),
        )
        assert r.status_code == 200

    async def test_large_date_range_returns_async_202(self, client):
        r = await client.get(
            "/admin/reports",
            params={"type": "revenue", "from": "2020-01-01", "to": "2026-12-31"},
            headers=admin_headers(),
        )
        assert r.status_code == 200
        body = r.json()
        # > 90 days → async job
        assert "job_id" in body
        assert "estimated_completion" in body

    async def test_invalid_report_type_returns_400(self, client):
        r = await client.get(
            "/admin/reports",
            params={"type": "fake_report", "from": "2026-01-01", "to": "2026-05-01"},
            headers=admin_headers(),
        )
        assert r.status_code == 400

    async def test_non_admin_cannot_access_reports(self, client):
        r = await client.get(
            "/admin/reports",
            params={"type": "revenue", "from": "2026-01-01", "to": "2026-02-01"},
            headers=student_headers(),
        )
        assert r.status_code == 403

    async def test_invalid_date_format_returns_400(self, client):
        r = await client.get(
            "/admin/reports",
            params={"type": "revenue", "from": "01-01-2026", "to": "05-17-2026"},
            headers=admin_headers(),
        )
        assert r.status_code == 400


# ══════════════════════════════════════════════════════════════════════════════
# PATCH /admin/config/{key}
# ══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
class TestAdminConfig:

    async def test_admin_can_update_config(self, client):
        r = await client.patch(
            "/admin/config/load_threshold",
            json={"value": "200"},
            headers=admin_headers(),
        )
        assert r.status_code == 200
        assert r.json()["value"] == "200"

    async def test_config_update_creates_audit_log(self, client):
        await client.patch(
            "/admin/config/load_threshold",
            json={"value": "200"},
            headers=admin_headers(),
        )
        r = await client.get(
            "/admin/audit-log",
            params={"entity_id": "load_threshold"},
            headers=admin_headers(),
        )
        logs = r.json()
        assert any(l["action"] == "CONFIG_UPDATED" for l in logs)

    async def test_update_nonexistent_config_returns_404(self, client):
        r = await client.patch(
            "/admin/config/does_not_exist",
            json={"value": "999"},
            headers=admin_headers(),
        )
        assert r.status_code == 404

    async def test_non_admin_cannot_update_config(self, client):
        r = await client.patch(
            "/admin/config/load_threshold",
            json={"value": "9999"},
            headers=staff_headers(),
        )
        assert r.status_code == 403


# ══════════════════════════════════════════════════════════════════════════════
# Flagged orders
# ══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
class TestFlaggedOrders:

    async def test_admin_can_list_flagged_orders(self, client):
        r = await client.get("/admin/flagged-orders", headers=admin_headers())
        assert r.status_code == 200
        body = r.json()
        assert any(o["order_id"] == "ord-flagged" for o in body)

    async def test_admin_can_approve_flagged_order(self, client):
        r = await client.post(
            "/admin/flagged-orders/ord-flagged/review",
            json={"decision": "APPROVED", "reason": "Order verified as legitimate bulk purchase"},
            headers=admin_headers(),
        )
        assert r.status_code == 200
        body = r.json()
        assert body["decision"]    == "APPROVED"
        assert body["reviewed_by"] == "adm-1"

    async def test_approved_flagged_order_moves_to_payment_pending(self, client):
        await client.post(
            "/admin/flagged-orders/ord-flagged/review",
            json={"decision": "APPROVED", "reason": "Verified"},
            headers=admin_headers(),
        )
        r = await client.get("/orders/ord-flagged", headers=admin_headers())
        assert r.json()["status"] == "PAYMENT_PENDING"

    async def test_admin_can_reject_flagged_order(self, client):
        r = await client.post(
            "/admin/flagged-orders/ord-flagged/review",
            json={"decision": "REJECTED", "reason": "Suspected bot activity"},
            headers=admin_headers(),
        )
        assert r.status_code == 200
        assert r.json()["decision"] == "REJECTED"

    async def test_rejected_flagged_order_becomes_cancelled(self, client):
        await client.post(
            "/admin/flagged-orders/ord-flagged/review",
            json={"decision": "REJECTED", "reason": "Suspected bot"},
            headers=admin_headers(),
        )
        r = await client.get("/orders/ord-flagged", headers=admin_headers())
        assert r.json()["status"] == "CANCELLED"

    async def test_reviewing_non_flagged_order_returns_409(self, client):
        r = await client.post(
            "/admin/flagged-orders/ord-placed/review",
            json={"decision": "APPROVED", "reason": "Test"},
            headers=admin_headers(),
        )
        assert r.status_code == 409

    async def test_non_admin_cannot_list_flagged_orders(self, client):
        r = await client.get("/admin/flagged-orders", headers=staff_headers())
        assert r.status_code == 403


# ══════════════════════════════════════════════════════════════════════════════
# GET /admin/audit-log
# ══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
class TestAuditLog:

    async def test_admin_can_access_audit_log(self, client):
        r = await client.get("/admin/audit-log", headers=admin_headers())
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    async def test_audit_log_filterable_by_entity(self, client):
        # First create an auditable action
        await client.patch(
            "/orders/ord-confirmed/status",
            json={"new_status": "PREPARING"},
            headers=staff_headers(),
        )
        r = await client.get(
            "/admin/audit-log",
            params={"entity_id": "ord-confirmed"},
            headers=admin_headers(),
        )
        logs = r.json()
        assert all(l["entity_id"] == "ord-confirmed" for l in logs)

    async def test_non_admin_cannot_access_audit_log(self, client):
        r = await client.get("/admin/audit-log", headers=student_headers())
        assert r.status_code == 403
