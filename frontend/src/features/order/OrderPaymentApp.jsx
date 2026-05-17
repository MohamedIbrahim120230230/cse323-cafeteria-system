// ============================================================
// OrderPaymentApp.jsx  —  CSE323 Cafeteria System
// Member 3: Order & Payment  (FR8–FR17, FR24, FR26–FR31)
//
// Integration contracts respected:
//  • Auth   (Member 1): JWT from localStorage["jwt_token"],
//                       apiFetch base = /api/v1, Bearer header
//  • Menu   (Member 2): fields stock_qty / max_order_qty / active,
//                       endpoint GET /api/v1/menu/items
//  • Admin  (Member 2): same field names, /api/v1/admin/menu
//  • Order  (Member 3): POST /api/v1/orders, /api/v1/payments/*
// ============================================================

import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "./shared/api";

// ─────────────────────────────────────────────────────────────
// FIELD NORMALISER
// Member 2 uses stock_qty / max_order_qty / active
// Member 3 backend uses stock_count / available_stock / is_available
// This normaliser maps both shapes to one internal shape.
// ─────────────────────────────────────────────────────────────
function normaliseItem(item) {
  return {
    ...item,
    // stock: prefer available_stock (backend lock-aware), fall back to stock_qty
    available_stock: item.available_stock ?? item.stock_qty ?? 0,
    stock_qty:       item.stock_qty       ?? item.stock_count ?? 0,
    // availability flag
    is_available:    item.is_available    ?? item.active      ?? true,
    // per-item quantity cap
    max_order_qty:   item.max_order_qty   ?? 20,
    // emoji / image
    image_url:       item.image_url       ?? "🍽️",
  };
}

// ─────────────────────────────────────────────────────────────
// MOCK DATA  (used only when backend is unreachable)
// ─────────────────────────────────────────────────────────────
const MOCK_MENU = [
  { id:"m1", name:"Classic Cheeseburger", price:120, category:"meals",     image_url:"🍔", active:true,  stock_qty:50,  max_order_qty:10 },
  { id:"m2", name:"Club Sandwich",        price:85,  category:"meals",     image_url:"🥪", active:true,  stock_qty:30,  max_order_qty:10 },
  { id:"m3", name:"Grilled Chicken Wrap", price:95,  category:"meals",     image_url:"🌯", active:true,  stock_qty:35,  max_order_qty:10 },
  { id:"m4", name:"Caesar Salad",         price:70,  category:"snacks",    image_url:"🥗", active:true,  stock_qty:40,  max_order_qty:10 },
  { id:"m5", name:"Iced Latte",           price:60,  category:"beverages", image_url:"☕", active:true,  stock_qty:100, max_order_qty:5  },
  { id:"m6", name:"Fresh Orange Juice",   price:45,  category:"beverages", image_url:"🍊", active:true,  stock_qty:80,  max_order_qty:5  },
  { id:"m7", name:"Water Bottle",         price:15,  category:"beverages", image_url:"💧", active:true,  stock_qty:200, max_order_qty:10 },
  { id:"m8", name:"Fish Sandwich",        price:90,  category:"meals",     image_url:"🐟", active:false, stock_qty:0,   max_order_qty:10 },
].map(normaliseItem);

const MOCK_VOUCHERS = {
  SAVE20:   { code:"SAVE20",   discount_type:"flat",          discount_value:20,  min_order:50  },
  HALF50:   { code:"HALF50",   discount_type:"percent",       discount_value:50,  min_order:100 },
  FREESHIP: { code:"FREESHIP", discount_type:"free_delivery", discount_value:0,   min_order:0   },
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function computeDiscount(v, sub) {
  if (!v) return 0;
  if (v.discount_type === "flat")    return Math.min(v.discount_value, sub);
  if (v.discount_type === "percent") return Math.round(sub * v.discount_value / 100 * 100) / 100;
  return 0;
}

function fmtTime(s) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const STEPS = ["cart", "checkout", "payment", "tracking"];

const STATUS_LABELS = {
  pending_payment:  "Pending Payment",
  confirmed:        "Confirmed",
  preparing:        "Preparing",
  ready_for_pickup: "Ready for Pickup",
  delivered:        "Delivered",
  cancelled:        "Cancelled",
  payment_timeout:  "Payment Timeout",
};

const STATUS_COLORS = {
  pending_payment:  "warning",
  confirmed:        "info",
  preparing:        "primary",
  ready_for_pickup: "success",
  delivered:        "success",
  cancelled:        "danger",
  payment_timeout:  "secondary",
};

const PAY_TIMEOUT_SECS = 600;   // FR24 — 10 min
const CANCEL_WINDOW_MS = 15 * 60 * 1000; // FR26 — 15 min

// ─────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────
export default function OrderPaymentApp() {
  // ── Who is logged in? Read from JWT payload set by Member 1 ──
  const currentUser = (() => {
    try {
      const token = localStorage.getItem("jwt_token");
      if (!token) return { id: "guest", name: "Guest", role: "student" };
      const payload = JSON.parse(atob(token.split(".")[1]));
      return { id: payload.sub || payload.user_id || "user", name: payload.name || payload.email || "Student", role: payload.role || "student" };
    } catch {
      return { id: "guest", name: "Guest", role: "student" };
    }
  })();

  // ── State ─────────────────────────────────────────────────
  const [step,           setStep]          = useState("cart");
  const [menu,           setMenu]          = useState([]);
  const [menuLoading,    setMenuLoading]   = useState(true);
  const [menuError,      setMenuError]     = useState(null);
  const [cart,           setCart]          = useState([]);
  const [search,         setSearch]        = useState("");
  const [category,       setCategory]      = useState("");   // "" = All, matches Member 2 convention
  const [voucherCode,    setVoucherCode]   = useState("");
  const [appliedVoucher, setApplied]       = useState(null);
  const [voucherApplied, setVoucherApplied]= useState(false); // FR15 — no stacking
  const [voucherMsg,     setVoucherMsg]    = useState(null);
  const [order,          setOrder]         = useState(null);
  const [payMethod,      setPayMethod]     = useState("online");
  const [payState,       setPayState]      = useState("idle");
  const [paymentId,      setPaymentId]     = useState(null);
  const [payError,       setPayError]      = useState(null);
  const [cancelModal,    setCancelModal]   = useState(false);
  const [partialModal,   setPartialModal]  = useState(false);
  const [toast,          setToast]         = useState(null);
  const [timeLeft,       setTimeLeft]      = useState(null);
  const [loading,        setLoading]       = useState(false);
  const timerRef = useRef(null);

  // ── Toast helper ──────────────────────────────────────────
  const showToast = useCallback((msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Load menu from backend (Member 2 contract) ────────────
  // GET /api/v1/menu/items?category=...&search=...
  useEffect(() => {
    setMenuLoading(true);
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (search)   params.set("search",   search);
    const qs = params.toString() ? `?${params.toString()}` : "";
    apiFetch(`/menu${qs}`)
      .then(data => {
        // Member 2 wraps in { items: [], total: X }
        const raw = Array.isArray(data) ? data : (data?.items ?? []);
        setMenu(raw.map(normaliseItem));
        setMenuError(null);
      })
      .catch(() => {
        // Graceful fallback — filter mock data locally
        const filtered = MOCK_MENU.filter(item => {
          const matchCat = !category || item.category === category;
          const matchQ   = !search   || item.name.toLowerCase().includes(search.toLowerCase());
          return matchCat && matchQ;
        });
        setMenu(filtered);
        setMenuError("Backend offline — showing demo data");
      })
      .finally(() => setMenuLoading(false));
  }, [category, search]);

  // ── Cart derived values ───────────────────────────────────
  const subtotal  = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const discount  = appliedVoucher ? computeDiscount(appliedVoucher, subtotal) : 0;
  const total     = Math.max(0, subtotal - discount);
  const cartCount = cart.reduce((s, c) => s + c.qty, 0);

  const categories = ["", "meals", "beverages", "snacks"]; // matches Member 2

  // ── Cart operations ───────────────────────────────────────
  const addToCart = (item) => {
    if (!item.is_available || item.available_stock < 1) return;
    setCart(prev => {
      const ex = prev.find(c => c.id === item.id);
      if (ex) {
        if (ex.qty + 1 > item.max_order_qty) {
          showToast(`Maximum ${item.max_order_qty} units for ${item.name}`, "warning");
          return prev;
        }
        return prev.map(c => c.id === item.id ? { ...c, qty: c.qty + 1 } : c);
      }
      return [...prev, { ...item, qty: 1 }];
    });
    showToast(`${item.name} added to cart`);
  };

  const updateQty = (id, delta) => {
    setCart(prev => prev.map(c => {
      if (c.id !== id) return c;
      const q = c.qty + delta;
      if (q < 1) return null;
      if (q > c.max_order_qty) { showToast(`Max ${c.max_order_qty} units`, "warning"); return c; }
      return { ...c, qty: q };
    }).filter(Boolean));
  };

  const removeItem = (id) => setCart(prev => prev.filter(c => c.id !== id));

  // ── Voucher (FR13, FR15) ──────────────────────────────────
  const applyVoucher = async () => {
    const code = voucherCode.trim().toUpperCase();
    if (!code) return;

    // FR15 — Prevent stacking (mirrors Member 2 MenuPage logic)
    if (voucherApplied) {
      setVoucherMsg({ type: "danger", msg: "A voucher has already been applied. Stacking is not allowed." });
      return;
    }

    try {
      // POST /api/cart/<userId>/voucher  (Flask backend)
      const data = await apiFetch(`/cart/${currentUser.id}/voucher`, {
        method: "POST",
        body:   JSON.stringify({ code }),
      });
      const v = data.voucher || { code, discount_type: "flat", discount_value: data.discount, min_order: 0 };
      setApplied(v);
      setVoucherApplied(true);
      setVoucherMsg({ type: "success", msg: `Voucher applied! You save ${data.discount} EGP` });
    } catch {
      // Fallback — mock vouchers for demo
      const v = MOCK_VOUCHERS[code];
      if (!v) { setVoucherMsg({ type: "danger", msg: "Invalid voucher code" }); return; }
      if (subtotal < v.min_order) { setVoucherMsg({ type: "danger", msg: `Minimum order of ${v.min_order} EGP required` }); return; }
      setApplied(v);
      setVoucherApplied(true);
      setVoucherMsg({ type: "success", msg: `Voucher applied! You save ${computeDiscount(v, subtotal)} EGP` });
    }
  };

  const removeVoucher = () => {
    setApplied(null);
    setVoucherApplied(false);
    setVoucherCode("");
    setVoucherMsg(null);
  };

  // ── Place Order (FR8, FR9, FR29, FR30, FR31) ─────────────
  const placeOrder = async () => {
    const bad = cart.filter(c => !c.is_available);
    if (bad.length) { showToast(`Unavailable: ${bad.map(i => i.name).join(", ")}`, "danger"); return; }
    setLoading(true);
    try {
      const idempotency_key = `IDP-${currentUser.id}-${Date.now()}`;
      const data = await apiFetch("/orders", {
        method: "POST",
        body:   JSON.stringify({
          user_id:         currentUser.id,
          idempotency_key,
          voucher_code:    appliedVoucher?.code || null,
          notes:           "",
          items:           cart.map(c => ({ menu_item_id: c.id, quantity: c.qty })),
        }),
      });
      // Enrich with local cart data for display (backend may not echo full items)
      const enriched = {
        ...data.order,
        items:        cart.map(c => ({ ...c, unit_price: c.price, subtotal: c.price * c.qty })),
        subtotal,
        discount,
        total,
        voucher_code: appliedVoucher?.code || null,
      };
      setOrder(enriched);
      setStep("checkout");
    } catch (e) {
      const msg = e?.message || e?.error || "Failed to place order";
      if (msg.includes("SYSTEM_OVERLOADED")) {
        showToast("We are experiencing high demand. Please try again shortly.", "warning");
      } else {
        showToast(msg, "danger");
      }
    } finally {
      setLoading(false);
    }
  };

  // ── Start Payment (FR10, FR24) ────────────────────────────
  const startPayment = async () => {
    setPayState("processing");
    setTimeLeft(PAY_TIMEOUT_SECS);
    setStep("payment");
    setPayError(null);
    setLoading(true);
    try {
      const data = await apiFetch("/payments/process", {
        method: "POST",
        body:   JSON.stringify({ order_id: order.id, payment_method: payMethod }),
      });
      setPaymentId(data.payment_id || data.payment?.id || null);
      // Cash / Wallet / Meal Plan confirm immediately
      if (payMethod !== "online") {
        setPayState("success");
        setOrder(o => o ? { ...o, status: "confirmed", confirmed_at: new Date().toISOString() } : o);
      }
    } catch (e) {
      setPayState("failed");
      setPayError(e?.message || "Payment initiation failed");
    } finally {
      setLoading(false);
    }
  };

  // ── FR24 – Countdown timer ────────────────────────────────
  useEffect(() => {
    if (step !== "payment" || payState !== "processing" || payMethod !== "online") return;
    timerRef.current = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) {
          clearInterval(timerRef.current);
          setPayState("timeout");
          setOrder(o => o ? { ...o, status: "payment_timeout" } : o);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [step, payState, payMethod]);

  // ── Confirm payment (gateway Pay button) ─────────────────
  const confirmOrder = async () => {
    clearInterval(timerRef.current);
    setLoading(true);
    try {
      if (paymentId) {
        await apiFetch(`/payments/${paymentId}/callback`, {
          method: "POST",
          body:   JSON.stringify({ success: true, transaction_id: `TXN-${Date.now()}` }),
        });
      }
      setPayState("success");
      setOrder(o => o ? { ...o, status: "confirmed", confirmed_at: new Date().toISOString() } : o);
    } catch (e) {
      setPayState("failed");
      setPayError(e?.message || "Payment confirmation failed");
    } finally {
      setLoading(false);
    }
  };

  // ── FR12 – Simulate gateway failure ──────────────────────
  const simulateFailure = async (reason) => {
    clearInterval(timerRef.current);
    if (paymentId) {
      try {
        await apiFetch(`/payments/${paymentId}/callback`, {
          method: "POST",
          body:   JSON.stringify({ success: false, failure_reason: reason }),
        });
      } catch {}
    }
    setPayState("failed");
    setPayError({
      insufficient_funds: "Payment declined: Insufficient funds",
      card_expired:       "Payment declined: Card expired",
      gateway_error:      "Payment service unavailable. Please try again",
    }[reason] || "Payment declined");
  };

  // ── FR12 – Retry payment ──────────────────────────────────
  const retryPayment = async () => {
    setLoading(true);
    try {
      if (paymentId) {
        const d = await apiFetch(`/payments/${paymentId}/retry`, { method: "POST" });
        setPaymentId(d.payment_id);
      }
      setPayState("processing");
      setPayError(null);
      setTimeLeft(PAY_TIMEOUT_SECS);
      if (payMethod !== "online") setTimeout(() => confirmOrder(), 800);
    } catch (e) {
      if (e?.message === "MAX_RETRIES_EXCEEDED") {
        showToast("Maximum retry attempts reached. Please contact support.", "danger");
        setPayState("failed");
        setPayError("Maximum retry attempts reached.");
      } else {
        showToast(e?.message || "Retry failed", "danger");
      }
    } finally {
      setLoading(false);
    }
  };

  // ── FR14, FR26 – Cancel order ─────────────────────────────
  const handleCancel = async () => {
    setLoading(true);
    try {
      const data = await apiFetch(`/orders/${order.id}/cancel`, { method: "PUT" });
      if (data.success) {
        setOrder(o => ({ ...o, status: "cancelled", cancelled_at: new Date().toISOString() }));
        setCancelModal(false);
        showToast("Order cancelled successfully");
        setTimeout(() => { setStep("cart"); setCart([]); setOrder(null); setPayState("idle"); }, 1500);
      } else if (data.code === "CANCELLATION_WINDOW_PASSED") {
        setCancelModal(false);
        setPartialModal(true);
      } else {
        showToast(data.message || "Cannot cancel at this stage", "danger");
        setCancelModal(false);
      }
    } catch (e) {
      // Fallback to local logic if backend unreachable
      const status = order?.status;
      if (status === "pending_payment") {
        setOrder(o => ({ ...o, status: "cancelled" }));
        setCancelModal(false);
        showToast("Order cancelled");
        setTimeout(() => { setStep("cart"); setCart([]); setOrder(null); setPayState("idle"); }, 1500);
      } else if (status === "confirmed") {
        const confirmedAt = new Date(order.confirmed_at);
        const windowEnd   = new Date(confirmedAt.getTime() + CANCEL_WINDOW_MS);
        if (new Date() <= windowEnd) {
          setOrder(o => ({ ...o, status: "cancelled" }));
          setCancelModal(false);
          showToast("Order cancelled. Refund initiated.");
          setTimeout(() => { setStep("cart"); setCart([]); setOrder(null); setPayState("idle"); }, 1500);
        } else {
          setCancelModal(false);
          setPartialModal(true);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  // ── FR26 – Confirm partial refund ─────────────────────────
  const confirmPartialRefund = async () => {
    setLoading(true);
    try {
      await apiFetch(`/orders/${order.id}/cancel/confirm-partial`, { method: "PUT" });
    } catch {}
    const amt = ((order?.total || 0) * 0.5).toFixed(2);
    setOrder(o => ({ ...o, status: "cancelled" }));
    setPartialModal(false);
    showToast(`50% refund (${amt} EGP) initiated.`, "info");
    setTimeout(() => { setStep("cart"); setCart([]); setOrder(null); setPayState("idle"); }, 2000);
    setLoading(false);
  };

  // ── FR16 – Staff status update ────────────────────────────
  const simulateStatusUpdate = async (newStatus) => {
    try {
      await apiFetch(`/orders/${order.id}/status`, {
        method: "PUT",
        body:   JSON.stringify({ status: newStatus }),
      });
    } catch {}
    setOrder(o => o ? { ...o, status: newStatus } : o);
    showToast(`Status → ${STATUS_LABELS[newStatus]}`);
  };

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", background: "#f0f4f8", minHeight: "100vh" }}>

      {/* ── Styles ── */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=Space+Grotesk:wght@600;700&display=swap');
        :root {
          --brand:#1a56db; --brand-dk:#1347c5; --success:#0ea770;
          --danger:#e53e3e; --warning:#d97706; --muted:#6b7280; --border:#e2e8f0;
        }
        .step-indicator { display:flex; align-items:center; }
        .step-dot { width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:600; }
        .step-line { flex:1; height:3px; background:var(--border); }
        .step-line.done { background:var(--brand); }
        .menu-card { transition:transform .15s,box-shadow .15s; }
        .menu-card:hover { transform:translateY(-3px); box-shadow:0 8px 24px rgba(26,86,219,.12)!important; }
        .cart-item { border-left:3px solid var(--brand); }
        .qty-btn { width:30px; height:30px; border-radius:50%; border:1.5px solid var(--border); background:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:16px; transition:all .12s; }
        .qty-btn:hover { background:var(--brand); color:#fff; border-color:var(--brand); }
        .pay-method { border:2px solid var(--border); border-radius:12px; padding:14px 18px; cursor:pointer; transition:all .15s; }
        .pay-method.selected { border-color:var(--brand); background:#eff4ff; }
        .pay-method:hover:not(.selected) { border-color:#93c5fd; }
        .section-title { font-family:'Space Grotesk',sans-serif; font-size:22px; font-weight:700; color:#1e293b; }
        .brand-text { font-family:'Space Grotesk',sans-serif; font-weight:700; }
        .badge-status { padding:5px 12px; border-radius:20px; font-size:12px; font-weight:600; }
        .toast-container { position:fixed; top:20px; right:20px; z-index:9999; min-width:280px; }
        .timer-ring { font-variant-numeric:tabular-nums; font-family:'Space Grotesk',sans-serif; }
        .offline-banner { background:#fef3c7; border:1.5px solid #fde68a; border-radius:10px; padding:10px 14px; font-size:12px; color:#92400e; margin-bottom:12px; }
      `}</style>

      {/* ── Toast ── */}
      {toast && (
        <div className="toast-container">
          <div className={`toast show align-items-center border-0 text-bg-${
            toast.type === "success" ? "success" :
            toast.type === "danger"  ? "danger"  :
            toast.type === "info"    ? "primary"  : "warning"}`}>
            <div className="d-flex">
              <div className="toast-body">{toast.msg}</div>
              <button className="btn-close btn-close-white me-2 m-auto" onClick={() => setToast(null)} />
            </div>
          </div>
        </div>
      )}

      {/* ── Navbar ── */}
      <nav style={{ background: "var(--brand)", padding: "14px 0", boxShadow: "0 2px 12px rgba(26,86,219,.3)" }}>
        <div className="container d-flex justify-content-between align-items-center">
          <span className="brand-text text-white" style={{ fontSize: 20 }}>🍽️ CampusBite</span>
          <div className="d-flex align-items-center gap-3">
            <span className="text-white opacity-75" style={{ fontSize: 13 }}>
              {currentUser.name}
              {currentUser.role !== "student" && (
                <span className="badge bg-warning text-dark ms-2" style={{ fontSize: 10 }}>
                  {currentUser.role.toUpperCase()}
                </span>
              )}
            </span>
            <button className="btn btn-light btn-sm position-relative" onClick={() => setStep("cart")}>
              🛒 Cart
              {cartCount > 0 && (
                <span className="position-absolute top-0 start-100 translate-middle badge rounded-pill bg-danger" style={{ fontSize: 10 }}>
                  {cartCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </nav>

      {/* ── Step bar ── */}
      <div style={{ background: "#fff", borderBottom: "1px solid var(--border)", padding: "14px 0" }}>
        <div className="container" style={{ maxWidth: 600 }}>
          <div className="step-indicator">
            {STEPS.map((s, i) => {
              const idx = STEPS.indexOf(step), done = i < idx, active = i === idx;
              return (
                <div key={s} style={{ display: "contents" }}>
                  <div className="d-flex flex-column align-items-center gap-1">
                    <div className="step-dot" style={{
                      background: done || active ? "var(--brand)" : "#e2e8f0",
                      color:      done || active ? "#fff" : "#94a3b8",
                    }}>
                      {done ? "✓" : i + 1}
                    </div>
                    <span style={{ fontSize: 11, color: active ? "var(--brand)" : "#94a3b8", fontWeight: active ? 600 : 400 }}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </span>
                  </div>
                  {i < STEPS.length - 1 && <div className={`step-line${i < idx ? " done" : ""}`} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="container py-4" style={{ maxWidth: 1100 }}>

        {/* ══════════════ CART / MENU ══════════════ */}
        {step === "cart" && (
          <div className="row g-4">

            {/* Menu panel */}
            <div className="col-lg-7">
              <div className="section-title mb-3">🍽️ Cafeteria Menu</div>

              {menuError && (
                <div className="offline-banner">⚠️ {menuError}</div>
              )}

              {/* Search — FR09/FR10 matching Member 2 */}
              <div className="input-group mb-3">
                <input
                  className="form-control"
                  placeholder="Search menu..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && setSearch(e.target.value)}
                  style={{ fontSize: 14 }}
                />
                <button className="btn btn-primary" onClick={() => setSearch(search)}>Search</button>
              </div>

              {/* Category filter — same labels as Member 2 */}
              <div className="mb-4 d-flex gap-2 flex-wrap">
                {categories.map(cat => (
                  <button
                    key={cat}
                    className={`btn ${category === cat ? "btn-dark" : "btn-outline-dark"} btn-sm`}
                    onClick={() => setCategory(cat)}
                  >
                    {cat === "" ? "All" : cat.charAt(0).toUpperCase() + cat.slice(1)}
                  </button>
                ))}
              </div>

              {menuLoading
                ? <div className="text-center py-5"><div className="spinner-border text-primary" /></div>
                : (
                  <div className="row g-3">
                    {menu.length === 0 && (
                      <div className="col-12 text-center text-muted py-4">No items found.</div>
                    )}
                    {menu.map(item => {
                      const inCart = cart.find(c => c.id === item.id);
                      return (
                        <div key={item.id} className="col-sm-6">
                          <div
                            className={`card menu-card h-100 border-0 shadow-sm ${!item.is_available ? "opacity-50" : ""}`}
                            style={{ borderRadius: 14 }}
                          >
                            <div className="card-body p-3">
                              <div className="d-flex justify-content-between align-items-start mb-2">
                                <span style={{ fontSize: 36 }}>{item.image_url}</span>
                                {item.is_available
                                  ? <span className="badge bg-success" style={{ fontSize: 10 }}>In Stock ({item.available_stock})</span>
                                  : <span className="badge bg-danger"  style={{ fontSize: 10 }}>Out of Stock</span>
                                }
                              </div>
                              <div className="fw-bold mb-1" style={{ fontSize: 15 }}>{item.name}</div>
                              <div className="text-muted" style={{ fontSize: 12, marginBottom: 4 }}>
                                <span className="badge bg-secondary text-capitalize me-1">{item.category}</span>
                                {item.description}
                              </div>
                              <div className="d-flex justify-content-between align-items-center mt-2">
                                <span className="fw-bold" style={{ color: "var(--brand)", fontSize: 16 }}>{item.price} EGP</span>
                                {item.is_available
                                  ? inCart
                                    ? (
                                      <div className="d-flex align-items-center gap-2">
                                        <button className="qty-btn" onClick={() => updateQty(item.id, -1)}>−</button>
                                        <span className="fw-bold">{inCart.qty}</span>
                                        <button className="qty-btn" onClick={() => addToCart(item)}>+</button>
                                      </div>
                                    )
                                    : <button className="btn btn-primary btn-sm" onClick={() => addToCart(item)} style={{ fontSize: 12, borderRadius: 8 }}>Add to Cart</button>
                                  : <span className="text-muted" style={{ fontSize: 12 }}>Unavailable</span>
                                }
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
            </div>

            {/* Cart sidebar */}
            <div className="col-lg-5">
              <div className="card border-0 shadow-sm sticky-top" style={{ borderRadius: 16, top: 20 }}>
                <div className="card-body p-4">
                  <div className="section-title mb-3">🛒 Your Cart</div>

                  {cart.length === 0 ? (
                    <div className="text-center py-4">
                      <div style={{ fontSize: 48 }}>🛒</div>
                      <div className="text-muted mt-2">Your cart is empty.</div>
                    </div>
                  ) : (
                    <>
                      <div className="d-flex flex-column gap-2 mb-3">
                        {cart.map(item => (
                          <div key={item.id} className="cart-item p-3 rounded-3" style={{ background: "#f8fafc" }}>
                            <div className="d-flex justify-content-between align-items-center">
                              <div>
                                <div className="fw-bold" style={{ fontSize: 14 }}>{item.image_url} {item.name}</div>
                                <div className="text-muted" style={{ fontSize: 12 }}>{item.price} EGP × {item.qty}</div>
                              </div>
                              <div className="d-flex align-items-center gap-2">
                                <span className="fw-bold" style={{ color: "var(--brand)", fontSize: 14 }}>{(item.price * item.qty).toFixed(0)} EGP</span>
                                <button className="qty-btn" onClick={() => removeItem(item.id)} style={{ fontSize: 12 }}>✕</button>
                              </div>
                            </div>
                            <div className="d-flex align-items-center gap-2 mt-2">
                              <button className="qty-btn" onClick={() => updateQty(item.id, -1)}>−</button>
                              <span className="fw-bold" style={{ fontSize: 13 }}>{item.qty}</span>
                              <button className="qty-btn" onClick={() => addToCart(item)}>+</button>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Voucher — FR13, FR15 */}
                      <div className="mb-3">
                        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>🏷️ Voucher Code</div>
                        {voucherApplied ? (
                          <div className="d-flex align-items-center justify-content-between p-2 rounded-3"
                            style={{ background: "#f0fdf4", border: "1.5px solid #bbf7d0" }}>
                            <span style={{ fontSize: 13, color: "var(--success)", fontWeight: 600 }}>✓ {appliedVoucher?.code} applied</span>
                            <button className="btn btn-sm btn-outline-danger" style={{ fontSize: 11 }} onClick={removeVoucher}>Remove</button>
                          </div>
                        ) : (
                          <div className="d-flex gap-2">
                            <input
                              className="form-control form-control-sm"
                              placeholder="Enter code"
                              value={voucherCode}
                              onChange={e => setVoucherCode(e.target.value.toUpperCase())}
                              style={{ letterSpacing: 1 }}
                            />
                            <button className="btn btn-outline-primary btn-sm" onClick={applyVoucher}>Apply</button>
                          </div>
                        )}
                        {voucherMsg && (
                          <div className={`mt-2 small text-${voucherMsg.type === "success" ? "success" : "danger"}`}>
                            {voucherMsg.msg}
                          </div>
                        )}
                      </div>

                      {/* Totals */}
                      <div className="border-top pt-3">
                        <div className="d-flex justify-content-between mb-1">
                          <span className="text-muted" style={{ fontSize: 13 }}>Subtotal</span>
                          <span style={{ fontSize: 13 }}>{subtotal.toFixed(2)} EGP</span>
                        </div>
                        {discount > 0 && (
                          <div className="d-flex justify-content-between mb-1">
                            <span style={{ fontSize: 13, color: "var(--success)" }}>Discount</span>
                            <span style={{ fontSize: 13, color: "var(--success)" }}>−{discount.toFixed(2)} EGP</span>
                          </div>
                        )}
                        <div className="d-flex justify-content-between fw-bold border-top pt-2 mt-1" style={{ fontSize: 18 }}>
                          <span>Total</span>
                          <span style={{ color: "var(--brand)" }}>{total.toFixed(2)} EGP</span>
                        </div>
                      </div>

                      <button
                        className="btn btn-success w-100 mt-3 py-2 fw-bold"
                        onClick={placeOrder}
                        disabled={loading || cart.length === 0}
                        style={{ borderRadius: 10, fontSize: 15 }}
                      >
                        {loading && <span className="spinner-border spinner-border-sm me-2" />}
                        Proceed to Checkout
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════ CHECKOUT ══════════════ */}
        {step === "checkout" && order && (
          <div className="row justify-content-center">
            <div className="col-lg-7">
              <div className="card border-0 shadow-sm" style={{ borderRadius: 16 }}>
                <div className="card-body p-4">
                  <div className="section-title mb-4">Order Summary</div>

                  {order.items.map(item => (
                    <div key={item.id || item.menu_item_id} className="d-flex justify-content-between py-2 border-bottom">
                      <div>
                        <span style={{ fontSize: 14, fontWeight: 500 }}>{item.image_url || "🍽️"} {item.name}</span>
                        <span className="text-muted ms-2" style={{ fontSize: 12 }}>×{item.qty || item.quantity}</span>
                      </div>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{Number(item.subtotal || item.price * item.qty).toFixed(0)} EGP</span>
                    </div>
                  ))}

                  <div className="p-3 rounded-3 my-4" style={{ background: "#f8fafc" }}>
                    <div className="d-flex justify-content-between mb-1">
                      <span className="text-muted" style={{ fontSize: 13 }}>Subtotal</span>
                      <span>{Number(order.subtotal).toFixed(2)} EGP</span>
                    </div>
                    {order.discount > 0 && (
                      <div className="d-flex justify-content-between mb-1">
                        <span style={{ fontSize: 13, color: "var(--success)" }}>Voucher ({order.voucher_code})</span>
                        <span style={{ color: "var(--success)" }}>−{Number(order.discount).toFixed(2)} EGP</span>
                      </div>
                    )}
                    <div className="d-flex justify-content-between fw-bold border-top pt-2 mt-1" style={{ fontSize: 17 }}>
                      <span>Total</span>
                      <span style={{ color: "var(--brand)" }}>{Number(order.total).toFixed(2)} EGP</span>
                    </div>
                  </div>

                  {/* Payment method — FR10 */}
                  <div className="section-title mb-3" style={{ fontSize: 17 }}>Select Payment Method</div>
                  <div className="row g-2 mb-4">
                    {[
                      { id: "online",    label: "💳 Online Payment",  desc: "Credit/Debit card via secure gateway" },
                      { id: "cash",      label: "💵 Cash on Delivery", desc: "Pay when you collect your order" },
                      { id: "wallet",    label: "👛 Wallet",           desc: "Deduct from your digital wallet" },
                      { id: "meal_plan", label: "🎓 Meal Plan",        desc: "Use your university meal credits" },
                    ].map(m => (
                      <div key={m.id} className="col-sm-6">
                        <div className={`pay-method ${payMethod === m.id ? "selected" : ""}`} onClick={() => setPayMethod(m.id)}>
                          <div className="fw-bold" style={{ fontSize: 14 }}>{m.label}</div>
                          <div className="text-muted" style={{ fontSize: 11, marginTop: 2 }}>{m.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="d-flex gap-3">
                    <button className="btn btn-outline-secondary flex-fill" onClick={() => setStep("cart")}>← Back</button>
                    <button
                      className="btn btn-primary flex-fill py-2 fw-bold"
                      onClick={startPayment}
                      disabled={loading}
                      style={{ borderRadius: 10 }}
                    >
                      {loading && <span className="spinner-border spinner-border-sm me-2" />}
                      Proceed to Payment →
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════ PAYMENT ══════════════ */}
        {step === "payment" && order && (
          <div className="row justify-content-center">
            <div className="col-lg-6">
              <div className="card border-0 shadow-sm" style={{ borderRadius: 16 }}>
                <div className="card-body p-4 text-center">

                  {/* Online — processing */}
                  {payState === "processing" && payMethod === "online" && (
                    <>
                      <div style={{ fontSize: 56, marginBottom: 12 }}>🔐</div>
                      <div className="section-title mb-2">Secure Payment</div>
                      <div className="text-muted mb-3" style={{ fontSize: 13 }}>
                        Complete your payment of <strong>{Number(order.total).toFixed(2)} EGP</strong>
                      </div>

                      {/* FR24 — countdown */}
                      <div className="p-3 rounded-3 mb-4" style={{ background: "#fef3c7", border: "1.5px solid #fde68a" }}>
                        <div className="timer-ring" style={{ fontSize: 32, fontWeight: 700, color: "#d97706" }}>
                          {fmtTime(timeLeft || 0)}
                        </div>
                        <div style={{ fontSize: 12, color: "#92400e", marginTop: 4 }}>
                          Session expires in {fmtTime(timeLeft || 0)}
                        </div>
                      </div>

                      {/* Card form */}
                      <div className="text-start mb-4">
                        <label className="form-label fw-bold" style={{ fontSize: 13 }}>Card Number</label>
                        <input className="form-control mb-2" placeholder="4111 1111 1111 1111" style={{ fontFamily: "monospace" }} />
                        <div className="row g-2">
                          <div className="col-6">
                            <label className="form-label fw-bold" style={{ fontSize: 13 }}>Expiry</label>
                            <input className="form-control" placeholder="MM/YY" />
                          </div>
                          <div className="col-6">
                            <label className="form-label fw-bold" style={{ fontSize: 13 }}>CVV</label>
                            <input className="form-control" placeholder="•••" />
                          </div>
                        </div>
                      </div>

                      <button
                        className="btn btn-success w-100 py-2 fw-bold mb-3"
                        onClick={confirmOrder}
                        disabled={loading}
                        style={{ borderRadius: 10 }}
                      >
                        {loading && <span className="spinner-border spinner-border-sm me-2" />}
                        Pay {Number(order.total).toFixed(2)} EGP
                      </button>

                      <div className="text-muted mb-2" style={{ fontSize: 12 }}>— Simulate gateway response —</div>
                      <div className="d-flex gap-2 justify-content-center">
                        <button className="btn btn-sm btn-outline-danger" onClick={() => simulateFailure("insufficient_funds")}>Fail: NSF</button>
                        <button className="btn btn-sm btn-outline-danger" onClick={() => simulateFailure("card_expired")}>Fail: Expired</button>
                        <button className="btn btn-sm btn-outline-danger" onClick={() => simulateFailure("gateway_error")}>Fail: Gateway</button>
                      </div>
                    </>
                  )}

                  {/* Non-online processing */}
                  {payState === "processing" && payMethod !== "online" && (
                    <>
                      <div className="spinner-border text-primary mb-3" style={{ width: 48, height: 48 }} />
                      <div className="fw-bold">Processing {payMethod.replace("_", " ")} payment…</div>
                    </>
                  )}

                  {/* FR13 — Success */}
                  {payState === "success" && (
                    <>
                      <div style={{ fontSize: 64 }}>✅</div>
                      <div className="section-title mt-2 mb-1" style={{ color: "var(--success)" }}>Payment Confirmed!</div>
                      <div className="text-muted mb-1" style={{ fontSize: 14 }}>Order ID: <strong>{order.id}</strong></div>
                      <div className="text-muted mb-4" style={{ fontSize: 13 }}>Your order is confirmed and being processed.</div>
                      <button className="btn btn-primary w-100 py-2 fw-bold" onClick={() => setStep("tracking")} style={{ borderRadius: 10 }}>
                        Track My Order →
                      </button>
                    </>
                  )}

                  {/* FR12 — Failed */}
                  {payState === "failed" && (
                    <>
                      <div style={{ fontSize: 64 }}>❌</div>
                      <div className="section-title mt-2 mb-1" style={{ color: "var(--danger)" }}>Payment Failed</div>
                      <div className="p-3 rounded-3 mb-4" style={{ background: "#fef2f2", border: "1.5px solid #fecaca" }}>
                        <div style={{ fontSize: 14, color: "var(--danger)", fontWeight: 500 }}>{payError}</div>
                      </div>
                      <div className="d-flex gap-3">
                        <button className="btn btn-outline-secondary flex-fill" onClick={() => setStep("checkout")}>Change Method</button>
                        <button
                          className="btn btn-primary flex-fill py-2 fw-bold"
                          onClick={retryPayment}
                          disabled={loading}
                          style={{ borderRadius: 10 }}
                        >
                          {loading && <span className="spinner-border spinner-border-sm me-2" />}
                          Retry Payment
                        </button>
                      </div>
                    </>
                  )}

                  {/* FR24 — Timeout */}
                  {payState === "timeout" && (
                    <>
                      <div style={{ fontSize: 64 }}>⏰</div>
                      <div className="section-title mt-2 mb-1" style={{ color: "var(--warning)" }}>Session Expired</div>
                      <div className="text-muted mb-4" style={{ fontSize: 14 }}>
                        Payment session timed out. Your cart has been preserved.
                      </div>
                      <button
                        className="btn btn-warning w-100 py-2 fw-bold"
                        onClick={retryPayment}
                        disabled={loading}
                        style={{ borderRadius: 10 }}
                      >
                        Restart Payment
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════ TRACKING ══════════════ */}
        {step === "tracking" && order && (
          <div className="row justify-content-center">
            <div className="col-lg-8">
              <div className="card border-0 shadow-sm" style={{ borderRadius: 16 }}>
                <div className="card-body p-4">

                  <div className="d-flex justify-content-between align-items-start mb-4">
                    <div>
                      <div className="section-title">📦 Order Tracking</div>
                      <div className="text-muted" style={{ fontSize: 13 }}>Order #{order.id}</div>
                    </div>
                    <span className={`badge-status bg-${STATUS_COLORS[order.status] || "secondary"} text-white`}>
                      {STATUS_LABELS[order.status] || order.status}
                    </span>
                  </div>

                  {/* Progress timeline */}
                  {!["cancelled", "payment_timeout"].includes(order.status) && (
                    <div className="mb-4">
                      {["confirmed", "preparing", "ready_for_pickup", "delivered"].map((s, i) => {
                        const ord  = ["confirmed", "preparing", "ready_for_pickup", "delivered"];
                        const done = i <= ord.indexOf(order.status);
                        return (
                          <div key={s} className="d-flex align-items-center gap-3 mb-3">
                            <div style={{
                              width: 40, height: 40, borderRadius: "50%",
                              background: done ? "var(--brand)" : "#e2e8f0",
                              color:      done ? "#fff" : "#94a3b8",
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 16, flexShrink: 0,
                            }}>
                              {["✅", "👨‍🍳", "🏪", "🎉"][i]}
                            </div>
                            <div>
                              <div className="fw-bold" style={{ fontSize: 14, color: done ? "#1e293b" : "#94a3b8" }}>
                                {STATUS_LABELS[s]}
                              </div>
                              {done && <div className="text-muted" style={{ fontSize: 12 }}>Completed</div>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Cancelled banner */}
                  {order.status === "cancelled" && (
                    <div className="p-3 rounded-3 mb-4 text-center" style={{ background: "#fef2f2", border: "1.5px solid #fecaca" }}>
                      <div style={{ fontSize: 32 }}>🚫</div>
                      <div className="fw-bold mt-1" style={{ color: "var(--danger)" }}>Order Cancelled</div>
                      {["online", "wallet", "meal_plan"].includes(order.payment_method) && (
                        <div className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>
                          Refund will be processed within 3-5 business days
                        </div>
                      )}
                    </div>
                  )}

                  {/* FR16 — Staff status panel (shown to staff/admin roles too) */}
                  {!["cancelled", "delivered", "payment_timeout"].includes(order.status) && (
                    <div className="p-3 rounded-3 mb-4" style={{ background: "#f0f9ff", border: "1.5px solid #bae6fd" }}>
                      <div className="fw-bold mb-2" style={{ fontSize: 13, color: "#0369a1" }}>
                        👨‍💼 Staff Panel — Update Order Status
                      </div>
                      <div className="d-flex gap-2 flex-wrap">
                        {["preparing", "ready_for_pickup", "delivered"].map(s => (
                          <button
                            key={s}
                            className="btn btn-sm btn-outline-primary"
                            style={{ fontSize: 11 }}
                            onClick={() => simulateStatusUpdate(s)}
                          >
                            → {STATUS_LABELS[s]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Order items recap */}
                  <div className="border-top pt-3">
                    <div className="fw-bold mb-2" style={{ fontSize: 14 }}>Items Ordered</div>
                    {order.items.map(item => (
                      <div key={item.id || item.menu_item_id} className="d-flex justify-content-between py-1">
                        <span style={{ fontSize: 13 }}>{item.image_url || "🍽️"} {item.name} ×{item.qty || item.quantity}</span>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{Number(item.subtotal || item.price * item.qty).toFixed(0)} EGP</span>
                      </div>
                    ))}
                    <div className="d-flex justify-content-between border-top mt-2 pt-2 fw-bold">
                      <span>Total Paid</span>
                      <span style={{ color: "var(--brand)" }}>{Number(order.total).toFixed(2)} EGP</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="d-flex gap-3 mt-4">
                    <button
                      className="btn btn-outline-secondary"
                      onClick={() => { setStep("cart"); setCart([]); setOrder(null); setPayState("idle"); }}
                    >
                      New Order
                    </button>
                    {["confirmed", "preparing"].includes(order.status) && (
                      <button className="btn btn-outline-danger" onClick={() => setCancelModal(true)}>
                        Cancel Order
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* ── Cancel Modal (FR14) ── */}
      {cancelModal && (
        <div className="modal d-block" style={{ background: "rgba(0,0,0,.5)" }}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content border-0" style={{ borderRadius: 14 }}>
              <div className="modal-header border-0 pb-0">
                <h5 className="modal-title">Cancel Order?</h5>
                <button className="btn-close" onClick={() => setCancelModal(false)} />
              </div>
              <div className="modal-body">
                <p className="text-muted" style={{ fontSize: 14 }}>
                  Are you sure you want to cancel order <strong>{order?.id}</strong>?
                  {["online", "wallet", "meal_plan"].includes(order?.payment_method) &&
                    " A full refund will be processed within 3-5 business days."}
                </p>
              </div>
              <div className="modal-footer border-0 pt-0">
                <button className="btn btn-outline-secondary" onClick={() => setCancelModal(false)}>Keep Order</button>
                <button className="btn btn-danger" onClick={handleCancel} disabled={loading}>
                  {loading && <span className="spinner-border spinner-border-sm me-1" />} Yes, Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Partial Refund Modal (FR26) ── */}
      {partialModal && (
        <div className="modal d-block" style={{ background: "rgba(0,0,0,.5)" }}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content border-0" style={{ borderRadius: 14 }}>
              <div className="modal-header border-0 pb-0">
                <h5 className="modal-title">⚠️ Cancellation Window Passed</h5>
                <button className="btn-close" onClick={() => setPartialModal(false)} />
              </div>
              <div className="modal-body">
                <div className="p-3 rounded-3" style={{ background: "#fffbeb", border: "1.5px solid #fde68a" }}>
                  <p style={{ fontSize: 14, marginBottom: 8 }}>
                    The 15-minute cancellation window has passed.
                    A <strong>50% partial refund</strong> of{" "}
                    <strong>{((order?.total || 0) * 0.5).toFixed(2)} EGP</strong> may apply.
                  </p>
                  <p className="text-muted mb-0" style={{ fontSize: 13 }}>Do you want to proceed?</p>
                </div>
              </div>
              <div className="modal-footer border-0 pt-0">
                <button className="btn btn-outline-secondary" onClick={() => setPartialModal(false)}>Keep Order</button>
                <button className="btn btn-warning" onClick={confirmPartialRefund} disabled={loading}>
                  {loading && <span className="spinner-border spinner-border-sm me-1" />}
                  Accept Partial Refund
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
