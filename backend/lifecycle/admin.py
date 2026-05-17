"""
Admin router — implements:
  GET   /admin/reports                          (FR53)
  PATCH /admin/config/{key}                     (FR54)
  GET   /admin/config                           (FR54)
  GET   /admin/flagged-orders                   (FR56)
  POST  /admin/flagged-orders/{order_id}/review (FR56)
  GET   /admin/audit-log                        (NFR20, NFR32)
"""
import uuid
import csv
import io
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from models.database import get_db
from models.orm import (
    Order, OrderStatus, OrderItem, SystemConfig,
    FlaggedOrderReview, AuditLog, UserRole, User
)
from schemas.schemas import (
    SyncReportResponse, AsyncReportResponse,
    ConfigUpdateRequest, ConfigResponse,
    FlaggedOrderSummary, FlaggedReviewRequest, FlaggedReviewResponse,
    OrderItemSchema, AuditLogEntry,
)
from services.reports import generate_report, is_async_range, to_csv
from services.audit import write_audit_log

router = APIRouter(prefix="/admin", tags=["Admin"])


# ── Auth guard (stub — real JWT from Member 1) ────────────────────────────────

def _require_admin(request: Request) -> dict:
    role = request.headers.get("X-Actor-Role", "")
    if role != UserRole.ADMIN:
        raise HTTPException(
            status_code=403,
            detail={
                "message"         : "Admin access required.",
                "corrective_action": "Log in with an administrator account.",
                "support_ref"     : f"REF-{uuid.uuid4().hex[:8].upper()}",
            },
        )
    return {"id": request.headers.get("X-Actor-Id", "admin"), "role": UserRole.ADMIN}


# ── GET /admin/reports ────────────────────────────────────────────────────────

@router.get("/reports")
async def get_report(
    request     : Request,
    type        : str   = Query(..., description="revenue | top_items | cancellations | heatmap | ratings"),
    from_date   : str   = Query(..., alias="from", description="ISO 8601 date e.g. 2026-01-01"),
    to_date     : str   = Query(..., alias="to",   description="ISO 8601 date e.g. 2026-05-17"),
    format      : str   = Query("json", description="json | csv"),
    db          : AsyncSession = Depends(get_db),
):
    actor = _require_admin(request)

    # Validate report type
    valid_types = {"revenue", "top_items", "cancellations", "heatmap", "ratings"}
    if type not in valid_types:
        raise HTTPException(
            status_code=400,
            detail={
                "message"         : f"Invalid report type '{type}'.",
                "corrective_action": f"Use one of: {', '.join(valid_types)}.",
                "support_ref"     : f"REF-{uuid.uuid4().hex[:8].upper()}",
            },
        )

    # Validate date format
    try:
        _parse_date(from_date)
        _parse_date(to_date)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail={
                "message"         : "Invalid date format.",
                "corrective_action": "Use ISO 8601 format: YYYY-MM-DD.",
                "support_ref"     : f"REF-{uuid.uuid4().hex[:8].upper()}",
            },
        )

    # Async for > 90-day ranges (FR53)
    if is_async_range(from_date, to_date):
        job_id = str(uuid.uuid4())
        return AsyncReportResponse(
            job_id              =job_id,
            estimated_completion=datetime.now(timezone.utc) + timedelta(minutes=10),
            notification_email  ="admin@university.edu",
        )

    data = await generate_report(db, type, from_date, to_date)

    # CSV export
    if format == "csv":
        csv_content = to_csv(data)
        return StreamingResponse(
            io.StringIO(csv_content),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename=report_{type}_{from_date}_{to_date}.csv"},
        )

    return {
        "report_type" : type,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "from"        : from_date,
        "to"          : to_date,
        "data"        : data,
    }


# ── GET /admin/config ─────────────────────────────────────────────────────────

@router.get("/config", response_model=list[ConfigResponse])
async def get_all_config(
    request: Request,
    db     : AsyncSession = Depends(get_db),
):
    _require_admin(request)
    result = await db.execute(select(SystemConfig))
    return result.scalars().all()


# ── PATCH /admin/config/{key} ─────────────────────────────────────────────────

@router.patch("/config/{key}", response_model=ConfigResponse)
async def update_config(
    key    : str,
    body   : ConfigUpdateRequest,
    request: Request,
    db     : AsyncSession = Depends(get_db),
):
    actor = _require_admin(request)

    result = await db.execute(select(SystemConfig).where(SystemConfig.key == key))
    config = result.scalar_one_or_none()

    if not config:
        raise HTTPException(
            status_code=404,
            detail={
                "message"         : f"Config key '{key}' not found.",
                "corrective_action": "Check /admin/config for valid keys.",
                "support_ref"     : f"REF-{uuid.uuid4().hex[:8].upper()}",
            },
        )

    old_value = config.value
    config.value      = body.value
    config.updated_by = actor["id"]
    config.updated_at = datetime.now(timezone.utc)

    await write_audit_log(
        db          =db,
        actor_id    =actor["id"],
        actor_role  =actor["role"],
        action      ="CONFIG_UPDATED",
        entity_type ="system_config",
        entity_id   =key,
        before_state={"value": old_value},
        after_state ={"value": body.value},
        detail      =f"Config '{key}' updated.",
    )

    await db.commit()
    await db.refresh(config)
    return config


# ── GET /admin/flagged-orders ─────────────────────────────────────────────────

@router.get("/flagged-orders", response_model=list[FlaggedOrderSummary])
async def get_flagged_orders(
    request: Request,
    db     : AsyncSession = Depends(get_db),
):
    _require_admin(request)

    result = await db.execute(
        select(Order)
        .options(selectinload(Order.items), selectinload(Order.flagged_review))
        .where(Order.status == OrderStatus.FLAGGED)
        .order_by(Order.placed_at.desc())
    )
    orders = result.scalars().all()

    summaries = []
    for order in orders:
        flagged_review = order.flagged_review
        summaries.append(
            FlaggedOrderSummary(
                order_id  =order.id,
                user_id   =order.user_id,
                total_egp =order.total_egp,
                placed_at =order.placed_at,
                flagged_at=flagged_review.flagged_at if flagged_review else order.updated_at,
                items=[
                    OrderItemSchema(
                        item_id       =i.item_id,
                        name          =i.name,
                        quantity      =i.quantity,
                        unit_price_egp=i.unit_price_egp,
                        subtotal_egp  =i.subtotal_egp,
                    )
                    for i in order.items
                ],
            )
        )
    return summaries


# ── POST /admin/flagged-orders/{order_id}/review ──────────────────────────────

@router.post("/flagged-orders/{order_id}/review", response_model=FlaggedReviewResponse)
async def review_flagged_order(
    order_id: str,
    body    : FlaggedReviewRequest,
    request : Request,
    db      : AsyncSession = Depends(get_db),
):
    actor = _require_admin(request)

    result = await db.execute(
        select(Order)
        .options(selectinload(Order.flagged_review))
        .where(Order.id == order_id)
    )
    order = result.scalar_one_or_none()

    if not order:
        raise HTTPException(status_code=404, detail=_error("Order not found.", "Check the order ID."))

    if order.status != OrderStatus.FLAGGED:
        raise HTTPException(
            status_code=409,
            detail=_error(
                f"Order is not in FLAGGED status (current: {order.status}).",
                "Only FLAGGED orders can be reviewed.",
            ),
        )

    now = datetime.now(timezone.utc)

    # APPROVED → move to PAYMENT_PENDING; REJECTED → CANCELLED
    new_status = OrderStatus.PAYMENT_PENDING if body.decision == "APPROVED" else OrderStatus.CANCELLED
    order.status     = new_status
    order.updated_at = now
    if body.decision == "REJECTED":
        order.cancellation_reason = "SUSPICIOUS_ORDER"
        order.cancellation_note   = body.reason
        order.cancelled_by        = actor["id"]

    # Update or create the review record
    review = order.flagged_review
    if not review:
        review = FlaggedOrderReview(order_id=order.id)
        db.add(review)
    review.reviewed_by  = actor["id"]
    review.decision     = body.decision
    review.reason       = body.reason
    review.reviewed_at  = now

    await write_audit_log(
        db          =db,
        actor_id    =actor["id"],
        actor_role  =actor["role"],
        action      =f"FLAGGED_ORDER_{body.decision}",
        entity_type ="order",
        entity_id   =order.id,
        before_state={"status": "FLAGGED"},
        after_state ={"status": new_status},
        detail      =body.reason,
    )

    await db.commit()

    return FlaggedReviewResponse(
        order_id   =order.id,
        decision   =body.decision,
        reviewed_by=actor["id"],
        reviewed_at=now,
    )


# ── GET /admin/audit-log ──────────────────────────────────────────────────────

@router.get("/audit-log", response_model=list[AuditLogEntry])
async def get_audit_log(
    request   : Request,
    entity_id : str | None = Query(None),
    actor_id  : str | None = Query(None),
    limit     : int        = Query(50, le=200),
    db        : AsyncSession = Depends(get_db),
):
    _require_admin(request)

    query = select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit)
    if entity_id:
        query = query.where(AuditLog.entity_id == entity_id)
    if actor_id:
        query = query.where(AuditLog.actor_id == actor_id)

    result = await db.execute(query)
    return result.scalars().all()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_date(date_str: str) -> datetime:
    return datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def _error(message: str, corrective_action: str) -> dict:
    return {
        "message"         : message,
        "corrective_action": corrective_action,
        "support_ref"     : f"REF-{uuid.uuid4().hex[:8].upper()}",
    }
