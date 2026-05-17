"""
PHASE 3 — TDP: Unit Tests (70% of pyramid)
These tests were written BEFORE the implementation as the "mathematical boundary."
They define exactly what the state machine must and must not allow.
Run: pytest tests/unit/ -v
"""
import pytest
from datetime import datetime, timezone, timedelta
from services.state_machine import (
    validate_transition,
    validate_student_cancellation,
    can_student_cancel,
    is_terminal,
    get_allowed_transitions,
    StateMachineError,
    STUDENT_CANCEL_WINDOW_MINUTES,
)
from models.orm import OrderStatus, UserRole


# ══════════════════════════════════════════════════════════════════════════════
# TDP BOUNDARY: validate_transition
# Failing tests written first — implementation must make ALL of these pass.
# ══════════════════════════════════════════════════════════════════════════════

class TestValidTransitions:
    """Happy path — every legal forward transition must succeed silently."""

    def test_placed_to_payment_pending_by_student(self):
        validate_transition(OrderStatus.PLACED, OrderStatus.PAYMENT_PENDING, UserRole.STUDENT)

    def test_payment_pending_to_confirmed_by_staff(self):
        validate_transition(OrderStatus.PAYMENT_PENDING, OrderStatus.CONFIRMED, UserRole.STAFF)

    def test_confirmed_to_preparing_by_staff(self):
        validate_transition(OrderStatus.CONFIRMED, OrderStatus.PREPARING, UserRole.STAFF)

    def test_preparing_to_ready_by_staff(self):
        validate_transition(OrderStatus.PREPARING, OrderStatus.READY, UserRole.STAFF)

    def test_ready_to_collected_by_staff(self):
        validate_transition(OrderStatus.READY, OrderStatus.COLLECTED, UserRole.STAFF)

    def test_collected_to_completed_by_admin(self):
        validate_transition(OrderStatus.COLLECTED, OrderStatus.COMPLETED, UserRole.ADMIN)

    def test_flagged_to_payment_pending_by_admin(self):
        validate_transition(OrderStatus.FLAGGED, OrderStatus.PAYMENT_PENDING, UserRole.ADMIN)

    def test_flagged_to_cancelled_by_admin(self):
        validate_transition(OrderStatus.FLAGGED, OrderStatus.CANCELLED, UserRole.ADMIN)


class TestIllegalTransitions:
    """Every backward or skip transition must raise StateMachineError."""

    def test_backward_preparing_to_confirmed_raises(self):
        with pytest.raises(StateMachineError):
            validate_transition(OrderStatus.PREPARING, OrderStatus.CONFIRMED, UserRole.STAFF)

    def test_backward_ready_to_preparing_raises(self):
        with pytest.raises(StateMachineError):
            validate_transition(OrderStatus.READY, OrderStatus.PREPARING, UserRole.STAFF)

    def test_skip_placed_to_preparing_raises(self):
        with pytest.raises(StateMachineError):
            validate_transition(OrderStatus.PLACED, OrderStatus.PREPARING, UserRole.STAFF)

    def test_skip_placed_to_completed_raises(self):
        with pytest.raises(StateMachineError):
            validate_transition(OrderStatus.PLACED, OrderStatus.COMPLETED, UserRole.STAFF)

    def test_terminal_completed_to_anything_raises(self):
        with pytest.raises(StateMachineError):
            validate_transition(OrderStatus.COMPLETED, OrderStatus.PLACED, UserRole.ADMIN)

    def test_terminal_cancelled_to_anything_raises(self):
        with pytest.raises(StateMachineError):
            validate_transition(OrderStatus.CANCELLED, OrderStatus.PLACED, UserRole.ADMIN)

    def test_payment_failed_to_anything_raises(self):
        with pytest.raises(StateMachineError):
            validate_transition(OrderStatus.PAYMENT_FAILED, OrderStatus.CONFIRMED, UserRole.ADMIN)


class TestRoleRestrictions:
    """Students must not be able to advance kitchen-side statuses."""

    def test_student_cannot_advance_to_preparing(self):
        with pytest.raises(StateMachineError):
            validate_transition(OrderStatus.CONFIRMED, OrderStatus.PREPARING, UserRole.STUDENT)

    def test_student_cannot_mark_ready(self):
        with pytest.raises(StateMachineError):
            validate_transition(OrderStatus.PREPARING, OrderStatus.READY, UserRole.STUDENT)

    def test_student_cannot_mark_collected(self):
        with pytest.raises(StateMachineError):
            validate_transition(OrderStatus.READY, OrderStatus.COLLECTED, UserRole.STUDENT)

    def test_student_cannot_review_flagged_order(self):
        with pytest.raises(StateMachineError):
            validate_transition(OrderStatus.FLAGGED, OrderStatus.PAYMENT_PENDING, UserRole.STUDENT)

    def test_admin_can_advance_any_staff_transition(self):
        # Admin has superset of staff permissions
        validate_transition(OrderStatus.CONFIRMED, OrderStatus.PREPARING, UserRole.ADMIN)
        validate_transition(OrderStatus.PREPARING, OrderStatus.READY,     UserRole.ADMIN)


# ══════════════════════════════════════════════════════════════════════════════
# TDP BOUNDARY: validate_student_cancellation (time window FR37)
# ══════════════════════════════════════════════════════════════════════════════

class TestStudentCancellationWindow:

    def test_cancellation_within_window_succeeds(self):
        placed_at = datetime.now(timezone.utc) - timedelta(seconds=30)
        validate_student_cancellation(placed_at)   # must not raise

    def test_cancellation_at_exactly_window_boundary_raises(self):
        """Exactly at the boundary is expired — we use strict >."""
        placed_at = datetime.now(timezone.utc) - timedelta(
            minutes=STUDENT_CANCEL_WINDOW_MINUTES, seconds=1
        )
        with pytest.raises(StateMachineError):
            validate_student_cancellation(placed_at)

    def test_cancellation_one_second_over_window_raises(self):
        placed_at = datetime.now(timezone.utc) - timedelta(
            minutes=STUDENT_CANCEL_WINDOW_MINUTES + 1
        )
        with pytest.raises(StateMachineError):
            validate_student_cancellation(placed_at)

    def test_cancellation_just_before_window_expires_succeeds(self):
        placed_at = datetime.now(timezone.utc) - timedelta(
            minutes=STUDENT_CANCEL_WINDOW_MINUTES - 0.5
        )
        validate_student_cancellation(placed_at)   # must not raise

    def test_naive_datetime_handled_gracefully(self):
        """placed_at without timezone info must still work (edge case)."""
        placed_at = datetime.now() - timedelta(seconds=10)   # no tz
        validate_student_cancellation(placed_at)   # must not raise


# ══════════════════════════════════════════════════════════════════════════════
# TDP BOUNDARY: helper predicates
# ══════════════════════════════════════════════════════════════════════════════

class TestHelperPredicates:

    def test_can_student_cancel_placed(self):
        assert can_student_cancel(OrderStatus.PLACED) is True

    def test_can_student_cancel_payment_pending(self):
        assert can_student_cancel(OrderStatus.PAYMENT_PENDING) is True

    def test_cannot_student_cancel_preparing(self):
        assert can_student_cancel(OrderStatus.PREPARING) is False

    def test_cannot_student_cancel_ready(self):
        assert can_student_cancel(OrderStatus.READY) is False

    def test_is_terminal_completed(self):
        assert is_terminal(OrderStatus.COMPLETED) is True

    def test_is_terminal_cancelled(self):
        assert is_terminal(OrderStatus.CANCELLED) is True

    def test_is_terminal_payment_failed(self):
        assert is_terminal(OrderStatus.PAYMENT_FAILED) is True

    def test_not_terminal_preparing(self):
        assert is_terminal(OrderStatus.PREPARING) is False

    def test_get_allowed_transitions_for_staff_from_confirmed(self):
        allowed = get_allowed_transitions(OrderStatus.CONFIRMED, UserRole.STAFF)
        assert OrderStatus.PREPARING in allowed
        assert OrderStatus.CANCELLED in allowed

    def test_get_allowed_transitions_empty_for_terminal(self):
        allowed = get_allowed_transitions(OrderStatus.COMPLETED, UserRole.ADMIN)
        assert allowed == []

    def test_error_carries_allowed_list(self):
        """StateMachineError for a wrong transition must include the allowed transitions."""
        try:
            validate_transition(OrderStatus.PLACED, OrderStatus.COMPLETED, UserRole.ADMIN)
        except StateMachineError as e:
            assert isinstance(e.allowed, list)
            assert len(e.allowed) > 0
        else:
            pytest.fail("Expected StateMachineError not raised")


# ══════════════════════════════════════════════════════════════════════════════
# TDP BOUNDARY: error message quality (NFR25 — plain-language errors)
# ══════════════════════════════════════════════════════════════════════════════

class TestErrorMessageQuality:

    def test_illegal_transition_error_is_human_readable(self):
        try:
            validate_transition(OrderStatus.COMPLETED, OrderStatus.PLACED, UserRole.ADMIN)
        except StateMachineError as e:
            msg = str(e)
            assert "COMPLETED" in msg
            assert "PLACED" in msg
            # must NOT contain internal jargon
            assert "traceback" not in msg.lower()
            assert "sqlalchemy" not in msg.lower()

    def test_role_restriction_error_mentions_role(self):
        try:
            validate_transition(OrderStatus.CONFIRMED, OrderStatus.PREPARING, UserRole.STUDENT)
        except StateMachineError as e:
            assert "STUDENT" in str(e)
