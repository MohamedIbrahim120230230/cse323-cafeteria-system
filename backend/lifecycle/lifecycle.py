"""
Lifecycle router — implements:
  PATCH /orders/{order_id}/status   (FR35, FR34 state machine)
  POST  /orders/{order_id}/cancel   (FR37-FR39)
  GET   /orders/{order_id}          (FR36 polling + SSE stream)
  GET   /orders/{order_id}/stream   (FR36 SSE push)
"""
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from sqlalchemy.orm import selectinload
from models.database import get_db
from models.orm import Order, OrderStatus, OrderItem, UserRole, CancellationReason
from schemas.schemas import (
    AdvanceStatusRequest, AdvanceStatusResponse,
    CancelOrderRequest, CancelOrderResponse,
    OrderDetailResponse, OrderItemSchema,
)
from services.state_machine import (
    validate_transition, validate_student_cancellation,
    can_student_cancel, StateMachineError, get_allowed_transitions,
)
from services.audit import write_audit_log
from services import sse as sse_service

router = APIRouter(prefix="/orders", tags=["Order Lifecycle"])


# ── Auth stub (real auth owned by Member 1) ───────────────────────────────────

def _get_actor(request: Request) -> dict:
    """
    Extract actor from request headers (stub for vertical slice demo).
    Real JWT validation is Member 1's responsibility.
    Expects headers:  X-Actor-Id, X-Actor-Role
    """
    actor_id   = request.headers.get("X-Actor-Id",   "system-actor")
    actor_role = request.headers.get("X-Actor-Role",  UserRole.STAFF)
    return {"id": actor_id, "role": actor_role}


# ── GET /orders/{order_id} ────────────────────────────────────────────────────

@router.get("/{order_id}", response_model=OrderDetailResponse)
async def get_order(
    order_id: str,
    request : Request,
    db      : AsyncSession = Depends(get_db),
):
    actor = _get_actor(request)
    order = await _fetch_order_or_404(order_id, db)

    # Students can only see their own orders (FR information hiding)
    if actor["role"] == UserRole.STUDENT and order.user_id != actor["id"]:
        raise HTTPException(
            status_code=403,
            detail={
                "message"         : "You do not have permission to view this order.",
                "corrective_action": "Check the order ID or contact support.",
                "support_ref"     : _support_ref(),
            },
        )

    items = [
        OrderItemSchema(
            item_id       =i.item_id,
            name          =i.name,
            quantity      =i.quantity,
            unit_price_egp=i.unit_price_egp,
            subtotal_egp  =i.subtotal_egp,
        )
        for i in order.items
    ]

    return OrderDetailResponse(
        id             =order.id,
        status         =order.status,
        placed_at      =order.placed_at,
        updated_at     =order.updated_at,
        items          =items,
        total_egp      =order.total_egp,
        payment_method =order.payment_method,
    )


# ── GET /orders/{order_id}/stream  (SSE) ─────────────────────────────────────

@router.get("/{order_id}/stream")
async def order_stream(order_id: str, db: AsyncSession = Depends(get_db)):
    """
    Server-Sent Events stream for real-time order status updates (FR36).
    Client connects once; server pushes updates as status changes.
    """
    await _fetch_order_or_404(order_id, db)
    return StreamingResponse(
        sse_service.subscribe(order_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── PATCH /orders/{order_id}/status ──────────────────────────────────────────

@router.patch("/{order_id}/status", response_model=AdvanceStatusResponse)
async def advance_order_status(
    order_id: str,
    body    : AdvanceStatusRequest,
    request : Request,
    db      : AsyncSession = Depends(get_db),
):
    actor = _get_actor(request)

    # Only Staff and Admin may advance status (FR35)
    if actor["role"] == UserRole.STUDENT:
        raise HTTPException(
            status_code=403,
            detail=_error(
                "Only staff and admin can update order status.",
                "Contact the cafeteria staff.",
            ),
        )

    order = await _fetch_order_or_404(order_id, db)
    prev_status = order.status

    # Validate via state machine
    try:
        validate_transition(prev_status, body.new_status, actor["role"])
    except StateMachineError as e:
        raise HTTPException(
            status_code=409,
            detail={
                "message"          : str(e),
                "allowed_transitions": e.allowed,
                "corrective_action": "Use one of the allowed transitions.",
                "support_ref"      : _support_ref(),
            },
        )

    # Apply transition
    order.status     = body.new_status
    order.updated_at = datetime.now(timezone.utc)

    if body.new_status == OrderStatus.COLLECTED:
        order.collected_at = datetime.now(timezone.utc)

    # Record transition history
    from models.orm import OrderStatusTransition
    transition = OrderStatusTransition(
        order_id       =order.id,
        from_status    =prev_status,
        to_status      =body.new_status,
        actor_id       =actor["id"],
        actor_role     =actor["role"],
        note           =body.note,
    )
    db.add(transition)

    # Write immutable audit log
    await write_audit_log(
        db          =db,
        actor_id    =actor["id"],
        actor_role  =actor["role"],
        action      ="ORDER_STATUS_ADVANCED",
        entity_type ="order",
        entity_id   =order.id,
        before_state={"status": prev_status},
        after_state ={"status": body.new_status},
        detail      =body.note,
    )

    await db.commit()

    # Broadcast SSE to any connected clients
    await sse_service.broadcast(order.id, body.new_status)

    return AdvanceStatusResponse(
        order_id       =order.id,
        previous_status=prev_status,
        new_status     =body.new_status,
        updated_by     =actor["id"],
        updated_at     =order.updated_at,
    )


# ── POST /orders/{order_id}/cancel ────────────────────────────────────────────

@router.post("/{order_id}/cancel", response_model=CancelOrderResponse)
async def cancel_order(
    order_id: str,
    body    : CancelOrderRequest,
    request : Request,
    db      : AsyncSession = Depends(get_db),
):
    actor = _get_actor(request)
    order = await _fetch_order_or_404(order_id, db)

    if order.status in {OrderStatus.COMPLETED, OrderStatus.CANCELLED}:
        raise HTTPException(
            status_code=409,
            detail=_error(
                f"Order is already {order.status}.",
                "No action needed.",
            ),
        )

    if actor["role"] == UserRole.STUDENT:
        # Students can only cancel PLACED or PAYMENT_PENDING
        if not can_student_cancel(order.status):
            raise HTTPException(
                status_code=403,
                detail=_error(
                    "You cannot cancel an order that is being prepared.",
                    "Please contact cafeteria staff for assistance.",
                ),
            )
        # Students must cancel within the 2-minute window (FR37)
        try:
            validate_student_cancellation(order.placed_at)
        except StateMachineError as e:
            raise HTTPException(
                status_code=403,
                detail=_error(str(e), "Please contact staff directly."),
            )
    else:
        # Staff/Admin must provide a reason code (FR39)
        if not body.reason_code:
            raise HTTPException(
                status_code=422,
                detail=_error(
                    "A reason code is required for staff/admin cancellations.",
                    "Provide one of: CUSTOMER_REQUEST, OUT_OF_STOCK, STAFF_ERROR, SYSTEM_ERROR, SUSPICIOUS_ORDER.",
                ),
            )

    prev_status = order.status
    order.status             = OrderStatus.CANCELLED
    order.updated_at         = datetime.now(timezone.utc)
    order.cancellation_reason= body.reason_code
    order.cancellation_note  = body.note
    order.cancelled_by       = actor["id"]

    # Record transition
    from models.orm import OrderStatusTransition
    transition = OrderStatusTransition(
        order_id   =order.id,
        from_status=prev_status,
        to_status  =OrderStatus.CANCELLED,
        actor_id   =actor["id"],
        actor_role =actor["role"],
        note       =f"Reason: {body.reason_code}. {body.note or ''}".strip(),
    )
    db.add(transition)

    # Audit log
    await write_audit_log(
        db          =db,
        actor_id    =actor["id"],
        actor_role  =actor["role"],
        action      ="ORDER_CANCELLED",
        entity_type ="order",
        entity_id   =order.id,
        before_state={"status": prev_status},
        after_state ={"status": "CANCELLED"},
        detail      =f"Reason: {body.reason_code}. {body.note or ''}".strip(),
    )

    await db.commit()
    await sse_service.broadcast(order.id, OrderStatus.CANCELLED)

    # Refund logic lives in Member 3 (payment). We signal intent only.
    refund_applicable = prev_status in {
        OrderStatus.CONFIRMED, OrderStatus.PAYMENT_PENDING
    }

    return CancelOrderResponse(
        order_id        =order.id,
        status          ="CANCELLED",
        cancelled_by    =actor["id"],
        reason_code     =body.reason_code,
        refund_initiated=refund_applicable,
        refund_id       =str(uuid.uuid4()) if refund_applicable else None,
        cancelled_at    =order.updated_at,
    )


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _fetch_order_or_404(order_id: str, db: AsyncSession) -> Order:
    result = await db.execute(
        select(Order)
        .options(selectinload(Order.items), selectinload(Order.flagged_review))
        .where(Order.id == order_id)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(
            status_code=404,
            detail=_error("Order not found.", "Check the order ID and try again."),
        )
    return order


def _support_ref() -> str:
    return f"REF-{uuid.uuid4().hex[:8].upper()}"


def _error(message: str, corrective_action: str) -> dict:
    return {
        "message"         : message,
        "corrective_action": corrective_action,
        "support_ref"     : _support_ref(),
    }
