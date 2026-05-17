# University Cafeteria Ordering System

## Phase 3 — Test-Driven Implementation (TDI)

### Test-Driven Prompting (TDP) Methodology

---

> **Methodology Overview**
>
> Phase 3 applies **Test-Driven Prompting (TDP)** — a structured three-step loop that governs every unit of AI-assisted implementation:
>
> 1. **The Failing Test** — A unit test is written first, establishing the precise mathematical/logical boundary the implementation must satisfy. The test is expected to fail before any implementation exists.
> 2. **The Edge Case Cage** — "Padlocks" are attached to each test: explicit boundary constraints, threshold guards, and extreme-value assertions that prevent the AI from hallucinating logic that passes the happy path but breaks edge conditions.
> 3. **Iteration** — The AI is prompted repeatedly using the failing test + padlocks as the specification, until the produced implementation causes all tests — including padlocks — to pass with zero modifications to the test suite.
>
> **Coverage target:** All 24 edge cases from the SRS + all 7 hidden requirements (HR-01 to HR-07) receive at least one TDP cycle.

---

## Module Ownership

| Module              | Member   | FRs Owned            | Edge Cases                                           |
| ------------------- | -------- | -------------------- | ---------------------------------------------------- |
| Auth & Identity     | Member 1 | FR01–FR08, FR50–FR51 | FR03, FR04, FR06, FR08                               |
| Menu & Cart         | Member 2 | FR09–FR19            | FR14, FR15, FR16, FR17, FR19                         |
| Order & Payment     | Member 3 | FR20–FR32            | FR22, FR23, FR24, FR25, FR28, FR29, FR30, FR31, FR32 |
| Stock & Resilience  | Member 4 | FR33–FR41            | FR37, FR38, FR40, FR41                               |
| Lifecycle & Reports | Member 5 | FR42–FR56            | FR44, FR45                                           |

---

---

# Member 1 — Auth & Identity

## TDP-M1-01 · FR03 — Account Lockout After 5 Failed Attempts

### Step 1 · The Failing Test

```python
# test_auth.py
import pytest
from freezegun import freeze_time
from app.auth import AuthService

class TestAccountLockout:

    def test_account_locked_on_fifth_consecutive_failure(self, db_session):
        """
        BOUNDARY: Exactly 5 consecutive failures trigger a 15-minute lock.
        4 failures must NOT trigger a lock. 5 failures MUST.
        """
        service = AuthService(db_session)
        email = "ali@university.edu"

        # 4 failures — account must still be open
        for attempt in range(4):
            result = service.login(email, "wrongPassword!")
            assert result.locked is False, (
                f"Account must NOT be locked after {attempt + 1} attempt(s)"
            )

        # 5th failure — account must lock NOW
        result = service.login(email, "wrongPassword!")
        assert result.locked is True
        assert result.http_status == 403
        assert "15 minutes" in result.message
        assert result.lock_duration_seconds == 900  # EXACT: 15 min = 900s

    def test_lock_duration_is_exactly_900_seconds(self, db_session):
        """BOUNDARY: Lock expires at exactly t+900s, not t+899s or t+901s."""
        service = AuthService(db_session)
        email = "ali@university.edu"
        lock_start = datetime.utcnow()

        _trigger_lockout(service, email)

        with freeze_time(lock_start + timedelta(seconds=899)):
            result = service.login(email, "correctPassword1!")
            assert result.locked is True, "Lock must still be active at t+899s"

        with freeze_time(lock_start + timedelta(seconds=900)):
            result = service.login(email, "correctPassword1!")
            assert result.locked is False, "Lock must be released at exactly t+900s"

    def test_lockout_event_logged_with_timestamp_and_ip(self, db_session):
        """PADLOCK: Audit log entry is mandatory — no silent lockouts."""
        service = AuthService(db_session)
        _trigger_lockout(service, "ali@university.edu", ip="192.168.1.100")

        log_entry = db_session.query(AuditLog).filter_by(
            event="ACCOUNT_LOCKED", actor_email="ali@university.edu"
        ).first()

        assert log_entry is not None
        assert log_entry.ip_address == "192.168.1.100"
        assert log_entry.timestamp is not None

    def test_failed_counter_resets_to_zero_after_successful_login(self, db_session):
        """PADLOCK: Counter must be zeroed on success, not merely decremented."""
        service = AuthService(db_session)
        email = "ali@university.edu"

        for _ in range(3):
            service.login(email, "wrongPassword!")

        service.login(email, "correctPassword1!")  # success
        user = db_session.query(User).filter_by(email=email).first()
        assert user.failed_attempts == 0  # EXACT zero, not 3-1=2
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                  | Boundary                                                          | Enforcement                                        |
| ----- | ---------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| 🔒 P1 | **Attempt count is exact**               | Lock triggers at attempt == 5, not attempt >= 4                   | Counter stored as integer; assertion is `== 5`     |
| 🔒 P2 | **Lock duration is exact**               | 900 seconds, not "approximately 15 minutes"                       | `lock_duration_seconds == 900` checked in response |
| 🔒 P3 | **Audit log is mandatory**               | Every lockout must write to `audit_log` before returning HTTP 403 | Test queries `AuditLog` table directly             |
| 🔒 P4 | **Counter resets to zero**               | Successful login resets to `0`, not to `current - 1`              | Assert `user.failed_attempts == 0`                 |
| 🔒 P5 | **Non-5th attempt returns 401, not 403** | HTTP 401 for wrong password; HTTP 403 only at lockout             | Assert status code per attempt number              |

### Step 3 · Iteration Prompt

```
You are implementing the login() method of AuthService.

SPECIFICATION (do not change this): The failing test suite above defines the exact
behavior you must produce. All 4 tests must pass without modifying any assertion.

CONSTRAINTS (Padlocks — inviolable):
- The lockout triggers on the 5th consecutive failed attempt, atomically.
- Lock duration is exactly 900 seconds stored as an integer.
- Before returning HTTP 403, write an AuditLog row with: event, actor_email,
  ip_address, timestamp. If the write fails, raise — do not swallow.
- On any successful login, set failed_attempts = 0 in the same transaction.
- Attempts 1–4 must return HTTP 401. Only attempt 5 returns HTTP 403.

Provide only the implementation of login() and any model changes required.
Do not invent behavior not asserted by the tests.
```

---

## TDP-M1-02 · FR04 — Session Expiry After 30-Minute Inactivity

### Step 1 · The Failing Test

```python
class TestSessionExpiry:

    def test_token_rejected_after_30_minutes_inactivity(self, redis_client):
        """BOUNDARY: Token is invalid at exactly t+1800s of inactivity."""
        token = issue_token(user_id="user-001", issued_at=NOW)

        with freeze_time(NOW + timedelta(seconds=1799)):
            result = validate_token(token, redis_client)
            assert result.valid is True  # still alive at 1799s

        with freeze_time(NOW + timedelta(seconds=1800)):
            result = validate_token(token, redis_client)
            assert result.valid is False
            assert result.http_status == 401
            assert result.message == "Session expired. Please log in again."

    def test_token_removed_from_redis_on_expiry(self, redis_client):
        """PADLOCK: Server-side invalidation — token must not persist in Redis."""
        token = issue_token(user_id="user-001")

        with freeze_time(NOW + timedelta(seconds=1800)):
            validate_token(token, redis_client)

        stored = redis_client.get(f"session:{token}")
        assert stored is None, "Expired token must be evicted from Redis"

    def test_activity_resets_inactivity_clock(self, redis_client):
        """BOUNDARY: Any authenticated request at t+1000s resets window to t+1000s+1800s."""
        token = issue_token(user_id="user-001", issued_at=NOW)

        with freeze_time(NOW + timedelta(seconds=1000)):
            touch_session(token, redis_client)  # activity event

        with freeze_time(NOW + timedelta(seconds=2799)):
            result = validate_token(token, redis_client)
            assert result.valid is True  # 1000+1800=2800 > 2799 → still valid

        with freeze_time(NOW + timedelta(seconds=2800)):
            result = validate_token(token, redis_client)
            assert result.valid is False
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                           | Boundary                                                                        | Enforcement                                     |
| ----- | ------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------- |
| 🔒 P1 | **Inactivity window is exact**                    | 1800s, not "about 30 minutes"                                                   | `timedelta(seconds=1799)` valid; `1800` invalid |
| 🔒 P2 | **Server-side invalidation is mandatory**         | Token must be removed from Redis — client-side expiry alone is insufficient     | Redis key checked directly after expiry         |
| 🔒 P3 | **Clock is inactivity-based, not issuance-based** | Activity resets the countdown; the window is from last activity, not from login | `touch_session` extends validity                |
| 🔒 P4 | **Error message is exact**                        | Must read `"Session expired. Please log in again."`                             | String equality assertion                       |

### Step 3 · Iteration Prompt

```
Implement the validate_token() and touch_session() functions.

CONSTRAINTS (Padlocks):
- The inactivity window is 1800 seconds measured from the last recorded activity,
  not from token issuance.
- On every valid authenticated request, call touch_session() to reset the TTL
  in Redis to 1800 seconds.
- At exactly 1800 seconds of inactivity, delete the Redis key and return
  HTTP 401 with the message: "Session expired. Please log in again."
- Do not return HTTP 403 for expiry; that is reserved for lockout only.
```

---

## TDP-M1-03 · FR06 — Password Reset Link (15-Minute TTL, Single-Use)

### Step 1 · The Failing Test

```python
class TestPasswordReset:

    def test_reset_link_expires_after_15_minutes(self, db_session):
        """BOUNDARY: Link invalid at exactly t+900s."""
        token = generate_reset_token(email="ali@university.edu", db=db_session)

        with freeze_time(NOW + timedelta(seconds=899)):
            result = consume_reset_token(token, db=db_session)
            assert result.valid is True

        with freeze_time(NOW + timedelta(seconds=900)):
            result = consume_reset_token(token, db=db_session)
            assert result.valid is False
            assert result.error == "LINK_EXPIRED"

    def test_reset_link_is_single_use(self, db_session):
        """PADLOCK: Token is invalidated after first use — reuse returns LINK_USED."""
        token = generate_reset_token(email="ali@university.edu", db=db_session)

        first = consume_reset_token(token, new_password="NewPass1!", db=db_session)
        assert first.valid is True

        second = consume_reset_token(token, new_password="AnotherPass1!", db=db_session)
        assert second.valid is False
        assert second.error == "LINK_ALREADY_USED"

    def test_password_not_changed_on_expired_token(self, db_session):
        """PADLOCK: Expired token must not mutate the password."""
        original_hash = get_password_hash("ali@university.edu", db=db_session)
        token = generate_reset_token(email="ali@university.edu", db=db_session)

        with freeze_time(NOW + timedelta(seconds=901)):
            consume_reset_token(token, new_password="HackedPass1!", db=db_session)

        current_hash = get_password_hash("ali@university.edu", db=db_session)
        assert current_hash == original_hash  # password unchanged
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                    | Boundary                                                                  | Enforcement                          |
| ----- | ------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------ |
| 🔒 P1 | **TTL is exactly 900 seconds**             | 899s → valid; 900s → expired                                              | `freeze_time` assertions at boundary |
| 🔒 P2 | **Single-use is enforced atomically**      | Token marked `used=True` in the same transaction as password update       | DB state verified after first use    |
| 🔒 P3 | **Expired token must not change password** | No side effects on expiry                                                 | Password hash unchanged assertion    |
| 🔒 P4 | **Distinct error codes**                   | `LINK_EXPIRED` ≠ `LINK_ALREADY_USED` — client can show different messages | Error string equality assertions     |

---

## TDP-M1-04 · FR08 — Reject Suspended / Expired Accounts

### Step 1 · The Failing Test

```python
@pytest.mark.parametrize("status,expected_message", [
    ("SUSPENDED", "Your account has been suspended. Contact the registrar."),
    ("EXPIRED",   "Your university account has expired. Contact IT services."),
    ("NOT_FOUND", "No account found for this email address."),
])
def test_rejected_account_statuses(db_session, status, expected_message):
    """BOUNDARY: Each invalid account status maps to a specific, distinct message."""
    email = f"{status.lower()}@university.edu"
    seed_account(email=email, status=status, db=db_session)

    result = AuthService(db_session).login(email, "validPass1!")

    assert result.http_status == 403
    assert result.message == expected_message
    # PADLOCK: No JWT is issued under any rejected status
    assert result.access_token is None
    assert result.refresh_token is None
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                          | Boundary                                                                | Enforcement                             |
| ----- | -------------------------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| 🔒 P1 | **No token on rejection**        | `access_token` and `refresh_token` are `None` for all rejected statuses | Null assertion on both fields           |
| 🔒 P2 | **Messages are status-specific** | SUSPENDED ≠ EXPIRED ≠ NOT_FOUND messages                                | Parametrize with exact expected strings |
| 🔒 P3 | **HTTP status is 403, not 401**  | Suspended is authorization failure, not authentication failure          | Assert `http_status == 403`             |

---

---

# Member 2 — Menu & Cart

## TDP-M2-01 · FR14–FR16 — Voucher Validation Edge Cases

### Step 1 · The Failing Test

```python
class TestVoucherValidation:

    def test_voucher_floors_total_at_zero_never_negative(self, db_session):
        """
        BOUNDARY: When discount > cart_total, final_total == 0.
        final_total must NEVER be negative. No excess is carried forward.
        """
        cart = build_cart(total_egp=30.00)
        voucher = build_voucher(flat_discount_egp=100.00)

        result = apply_voucher(cart, voucher, db=db_session)

        assert result.final_total_egp == 0.00       # exact zero
        assert result.final_total_egp >= 0.00        # never negative
        assert result.discount_egp == 30.00          # discount == cart total, not 100
        assert result.excess_egp is None             # no carryover field exposed

    def test_cannot_stack_two_vouchers(self, db_session):
        """BOUNDARY: Second voucher application must fail with HTTP 422."""
        cart = build_cart(total_egp=120.00, applied_voucher="FIRST10")

        result = apply_voucher(cart, "SECOND20", db=db_session)

        assert result.http_status == 422
        assert result.error == "VOUCHER_STACK_REJECTED"
        assert result.message == "Only one voucher may be applied per order."

    def test_concurrent_single_use_voucher_first_wins(self, db_session):
        """
        PADLOCK: Concurrency — exactly ONE of two simultaneous applications succeeds.
        Uses atomic DB check; no race condition allowed.
        """
        voucher_code = "ONCE01"
        results = run_concurrent([
            lambda: apply_voucher(build_cart(120), voucher_code, db=db_session),
            lambda: apply_voucher(build_cart(120), voucher_code, db=db_session),
        ])

        successes = [r for r in results if r.http_status == 200]
        conflicts  = [r for r in results if r.http_status == 409]

        assert len(successes) == 1
        assert len(conflicts) == 1
        assert conflicts[0].message == "Voucher already applied."

    @pytest.mark.parametrize("code,cart_total,expected_error", [
        ("USED01",  80.00, "Voucher has already been used by your account."),
        ("EXPD01",  80.00, "Voucher has expired."),
        ("MIN100",  50.00, "Minimum order of 100 EGP required for this voucher."),
        ("RVKD01",  80.00, "Voucher is no longer valid."),
    ])
    def test_invalid_voucher_returns_specific_error(self, code, cart_total, expected_error, db_session):
        """PADLOCK: Error messages are exact strings — no generic 'invalid voucher' allowed."""
        cart = build_cart(total_egp=cart_total)
        result = apply_voucher(cart, code, db=db_session)

        assert result.http_status == 422
        assert result.message == expected_error
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                  | Boundary                                                         | Enforcement                                             |
| ----- | ---------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| 🔒 P1 | **Final total floor is zero**            | `final_total_egp >= 0` always                                    | Direct assertion; `excess_egp` must be absent           |
| 🔒 P2 | **Applied discount ≤ cart total**        | `discount_egp` is capped at `cart_total`, not at `voucher_value` | Assert `discount_egp == min(voucher_value, cart_total)` |
| 🔒 P3 | **Stacking rejected with specific code** | `VOUCHER_STACK_REJECTED` code, not a generic 422                 | Error code string assertion                             |
| 🔒 P4 | **Concurrent use: exactly 1 success**    | DB-level atomic check; second request gets HTTP 409              | `run_concurrent` wrapper; count successes == 1          |
| 🔒 P5 | **All error messages are exact**         | No generic fallback message allowed                              | Parametrized string equality                            |

### Step 3 · Iteration Prompt

```
Implement apply_voucher(cart, voucher_code, db).

CONSTRAINTS (Padlocks — cannot be relaxed):
1. final_total_egp = max(0, cart_total - voucher_discount). Never store or return
   a negative value. Never expose an "excess" or "carry-forward" field.
2. If the cart already has an applied voucher, return HTTP 422 immediately before
   any DB lookup. Error code: VOUCHER_STACK_REJECTED.
3. The single-use check must use a DB-level atomic operation (SELECT FOR UPDATE or
   equivalent). The transaction must commit the "used" flag before returning 200.
4. Error messages for each rejection reason must match the exact strings in the
   parametrized test — no paraphrasing, no generic fallbacks.
```

---

## TDP-M2-02 · FR17 — Cart Lock at Checkout

### Step 1 · The Failing Test

```python
class TestCartLock:

    def test_cart_is_read_only_after_checkout_initiated(self, db_session):
        """BOUNDARY: Any mutation attempt on a locked cart returns HTTP 409."""
        cart = create_and_lock_cart(user_id="user-001", db=db_session)

        result = add_item_to_cart(cart.id, item_id="item-xyz", db=db_session)

        assert result.http_status == 409
        assert result.error == "CART_LOCKED"

    def test_price_change_detected_on_lock(self, db_session):
        """PADLOCK: If item price changes between add-to-cart and lock, user is notified."""
        cart = build_cart_with_item("koshary", price_at_add=35.00)
        change_item_price("koshary", new_price=40.00, db=db_session)

        result = lock_cart_for_checkout(cart.id, db=db_session)

        assert result.warnings is not None
        assert any(
            w["item"] == "Koshary Bowl" and
            w["old_price"] == 35.00 and
            w["new_price"] == 40.00
            for w in result.warnings
        )

    def test_out_of_stock_item_detected_on_lock(self, db_session):
        """PADLOCK: If an item goes out of stock between add-to-cart and lock, user is notified."""
        cart = build_cart_with_item("grilled_chicken", quantity=2)
        set_stock("grilled_chicken", quantity=0, db=db_session)

        result = lock_cart_for_checkout(cart.id, db=db_session)

        assert result.http_status == 409
        assert result.error == "ITEM_OUT_OF_STOCK"
        assert "Grilled Chicken" in result.message
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                  | Boundary                                                                 | Enforcement                        |
| ----- | ---------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| 🔒 P1 | **Locked cart rejects all mutations**    | HTTP 409 `CART_LOCKED` on any POST/PATCH to cart while in checkout state | Direct mutation attempt after lock |
| 🔒 P2 | **Price drift is detected and reported** | `warnings[]` array with `old_price` and `new_price` fields               | Warning structure assertion        |
| 🔒 P3 | **Stock depletion blocks locking**       | HTTP 409 if any item reaches 0 stock before lock completes               | Out-of-stock seed + lock attempt   |

---

## TDP-M2-03 · FR19 — Max Order Quantity Per Item

### Step 1 · The Failing Test

```python
class TestMaxOrderQuantity:

    def test_quantity_at_cap_is_accepted(self, db_session):
        """BOUNDARY: quantity == max_order_qty must succeed."""
        set_item_max_qty("grilled_chicken", max_qty=10, db=db_session)
        result = add_to_cart("grilled_chicken", quantity=10)
        assert result.http_status == 200

    def test_quantity_one_above_cap_is_rejected(self, db_session):
        """BOUNDARY: quantity == max_order_qty + 1 must fail."""
        set_item_max_qty("grilled_chicken", max_qty=10, db=db_session)
        result = add_to_cart("grilled_chicken", quantity=11)
        assert result.http_status == 422
        assert result.error == "QUANTITY_EXCEEDS_CAP"
        assert result.max_allowed == 10

    def test_cap_is_per_item_not_per_cart(self, db_session):
        """PADLOCK: Cap applies to a single item, not total cart quantity."""
        set_item_max_qty("grilled_chicken", max_qty=10, db=db_session)
        set_item_max_qty("koshary", max_qty=10, db=db_session)

        result = add_multiple_to_cart([
            ("grilled_chicken", 10),
            ("koshary", 10),
        ])
        # Total cart qty = 20, but each item is within its own cap
        assert result.http_status == 200
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                         | Boundary                                         | Enforcement                              |
| ----- | ----------------------------------------------- | ------------------------------------------------ | ---------------------------------------- |
| 🔒 P1 | **Cap is per-item, not per-cart**               | 10 of item A + 10 of item B = 20 total → allowed | Multi-item cart assertion                |
| 🔒 P2 | **Response includes `max_allowed`**             | Client needs this to display correct UI message  | Field presence assertion                 |
| 🔒 P3 | **Cap is enforced at add-to-cart AND checkout** | Both points must validate; not just one          | Separate test for checkout re-validation |

---

---

# Member 3 — Order & Payment

## TDP-M3-01 · FR22 — Pessimistic Stock Lock (Oversell Prevention)

### Step 1 · The Failing Test

```python
class TestStockLock:

    def test_last_item_cannot_be_oversold_under_concurrency(self, db_session):
        """
        BOUNDARY: When stock == 1, exactly ONE of two concurrent orders acquires
        the lock. The other receives HTTP 409 OVERSELL_PREVENTED.
        """
        set_stock("koshary", quantity=1, db=db_session)

        results = run_concurrent([
            lambda: place_order(user="user-001", items=[("koshary", 1)], db=db_session),
            lambda: place_order(user="user-002", items=[("koshary", 1)], db=db_session),
        ])

        confirmed = [r for r in results if r.http_status == 200]
        rejected  = [r for r in results if r.http_status == 409]

        assert len(confirmed) == 1
        assert len(rejected)  == 1
        assert rejected[0].error == "OVERSELL_PREVENTED"

    def test_stock_lock_released_on_payment_failure(self, db_session):
        """PADLOCK: Stock lock must be released — no permanent drain on payment failure."""
        set_stock("koshary", quantity=5, db=db_session)
        order = place_order_to_payment_pending("user-001", [("koshary", 2)], db=db_session)

        simulate_gateway_failure(order.id, db=db_session)

        available = get_available_stock("koshary", db=db_session)
        assert available == 5  # fully restored

    def test_lock_ttl_is_exactly_10_minutes(self, db_session):
        """BOUNDARY: Lock auto-releases at t+600s if payment never completes."""
        set_stock("koshary", quantity=1, db=db_session)
        place_order_to_payment_pending("user-001", [("koshary", 1)], db=db_session)

        with freeze_time(NOW + timedelta(seconds=599)):
            available = get_available_stock("koshary", db=db_session)
            assert available == 0  # still locked

        with freeze_time(NOW + timedelta(seconds=600)):
            available = get_available_stock("koshary", db=db_session)
            assert available == 1  # released
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                | Boundary                                                   | Enforcement                           |
| ----- | -------------------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| 🔒 P1 | **Exactly 1 winner under concurrency** | Stock=1, 2 concurrent requests → 1 success, 1 rejection    | `run_concurrent` + count assertions   |
| 🔒 P2 | **Lock TTL is exactly 600 seconds**    | Lock held at 599s; released at 600s                        | `freeze_time` boundary assertions     |
| 🔒 P3 | **Payment failure releases full lock** | Available stock returns to pre-order level                 | Stock quantity equality after failure |
| 🔒 P4 | **No partial release**                 | If order has 3 items locked, all 3 are released atomically | Verify all item stocks restored       |

### Step 3 · Iteration Prompt

```
Implement the stock locking mechanism for place_order().

CONSTRAINTS (Padlocks):
- Use SELECT FOR UPDATE NOWAIT (or Redis distributed lock) to acquire stock.
  If lock acquisition fails, return HTTP 409 with error OVERSELL_PREVENTED immediately.
- Stock lock TTL is exactly 600 seconds. Implement a background job that releases
  expired locks every 60 seconds (the cleanup job must run regardless of payment state).
- On PAYMENT_FAILED or PAYMENT_TIMEOUT, release ALL stock locks for the order in a
  single atomic transaction. Partial release is architecturally prohibited.
- Under concurrent requests, the first to acquire the DB lock wins.
  Do not implement retry logic inside place_order() itself.
```

---

## TDP-M3-02 · FR23 — Duplicate Order Idempotency (60-Second Window)

### Step 1 · The Failing Test

```python
class TestOrderIdempotency:

    def test_duplicate_within_60s_returns_original_order(self, db_session):
        """BOUNDARY: Same cart fingerprint within 60s → same order_id returned."""
        key = "idem-key-abc-123"
        first  = place_order(cart_id="cart-001", idempotency_key=key, db=db_session)
        second = place_order(cart_id="cart-001", idempotency_key=key, db=db_session)

        assert second.order_id == first.order_id
        assert second.http_status == 200
        order_count = db_session.query(Order).filter_by(idempotency_key=key).count()
        assert order_count == 1  # only one record ever created

    def test_new_order_allowed_after_60_second_window(self, db_session):
        """BOUNDARY: Same key after 61s → new order created."""
        key = "idem-key-abc-123"
        first = place_order(cart_id="cart-001", idempotency_key=key, db=db_session)

        with freeze_time(NOW + timedelta(seconds=61)):
            second = place_order(cart_id="cart-001", idempotency_key=key, db=db_session)

        assert second.order_id != first.order_id
        order_count = db_session.query(Order).filter_by(idempotency_key=key).count()
        assert order_count == 2

    def test_different_key_always_creates_new_order(self, db_session):
        """PADLOCK: Idempotency is keyed on client-generated UUID, not on cart contents."""
        first  = place_order(cart_id="cart-001", idempotency_key="key-A", db=db_session)
        second = place_order(cart_id="cart-001", idempotency_key="key-B", db=db_session)
        assert first.order_id != second.order_id
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                              | Boundary                                 | Enforcement            |
| ----- | ---------------------------------------------------- | ---------------------------------------- | ---------------------- |
| 🔒 P1 | **Window is exactly 60 seconds**                     | At 59s → deduplicate; at 61s → new order | `freeze_time` boundary |
| 🔒 P2 | **Deduplication is key-based, not content-based**    | Same cart with different key → 2 orders  | Different key test     |
| 🔒 P3 | **Only 1 DB row ever written per key within window** | Not 2 rows returning same ID             | `count()` assertion    |

---

## TDP-M3-03 · FR28–FR30 — Payment Gateway Failure, Timeout, Double-Charge Prevention

### Step 1 · The Failing Test

```python
class TestPaymentResilience:

    def test_gateway_failure_sets_payment_failed_and_releases_stock(self, db_session):
        """BOUNDARY: On gateway error, status → PAYMENT_FAILED and stock released atomically."""
        order = create_order_in_payment_pending("user-001", db=db_session)
        initial_stock = get_available_stock("koshary", db=db_session)

        simulate_gateway_error(order.id, db=db_session)

        order = db_session.query(Order).get(order.id)
        assert order.status == "PAYMENT_FAILED"
        assert get_available_stock("koshary", db=db_session) == initial_stock

    def test_gateway_timeout_after_10_seconds(self, db_session):
        """BOUNDARY: No webhook in 10s → PAYMENT_FAILED. Not 9s, not 11s."""
        order = create_order_in_payment_pending("user-001", db=db_session)

        with freeze_time(NOW + timedelta(seconds=9)):
            status = get_order_status(order.id, db=db_session)
            assert status == "PAYMENT_PENDING"  # still waiting

        with freeze_time(NOW + timedelta(seconds=10)):
            run_timeout_checker(db=db_session)
            status = get_order_status(order.id, db=db_session)
            assert status == "PAYMENT_FAILED"

    def test_retry_max_3_attempts(self, db_session):
        """BOUNDARY: 3rd retry allowed; 4th retry returns HTTP 422 MAX_RETRIES_EXCEEDED."""
        order = create_order_in_payment_failed("user-001", retry_count=2, db=db_session)

        third_attempt = retry_payment(order.id, db=db_session)
        assert third_attempt.http_status == 200

        fourth_attempt = retry_payment(order.id, db=db_session)
        assert fourth_attempt.http_status == 422
        assert fourth_attempt.error == "MAX_RETRIES_EXCEEDED"

    def test_idempotency_key_prevents_double_charge(self, db_session):
        """PADLOCK: Two payment attempts with same idempotency_key charge exactly once."""
        order = create_order_in_payment_pending("user-001", db=db_session)
        key = order.payment_idempotency_key

        simulate_gateway_success(order.id, idempotency_key=key, db=db_session)
        simulate_gateway_success(order.id, idempotency_key=key, db=db_session)  # retry

        charges = db_session.query(PaymentRecord).filter_by(idempotency_key=key).count()
        assert charges == 1

    def test_meal_plan_rejected_on_insufficient_balance(self, db_session):
        """BOUNDARY: Balance=85, order=120 → rejected with exact shortfall shown."""
        set_meal_plan_balance("user-001", balance=85.00, db=db_session)
        result = pay_with_meal_plan(order_total=120.00, user="user-001", db=db_session)

        assert result.http_status == 422
        assert result.current_balance_egp == 85.00
        assert result.required_egp == 120.00
        assert result.shortfall_egp == 35.00
        assert result.error == "INSUFFICIENT_MEAL_PLAN_BALANCE"
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                                | Boundary                                               | Enforcement                           |
| ----- | ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------- |
| 🔒 P1 | **Timeout is exactly 10 seconds**                      | At 9s → PAYMENT_PENDING; at 10s → PAYMENT_FAILED       | `freeze_time` boundary                |
| 🔒 P2 | **Stock release is atomic with status change**         | Cannot have PAYMENT_FAILED + still-locked stock        | Single transaction assertion          |
| 🔒 P3 | **Max retries is exactly 3**                           | 3rd → allowed; 4th → `MAX_RETRIES_EXCEEDED`            | `retry_count` boundary                |
| 🔒 P4 | **Double-charge blocked by idempotency key**           | Same key → 1 `PaymentRecord` row in DB                 | `count() == 1` assertion              |
| 🔒 P5 | **Meal Plan response includes all three money fields** | `current_balance`, `required`, `shortfall` all present | Field presence + arithmetic assertion |

---

## TDP-M3-04 · FR25 — System Load-Shedding (HTTP 503)

### Step 1 · The Failing Test

```python
class TestLoadShedding:

    def test_503_returned_when_concurrent_orders_at_limit(self, db_session):
        """BOUNDARY: At exactly max_concurrent_orders, new request returns 503."""
        set_system_config("max_concurrent_orders", 150, db=db_session)
        seed_active_orders(count=150, db=db_session)

        result = place_order(user="user-new", cart_id="cart-xyz", db=db_session)

        assert result.http_status == 503
        assert int(result.headers["Retry-After"]) == 30
        assert result.message == "Service temporarily busy. Please try again shortly."

    def test_order_accepted_when_one_below_limit(self, db_session):
        """BOUNDARY: At max-1 concurrent orders, new order must be accepted."""
        set_system_config("max_concurrent_orders", 150, db=db_session)
        seed_active_orders(count=149, db=db_session)

        result = place_order(user="user-new", cart_id="cart-xyz", db=db_session)
        assert result.http_status in (200, 201)
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                             | Boundary                                                | Enforcement                 |
| ----- | --------------------------------------------------- | ------------------------------------------------------- | --------------------------- |
| 🔒 P1 | **Threshold is configurable and respected exactly** | 150 active → 503; 149 active → 200                      | Both boundary values tested |
| 🔒 P2 | **`Retry-After` header is required**                | Must be present and set to `30`                         | Header value assertion      |
| 🔒 P3 | **Message is exact, no stack trace**                | `"Service temporarily busy. Please try again shortly."` | String equality             |

---

---

# Member 4 — Stock & Resilience

## TDP-M4-01 · FR37–FR38 — User Cancellation Window (2 Minutes)

### Step 1 · The Failing Test

```python
class TestCancellationWindow:

    def test_cancellation_allowed_at_119_seconds(self, db_session):
        """BOUNDARY: Cancel at t+119s must succeed."""
        order = place_order_at(time=NOW, db=db_session)

        with freeze_time(NOW + timedelta(seconds=119)):
            result = cancel_order(order.id, user_role="student", db=db_session)

        assert result.http_status == 200
        assert result.status == "CANCELLED"

    def test_cancellation_rejected_at_120_seconds(self, db_session):
        """BOUNDARY: Cancel at exactly t+120s must fail."""
        order = place_order_at(time=NOW, db=db_session)

        with freeze_time(NOW + timedelta(seconds=120)):
            result = cancel_order(order.id, user_role="student", db=db_session)

        assert result.http_status == 403
        assert result.error == "CANCELLATION_WINDOW_EXPIRED"
        assert result.message == "Cancellation window has expired. Please contact staff."

    def test_cancellation_rejected_when_order_is_preparing(self, db_session):
        """PADLOCK: PREPARING status blocks user cancellation regardless of time."""
        order = create_order_in_status("PREPARING", db=db_session)

        result = cancel_order(order.id, user_role="student", db=db_session)

        assert result.http_status == 403
        assert result.error == "CANCELLATION_NOT_PERMITTED_IN_STATUS"

    def test_staff_can_cancel_preparing_order_with_reason(self, db_session):
        """PADLOCK: Staff override works for PREPARING; reason_code is mandatory."""
        order = create_order_in_status("PREPARING", db=db_session)

        result = cancel_order(
            order.id, user_role="staff",
            reason_code="OUT_OF_STOCK", db=db_session
        )
        assert result.http_status == 200
        assert result.status == "CANCELLED"
        assert result.reason_code == "OUT_OF_STOCK"

    def test_staff_cancel_without_reason_code_rejected(self, db_session):
        """PADLOCK: reason_code is mandatory for staff/admin cancellations."""
        order = create_order_in_status("PREPARING", db=db_session)

        result = cancel_order(order.id, user_role="staff", reason_code=None, db=db_session)
        assert result.http_status == 422
        assert result.error == "REASON_CODE_REQUIRED"
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                           | Boundary                                          | Enforcement                                 |
| ----- | ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| 🔒 P1 | **Window boundary is exactly 120 seconds**        | 119s → allowed; 120s → rejected                   | `freeze_time` at both values                |
| 🔒 P2 | **Status also blocks cancellation independently** | PREPARING blocks user regardless of elapsed time  | Status-based test without time manipulation |
| 🔒 P3 | **Staff cancellation requires reason_code**       | `reason_code=None` → HTTP 422                     | Null reason test                            |
| 🔒 P4 | **Error messages are status-specific**            | Window expiry ≠ status block → different messages | String equality per case                    |

### Step 3 · Iteration Prompt

```
Implement cancel_order(order_id, user_role, reason_code, db).

CONSTRAINTS (Padlocks):
- For student role: check BOTH conditions independently:
  (1) order.placed_at + 120 seconds > now  → if false, return 403 CANCELLATION_WINDOW_EXPIRED
  (2) order.status not in [PREPARING, READY, COLLECTED] → if false, return 403
      CANCELLATION_NOT_PERMITTED_IN_STATUS
  If either check fails, return 403. Do not combine them into one message.
- For staff/admin role: status COMPLETED and CANCELLED are the only blocked statuses.
  All others are cancellable WITH a reason_code. reason_code=None → HTTP 422.
- Valid reason_codes: CUSTOMER_REQUEST, OUT_OF_STOCK, STAFF_ERROR, SYSTEM_ERROR,
  SUSPICIOUS_ORDER. Any other value → HTTP 422 INVALID_REASON_CODE.
- Write to audit_log before returning any response. No silent cancellations.
```

---

## TDP-M4-02 · FR40 — Auto-Cancel Abandoned Checkout (10-Minute TTL)

### Step 1 · The Failing Test

```python
class TestAbandonedCheckoutAutoCancellation:

    def test_auto_cancelled_at_exactly_10_minutes(self, db_session):
        """BOUNDARY: PAYMENT_PENDING order auto-cancelled at t+600s."""
        order = create_order_in_status("PAYMENT_PENDING", created_at=NOW, db=db_session)

        with freeze_time(NOW + timedelta(seconds=599)):
            run_cleanup_job(db=db_session)
            assert get_order_status(order.id, db=db_session) == "PAYMENT_PENDING"

        with freeze_time(NOW + timedelta(seconds=600)):
            run_cleanup_job(db=db_session)
            assert get_order_status(order.id, db=db_session) == "CANCELLED"

    def test_stock_locks_released_on_auto_cancel(self, db_session):
        """PADLOCK: Auto-cancellation must release ALL stock locks atomically."""
        set_stock("koshary", quantity=5, db=db_session)
        order = create_order_in_status(
            "PAYMENT_PENDING", items=[("koshary", 2)], db=db_session
        )

        with freeze_time(NOW + timedelta(seconds=600)):
            run_cleanup_job(db=db_session)

        assert get_available_stock("koshary", db=db_session) == 5

    def test_student_notified_on_auto_cancel(self, db_session, mock_notification):
        """PADLOCK: Student must receive notification — no silent auto-cancellation."""
        order = create_order_in_status(
            "PAYMENT_PENDING", user_id="user-001", db=db_session
        )

        with freeze_time(NOW + timedelta(seconds=600)):
            run_cleanup_job(db=db_session)

        mock_notification.assert_called_once_with(
            user_id="user-001",
            message="Your pending order was automatically cancelled due to payment timeout."
        )
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                              | Boundary                                       | Enforcement                          |
| ----- | ---------------------------------------------------- | ---------------------------------------------- | ------------------------------------ |
| 🔒 P1 | **TTL is exactly 600 seconds**                       | 599s → still PAYMENT_PENDING; 600s → CANCELLED | Cleanup job run at both timestamps   |
| 🔒 P2 | **Stock release is part of auto-cancel transaction** | Cannot cancel without releasing locks          | Stock quantity assertion post-cancel |
| 🔒 P3 | **Notification is mandatory**                        | No silent auto-cancellations                   | Mock notification assertion          |

---

## TDP-M4-03 · FR41 — Stock Inconsistency Post-Confirmation

### Step 1 · The Failing Test

```python
class TestStockInconsistency:

    def test_order_held_when_stock_inconsistency_detected(self, db_session):
        """PADLOCK: Oversell discovered post-confirmation → order HELD, admin notified."""
        order = create_confirmed_order(items=[("koshary", 3)], db=db_session)
        force_stock_inconsistency("koshary", available=1, db=db_session)

        run_stock_consistency_checker(db=db_session)

        order = db_session.query(Order).get(order.id)
        assert order.status == "HELD"

    def test_admin_notified_on_stock_inconsistency(self, db_session, mock_admin_alert):
        """PADLOCK: Admin queue entry created — not just an internal log."""
        order = create_confirmed_order(items=[("koshary", 3)], db=db_session)
        force_stock_inconsistency("koshary", available=1, db=db_session)

        run_stock_consistency_checker(db=db_session)

        mock_admin_alert.assert_called_once()
        alert = mock_admin_alert.call_args[0][0]
        assert alert["order_id"] == order.id
        assert alert["type"] == "STOCK_INCONSISTENCY"
```

---

---

# Member 5 — Lifecycle & Reports

## TDP-M5-01 · FR42–FR43 — Refund Initiation & Wallet Idempotency

### Step 1 · The Failing Test

```python
class TestRefunds:

    def test_wallet_refund_is_atomic_and_immediate(self, db_session):
        """BOUNDARY: Wallet refund credited in same DB transaction as cancellation."""
        set_wallet_balance("user-001", balance=100.00, db=db_session)
        order = create_confirmed_wallet_order(
            user="user-001", total=60.00, db=db_session
        )

        cancel_order(order.id, reason_code="CUSTOMER_REQUEST", db=db_session)

        balance = get_wallet_balance("user-001", db=db_session)
        assert balance == 100.00  # fully restored

    def test_wallet_refund_is_idempotent(self, db_session):
        """PADLOCK: Retrying refund with same refund_reference never double-credits."""
        set_wallet_balance("user-001", balance=100.00, db=db_session)
        order = create_cancelled_order_with_refund_reference(
            user="user-001", total=60.00, refund_ref="REF-001", db=db_session
        )

        process_refund(order.id, refund_reference="REF-001", db=db_session)
        process_refund(order.id, refund_reference="REF-001", db=db_session)  # retry

        balance = get_wallet_balance("user-001", db=db_session)
        assert balance == 160.00  # 100 + 60 once only

    def test_failed_gateway_refund_added_to_manual_queue(self, db_session):
        """PADLOCK: Gateway refund failure must not silently drop — must queue."""
        order = create_cancelled_paid_order("user-001", total=120.00, db=db_session)
        simulate_gateway_refund_failure(order.id, db=db_session)

        queue_item = db_session.query(ManualRefundQueue).filter_by(
            order_id=order.id
        ).first()

        assert queue_item is not None
        assert queue_item.status == "PENDING_MANUAL"
        assert queue_item.amount_egp == 120.00
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                                      | Boundary                                                   | Enforcement                      |
| ----- | ------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------- |
| 🔒 P1 | **Wallet refund is in the same transaction as cancellation** | No window where order is CANCELLED but wallet not credited | Transaction boundary assertion   |
| 🔒 P2 | **Refund idempotency prevents double-credit**                | Same `refund_reference` → credited exactly once            | `count()` and balance assertions |
| 🔒 P3 | **Gateway failure creates queue entry — no silent drop**     | `ManualRefundQueue` row must exist                         | Direct DB query assertion        |

### Step 3 · Iteration Prompt

```
Implement process_refund() and the gateway failure handler.

CONSTRAINTS (Padlocks):
- Wallet refunds must execute inside the same DB transaction as the order status
  update to CANCELLED. If the wallet credit fails, the entire transaction rolls back.
- Idempotency: before crediting, check if a refund record with this refund_reference
  already exists. If yes, return 200 without any DB write.
- On gateway refund API failure (any non-2xx or timeout): do NOT raise to the user.
  Instead, write a row to manual_refund_queue with status=PENDING_MANUAL and
  notify the student with the message:
  "Your refund is delayed due to a technical issue. Our team is processing it manually."
- audit_log must record every refund attempt (success, failure, and duplicate-skip).
```

---

## TDP-M5-02 · FR45 — Partial Refund on Partial Fulfilment

### Step 1 · The Failing Test

```python
class TestPartialRefund:

    def test_partial_refund_amount_matches_unfulfilled_items_only(self, db_session):
        """
        BOUNDARY: If order has 3 items and 1 was not fulfilled,
        refund == price of unfulfilled item only.
        """
        order = create_order_with_items([
            ("koshary",         35.00, "FULFILLED"),
            ("grilled_chicken", 65.00, "NOT_FULFILLED"),
            ("juice",           20.00, "FULFILLED"),
        ], db=db_session)

        result = process_partial_refund(
            order.id,
            unfulfilled_items=["grilled_chicken"],
            db=db_session
        )

        assert result.refund_amount_egp == 65.00
        assert result.refund_amount_egp != 120.00  # not full order
        assert result.refund_amount_egp != 55.00   # not fulfilled items

    def test_partial_refund_requires_staff_authorization(self, db_session):
        """PADLOCK: Only staff or admin may mark items as not fulfilled."""
        order = create_confirmed_order(db=db_session)

        result = process_partial_refund(
            order.id,
            unfulfilled_items=["grilled_chicken"],
            actor_role="student",
            db=db_session
        )

        assert result.http_status == 403
        assert result.error == "INSUFFICIENT_ROLE"
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                         | Boundary                             | Enforcement                      |
| ----- | ----------------------------------------------- | ------------------------------------ | -------------------------------- |
| 🔒 P1 | **Refund is sum of unfulfilled items only**     | Not total order; not fulfilled items | Arithmetic boundary assertions   |
| 🔒 P2 | **Only staff/admin can trigger partial refund** | Student actor → HTTP 403             | Role-based assertion             |
| 🔒 P3 | **Refund is recorded in audit_log**             | Append-only; no edits permitted      | Log entry assertion after refund |

---

## TDP-M5-03 · FR47 — Feedback Submission (Post-COMPLETED Only)

### Step 1 · The Failing Test

```python
class TestFeedback:

    def test_rating_accepted_only_for_completed_order(self, db_session):
        """BOUNDARY: COMPLETED → 200; any other status → 403."""
        completed_order = create_order_in_status("COMPLETED", db=db_session)
        result = submit_rating(completed_order.id, stars=4, db=db_session)
        assert result.http_status == 200

    @pytest.mark.parametrize("status", ["PLACED", "CONFIRMED", "PREPARING", "READY", "CANCELLED"])
    def test_rating_blocked_for_non_completed_statuses(self, status, db_session):
        order = create_order_in_status(status, db=db_session)
        result = submit_rating(order.id, stars=5, db=db_session)
        assert result.http_status == 403
        assert result.message == "Ratings are only available after your order is marked COMPLETED."

    def test_rating_cannot_be_edited_after_submission(self, db_session):
        """PADLOCK: Second submission for same order returns HTTP 409."""
        order = create_order_in_status("COMPLETED", db=db_session)

        submit_rating(order.id, stars=4, db=db_session)
        second = submit_rating(order.id, stars=2, db=db_session)

        assert second.http_status == 409
        assert second.error == "RATING_ALREADY_SUBMITTED"
        # Verify original rating unchanged
        rating = db_session.query(Rating).filter_by(order_id=order.id).first()
        assert rating.stars == 4

    def test_star_rating_must_be_between_1_and_5(self, db_session):
        """PADLOCK: 0 stars and 6 stars are both invalid."""
        order = create_order_in_status("COMPLETED", db=db_session)

        assert submit_rating(order.id, stars=0, db=db_session).http_status == 422
        assert submit_rating(order.id, stars=6, db=db_session).http_status == 422
        assert submit_rating(order.id, stars=1, db=db_session).http_status == 200
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                               | Boundary                                       | Enforcement                      |
| ----- | ------------------------------------- | ---------------------------------------------- | -------------------------------- |
| 🔒 P1 | **Rating allowed for COMPLETED only** | All 5 other statuses → 403                     | Parametrized status test         |
| 🔒 P2 | **No editing after submission**       | Second submit → 409, original rating unchanged | DB query verifies original value |
| 🔒 P3 | **Stars range: 1–5 inclusive**        | 0 and 6 → 422; 1 and 5 → 200                   | Boundary value tests             |

---

---

# Hidden Requirements — TDP Cycles

## TDP-HR-01 · HR-02 — Meal Plan Activation Lag (New Student Day-One)

### Step 1 · The Failing Test

```python
class TestMealPlanActivationLag:

    def test_pending_activation_returns_distinct_error_from_insufficient_balance(self, db_session):
        """
        PADLOCK: 'Plan not activated' and 'balance insufficient' are different error
        states with different messages. The AI must NOT merge them.
        """
        # Not activated — plan exists but activation_status == PENDING
        set_meal_plan_status("user-new", status="PENDING_ACTIVATION", db=db_session)
        result_pending = pay_with_meal_plan(order_total=50.00, user="user-new", db=db_session)
        assert result_pending.error == "MEAL_PLAN_NOT_YET_ACTIVATED"
        assert result_pending.message == (
            "Your Meal Plan is pending activation. "
            "Please contact the student services office."
        )

        # Activated but zero balance
        set_meal_plan_status("user-new", status="ACTIVE", balance=0.00, db=db_session)
        result_zero = pay_with_meal_plan(order_total=50.00, user="user-new", db=db_session)
        assert result_zero.error == "INSUFFICIENT_MEAL_PLAN_BALANCE"
        assert result_zero.error != "MEAL_PLAN_NOT_YET_ACTIVATED"
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                       | Boundary                                                         | Enforcement                 |
| ----- | --------------------------------------------- | ---------------------------------------------------------------- | --------------------------- |
| 🔒 P1 | **Two distinct error codes required**         | `MEAL_PLAN_NOT_YET_ACTIVATED` ≠ `INSUFFICIENT_MEAL_PLAN_BALANCE` | String inequality assertion |
| 🔒 P2 | **PENDING_ACTIVATION checked before balance** | Activation status check is first gate                            | Order of assertions in test |

---

## TDP-HR-04 · HR-04 — Staff Order Assignment Idempotency

### Step 1 · The Failing Test

```python
class TestStaffOrderIdempotency:

    def test_concurrent_staff_transitions_are_idempotent(self, db_session):
        """
        PADLOCK: Two staff members advancing the same order simultaneously
        must result in exactly one successful transition, not two.
        """
        order = create_order_in_status("CONFIRMED", db=db_session)

        results = run_concurrent([
            lambda: advance_order_status(order.id, actor="staff-A",
                                         to_status="PREPARING", db=db_session),
            lambda: advance_order_status(order.id, actor="staff-B",
                                         to_status="PREPARING", db=db_session),
        ])

        successes = [r for r in results if r.http_status == 200]
        conflicts  = [r for r in results if r.http_status == 409]

        assert len(successes) == 1
        assert len(conflicts) == 1
        assert conflicts[0].error == "ORDER_ALREADY_ADVANCED"

        # Order is in PREPARING exactly once
        order = db_session.query(Order).get(order.id)
        assert order.status == "PREPARING"
        transitions = db_session.query(OrderTransitionLog).filter_by(order_id=order.id).count()
        assert transitions == 1
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                               | Boundary                                                     | Enforcement                         |
| ----- | ----------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------- |
| 🔒 P1 | **Exactly 1 successful transition under concurrency** | DB-level optimistic/pessimistic lock prevents double-advance | `run_concurrent` + count assertions |
| 🔒 P2 | **Exactly 1 row in `OrderTransitionLog`**             | No duplicate log entries for same transition                 | `count() == 1` assertion            |
| 🔒 P3 | **HTTP 409 for the loser**                            | `ORDER_ALREADY_ADVANCED` error code                          | Error code string assertion         |

---

## TDP-HR-07 · HR-07 — Cross-Device Cart Invalidation

### Step 1 · The Failing Test

```python
class TestCrossDeviceCart:

    def test_stale_cart_invalidated_when_same_user_checks_out_on_second_device(self, db_session):
        """
        PADLOCK: If user locks cart on Device A and then tries to checkout
        the same cart on Device B (where it still appears editable), Device B
        must receive a CART_INVALIDATED error — not a silent stale checkout.
        """
        cart = create_cart(user_id="user-001", db=db_session)

        # Device A locks and proceeds to checkout
        lock_cart_for_checkout(cart.id, session_id="session-device-A", db=db_session)

        # Device B still has the old session and tries to checkout the same cart
        result = lock_cart_for_checkout(cart.id, session_id="session-device-B", db=db_session)

        assert result.http_status == 409
        assert result.error == "CART_INVALIDATED"
        assert result.message == (
            "Your cart was modified on another device. "
            "Please refresh to see the latest state."
        )
```

### Step 2 · The Edge Case Cage (Padlocks)

| #     | Padlock                                                 | Boundary                                     | Enforcement                 |
| ----- | ------------------------------------------------------- | -------------------------------------------- | --------------------------- |
| 🔒 P1 | **Cart locked by session A blocks session B**           | Second lock attempt → HTTP 409               | Session-specific lock check |
| 🔒 P2 | **Error code is `CART_INVALIDATED`, not `CART_LOCKED`** | Cross-device scenario has its own error code | String equality assertion   |

---
