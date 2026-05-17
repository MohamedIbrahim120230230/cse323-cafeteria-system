"""
State machine service — enforces all legal order transitions (FR34-FR39).
This is the single source of truth for what transitions are allowed.
No transition logic exists anywhere else in the codebase.
"""
from datetime import datetime, timezone, timedelta
from typing import Optional
from models.orm import OrderStatus, UserRole

# ── Legal transition table (from API contract + SRS state machine) ────────────
# Key   = current status
# Value = dict of { new_status: [roles_allowed_to_trigger] }

TRANSITIONS: dict[str, dict[str, list[str]]] = {
    OrderStatus.PLACED: {
        OrderStatus.PAYMENT_PENDING: [UserRole.STUDENT, UserRole.STAFF, UserRole.ADMIN],
        OrderStatus.CANCELLED      : [UserRole.STUDENT, UserRole.STAFF, UserRole.ADMIN],
    },
    OrderStatus.PAYMENT_PENDING: {
        OrderStatus.CONFIRMED      : [UserRole.STAFF, UserRole.ADMIN],   # triggered by webhook (system)
        OrderStatus.PAYMENT_FAILED : [UserRole.STAFF, UserRole.ADMIN],
        OrderStatus.CANCELLED      : [UserRole.STUDENT, UserRole.STAFF, UserRole.ADMIN],
    },
    OrderStatus.CONFIRMED: {
        OrderStatus.PREPARING      : [UserRole.STAFF, UserRole.ADMIN],
        OrderStatus.CANCELLED      : [UserRole.STAFF, UserRole.ADMIN],
    },
    OrderStatus.PREPARING: {
        OrderStatus.READY          : [UserRole.STAFF, UserRole.ADMIN],
        OrderStatus.CANCELLED      : [UserRole.STAFF, UserRole.ADMIN],
    },
    OrderStatus.READY: {
        OrderStatus.COLLECTED      : [UserRole.STAFF, UserRole.ADMIN],
    },
    OrderStatus.COLLECTED: {
        OrderStatus.COMPLETED      : [UserRole.STAFF, UserRole.ADMIN],   # also auto by system
    },
    # Terminal states — no transitions allowed
    OrderStatus.COMPLETED      : {},
    OrderStatus.CANCELLED      : {},
    OrderStatus.PAYMENT_FAILED : {},
    OrderStatus.FLAGGED        : {
        OrderStatus.PAYMENT_PENDING: [UserRole.ADMIN],   # admin approves
        OrderStatus.CANCELLED      : [UserRole.ADMIN],   # admin rejects
    },
}

# How many minutes after placement can a student cancel? (FR37)
STUDENT_CANCEL_WINDOW_MINUTES = 2

# Statuses staff/admin can cancel from (FR39)
STAFF_CANCELLABLE_STATUSES = {
    OrderStatus.PLACED,
    OrderStatus.PAYMENT_PENDING,
    OrderStatus.CONFIRMED,
    OrderStatus.PREPARING,
    OrderStatus.READY,
}


class StateMachineError(Exception):
    """Raised when a requested transition is illegal."""
    def __init__(self, message: str, allowed: list[str] | None = None):
        super().__init__(message)
        self.allowed = allowed or []


def validate_transition(
    current_status: str,
    new_status: str,
    actor_role: str,
) -> None:
    """
    Raise StateMachineError if the transition is illegal.
    Called before any DB write.
    """
    allowed_from = TRANSITIONS.get(current_status, {})

    if new_status not in allowed_from:
        raise StateMachineError(
            f"Transition from {current_status} to {new_status} is not allowed.",
            allowed=list(allowed_from.keys()),
        )

    roles_allowed = allowed_from[new_status]
    if actor_role not in roles_allowed:
        raise StateMachineError(
            f"Role {actor_role} cannot perform the transition {current_status} → {new_status}."
        )


def validate_student_cancellation(placed_at: datetime) -> None:
    """
    Students can only cancel within STUDENT_CANCEL_WINDOW_MINUTES of placing (FR37).
    Raises StateMachineError if the window has passed.
    """
    now = datetime.now(timezone.utc)
    # ensure placed_at is timezone-aware
    if placed_at.tzinfo is None:
        placed_at = placed_at.replace(tzinfo=timezone.utc)
    deadline = placed_at + timedelta(minutes=STUDENT_CANCEL_WINDOW_MINUTES)
    if now > deadline:
        raise StateMachineError(
            "Cancellation window has expired. Please contact staff.",
        )


def can_student_cancel(current_status: str) -> bool:
    """Returns True if students are allowed to request cancellation from this status."""
    return current_status in {OrderStatus.PLACED, OrderStatus.PAYMENT_PENDING}


def is_terminal(status: str) -> bool:
    return status in {OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.PAYMENT_FAILED}


def get_allowed_transitions(current_status: str, actor_role: str) -> list[str]:
    """Return all statuses this role can transition to from current_status."""
    allowed_from = TRANSITIONS.get(current_status, {})
    return [
        to_status
        for to_status, roles in allowed_from.items()
        if actor_role in roles
    ]
