// ============================================================
// frontend/src/features/menu-cart/MenuPage.jsx
// ── FIXES APPLIED ────────────────────────────────────────────
// FIX-1: Staff users now see nav tabs too. The original code
//         only showed tabs when `isAdmin`. Staff also need to
//         navigate to /stock and /lifecycle. Now both admin
//         and staff see the relevant tabs (staff sees Stock +
//         Lifecycle but NOT Admin).
//
// FIX-2: handleLogout now uses shared `apiLogout` helper
//         so the backend token blacklist endpoint is also hit,
//         consistent with all other feature files.
//
// FIX-3: The nav tab for /lifecycle was missing entirely from
//         MenuPage. Added it so admin/staff can reach it.
// ============================================================

import React, { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch, apiLogout } from "../../shared/api";   // FIX-2
import { useNavigate } from "react-router-dom";

// ── Google Fonts & Icons (same as Login) ─────────────────────
if (typeof document !== "undefined") {
  if (!document.querySelector('link[href*="Sora"]')) {
    const f = document.createElement("link");
    f.rel  = "stylesheet";
    f.href = "https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&family=DM+Sans:wght@400;500;600&display=swap";
    document.head.appendChild(f);
  }
  if (!document.querySelector('link[href*="bootstrap-icons"]')) {
    const i = document.createElement("link");
    i.rel  = "stylesheet";
    i.href = "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css";
    document.head.appendChild(i);
  }
}

// ── Category config ───────────────────────────────────────────
const CATEGORIES = [
  { value: "",           label: "All",       icon: "bi-grid-3x3-gap-fill" },
  { value: "meals",      label: "Meals",     icon: "bi-bowl-hot-fill"     },
  { value: "beverages",  label: "Beverages", icon: "bi-cup-hot-fill"      },
  { value: "snacks",     label: "Snacks",    icon: "bi-cookie"            },
];

// ── Voucher error messages ────────────────────────────────────
const VOUCHER_ERRORS = {
  VOUCHER_ALREADY_USED:    "Voucher has already been used by your account.",
  VOUCHER_EXPIRED:         "Voucher has expired.",
  VOUCHER_MIN_ORDER:       "Minimum order of 100 EGP required for this voucher.",
  VOUCHER_REVOKED:         "Voucher is no longer valid.",
  VOUCHER_STACK_REJECTED:  "Only one voucher may be applied per order.",
};

// ── Toast notification ────────────────────────────────────────
function Toast({ toasts, removeToast }) {
  return (
    <div style={{ position:"fixed", bottom:24, right:24, zIndex:9999, display:"flex", flexDirection:"column", gap:8 }}>
      {toasts.map(t => (
        <div key={t.id} className={`uc-toast uc-toast--${t.type}`}>
          <i className={`bi ${t.type === "success" ? "bi-check-circle-fill" : t.type === "warn" ? "bi-exclamation-triangle-fill" : "bi-x-circle-fill"}`} />
          <span>{t.message}</span>
          <button onClick={() => removeToast(t.id)} className="uc-toast-close">
            <i className="bi bi-x" />
          </button>
        </div>
      ))}
    </div>
  );
}

function useToast() {
  const [toasts, setToasts] = useState([]);
  const add = useCallback((message, type = "success") => {
    const id = Date.now();
    setToasts(p => [...p, { id, message, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3500);
  }, []);
  const remove = useCallback(id => setToasts(p => p.filter(t => t.id !== id)), []);
  return { toasts, addToast: add, removeToast: remove };
}

// ════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════
export default function MenuPage() {
  const navigate                  = useNavigate();
  const { toasts, addToast, removeToast } = useToast();

  // FIX-1: read both role flags
  const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
  const isAdmin     = currentUser.role === "admin";
  const isStaff     = currentUser.role === "staff";
  const isPrivileged = isAdmin || isStaff;   // FIX-1: staff also gets nav tabs

  // Menu state
  const [items,     setItems]     = useState([]);
  const [search,    setSearch]    = useState("");
  const [category,  setCategory]  = useState("");
  const [loading,   setLoading]   = useState(true);

  // Cart state
  const [cart,          setCart]          = useState([]);
  const [cartOpen,      setCartOpen]      = useState(false);
  const [cartLocked,    setCartLocked]    = useState(false);
  const [lockWarnings,  setLockWarnings]  = useState([]);

  // Voucher state
  const [voucher,            setVoucher]            = useState("");
  const [voucherApplied,     setVoucherApplied]     = useState(false);
  const [discount,           setDiscount]           = useState(0);
  const [appliedVoucherObj,  setAppliedVoucherObj]  = useState(null);
  const [voucherLoading,     setVoucherLoading]     = useState(false);
  const [voucherError,       setVoucherError]       = useState("");

  // Checkout state
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  const searchRef = useRef(null);

  // ── Fetch menu ──────────────────────────────────────────────
  const fetchMenu = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (category) params.append("category", category);
      if (search.trim()) params.append("search", search.trim());
      const data = await apiFetch(`/menu/items?${params}`);
      setItems(data.items || data || []);
    } catch {
      addToast("Failed to load menu.", "error");
    } finally {
      setLoading(false);
    }
  }, [category, search]); // eslint-disable-line

  useEffect(() => { fetchMenu(); }, [category]);

  // ── Cart helpers ────────────────────────────────────────────
  const guardLocked = () => {
    if (cartLocked) {
      addToast("Cart is locked — checkout in progress.", "warn");
      return true;
    }
    return false;
  };

  const addToCart = async (item) => {
    if (guardLocked()) return;
    if (item.stock_qty === 0) return;

    const existing = cart.find(c => c.id === item.id);
    const newQty   = existing ? existing.qty + 1 : 1;

    if (newQty > item.max_order_qty) {
      addToast(`Max ${item.max_order_qty} per order for "${item.name}".`, "warn");
      return;
    }

    setCart(prev =>
      existing
        ? prev.map(c => c.id === item.id ? { ...c, qty: newQty } : c)
        : [...prev, { ...item, qty: 1 }]
    );

    try {
      await apiFetch("/cart/add", {
        method: "POST",
        body: JSON.stringify({ item_id: item.id, qty: 1 }),
      });
    } catch (err) {
      if (err?.code === "CART_LOCKED") {
        setCartLocked(true);
        addToast("Cart is locked. Please complete or cancel your checkout.", "warn");
      }
    }
  };

  const removeFromCart = (id) => {
    if (guardLocked()) return;
    setCart(prev => prev.filter(c => c.id !== id));
  };

  const updateQty = (id, qty) => {
    if (guardLocked()) return;
    if (qty < 1) { removeFromCart(id); return; }
    const item = items.find(i => i.id === id);
    if (item && qty > item.max_order_qty) {
      addToast(`Max order quantity for "${item.name}" is ${item.max_order_qty}.`, "warn");
      return;
    }
    setCart(prev => prev.map(c => c.id === id ? { ...c, qty } : c));
  };

  // ── Totals ──────────────────────────────────────────────────
  const subtotal        = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const finalTotal      = Math.max(0, subtotal - discount);
  const appliedDiscount = Math.min(discount, subtotal);

  // ── Voucher ─────────────────────────────────────────────────
  const applyVoucher = async () => {
    if (voucherApplied) {
      setVoucherError(VOUCHER_ERRORS.VOUCHER_STACK_REJECTED);
      return;
    }
    if (!voucher.trim()) return;

    setVoucherLoading(true);
    setVoucherError("");
    try {
      const data = await apiFetch("/cart/voucher", {
        method: "POST",
        body: JSON.stringify({ code: voucher.trim().toUpperCase() }),
      });
      const discountAmt = Math.min(data.discount ?? data.discount_egp ?? 0, subtotal);
      setDiscount(discountAmt);
      setVoucherApplied(true);
      setAppliedVoucherObj({
        code: voucher.trim().toUpperCase(),
        discount_type:  data.discount_type  ?? "flat",
        discount_value: data.discount ?? data.discount_egp ?? 0,
      });
      addToast(`Voucher applied! You save ${discountAmt.toFixed(2)} EGP`, "success");
    } catch (err) {
      const code = err?.code ?? "";
      setVoucherError(
        VOUCHER_ERRORS[code] ??
        err?.message ??
        "Invalid voucher code."
      );
    } finally {
      setVoucherLoading(false);
    }
  };

  const removeVoucher = () => {
    setVoucherApplied(false);
    setDiscount(0);
    setVoucher("");
    setVoucherError("");
    setAppliedVoucherObj(null);
    addToast("Voucher removed.", "success");
  };

  // ── Checkout ─────────────────────────────────────────────────
  const handleCheckout = async () => {
    if (cart.length === 0) return;
    setCheckoutLoading(true);
    setLockWarnings([]);

    try {
      const data = await apiFetch("/cart/lock", { method: "POST" });

      if (data.warnings?.length) {
        setLockWarnings(data.warnings);
        addToast("Prices changed — please review before confirming.", "warn");
        setCheckoutLoading(false);
        return;
      }

      navigate("/order", {
        state: {
          cart,
          subtotal,
          discount:    appliedDiscount,
          total:       finalTotal,
          voucherCode: appliedVoucherObj?.code ?? null,
          lockedOrder: data.order ?? null,
        },
      });

    } catch (err) {
      if (err?.code === "ITEM_OUT_OF_STOCK") {
        addToast(`${err.message}`, "error");
      } else if (err?.code === "CART_LOCKED") {
        setCartLocked(true);
        addToast("Cart is already locked.", "warn");
      } else {
        addToast(err?.message || "Checkout failed. Please try again.", "error");
      }
    } finally {
      setCheckoutLoading(false);
    }
  };

  const confirmWarningsAndCheckout = async () => {
    setLockWarnings([]);
    await handleCheckout();
  };

  // FIX-2: use shared apiLogout
  const handleLogout = async () => {
    await apiLogout();
    navigate("/");
  };

  const cartCount = cart.reduce((s, c) => s + c.qty, 0);

  return (
    <>
      <style>{MENU_CSS}</style>
      <div className="mp-page">

        <div className="uc-mesh"  aria-hidden="true" />
        <div className="uc-grid"  aria-hidden="true" />

        {/* ── SINGLE Navbar ── */}
        <nav className="mp-nav">
          <div className="mp-nav-brand">
            <div className="mp-nav-logo">🍽️</div>
            <span className="mp-nav-name">CampusBite</span>
          </div>

          {/* FIX-1 + FIX-3: staff AND admin see tabs; staff doesn't see /admin */}
          {isPrivileged && (
            <div className="mp-nav-tabs">
              <button className="mp-nav-tab mp-nav-tab--active">
                <i className="bi bi-storefront" /> Menu
              </button>
              {isAdmin && (
                <button className="mp-nav-tab" onClick={() => navigate("/admin")}>
                  <i className="bi bi-gear-fill" /> Admin
                </button>
              )}
              <button className="mp-nav-tab" onClick={() => navigate("/stock")}>
                <i className="bi bi-boxes" /> Stock
              </button>
              {/* FIX-3: Lifecycle tab was missing from MenuPage entirely */}
              <button className="mp-nav-tab" onClick={() => navigate("/lifecycle")}>
                <i className="bi bi-arrow-repeat" /> Lifecycle
              </button>
            </div>
          )}

          <div className="mp-nav-actions">
            <button
              className="mp-cart-btn"
              onClick={() => setCartOpen(v => !v)}
              aria-label={`Cart — ${cartCount} items`}
            >
              <i className="bi bi-bag-fill" />
              {cartCount > 0 && <span className="mp-cart-badge">{cartCount}</span>}
              <span className="mp-cart-label">Cart</span>
            </button>
            <button className="mp-logout-btn" onClick={handleLogout} title="Sign out">
              <i className="bi bi-box-arrow-right" />
            </button>
          </div>
        </nav>

        {/* ── Main content ── */}
        <div className={`mp-layout ${cartOpen ? "mp-layout--cart-open" : ""}`}>

          {/* ── LEFT: Menu ── */}
          <main className="mp-main">

            <div className="mp-header">
              <div>
                <h1 className="mp-title">Today's Menu</h1>
                <p className="mp-subtitle">{items.length} item{items.length !== 1 ? "s" : ""} available</p>
              </div>
            </div>

            {/* Search bar */}
            <div className="mp-search-wrap">
              <i className="bi bi-search mp-search-ico" aria-hidden="true" />
              <input
                ref={searchRef}
                className="mp-search"
                type="text"
                placeholder="Search menu…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => e.key === "Enter" && fetchMenu()}
              />
              {search && (
                <button className="mp-search-clear" onClick={() => { setSearch(""); fetchMenu(); }}>
                  <i className="bi bi-x" />
                </button>
              )}
              <button className="mp-search-btn" onClick={fetchMenu}>
                Search
              </button>
            </div>

            {/* Category pills */}
            <div className="mp-cats" role="tablist">
              {CATEGORIES.map(c => (
                <button
                  key={c.value}
                  role="tab"
                  aria-selected={category === c.value}
                  className={`mp-cat ${category === c.value ? "mp-cat--active" : ""}`}
                  onClick={() => setCategory(c.value)}
                >
                  <i className={`bi ${c.icon}`} aria-hidden="true" />
                  {c.label}
                </button>
              ))}
            </div>

            {/* Lock warnings banner */}
            {lockWarnings.length > 0 && (
              <div className="mp-warn-banner">
                <i className="bi bi-exclamation-triangle-fill" />
                <div>
                  <strong>Price changes detected:</strong>
                  {lockWarnings.map((w, i) => (
                    <div key={i} className="mp-warn-item">
                      {w.item}: {w.old_price} EGP → <strong>{w.new_price} EGP</strong>
                    </div>
                  ))}
                  <button className="mp-warn-confirm" onClick={confirmWarningsAndCheckout}>
                    Confirm new prices &amp; proceed
                  </button>
                </div>
              </div>
            )}

            {/* Items grid */}
            {loading ? (
              <div className="mp-loading">
                <div className="mp-spinner" />
                <span>Loading menu…</span>
              </div>
            ) : items.length === 0 ? (
              <div className="mp-empty">
                <span style={{ fontSize: 48 }}>🍽️</span>
                <p>No items found{search ? ` for "${search}"` : ""}.</p>
                {search && <button className="mp-ghost-btn" onClick={() => { setSearch(""); fetchMenu(); }}>Clear search</button>}
              </div>
            ) : (
              <div className="mp-grid">
                {items.map(item => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    cartQty={cart.find(c => c.id === item.id)?.qty ?? 0}
                    onAdd={() => addToCart(item)}
                    onRemove={() => updateQty(item.id, (cart.find(c => c.id === item.id)?.qty ?? 1) - 1)}
                    locked={cartLocked}
                  />
                ))}
              </div>
            )}
          </main>

          {/* ── RIGHT: Cart drawer ── */}
          <aside className={`mp-cart ${cartOpen ? "mp-cart--open" : ""}`} aria-label="Shopping cart">
            <CartPanel
              cart={cart}
              subtotal={subtotal}
              finalTotal={finalTotal}
              appliedDiscount={appliedDiscount}
              voucher={voucher}
              setVoucher={setVoucher}
              voucherApplied={voucherApplied}
              voucherError={voucherError}
              voucherLoading={voucherLoading}
              onApplyVoucher={applyVoucher}
              onRemoveVoucher={removeVoucher}
              onUpdateQty={updateQty}
              onRemoveItem={removeFromCart}
              onCheckout={handleCheckout}
              checkoutLoading={checkoutLoading}
              cartLocked={cartLocked}
              onClose={() => setCartOpen(false)}
            />
          </aside>
        </div>

        {cartOpen && <div className="mp-overlay" onClick={() => setCartOpen(false)} />}

        <Toast toasts={toasts} removeToast={removeToast} />
      </div>
    </>
  );
}

// ── Item card ─────────────────────────────────────────────────
function ItemCard({ item, cartQty, onAdd, onRemove, locked }) {
  const outOfStock = item.stock_qty === 0;
  const atCap      = cartQty >= item.max_order_qty;

  return (
    <div className={`mp-item ${outOfStock ? "mp-item--oos" : ""}`}>
      <span className="mp-item-cat">{item.category}</span>

      {outOfStock
        ? <span className="mp-badge mp-badge--oos">Out of stock</span>
        : item.stock_qty <= 5
          ? <span className="mp-badge mp-badge--low">Only {item.stock_qty} left</span>
          : null
      }

      <div className="mp-item-body">
        <h3 className="mp-item-name">{item.name}</h3>
        {item.description && <p className="mp-item-desc">{item.description}</p>}
        <div className="mp-item-footer">
          <span className="mp-item-price">{Number(item.price).toFixed(2)} <small>EGP</small></span>

          {outOfStock || locked ? (
            <button className="mp-add-btn mp-add-btn--disabled" disabled>
              {locked ? <><i className="bi bi-lock-fill" /> Locked</> : "Unavailable"}
            </button>
          ) : cartQty === 0 ? (
            <button className="mp-add-btn" onClick={onAdd}>
              <i className="bi bi-plus-lg" /> Add
            </button>
          ) : (
            <div className="mp-qty-ctrl">
              <button onClick={onRemove} aria-label="Decrease quantity"><i className="bi bi-dash" /></button>
              <span>{cartQty}</span>
              <button
                onClick={onAdd}
                disabled={atCap}
                aria-label="Increase quantity"
                title={atCap ? `Max ${item.max_order_qty} per order` : "Add one more"}
              >
                <i className="bi bi-plus" />
              </button>
            </div>
          )}
        </div>
        {atCap && !outOfStock && (
          <p className="mp-cap-msg">
            <i className="bi bi-info-circle me-1" />
            Max {item.max_order_qty} per order
          </p>
        )}
      </div>
    </div>
  );
}

// ── Cart panel ────────────────────────────────────────────────
function CartPanel({
  cart, subtotal, finalTotal, appliedDiscount,
  voucher, setVoucher, voucherApplied, voucherError, voucherLoading,
  onApplyVoucher, onRemoveVoucher,
  onUpdateQty, onRemoveItem,
  onCheckout, checkoutLoading, cartLocked, onClose,
}) {
  return (
    <div className="mp-cart-inner">
      <div className="mp-cart-hd">
        <h2 className="mp-cart-title">
          <i className="bi bi-bag-fill" />
          Your Cart
          {cartLocked && <span className="mp-cart-locked-tag"><i className="bi bi-lock-fill" /> Locked</span>}
        </h2>
        <button className="mp-cart-close" onClick={onClose} aria-label="Close cart">
          <i className="bi bi-x-lg" />
        </button>
      </div>

      {cart.length === 0 ? (
        <div className="mp-cart-empty">
          <span style={{ fontSize: 40 }}>🛒</span>
          <p>Your cart is empty</p>
          <span className="mp-cart-empty-sub">Add items from the menu</span>
        </div>
      ) : (
        <>
          <div className="mp-cart-items">
            {cart.map(c => (
              <div key={c.id} className="mp-cart-item">
                <div className="mp-cart-item-info">
                  <span className="mp-cart-item-name">{c.name}</span>
                  <span className="mp-cart-item-price">{(c.price * c.qty).toFixed(2)} EGP</span>
                </div>
                <div className="mp-cart-item-ctrl">
                  <div className="mp-qty-ctrl mp-qty-ctrl--sm">
                    <button onClick={() => onUpdateQty(c.id, c.qty - 1)} disabled={cartLocked}><i className="bi bi-dash" /></button>
                    <span>{c.qty}</span>
                    <button onClick={() => onUpdateQty(c.id, c.qty + 1)} disabled={cartLocked || c.qty >= c.max_order_qty}><i className="bi bi-plus" /></button>
                  </div>
                  <button className="mp-cart-remove" onClick={() => onRemoveItem(c.id)} disabled={cartLocked} aria-label="Remove item">
                    <i className="bi bi-trash3" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Voucher */}
          {!cartLocked && (
            <div className="mp-voucher">
              {voucherApplied ? (
                <div className="mp-voucher-applied">
                  <i className="bi bi-tag-fill" />
                  <span>Voucher applied — saving {appliedDiscount.toFixed(2)} EGP</span>
                  <button onClick={onRemoveVoucher} className="mp-voucher-remove" aria-label="Remove voucher">
                    <i className="bi bi-x" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="mp-voucher-row">
                    <div className="mp-voucher-iw">
                      <i className="bi bi-tag uc-iico" />
                      <input
                        className="uc-input mp-voucher-input"
                        type="text"
                        placeholder="Voucher code"
                        value={voucher}
                        onChange={e => { setVoucher(e.target.value.toUpperCase()); }}
                        onKeyDown={e => e.key === "Enter" && onApplyVoucher()}
                        disabled={voucherLoading}
                      />
                    </div>
                    <button
                      className="mp-voucher-btn"
                      onClick={onApplyVoucher}
                      disabled={voucherLoading || !voucher.trim()}
                    >
                      {voucherLoading ? <span className="mp-spinner-sm" /> : "Apply"}
                    </button>
                  </div>
                  {voucherError && (
                    <p className="mp-voucher-err">
                      <i className="bi bi-exclamation-circle me-1" />
                      {voucherError}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {/* Totals */}
          <div className="mp-totals">
            <div className="mp-totals-row">
              <span>Subtotal</span>
              <span>{subtotal.toFixed(2)} EGP</span>
            </div>
            {appliedDiscount > 0 && (
              <div className="mp-totals-row mp-totals-row--disc">
                <span><i className="bi bi-tag-fill me-1" />Discount</span>
                <span>−{appliedDiscount.toFixed(2)} EGP</span>
              </div>
            )}
            <div className="mp-totals-row mp-totals-total">
              <span>Total</span>
              <span>{finalTotal.toFixed(2)} EGP</span>
            </div>
          </div>

          {/* Checkout */}
          <button
            className="mp-checkout-btn"
            onClick={onCheckout}
            disabled={checkoutLoading || cartLocked || cart.length === 0}
          >
            {checkoutLoading ? (
              <><span className="mp-spinner-sm" /> Processing…</>
            ) : cartLocked ? (
              <><i className="bi bi-lock-fill" /> Order Locked</>
            ) : (
              <><i className="bi bi-bag-check-fill" /> Checkout — {finalTotal.toFixed(2)} EGP</>
            )}
          </button>
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// CSS  (unchanged from original)
// ════════════════════════════════════════════════════════════
const MENU_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --uc-bg:    #080d14; --uc-card:  #111825;
    --uc-brd:   rgba(255,255,255,0.07); --uc-brd-hi: rgba(99,179,237,0.4);
    --uc-acc:   #3b9eda; --uc-acc2:  #22c993; --uc-gold: #f6c90e;
    --uc-text:  #e8edf5; --uc-muted: #6b7a90;
    --uc-danger:#f56565; --uc-warn:  #f6ad55;
    --uc-inp:   rgba(255,255,255,0.035);
    --uc-r:14px; --uc-rs:9px;
    --fd:'Sora',sans-serif; --fb:'DM Sans',sans-serif;
  }
  .mp-page { min-height:100vh; background:var(--uc-bg); color:var(--uc-text); font-family:var(--fb); position:relative; overflow-x:hidden; }
  .uc-mesh { position:fixed; inset:0; z-index:0; pointer-events:none; overflow:hidden; }
  .uc-mesh::before { content:''; position:absolute; inset:-40%;
    background: radial-gradient(ellipse 65% 55% at 15% 25%,rgba(59,158,218,.10) 0%,transparent 60%),
                radial-gradient(ellipse 55% 45% at 85% 75%,rgba(34,201,147,.07) 0%,transparent 55%),
                radial-gradient(ellipse 45% 55% at 55% 5%, rgba(246,201,14,.05) 0%,transparent 50%);
    animation:meshMove 18s ease-in-out infinite alternate; }
  @keyframes meshMove { from{transform:translate(0,0) rotate(0)} to{transform:translate(2%,1.5%) rotate(2deg)} }
  .uc-grid { position:fixed; inset:0; z-index:0; pointer-events:none;
    background-image:linear-gradient(rgba(255,255,255,.014) 1px,transparent 1px),
                     linear-gradient(90deg,rgba(255,255,255,.014) 1px,transparent 1px);
    background-size:52px 52px; }
  .mp-nav { position:sticky; top:0; z-index:200; display:flex; align-items:center; justify-content:space-between;
    padding:0 clamp(16px,3vw,32px); height:60px;
    background:rgba(8,13,20,.85); backdrop-filter:blur(16px); border-bottom:1px solid var(--uc-brd); }
  .mp-nav-brand { display:flex; align-items:center; gap:10px; }
  .mp-nav-logo { width:36px; height:36px; border-radius:10px; background:linear-gradient(135deg,var(--uc-acc),var(--uc-acc2));
    display:flex; align-items:center; justify-content:center; font-size:16px; }
  .mp-nav-name { font-family:var(--fd); font-size:16px; font-weight:700; letter-spacing:-.02em; }
  .mp-nav-actions { display:flex; align-items:center; gap:8px; }
  .mp-nav-tabs { display:flex; gap:4px; background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs); padding:3px; }
  .mp-nav-tab { display:flex; align-items:center; gap:6px; background:none; border:none; border-radius:7px;
    color:var(--uc-muted); font-family:var(--fb); font-size:12.5px; font-weight:600;
    padding:5px 14px; cursor:pointer; transition:all .2s; white-space:nowrap; }
  .mp-nav-tab:hover { color:var(--uc-text); background:rgba(255,255,255,.05); }
  .mp-nav-tab--active { background:var(--uc-card); color:var(--uc-text); box-shadow:0 1px 4px rgba(0,0,0,.35); }
  .mp-cart-btn { display:flex; align-items:center; gap:6px; position:relative;
    background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-text); font-family:var(--fb); font-size:13px; font-weight:600;
    padding:7px 14px; cursor:pointer; transition:border-color .2s,background .2s; }
  .mp-cart-btn:hover { border-color:var(--uc-acc); background:rgba(59,158,218,.07); }
  .mp-cart-badge { position:absolute; top:-6px; right:-6px; width:18px; height:18px; border-radius:50%;
    background:var(--uc-acc); color:#fff; font-size:10px; font-weight:700;
    display:flex; align-items:center; justify-content:center; border:2px solid var(--uc-bg); }
  .mp-cart-label { display:none; }
  @media(min-width:640px) { .mp-cart-label { display:inline; } }
  .mp-logout-btn { width:36px; height:36px; display:flex; align-items:center; justify-content:center;
    background:none; border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-muted); cursor:pointer; font-size:15px; transition:all .2s; }
  .mp-logout-btn:hover { border-color:var(--uc-danger); color:var(--uc-danger); }
  .mp-layout { position:relative; z-index:1; display:grid; grid-template-columns:1fr; min-height:calc(100vh - 60px); transition:grid-template-columns .3s; }
  @media(min-width:1024px) { .mp-layout--cart-open { grid-template-columns:1fr 380px; } }
  .mp-main { padding:clamp(16px,3vw,32px); width:100%; }
  .mp-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; }
  .mp-title { font-family:var(--fd); font-size:clamp(20px,3vw,28px); font-weight:700; letter-spacing:-.02em; }
  .mp-subtitle { font-size:13px; color:var(--uc-muted); margin-top:3px; }
  .mp-search-wrap { position:relative; display:flex; align-items:center; gap:8px; margin-bottom:18px; }
  .mp-search-ico { position:absolute; left:13px; color:var(--uc-muted); font-size:14px; pointer-events:none; }
  .mp-search { flex:1; background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-text); font-family:var(--fb); font-size:14px; padding:10px 36px 10px 38px;
    outline:none; transition:border-color .2s,box-shadow .2s; }
  .mp-search::placeholder { color:rgba(107,122,144,.55); }
  .mp-search:focus { border-color:var(--uc-acc); box-shadow:0 0 0 3px rgba(59,158,218,.12); }
  .mp-search-clear { position:absolute; right:90px; background:none; border:none; cursor:pointer; color:var(--uc-muted); font-size:16px; padding:4px; transition:color .2s; }
  .mp-search-clear:hover { color:var(--uc-text); }
  .mp-search-btn { flex-shrink:0; background:linear-gradient(135deg,var(--uc-acc),#2878be); border:none; border-radius:var(--uc-rs);
    color:#fff; font-family:var(--fb); font-size:13px; font-weight:600; padding:10px 18px; cursor:pointer; transition:opacity .2s; }
  .mp-search-btn:hover { opacity:.88; }
  .mp-cats { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px; }
  .mp-cat { display:flex; align-items:center; gap:6px; background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:100px;
    color:var(--uc-muted); font-family:var(--fb); font-size:12.5px; font-weight:600; padding:6px 14px; cursor:pointer; transition:all .2s; }
  .mp-cat:hover { border-color:var(--uc-acc); color:var(--uc-text); }
  .mp-cat--active { background:rgba(59,158,218,.12); border-color:var(--uc-acc); color:var(--uc-acc); }
  .mp-warn-banner { display:flex; gap:12px; align-items:flex-start; background:rgba(246,173,85,.08); border:1px solid rgba(246,173,85,.28);
    border-radius:var(--uc-rs); padding:14px; margin-bottom:20px; color:var(--uc-warn); font-size:13.5px; }
  .mp-warn-item { font-size:12.5px; margin-top:4px; opacity:.9; }
  .mp-warn-confirm { display:inline-flex; align-items:center; gap:6px; margin-top:10px; background:var(--uc-warn); border:none;
    border-radius:var(--uc-rs); color:#000; font-family:var(--fb); font-size:12.5px; font-weight:700; padding:7px 14px; cursor:pointer; transition:opacity .2s; }
  .mp-warn-confirm:hover { opacity:.85; }
  .mp-loading { display:flex; flex-direction:column; align-items:center; gap:14px; padding:80px 20px; color:var(--uc-muted); }
  .mp-spinner { width:32px; height:32px; border:3px solid var(--uc-brd); border-top-color:var(--uc-acc); border-radius:50%; animation:spin .7s linear infinite; }
  .mp-spinner-sm { display:inline-block; width:14px; height:14px; border:2px solid rgba(255,255,255,.3); border-top-color:#fff; border-radius:50%; animation:spin .7s linear infinite; }
  @keyframes spin { to{transform:rotate(360deg)} }
  .mp-empty { display:flex; flex-direction:column; align-items:center; gap:12px; padding:80px 20px; color:var(--uc-muted); }
  .mp-ghost-btn { background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs); color:var(--uc-muted); font-family:var(--fb); font-size:13px; padding:9px 18px; cursor:pointer; transition:all .2s; }
  .mp-ghost-btn:hover { border-color:var(--uc-acc); color:var(--uc-text); }
  .mp-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:16px; }
  .mp-item { background:var(--uc-card); border:1px solid var(--uc-brd); border-radius:var(--uc-r);
    padding:18px; position:relative; transition:border-color .25s,transform .2s; display:flex; flex-direction:column; }
  .mp-item:hover { border-color:var(--uc-brd-hi); transform:translateY(-2px); }
  .mp-item--oos { opacity:.55; }
  .mp-item--oos:hover { transform:none; }
  .mp-item-cat { font-size:10px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--uc-muted); margin-bottom:6px; display:block; }
  .mp-badge { position:absolute; top:14px; right:14px; font-size:10px; font-weight:700; padding:3px 8px; border-radius:100px; letter-spacing:.04em; }
  .mp-badge--oos { background:rgba(245,101,101,.15); color:var(--uc-danger); border:1px solid rgba(245,101,101,.25); }
  .mp-badge--low { background:rgba(246,173,85,.15); color:var(--uc-warn); border:1px solid rgba(246,173,85,.25); }
  .mp-item-body { display:flex; flex-direction:column; flex:1; }
  .mp-item-name { font-family:var(--fd); font-size:15px; font-weight:700; margin-bottom:5px; line-height:1.3; }
  .mp-item-desc { font-size:12px; color:var(--uc-muted); line-height:1.5; flex:1; margin-bottom:12px; }
  .mp-item-footer { display:flex; align-items:center; justify-content:space-between; margin-top:auto; }
  .mp-item-price { font-family:var(--fd); font-size:17px; font-weight:700; color:var(--uc-acc); }
  .mp-item-price small { font-size:11px; font-weight:500; opacity:.7; }
  .mp-cap-msg { font-size:11px; color:var(--uc-warn); margin-top:7px; }
  .mp-add-btn { display:flex; align-items:center; gap:5px; background:linear-gradient(135deg,var(--uc-acc),#2878be);
    border:none; border-radius:var(--uc-rs); color:#fff; font-family:var(--fb); font-size:12.5px; font-weight:600; padding:7px 14px; cursor:pointer; transition:opacity .2s; }
  .mp-add-btn:hover { opacity:.88; }
  .mp-add-btn--disabled { background:var(--uc-inp); border:1px solid var(--uc-brd); color:var(--uc-muted); cursor:not-allowed; }
  .mp-qty-ctrl { display:flex; align-items:center; background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs); overflow:hidden; }
  .mp-qty-ctrl button { width:32px; height:32px; display:flex; align-items:center; justify-content:center; background:none; border:none; color:var(--uc-text); cursor:pointer; font-size:14px; transition:background .15s; }
  .mp-qty-ctrl button:hover:not(:disabled) { background:rgba(255,255,255,.06); }
  .mp-qty-ctrl button:disabled { color:var(--uc-muted); cursor:not-allowed; }
  .mp-qty-ctrl span { min-width:28px; text-align:center; font-size:13px; font-weight:600; }
  .mp-qty-ctrl--sm button { width:28px; height:28px; font-size:12px; }
  .mp-qty-ctrl--sm span  { min-width:22px; font-size:12px; }
  .mp-cart { position:fixed; top:60px; right:-100%; width:min(380px,100vw); height:calc(100vh - 60px); z-index:300; transition:right .3s cubic-bezier(.4,0,.2,1); }
  .mp-cart--open { right:0; }
  @media(min-width:1024px) {
    .mp-cart { position:sticky; top:60px; right:0; height:calc(100vh - 60px); }
    .mp-layout--cart-open .mp-cart { display:block; }
    .mp-layout:not(.mp-layout--cart-open) .mp-cart { display:none; }
  }
  .mp-overlay { position:fixed; inset:0; z-index:299; background:rgba(0,0,0,.5); backdrop-filter:blur(2px); }
  @media(min-width:1024px) { .mp-overlay { display:none; } }
  .mp-cart-inner { height:100%; overflow-y:auto; display:flex; flex-direction:column; background:var(--uc-card); border-left:1px solid var(--uc-brd); padding:20px; }
  .mp-cart-hd { display:flex; align-items:center; justify-content:space-between; margin-bottom:18px; }
  .mp-cart-title { font-family:var(--fd); font-size:17px; font-weight:700; display:flex; align-items:center; gap:8px; }
  .mp-cart-locked-tag { font-size:11px; background:rgba(246,173,85,.15); color:var(--uc-warn); border:1px solid rgba(246,173,85,.25); border-radius:100px; padding:2px 8px; }
  .mp-cart-close { width:30px; height:30px; display:flex; align-items:center; justify-content:center; background:none; border:1px solid var(--uc-brd); border-radius:var(--uc-rs); color:var(--uc-muted); cursor:pointer; font-size:13px; transition:all .2s; }
  .mp-cart-close:hover { border-color:var(--uc-danger); color:var(--uc-danger); }
  .mp-cart-empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:var(--uc-muted); text-align:center; }
  .mp-cart-empty-sub { font-size:12px; opacity:.7; }
  .mp-cart-items { flex:1; display:flex; flex-direction:column; gap:10px; overflow-y:auto; margin-bottom:14px; }
  .mp-cart-item { background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs); padding:10px 12px; display:flex; flex-direction:column; gap:7px; }
  .mp-cart-item-info { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
  .mp-cart-item-name { font-size:13px; font-weight:500; line-height:1.3; }
  .mp-cart-item-price { font-size:13px; font-weight:700; color:var(--uc-acc); white-space:nowrap; }
  .mp-cart-item-ctrl { display:flex; align-items:center; justify-content:space-between; }
  .mp-cart-remove { width:28px; height:28px; display:flex; align-items:center; justify-content:center; background:none; border:1px solid var(--uc-brd); border-radius:var(--uc-rs); color:var(--uc-muted); cursor:pointer; font-size:13px; transition:all .2s; }
  .mp-cart-remove:hover:not(:disabled) { border-color:var(--uc-danger); color:var(--uc-danger); }
  .mp-cart-remove:disabled { opacity:.4; cursor:not-allowed; }
  .mp-voucher { margin-bottom:14px; }
  .mp-voucher-row { display:flex; gap:8px; }
  .mp-voucher-iw { position:relative; flex:1; display:flex; align-items:center; }
  .mp-voucher-iw .uc-iico { position:absolute; left:12px; z-index:1; color:var(--uc-muted); font-size:13px; pointer-events:none; }
  .mp-voucher-input { padding:9px 12px 9px 34px !important; font-size:13px !important; }
  .uc-input { width:100%; background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs); color:var(--uc-text); font-family:var(--fb); font-size:14px; padding:10px 14px; outline:none; transition:border-color .2s,box-shadow .2s; }
  .uc-input:focus { border-color:var(--uc-acc); box-shadow:0 0 0 3px rgba(59,158,218,.12); }
  .uc-iico { color:var(--uc-muted); }
  .mp-voucher-btn { flex-shrink:0; background:rgba(59,158,218,.12); border:1px solid rgba(59,158,218,.3); border-radius:var(--uc-rs); color:var(--uc-acc); font-family:var(--fb); font-size:12.5px; font-weight:600; padding:9px 14px; cursor:pointer; transition:all .2s; display:flex; align-items:center; }
  .mp-voucher-btn:hover:not(:disabled) { background:rgba(59,158,218,.2); }
  .mp-voucher-btn:disabled { opacity:.4; cursor:not-allowed; }
  .mp-voucher-err { font-size:11.5px; color:var(--uc-danger); margin-top:6px; line-height:1.4; }
  .mp-voucher-applied { display:flex; align-items:center; gap:8px; background:rgba(34,201,147,.08); border:1px solid rgba(34,201,147,.25); border-radius:var(--uc-rs); padding:9px 12px; font-size:12.5px; color:var(--uc-acc2); }
  .mp-voucher-applied span { flex:1; }
  .mp-voucher-remove { background:none; border:none; color:var(--uc-acc2); cursor:pointer; font-size:15px; padding:0; line-height:1; transition:opacity .2s; }
  .mp-voucher-remove:hover { opacity:.7; }
  .mp-totals { border-top:1px solid var(--uc-brd); padding-top:12px; margin-bottom:14px; display:flex; flex-direction:column; gap:7px; }
  .mp-totals-row { display:flex; justify-content:space-between; font-size:13px; color:var(--uc-muted); }
  .mp-totals-row--disc { color:var(--uc-acc2); }
  .mp-totals-total { font-family:var(--fd); font-size:16px; font-weight:700; color:var(--uc-text); padding-top:7px; border-top:1px solid var(--uc-brd); }
  .mp-checkout-btn { width:100%; display:flex; align-items:center; justify-content:center; gap:8px;
    background:linear-gradient(135deg,var(--uc-acc2),#16a87a); border:none; border-radius:var(--uc-rs); color:#fff;
    font-family:var(--fb); font-size:14px; font-weight:700; padding:13px; cursor:pointer; letter-spacing:.01em;
    box-shadow:0 4px 18px rgba(34,201,147,.28); transition:transform .15s,box-shadow .15s,opacity .2s; }
  .mp-checkout-btn:hover:not(:disabled) { transform:translateY(-1px); box-shadow:0 8px 24px rgba(34,201,147,.38); }
  .mp-checkout-btn:disabled { opacity:.45; cursor:not-allowed; transform:none; box-shadow:none; }
  .uc-toast { display:flex; align-items:center; gap:10px; padding:11px 16px; border-radius:var(--uc-rs); font-size:13px; font-weight:500; min-width:260px; max-width:380px; box-shadow:0 8px 24px rgba(0,0,0,.4); animation:fadeUp .3s ease both; }
  .uc-toast--success { background:#0e2e20; border:1px solid rgba(34,201,147,.3); color:var(--uc-acc2); }
  .uc-toast--warn    { background:#2b1f0a; border:1px solid rgba(246,173,85,.3);  color:var(--uc-warn); }
  .uc-toast--error   { background:#2b0e0e; border:1px solid rgba(245,101,101,.3); color:var(--uc-danger); }
  .uc-toast-close { margin-left:auto; background:none; border:none; cursor:pointer; color:inherit; opacity:.7; font-size:16px; padding:0; }
  @keyframes fadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
  @media(max-width:640px) {
    .mp-grid { grid-template-columns:1fr 1fr; }
    .mp-item { padding:14px; }
    .mp-item-name { font-size:13px; }
    .mp-nav-tabs { display:none; }
  }
  @media(max-width:420px) { .mp-grid { grid-template-columns:1fr; } }
`;