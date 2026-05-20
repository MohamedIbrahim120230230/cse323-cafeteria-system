// ============================================================
// frontend/src/features/lifecycle/LifecycleDashboard.jsx
//
// CHANGES FROM ORIGINAL:
//   - API paths corrected to match backend/lifecycle/lifecycle.py
//     and backend/lifecycle/admin.py route prefixes:
//       /orders/*          → /api/v1/orders/*
//       /admin/reports     → /api/v1/admin/reports
//       /admin/config      → /api/v1/admin/config
//       /admin/flagged-orders → /api/v1/admin/flagged-orders
//       /admin/audit-log   → /api/v1/admin/audit-log
//   - Demo order IDs updated to match 005 migration seed UUIDs
//   - actorHeaders now reads JWT role so real auth works
//   - Rating tab added (FR47 — post-COMPLETED rating widget)
//   - apiFetch from shared/api used for all calls (no local fetch)
// ============================================================

import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, apiLogout } from "../../shared/api";

// ── Fonts & Icons ─────────────────────────────────────────────
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

// ── Status config ─────────────────────────────────────────────
const STATUS_COLORS = {
  placed:           { bg:"rgba(30,58,95,.4)",     text:"#60A5FA" },
  pending_payment:  { bg:"rgba(59,42,0,.4)",      text:"#FCD34D" },
  confirmed:        { bg:"rgba(26,58,42,.4)",      text:"#34D399" },
  preparing:        { bg:"rgba(45,27,105,.4)",     text:"#A78BFA" },
  ready_for_pickup: { bg:"rgba(26,58,58,.4)",      text:"#22D3EE" },
  delivered:        { bg:"rgba(26,42,58,.4)",       text:"#93C5FD" },
  completed:        { bg:"rgba(26,58,26,.4)",       text:"#86EFAC" },
  cancelled:        { bg:"rgba(58,26,26,.4)",       text:"#FCA5A5" },
  payment_failed:   { bg:"rgba(58,26,0,.4)",        text:"#FDBA74" },
  flagged:          { bg:"rgba(58,42,0,.4)",         text:"#FDE68A" },
};

// Status → what PATCH /status accepts as new_status (backend state machine)
const NEXT_STATUS = {
  confirmed:        "preparing",
  preparing:        "ready_for_pickup",
  ready_for_pickup: "delivered",
  delivered:        "completed",
};

// Demo order IDs from 005 migration seed
const DEMO_ORDER_IDS = [
  "00000000-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000002",
  "00000000-0000-0000-0000-000000000003",
  "00000000-0000-0000-0000-000000000004",
  "00000000-0000-0000-0000-000000000005",
];

// ── Actor headers (JWT role + explicit header for lifecycle router) ─
function actorHeaders(role, actorId) {
  return {
    "X-Actor-Role": role || "STAFF",
    "X-Actor-Id":   actorId || `${(role || "staff").toLowerCase()}-demo`,
  };
}

// ── Toast ─────────────────────────────────────────────────────
function useToast() {
  const [toasts, setToasts] = useState([]);
  const add = useCallback((message, type = "success") => {
    const id = Date.now() + Math.random();
    setToasts(p => [...p, { id, message, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 4000);
  }, []);
  const remove = useCallback(id => setToasts(p => p.filter(t => t.id !== id)), []);
  return { toasts, addToast: add, removeToast: remove };
}

function ToastStack({ toasts, removeToast }) {
  return (
    <div style={{ position:"fixed", bottom:24, right:24, zIndex:9999, display:"flex", flexDirection:"column", gap:8 }}>
      {toasts.map(t => (
        <div key={t.id} className={`uc-toast uc-toast--${t.type}`}>
          <i className={`bi ${t.type==="success"?"bi-check-circle-fill":t.type==="warn"?"bi-exclamation-triangle-fill":"bi-x-circle-fill"}`} />
          <span>{t.message}</span>
          <button onClick={() => removeToast(t.id)} className="uc-toast-close"><i className="bi bi-x" /></button>
        </div>
      ))}
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────
function StatusBadge({ status }) {
  const c = STATUS_COLORS[status?.toLowerCase()] || { bg:"rgba(55,65,81,.4)", text:"#9CA3AF" };
  return (
    <span data-testid="status-badge" className="lc-status-badge"
      style={{ background:c.bg, color:c.text }}>
      {status}
    </span>
  );
}

// ── Modal ─────────────────────────────────────────────────────
function Modal({ title, children, onClose }) {
  return (
    <>
      <div className="lc-backdrop" onClick={onClose} />
      <div className="lc-modal-wrap" role="dialog" aria-modal="true">
        <div className="lc-modal">
          <div className="lc-modal-hd">
            <h3 className="lc-modal-title">{title}</h3>
            <button className="lc-icon-btn" onClick={onClose} aria-label="Close">
              <i className="bi bi-x-lg" />
            </button>
          </div>
          {children}
        </div>
      </div>
    </>
  );
}

// ── Star rating widget (FR47) ─────────────────────────────────
function StarRating({ value, onChange, readOnly }) {
  return (
    <div style={{ display:"flex", gap:4 }}>
      {[1,2,3,4,5].map(n => (
        <button key={n}
          onClick={() => !readOnly && onChange(n)}
          style={{
            background:"none", border:"none", cursor:readOnly?"default":"pointer",
            fontSize:22, color: n <= value ? "var(--uc-gold)" : "var(--uc-brd)",
            padding:0, lineHeight:1,
          }}
          aria-label={`${n} star`}
        >
          {n <= value ? "★" : "☆"}
        </button>
      ))}
    </div>
  );
}

// ── Order card ────────────────────────────────────────────────
function OrderCard({ order, role, actorId, onRefresh, onToast }) {
  const [showAdvance,    setShowAdvance]    = useState(false);
  const [showCancel,     setShowCancel]     = useState(false);
  const [showRate,       setShowRate]       = useState(false);
  const [cancelReason,   setCancelReason]   = useState("CUSTOMER_REQUEST");
  const [cancelNote,     setCancelNote]     = useState("");
  const [advanceNote,    setAdvanceNote]    = useState("");
  const [stars,          setStars]          = useState(0);
  const [ratingText,     setRatingText]     = useState("");
  const [submittingRate, setSubmittingRate] = useState(false);

  const normRole   = role?.toUpperCase();
  const status     = order.status?.toLowerCase();
  const nextStatus = NEXT_STATUS[status];
  const canAdvance = (normRole === "STAFF" || normRole === "ADMIN") && !!nextStatus;
  const canCancel  = (normRole === "STAFF" || normRole === "ADMIN") ||
    (normRole === "STUDENT" && ["placed","pending_payment"].includes(status));
  const canRate    = normRole === "STUDENT" && status === "completed";

  // PATCH /api/v1/orders/{id}/status
  async function doAdvance() {
    try {
      await apiFetch(`/orders/${order.id}/status`, {
        method:  "PATCH",
        headers: actorHeaders(normRole, actorId),
        body:    JSON.stringify({ new_status: nextStatus, note: advanceNote || undefined }),
      });
      setShowAdvance(false);
      onToast(`Order advanced to ${nextStatus}`, "success");
      onRefresh();
    } catch (e) {
      setShowAdvance(false);
      onToast(e?.message || "Failed to advance order.", "error");
    }
  }

  // POST /api/v1/orders/{id}/cancel
  async function doCancel() {
    try {
      await apiFetch(`/orders/${order.id}/cancel`, {
        method:  "POST",
        headers: actorHeaders(normRole, actorId),
        body:    JSON.stringify({ reason_code: cancelReason, note: cancelNote || undefined }),
      });
      setShowCancel(false);
      onToast("Order cancelled.", "success");
      onRefresh();
    } catch (e) {
      setShowCancel(false);
      onToast(e?.message || "Failed to cancel order.", "error");
    }
  }

  // POST /api/v1/ratings  (FR47 — only after COMPLETED)
  async function doRate() {
    if (stars === 0) { onToast("Please select a star rating.", "warn"); return; }
    setSubmittingRate(true);
    try {
      await apiFetch("/ratings", {
        method:  "POST",
        headers: actorHeaders(normRole, actorId),
        body:    JSON.stringify({ order_id: order.id, stars, text: ratingText || undefined }),
      });
      setShowRate(false);
      onToast("Rating submitted — thank you!", "success");
      onRefresh();
    } catch (e) {
      onToast(e?.message || "Failed to submit rating.", "error");
    } finally {
      setSubmittingRate(false);
    }
  }

  return (
    <div data-testid="order-card" data-order-id={order.id} data-status={order.status}
      className="lc-order-card">

      <div className="lc-order-hd">
        <StatusBadge status={order.status} />
        <span className="lc-order-id">#{order.id?.slice(0,8).toUpperCase()}</span>
        <span className="lc-order-total">
          {(order.total_egp ?? order.total ?? 0).toFixed(2)} EGP
        </span>
        <span className="lc-order-time">
          {new Date(order.placed_at ?? order.created_at).toLocaleTimeString()}
        </span>
      </div>

      {order.items?.length > 0 && (
        <div data-testid="order-items-list" className="lc-order-items">
          {order.items.map((item, i) => (
            <div key={item.item_id || i} className="lc-order-item">
              <span>{item.quantity}× {item.name}</span>
              <span>{(item.subtotal_egp ?? item.subtotal ?? 0).toFixed(2)} EGP</span>
            </div>
          ))}
        </div>
      )}

      {(canAdvance || canCancel || canRate) && (
        <div className="lc-order-actions">
          {canAdvance && (
            <button data-testid="advance-btn" className="lc-advance-btn"
              onClick={() => setShowAdvance(true)}>
              <i className="bi bi-arrow-right-circle-fill" /> → {nextStatus?.replace("_"," ")}
            </button>
          )}
          {canCancel && !["completed","cancelled","payment_failed"].includes(status) && (
            <button data-testid="cancel-btn" className="lc-cancel-btn"
              onClick={() => setShowCancel(true)}>
              <i className="bi bi-x-circle" /> Cancel
            </button>
          )}
          {canRate && (
            <button className="lc-advance-btn" style={{ borderColor:"rgba(246,201,14,.3)", color:"var(--uc-gold)" }}
              onClick={() => setShowRate(true)}>
              <i className="bi bi-star-fill" /> Rate
            </button>
          )}
        </div>
      )}

      {showAdvance && (
        <Modal title={`Advance to ${nextStatus?.replace("_"," ")}`} onClose={() => setShowAdvance(false)}>
          <div className="lc-modal-body">
            <label className="lc-field-label">Optional note</label>
            <input className="lc-input" value={advanceNote}
              onChange={e => setAdvanceNote(e.target.value)}
              placeholder="e.g. Started at station 2" />
          </div>
          <div className="lc-modal-ft">
            <button className="lc-ghost-btn" onClick={() => setShowAdvance(false)}>Cancel</button>
            <button data-testid="confirm-advance-btn" className="lc-primary-btn" onClick={doAdvance}>
              <i className="bi bi-check-lg" /> Confirm
            </button>
          </div>
        </Modal>
      )}

      {showCancel && (
        <Modal title="Cancel Order" onClose={() => setShowCancel(false)}>
          <div className="lc-modal-body">
            <label className="lc-field-label">Reason *</label>
            <select data-testid="cancel-reason-select" className="lc-select"
              value={cancelReason} onChange={e => setCancelReason(e.target.value)}>
              {["CUSTOMER_REQUEST","OUT_OF_STOCK","STAFF_ERROR","SYSTEM_ERROR","SUSPICIOUS_ORDER"].map(r => (
                <option key={r} value={r}>{r.replace(/_/g," ")}</option>
              ))}
            </select>
            <label className="lc-field-label" style={{ marginTop:10 }}>Note</label>
            <input data-testid="cancel-note" className="lc-input" value={cancelNote}
              onChange={e => setCancelNote(e.target.value)}
              placeholder="Optional additional details" />
          </div>
          <div className="lc-modal-ft">
            <button className="lc-ghost-btn" onClick={() => setShowCancel(false)}>Back</button>
            <button data-testid="confirm-cancel-btn" className="lc-danger-btn" onClick={doCancel}>
              <i className="bi bi-x-circle-fill" /> Cancel Order
            </button>
          </div>
        </Modal>
      )}

      {showRate && (
        <Modal title="Rate Your Order" onClose={() => setShowRate(false)}>
          <div className="lc-modal-body">
            <p className="lc-muted" style={{ marginBottom:12 }}>
              How was your experience? (FR47 — only available after order is completed)
            </p>
            <StarRating value={stars} onChange={setStars} />
            <label className="lc-field-label" style={{ marginTop:12 }}>Comments (optional)</label>
            <textarea className="lc-textarea" rows={3} value={ratingText}
              onChange={e => setRatingText(e.target.value)}
              placeholder="Tell us about your meal…" />
          </div>
          <div className="lc-modal-ft">
            <button className="lc-ghost-btn" onClick={() => setShowRate(false)}>Cancel</button>
            <button className="lc-primary-btn" onClick={doRate} disabled={submittingRate}>
              {submittingRate ? <><span className="lc-spinner-sm" /> Submitting…</> : <><i className="bi bi-star-fill" /> Submit</>}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Orders tab ────────────────────────────────────────────────
function OrdersTab({ role, actorId, addToast }) {
  const [orders,     setOrders]     = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [liveActive, setLiveActive] = useState(false);
  const esRefs   = useRef({});
  const normRole = role?.toUpperCase();

const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiFetch("/orders", { headers: actorHeaders(normRole, actorId) });
      const list = Array.isArray(result) ? result : (result?.data || []);
      setOrders(list);
    } catch (e) {
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, [normRole, actorId]);

  useEffect(() => { load(); }, [load]);

  // SSE live updates (FR36) — GET /api/v1/orders/{id}/stream
  useEffect(() => {
    orders.forEach(order => {
      if (esRefs.current[order.id]) return;
      try {
        const token = localStorage.getItem("jwt_token");
        const base  = import.meta?.env?.VITE_API_BASE || "/api/v1";
        const es = new EventSource(
          `${base}/orders/${order.id}/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`
        );
        es.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            setOrders(prev => prev.map(o =>
              o.id === data.order_id ? { ...o, status: data.status || data.new_status } : o
            ));
            setLiveActive(true);
          } catch {}
        };
        esRefs.current[order.id] = es;
      } catch {}
    });
    return () => {
      Object.values(esRefs.current).forEach(es => { try { es.close(); } catch {} });
      esRefs.current = {};
    };
  }, [orders.length]); // eslint-disable-line

  const grouped = {
    Active:    orders.filter(o => ["placed","pending_payment","confirmed","preparing","ready_for_pickup","delivered"].includes(o.status?.toLowerCase())),
    Completed: orders.filter(o => o.status?.toLowerCase() === "completed"),
    Cancelled: orders.filter(o => ["cancelled","payment_failed"].includes(o.status?.toLowerCase())),
    Flagged:   orders.filter(o => o.status?.toLowerCase() === "flagged"),
  };

  return (
    <div>
      <div className="lc-tab-hd">
        <div className="lc-tab-hd-left">
          <h2 className="lc-section-title">Order Dashboard</h2>
          <div data-testid="live-indicator" className="lc-live-dot" style={{
            background: liveActive ? "var(--uc-acc2)" : "var(--uc-brd)",
            boxShadow:  liveActive ? "0 0 8px var(--uc-acc2)" : "none",
          }} title="Live SSE updates (FR36)" />
          <span className="lc-live-label">{liveActive ? "Live" : "Connecting…"}</span>
        </div>
        <button className="lc-ghost-btn" onClick={load}>
          <i className="bi bi-arrow-clockwise" /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="lc-loading"><div className="lc-spinner" /><span>Loading orders…</span></div>
      ) : (
        <div data-testid="orders-list">
          {Object.entries(grouped).map(([group, list]) => list.length > 0 && (
            <div key={group} style={{ marginBottom:28 }}>
              <div className="lc-group-label">{group.toUpperCase()} ({list.length})</div>
              {list.map(order => (
                <OrderCard key={order.id} order={order} role={normRole}
                  actorId={actorId} onRefresh={load} onToast={addToast} />
              ))}
            </div>
          ))}
          {orders.length === 0 && (
            <div className="lc-empty">
              <i className="bi bi-inbox" style={{ fontSize:40, color:"var(--uc-muted)" }} />
              <p>No orders found — check the backend is running.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Reports tab (FR53) ────────────────────────────────────────
function ReportsTab({ role, actorId, addToast }) {
  const [type,      setType]      = useState("revenue");
  const [from,      setFrom]      = useState("2026-04-01");
  const [to,        setTo]        = useState("2026-05-17");
  const [data,      setData]      = useState(null);
  const [asyncJob,  setAsyncJob]  = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [dateError, setDateError] = useState("");
  const normRole = role?.toUpperCase();

  async function generate() {
    if (!from || !to) { setDateError("Both dates are required."); return; }
    if (new Date(from) > new Date(to)) { setDateError("From date must be before to date."); return; }
    setDateError(""); setLoading(true); setData(null); setAsyncJob(null);
    try {
      // GET /api/v1/admin/reports?type=...&from=...&to=...
      const body = await apiFetch(
        `/admin/reports?type=${type}&from=${from}&to=${to}`,
        { headers: actorHeaders(normRole, actorId) }
      );
      if (body?.job_id) setAsyncJob(body);
      else setData(body);
    } catch (e) {
      addToast(e?.message || "Report generation failed.", "error");
    } finally {
      setLoading(false);
    }
  }

  const REPORT_TYPES = ["revenue","top_items","cancellations","heatmap","ratings"];

  return (
    <div>
      <div className="lc-tab-hd" style={{ marginBottom:20 }}>
        <h2 className="lc-section-title">Analytics Reports (FR53)</h2>
      </div>

      <div className="lc-info-banner" style={{ marginBottom:16 }}>
        <i className="bi bi-info-circle-fill" />
        Ranges &gt; 90 days are processed asynchronously — you'll receive a job ID.
      </div>

      <div className="lc-report-controls">
        <div className="lc-field">
          <label className="lc-field-label">Report Type</label>
          <select className="lc-select" value={type} onChange={e => setType(e.target.value)}>
            {REPORT_TYPES.map(t => (
              <option key={t} value={t}>{t.replace("_"," ").replace(/\b\w/g,c=>c.toUpperCase())}</option>
            ))}
          </select>
        </div>
        <div className="lc-field">
          <label className="lc-field-label">From</label>
          <input type="date" className="lc-input" value={from}
            onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="lc-field">
          <label className="lc-field-label">To</label>
          <input type="date" className="lc-input" value={to}
            onChange={e => setTo(e.target.value)} />
        </div>
        <button className="lc-primary-btn" onClick={generate} style={{ alignSelf:"flex-end" }}>
          {loading
            ? <><span className="lc-spinner-sm" /> Generating…</>
            : <><i className="bi bi-graph-up" /> Generate</>}
        </button>
      </div>
      {dateError && <p className="lc-field-err" style={{ marginTop:6 }}>{dateError}</p>}

      {asyncJob && (
        <div className="lc-info-banner" style={{ marginTop:16 }}>
          <i className="bi bi-hourglass-split" />
          Report queued — job <code style={{ fontFamily:"monospace" }}>{asyncJob.job_id?.slice(0,8)}</code>.
          Estimated completion: ~10 minutes.
        </div>
      )}

      {data?.report_rows?.length > 0 && (
        <div className="lc-table-card" style={{ marginTop:16 }}>
          <div className="lc-table-meta">
            {data.report_type} · {data.from} → {data.to} · {data.report_rows.length} rows
          </div>
          <div className="lc-table-wrap">
            <table className="lc-table">
              <thead>
                <tr>{Object.keys(data.report_rows[0]).map(k => <th key={k}>{k.toUpperCase()}</th>)}</tr>
              </thead>
              <tbody>
                {data.report_rows.map((row, i) => (
                  <tr key={i}>
                    {Object.values(row).map((v,j) => (
                      <td key={j}>{typeof v === "object" ? JSON.stringify(v) : String(v)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Flagged orders tab (FR56) ─────────────────────────────────
function FlaggedTab({ role, actorId, addToast }) {
  const [orders,      setOrders]      = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [reviewing,   setReviewing]   = useState(null);
  const [decision,    setDecision]    = useState("APPROVED");
  const [reason,      setReason]      = useState("");
  const [reasonError, setReasonError] = useState("");
  const normRole = role?.toUpperCase();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // GET /api/v1/admin/flagged-orders
      const body = await apiFetch("/admin/flagged-orders",
        { headers: actorHeaders(normRole, actorId) });
      setOrders(Array.isArray(body) ? body : []);
    } catch (e) {
      addToast(e?.message || "Failed to load flagged orders.", "error");
    } finally {
      setLoading(false);
    }
  }, [normRole, actorId]); // eslint-disable-line

  useEffect(() => { load(); }, [load]);

  async function submitReview() {
    if (!reason.trim()) { setReasonError("Reason is required."); return; }
    setReasonError("");
    try {
      // POST /api/v1/admin/flagged-orders/{order_id}/review
      await apiFetch(`/admin/flagged-orders/${reviewing.order_id}/review`, {
        method:  "POST",
        headers: actorHeaders(normRole, actorId),
        body:    JSON.stringify({ decision, reason }),
      });
      setReviewing(null); setReason("");
      addToast(`Order ${decision.toLowerCase()}.`, "success");
      load();
    } catch (e) {
      addToast(e?.message || "Review failed.", "error");
    }
  }

  return (
    <div>
      <div className="lc-tab-hd" style={{ marginBottom:20 }}>
        <div className="lc-tab-hd-left">
          <h2 className="lc-section-title">Flagged Orders (FR56)</h2>
          {orders.length > 0 && <span className="lc-badge-gold">{orders.length}</span>}
        </div>
        <button className="lc-ghost-btn" onClick={load}>
          <i className="bi bi-arrow-clockwise" /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="lc-loading"><div className="lc-spinner" /><span>Loading…</span></div>
      ) : orders.length === 0 ? (
        <div className="lc-empty">
          <i className="bi bi-check-circle-fill" style={{ fontSize:32, color:"var(--uc-acc2)" }} />
          <p>No flagged orders — all clear!</p>
        </div>
      ) : (
        <div data-testid="flagged-orders-list" style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {orders.map(order => (
            <div key={order.order_id} data-testid="flagged-order-card"
              data-order-id={order.order_id} className="lc-flag-card">
              <div className="lc-flag-hd">
                <span className="lc-flag-chip">
                  <i className="bi bi-flag-fill" /> #{order.order_id?.slice(0,8).toUpperCase()}
                </span>
                <span className="lc-order-total">
                  {(order.total_egp ?? 0).toFixed(2)} EGP
                </span>
              </div>
              {order.items?.map((item, i) => (
                <div key={item.item_id || i} className="lc-order-item">
                  {item.quantity}× {item.name} — {(item.subtotal_egp ?? 0).toFixed(2)} EGP
                </div>
              ))}
              <div className="lc-order-actions" style={{ marginTop:14 }}>
                <button data-testid="approve-btn" className="lc-advance-btn"
                  onClick={() => { setReviewing(order); setDecision("APPROVED"); }}>
                  <i className="bi bi-check-lg" /> Approve
                </button>
                <button data-testid="reject-btn" className="lc-danger-btn"
                  onClick={() => { setReviewing(order); setDecision("REJECTED"); }}>
                  <i className="bi bi-x-lg" /> Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {reviewing && (
        <Modal
          title={`${decision} Order #${reviewing.order_id?.slice(0,8).toUpperCase()}`}
          onClose={() => { setReviewing(null); setReason(""); setReasonError(""); }}
        >
          <div className="lc-modal-body">
            <div className="lc-decision-row">
              {["APPROVED","REJECTED"].map(d => (
                <button key={d} onClick={() => setDecision(d)}
                  className={`lc-decision-btn${decision===d?(d==="APPROVED"?" lc-decision-btn--approve":" lc-decision-btn--reject"):""}`}>
                  {d}
                </button>
              ))}
            </div>
            <label className="lc-field-label">Reason *</label>
            <textarea data-testid="review-reason" className="lc-textarea" rows={3}
              value={reason} onChange={e => setReason(e.target.value)}
              placeholder="Provide a clear reason for your decision…" />
            {reasonError && <p data-testid="reason-error" className="lc-field-err">{reasonError}</p>}
          </div>
          <div className="lc-modal-ft">
            <button className="lc-ghost-btn"
              onClick={() => { setReviewing(null); setReason(""); setReasonError(""); }}>
              Cancel
            </button>
            <button data-testid="confirm-review-btn"
              className={decision==="APPROVED" ? "lc-primary-btn" : "lc-danger-btn"}
              onClick={submitReview}>
              <i className={`bi ${decision==="APPROVED"?"bi-check-circle-fill":"bi-x-circle-fill"}`} />
              Confirm {decision}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Config tab (FR54) ─────────────────────────────────────────
function ConfigTab({ role, actorId, addToast }) {
  const [configs,  setConfigs]  = useState([]);
  const [edits,    setEdits]    = useState({});
  const [loading,  setLoading]  = useState(true);
  const normRole = role?.toUpperCase();

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // GET /api/v1/admin/config
        const body = await apiFetch("/admin/config",
          { headers: actorHeaders(normRole, actorId) });
        setConfigs(Array.isArray(body) ? body : []);
      } catch (e) {
        addToast(e?.message || "Failed to load config.", "error");
      } finally {
        setLoading(false);
      }
    })();
  }, []); // eslint-disable-line

  async function save(key) {
    const value = edits[key];
    if (value === undefined) return;
    try {
      // PATCH /api/v1/admin/config/{key}
      await apiFetch(`/admin/config/${key}`, {
        method:  "PATCH",
        headers: actorHeaders(normRole, actorId),
        body:    JSON.stringify({ value }),
      });
      addToast(`"${key}" updated.`, "success");
      setConfigs(prev => prev.map(c => c.key === key ? { ...c, value } : c));
      setEdits(prev => { const n = { ...prev }; delete n[key]; return n; });
    } catch (e) {
      addToast(e?.message || "Config update failed.", "error");
    }
  }

  return (
    <div>
      <div className="lc-tab-hd" style={{ marginBottom:8 }}>
        <h2 className="lc-section-title">System Configuration (FR54)</h2>
      </div>
      <p className="lc-muted" style={{ marginBottom:16 }}>
        All thresholds configurable at runtime — applied within 60 seconds, no restart required.
        Every edit is immutably audit-logged.
      </p>
      <div className="lc-info-banner" style={{ marginBottom:16 }}>
        <i className="bi bi-info-circle-fill" />
        Changes take effect within 60 seconds without a system restart.
      </div>

      {loading ? (
        <div className="lc-loading"><div className="lc-spinner" /><span>Loading config…</span></div>
      ) : (
        <div className="lc-table-card">
          <div className="lc-table-wrap">
            <table className="lc-table">
              <thead><tr><th>Parameter</th><th>Description</th><th>Value</th><th /></tr></thead>
              <tbody>
                {configs.map(c => (
                  <tr key={c.key} data-config-key={c.key}>
                    <td><code className="lc-code">{c.key}</code></td>
                    <td className="lc-td-muted lc-td-note">{c.description}</td>
                    <td>
                      <input data-testid="save-config" className="lc-inline-input"
                        defaultValue={c.value}
                        onChange={e => setEdits(p => ({ ...p, [c.key]: e.target.value }))} />
                    </td>
                    <td>
                      {edits[c.key] !== undefined && edits[c.key] !== c.value ? (
                        <button className="lc-primary-btn"
                          style={{ padding:"5px 14px", fontSize:12 }}
                          onClick={() => save(c.key)}>
                          Save
                        </button>
                      ) : <span className="lc-td-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Audit log tab (NFR20, NFR32) ──────────────────────────────
function AuditTab({ role, actorId }) {
  const [logs,    setLogs]    = useState([]);
  const [loading, setLoading] = useState(true);
  const normRole = role?.toUpperCase();

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // GET /api/v1/admin/audit-log?limit=50
        const body = await apiFetch("/admin/audit-log?limit=50",
          { headers: actorHeaders(normRole, actorId) });
        setLogs(Array.isArray(body) ? body : []);
      } catch {}
      finally { setLoading(false); }
    })();
  }, []); // eslint-disable-line

  return (
    <div>
      <div className="lc-tab-hd" style={{ marginBottom:8 }}>
        <h2 className="lc-section-title">Audit Log (NFR20, NFR32)</h2>
      </div>
      <p className="lc-muted" style={{ marginBottom:20 }}>
        Immutable, append-only record of all system actions. 2-year retention.
        UPDATE and DELETE are blocked at the database rule level.
      </p>
      {loading ? (
        <div className="lc-loading"><div className="lc-spinner" /><span>Loading audit log…</span></div>
      ) : logs.length === 0 ? (
        <div className="lc-empty">
          <i className="bi bi-journal-text" style={{ fontSize:32, color:"var(--uc-muted)" }} />
          <p>No audit entries yet — perform some actions first.</p>
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {logs.map(log => (
            <div key={log.id} className="lc-audit-row">
              <span className="lc-audit-time">{new Date(log.created_at).toLocaleString()}</span>
              <span className="lc-audit-role">{log.actor_role || log.actor_id?.slice(0,8)}</span>
              <span className="lc-audit-action">{log.action || log.event_type}</span>
              <span className="lc-td-muted">
                {log.entity_type}:{(log.entity_id || log.target_id || "")?.toString().slice(0,8)}
              </span>
              {log.detail && <span className="lc-audit-detail">{log.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN — LifecycleDashboard
// Props injected by App.jsx LifecyclePage wrapper
// ════════════════════════════════════════════════════════════
export default function LifecycleDashboard({ role, actorId }) {
  const navigate = useNavigate();
  const { toasts, addToast, removeToast } = useToast();

  const normRole = (role?.toUpperCase()) || "STAFF";
  const isAdmin  = normRole === "ADMIN";

  const [tab, setTab] = useState("orders");

  const TABS = [
    { id:"orders",  icon:"bi-list-ol",      label:"Orders",         roles:["STUDENT","STAFF","ADMIN"] },
    { id:"reports", icon:"bi-graph-up",      label:"Reports",        roles:["ADMIN"]                   },
    { id:"flagged", icon:"bi-flag-fill",     label:"Flagged Orders", roles:["ADMIN"]                   },
    { id:"config",  icon:"bi-sliders",       label:"Config",         roles:["ADMIN"]                   },
    { id:"audit",   icon:"bi-journal-check", label:"Audit Log",      roles:["ADMIN"]                   },
  ].filter(t => t.roles.includes(normRole));

  useEffect(() => {
    if (!TABS.find(t => t.id === tab)) setTab(TABS[0]?.id || "orders");
  }, [normRole]); // eslint-disable-line

  const handleLogout = async () => {
    await apiLogout();
    navigate("/");
  };

  return (
    <>
      <style>{LC_CSS}</style>
      <div className="lc-page">
        <div className="uc-mesh"  aria-hidden="true" />
        <div className="uc-grid"  aria-hidden="true" />

        {/* ── Navbar ── */}
        <nav className="mp-nav">
          <div className="mp-nav-brand">
            <div className="mp-nav-logo">🍽️</div>
            <span className="mp-nav-name">CampusBite</span>
            <span className="lc-role-tag">
              {isAdmin ? "🔴 Admin" : "🟡 Staff"} · lifecycle
            </span>
          </div>

          <div className="mp-nav-tabs">
            <button className="mp-nav-tab" onClick={() => navigate("/menu")}>
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
            <button className="mp-nav-tab mp-nav-tab--active">
              <i className="bi bi-arrow-repeat" /> Lifecycle
            </button>
          </div>

          <div className="mp-nav-actions">
            <button className="mp-logout-btn" onClick={handleLogout} title="Sign out">
              <i className="bi bi-box-arrow-right" />
            </button>
          </div>
        </nav>

        <div className="lc-body">
          <div className="lc-tabs" role="tablist">
            {TABS.map(t => (
              <button key={t.id} role="tab" data-testid={`tab-${t.id}`}
                aria-selected={tab === t.id}
                className={`lc-tab${tab === t.id ? " lc-tab--active" : ""}`}
                onClick={() => setTab(t.id)}>
                <i className={`bi ${t.icon}`} aria-hidden="true" />
                {t.label}
              </button>
            ))}
          </div>

          <div className="lc-tab-content">
            {tab === "orders"  && <OrdersTab  role={normRole} actorId={actorId} addToast={addToast} />}
            {tab === "reports" && <ReportsTab role={normRole} actorId={actorId} addToast={addToast} />}
            {tab === "flagged" && <FlaggedTab role={normRole} actorId={actorId} addToast={addToast} />}
            {tab === "config"  && <ConfigTab  role={normRole} actorId={actorId} addToast={addToast} />}
            {tab === "audit"   && <AuditTab   role={normRole} actorId={actorId} />}
          </div>
        </div>

        <ToastStack toasts={toasts} removeToast={removeToast} />
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════════
// CSS — identical design tokens to all other pages
// ════════════════════════════════════════════════════════════
const LC_CSS = `
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  :root {
    --uc-bg:#080d14; --uc-card:#111825;
    --uc-brd:rgba(255,255,255,0.07); --uc-brd-hi:rgba(99,179,237,0.4);
    --uc-acc:#3b9eda; --uc-acc2:#22c993; --uc-gold:#f6c90e;
    --uc-text:#e8edf5; --uc-muted:#6b7a90;
    --uc-danger:#f56565; --uc-warn:#f6ad55;
    --uc-inp:rgba(255,255,255,0.035);
    --uc-r:14px; --uc-rs:9px;
    --fd:'Sora',sans-serif; --fb:'DM Sans',sans-serif;
  }
  .lc-page { min-height:100vh; background:var(--uc-bg); color:var(--uc-text); font-family:var(--fb); position:relative; }
  .uc-mesh { position:fixed; inset:0; z-index:0; pointer-events:none; overflow:hidden; }
  .uc-mesh::before { content:''; position:absolute; inset:-40%;
    background:
      radial-gradient(ellipse 65% 55% at 15% 25%,rgba(59,158,218,.09) 0%,transparent 60%),
      radial-gradient(ellipse 45% 55% at 85% 75%,rgba(34,201,147,.06) 0%,transparent 55%);
    animation:meshMove 18s ease-in-out infinite alternate; }
  @keyframes meshMove { from{transform:translate(0,0)} to{transform:translate(2%,1.5%) rotate(1deg)} }
  .uc-grid { position:fixed; inset:0; z-index:0; pointer-events:none;
    background-image:linear-gradient(rgba(255,255,255,.013) 1px,transparent 1px),
                     linear-gradient(90deg,rgba(255,255,255,.013) 1px,transparent 1px);
    background-size:52px 52px; }
  .mp-nav { position:sticky; top:0; z-index:200; display:flex; align-items:center;
    justify-content:space-between; padding:0 clamp(16px,3vw,32px); height:60px;
    background:rgba(8,13,20,.9); backdrop-filter:blur(16px); border-bottom:1px solid var(--uc-brd); }
  .mp-nav-brand { display:flex; align-items:center; gap:10px; }
  .mp-nav-logo { width:36px; height:36px; border-radius:10px;
    background:linear-gradient(135deg,var(--uc-acc),var(--uc-acc2));
    display:flex; align-items:center; justify-content:center; font-size:16px; }
  .mp-nav-name { font-family:var(--fd); font-size:16px; font-weight:700; letter-spacing:-.02em; }
  .lc-role-tag { font-size:10px; font-weight:700; letter-spacing:.06em; color:var(--uc-muted);
    background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:100px; padding:3px 9px; }
  .mp-nav-tabs { display:flex; gap:4px; background:var(--uc-inp); border:1px solid var(--uc-brd);
    border-radius:var(--uc-rs); padding:3px; }
  .mp-nav-tab { display:flex; align-items:center; gap:6px; background:none; border:none; border-radius:7px;
    color:var(--uc-muted); font-family:var(--fb); font-size:12.5px; font-weight:600;
    padding:5px 14px; cursor:pointer; transition:all .2s; white-space:nowrap; }
  .mp-nav-tab:hover { color:var(--uc-text); background:rgba(255,255,255,.05); }
  .mp-nav-tab--active { background:var(--uc-card); color:var(--uc-text); box-shadow:0 1px 4px rgba(0,0,0,.35); }
  .mp-nav-actions { display:flex; align-items:center; gap:8px; }
  .mp-logout-btn { width:36px; height:36px; display:flex; align-items:center; justify-content:center;
    background:none; border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-muted); cursor:pointer; font-size:15px; transition:all .2s; }
  .mp-logout-btn:hover { border-color:var(--uc-danger); color:var(--uc-danger); }
  .lc-body { position:relative; z-index:1; padding:clamp(16px,3vw,28px); max-width:1000px; }
  .lc-tabs { display:flex; gap:2px; flex-wrap:wrap; border-bottom:1px solid var(--uc-brd); margin-bottom:24px; }
  .lc-tab { display:flex; align-items:center; gap:6px; background:none; border:none;
    border-bottom:2px solid transparent; color:var(--uc-muted); font-family:var(--fb);
    font-size:12.5px; font-weight:600; padding:10px 14px; cursor:pointer; transition:all .2s; white-space:nowrap; }
  .lc-tab:hover { color:var(--uc-text); }
  .lc-tab--active { color:var(--uc-acc); border-bottom-color:var(--uc-acc); }
  .lc-tab-content { animation:fadeUp .3s ease both; }
  @keyframes fadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
  .lc-tab-hd { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
  .lc-tab-hd-left { display:flex; align-items:center; gap:10px; }
  .lc-section-title { font-family:var(--fd); font-size:18px; font-weight:700; letter-spacing:-.02em; }
  .lc-live-dot { width:10px; height:10px; border-radius:50%; transition:all .5s; flex-shrink:0; }
  .lc-live-label { font-size:11.5px; color:var(--uc-muted); }
  .lc-muted { font-size:13px; color:var(--uc-muted); line-height:1.5; }
  .lc-order-card { background:var(--uc-card); border:1px solid var(--uc-brd); border-radius:var(--uc-r);
    padding:16px 18px; margin-bottom:10px; transition:border-color .2s; }
  .lc-order-card:hover { border-color:var(--uc-brd-hi); }
  .lc-order-hd { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px; }
  .lc-order-id { font-size:12px; color:var(--uc-muted); font-family:monospace; }
  .lc-order-total { font-family:var(--fd); font-weight:700; font-size:14px; color:var(--uc-acc); margin-left:auto; }
  .lc-order-time { font-size:12px; color:var(--uc-muted); }
  .lc-order-items { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; }
  .lc-order-item { display:flex; justify-content:space-between; font-size:12.5px; color:var(--uc-muted);
    padding:3px 0; border-bottom:1px solid rgba(255,255,255,.03); }
  .lc-order-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .lc-status-badge { display:inline-flex; align-items:center; font-size:11px; font-weight:700;
    font-family:monospace; letter-spacing:.06em; padding:3px 10px; border-radius:6px; }
  .lc-group-label { font-size:11px; font-weight:700; letter-spacing:.1em; color:var(--uc-muted); margin-bottom:10px; }
  .lc-flag-card { background:var(--uc-card); border:1px solid rgba(246,201,14,.2); border-radius:var(--uc-r); padding:16px 18px; }
  .lc-flag-hd { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
  .lc-flag-chip { display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:700;
    padding:3px 10px; border-radius:100px; background:rgba(246,201,14,.1);
    color:var(--uc-gold); border:1px solid rgba(246,201,14,.25); }
  .lc-badge-gold { font-size:11px; font-weight:700; padding:2px 9px; border-radius:100px;
    background:rgba(246,201,14,.12); color:var(--uc-gold); border:1px solid rgba(246,201,14,.25); }
  .lc-report-controls { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-start;
    background:var(--uc-card); border:1px solid var(--uc-brd); border-radius:var(--uc-r);
    padding:20px; margin-bottom:4px; }
  .lc-table-meta { font-size:12px; color:var(--uc-muted); padding:12px 16px 0; }
  .lc-audit-row { background:var(--uc-card); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    padding:10px 14px; display:flex; gap:14px; align-items:flex-start; flex-wrap:wrap;
    font-family:monospace; font-size:12px; }
  .lc-audit-time   { color:var(--uc-muted); min-width:160px; }
  .lc-audit-role   { color:var(--uc-acc); min-width:80px; }
  .lc-audit-action { color:#a78bfa; min-width:200px; }
  .lc-audit-detail { color:var(--uc-muted); font-style:italic; }
  .lc-info-banner { display:flex; align-items:center; gap:10px; background:rgba(59,158,218,.07);
    border:1px solid rgba(59,158,218,.2); border-radius:var(--uc-rs); padding:12px 16px;
    font-size:13px; color:var(--uc-acc); }
  .lc-table-card { background:var(--uc-card); border:1px solid var(--uc-brd); border-radius:var(--uc-r); overflow:hidden; }
  .lc-table-wrap { overflow-x:auto; }
  .lc-table { width:100%; border-collapse:collapse; }
  .lc-table th { background:rgba(255,255,255,.025); padding:10px 14px; font-size:10.5px; font-weight:700;
    letter-spacing:.07em; text-transform:uppercase; color:var(--uc-muted); text-align:left;
    white-space:nowrap; border-bottom:1px solid var(--uc-brd); }
  .lc-table td { padding:11px 14px; border-bottom:1px solid rgba(255,255,255,.04); font-size:13px; vertical-align:middle; }
  .lc-table tr:last-child td { border-bottom:none; }
  .lc-table tr:hover td { background:rgba(255,255,255,.018); }
  .lc-td-muted { color:var(--uc-muted); }
  .lc-td-note { max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .lc-code { font-size:11px; font-family:monospace; background:rgba(255,255,255,.05); padding:2px 6px; border-radius:4px; color:var(--uc-muted); }
  .lc-inline-input { background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-text); font-family:var(--fb); font-size:13px; padding:7px 10px;
    outline:none; width:100%; transition:border-color .2s; }
  .lc-inline-input:focus { border-color:var(--uc-acc); }
  .lc-field { display:flex; flex-direction:column; gap:5px; }
  .lc-field-label { font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:var(--uc-muted); }
  .lc-field-err { font-size:11.5px; color:var(--uc-danger); margin-top:4px; }
  .lc-input { background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-text); font-family:var(--fb); font-size:13.5px; padding:10px 12px;
    outline:none; transition:border-color .2s,box-shadow .2s; width:100%; }
  .lc-input:focus { border-color:var(--uc-acc); box-shadow:0 0 0 3px rgba(59,158,218,.12); }
  .lc-input::placeholder { color:rgba(107,122,144,.5); }
  .lc-textarea { background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-text); font-family:var(--fb); font-size:13.5px; padding:10px 12px;
    outline:none; transition:border-color .2s; width:100%; resize:vertical; min-height:72px; }
  .lc-textarea:focus { border-color:var(--uc-acc); box-shadow:0 0 0 3px rgba(59,158,218,.12); }
  .lc-select { background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-text); font-family:var(--fb); font-size:13px; padding:10px 12px;
    outline:none; cursor:pointer; width:100%; transition:border-color .2s; }
  .lc-select:focus { border-color:var(--uc-acc); }
  .lc-select option { background:#1e2433; color:#e2e8f0; }
  .lc-decision-row { display:flex; gap:8px; margin-bottom:12px; }
  .lc-decision-btn { flex:1; padding:9px; border-radius:var(--uc-rs); cursor:pointer;
    border:1px solid var(--uc-brd); background:none; color:var(--uc-muted);
    font-family:var(--fb); font-size:13px; font-weight:600; transition:all .2s; }
  .lc-decision-btn--approve { background:rgba(34,201,147,.12); border-color:rgba(34,201,147,.3); color:var(--uc-acc2); }
  .lc-decision-btn--reject  { background:rgba(245,101,101,.12); border-color:rgba(245,101,101,.3); color:var(--uc-danger); }
  .lc-primary-btn { display:inline-flex; align-items:center; gap:6px;
    background:linear-gradient(135deg,var(--uc-acc),#2878be); border:none; border-radius:var(--uc-rs);
    color:#fff; font-family:var(--fb); font-size:13px; font-weight:700;
    padding:9px 18px; cursor:pointer; box-shadow:0 4px 14px rgba(59,158,218,.25);
    transition:transform .15s,opacity .2s; }
  .lc-primary-btn:hover:not(:disabled) { transform:translateY(-1px); opacity:.9; }
  .lc-primary-btn:disabled { opacity:.4; cursor:not-allowed; transform:none; }
  .lc-danger-btn { display:inline-flex; align-items:center; gap:6px;
    background:rgba(245,101,101,.12); border:1px solid rgba(245,101,101,.3);
    border-radius:var(--uc-rs); color:var(--uc-danger); font-family:var(--fb);
    font-size:13px; font-weight:700; padding:9px 18px; cursor:pointer; transition:all .2s; }
  .lc-danger-btn:hover:not(:disabled) { background:rgba(245,101,101,.2); }
  .lc-danger-btn:disabled { opacity:.4; cursor:not-allowed; }
  .lc-advance-btn { display:inline-flex; align-items:center; gap:6px;
    background:rgba(59,158,218,.12); border:1px solid rgba(59,158,218,.3);
    border-radius:var(--uc-rs); color:var(--uc-acc); font-family:var(--fb);
    font-size:12.5px; font-weight:600; padding:7px 14px; cursor:pointer; transition:all .2s; }
  .lc-advance-btn:hover { background:rgba(59,158,218,.2); }
  .lc-cancel-btn { display:inline-flex; align-items:center; gap:6px; background:none;
    border:1px solid rgba(245,101,101,.3); border-radius:var(--uc-rs);
    color:var(--uc-danger); font-family:var(--fb); font-size:12.5px; font-weight:600;
    padding:7px 14px; cursor:pointer; transition:all .2s; }
  .lc-cancel-btn:hover { background:rgba(245,101,101,.08); }
  .lc-ghost-btn { display:inline-flex; align-items:center; gap:6px; background:var(--uc-inp);
    border:1px solid var(--uc-brd); border-radius:var(--uc-rs); color:var(--uc-muted);
    font-family:var(--fb); font-size:12.5px; padding:7px 14px; cursor:pointer; transition:all .2s; }
  .lc-ghost-btn:hover { border-color:var(--uc-acc); color:var(--uc-text); }
  .lc-icon-btn { width:30px; height:30px; display:flex; align-items:center; justify-content:center;
    background:none; border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-muted); cursor:pointer; font-size:13px; transition:all .2s; }
  .lc-icon-btn:hover { border-color:var(--uc-danger); color:var(--uc-danger); }
  .lc-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.6); backdrop-filter:blur(4px); z-index:500; }
  .lc-modal-wrap { position:fixed; inset:0; z-index:501; display:flex; align-items:center; justify-content:center; padding:20px; }
  .lc-modal { background:var(--uc-card); border:1px solid var(--uc-brd-hi); border-radius:var(--uc-r);
    padding:24px; width:100%; max-width:460px; box-shadow:0 24px 48px rgba(0,0,0,.6);
    display:flex; flex-direction:column; gap:14px; animation:fadeUp .25s ease both; }
  .lc-modal-hd { display:flex; justify-content:space-between; align-items:center; }
  .lc-modal-title { font-family:var(--fd); font-size:16px; font-weight:700; }
  .lc-modal-body { display:flex; flex-direction:column; gap:8px; }
  .lc-modal-ft { display:flex; justify-content:flex-end; gap:10px; }
  .lc-loading { display:flex; flex-direction:column; align-items:center; gap:14px; padding:60px 20px; color:var(--uc-muted); }
  .lc-spinner { width:30px; height:30px; border:3px solid var(--uc-brd); border-top-color:var(--uc-acc); border-radius:50%; animation:spin .7s linear infinite; }
  .lc-spinner-sm { display:inline-block; width:14px; height:14px; border:2px solid rgba(255,255,255,.3); border-top-color:#fff; border-radius:50%; animation:spin .7s linear infinite; }
  @keyframes spin { to{transform:rotate(360deg)} }
  .lc-empty { display:flex; flex-direction:column; align-items:center; gap:12px; padding:60px 20px; color:var(--uc-muted); text-align:center; }
  .uc-toast { display:flex; align-items:center; gap:10px; padding:11px 16px; border-radius:var(--uc-rs);
    font-size:13px; font-weight:500; min-width:260px; max-width:380px; box-shadow:0 8px 24px rgba(0,0,0,.4); animation:fadeUp .3s ease both; }
  .uc-toast--success { background:#0e2e20; border:1px solid rgba(34,201,147,.3); color:var(--uc-acc2); }
  .uc-toast--warn    { background:#2b1f0a; border:1px solid rgba(246,173,85,.3);  color:var(--uc-warn); }
  .uc-toast--error   { background:#2b0e0e; border:1px solid rgba(245,101,101,.3); color:var(--uc-danger); }
  .uc-toast-close    { margin-left:auto; background:none; border:none; cursor:pointer; color:inherit; opacity:.7; font-size:16px; padding:0; }
  @media(max-width:640px) {
    .lc-tabs { gap:0; }
    .lc-tab  { padding:10px 10px; font-size:11.5px; }
    .lc-report-controls { flex-direction:column; }
    .mp-nav-tabs { display:none; }
  }
`;