import { useState, useEffect, useCallback, useRef } from "react";

// ── Config ────────────────────────────────────────────────────────────────────
const API = "http://localhost:8000";

const STATUS_COLORS = {
  DRAFT:           { bg: "#374151", text: "#9CA3AF" },
  PLACED:          { bg: "#1e3a5f", text: "#60A5FA" },
  PAYMENT_PENDING: { bg: "#3b2a00", text: "#FCD34D" },
  CONFIRMED:       { bg: "#1a3a2a", text: "#34D399" },
  PREPARING:       { bg: "#2d1b69", text: "#A78BFA" },
  READY:           { bg: "#1a3a3a", text: "#22D3EE" },
  COLLECTED:       { bg: "#1a2a3a", text: "#93C5FD" },
  COMPLETED:       { bg: "#1a3a1a", text: "#86EFAC" },
  CANCELLED:       { bg: "#3a1a1a", text: "#FCA5A5" },
  PAYMENT_FAILED:  { bg: "#3a1a00", text: "#FDBA74" },
  FLAGGED:         { bg: "#3a2a00", text: "#FDE68A" },
};

const NEXT_STATUS = {
  CONFIRMED: "PREPARING",
  PREPARING: "READY",
  READY:     "COLLECTED",
  COLLECTED: "COMPLETED",
};

const ROLES = ["STUDENT", "STAFF", "ADMIN"];

// ── Helpers ───────────────────────────────────────────────────────────────────
function headers(role, actorId) {
  return {
    "Content-Type": "application/json",
    "X-Actor-Role": role,
    "X-Actor-Id":   actorId || `${role.toLowerCase()}-demo`,
  };
}

async function apiFetch(url, opts = {}) {
  const r = await fetch(API + url, opts);
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

// ── Components ────────────────────────────────────────────────────────────────

function Toast({ msg, type, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [msg]);

  if (!msg) return null;
  const colors = type === "error"
    ? { bg: "#3a1a1a", border: "#EF4444", text: "#FCA5A5" }
    : { bg: "#1a3a1a", border: "#22C55E", text: "#86EFAC" };

  return (
    <div data-testid="toast" style={{
      position: "fixed", bottom: 24, right: 24, zIndex: 9999,
      background: colors.bg, border: `1px solid ${colors.border}`,
      borderRadius: 10, padding: "12px 20px", color: colors.text,
      fontFamily: "monospace", fontSize: 14, maxWidth: 360,
      boxShadow: "0 4px 24px #0006",
    }}>
      {msg}
      <button onClick={onClose} style={{ marginLeft: 12, background: "none", border: "none", color: colors.text, cursor: "pointer" }}>×</button>
    </div>
  );
}

function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || { bg: "#222", text: "#aaa" };
  return (
    <span data-testid="status-badge" style={{
      background: c.bg, color: c.text,
      borderRadius: 6, padding: "2px 10px",
      fontSize: 12, fontWeight: 700, letterSpacing: 1,
      fontFamily: "monospace",
    }}>
      {status}
    </span>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "#000a",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}>
      <div style={{
        background: "#111827", border: "1px solid #374151",
        borderRadius: 14, padding: 28, minWidth: 380, maxWidth: 520,
        boxShadow: "0 8px 40px #000a",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, color: "#F9FAFB", fontFamily: "monospace", fontSize: 16 }}>{title}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Order Card ─────────────────────────────────────────────────────────────────

function OrderCard({ order, role, actorId, onRefresh, onToast }) {
  const [expanding, setExpanding] = useState(false);
  const [showAdvance, setShowAdvance] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("CUSTOMER_REQUEST");
  const [cancelNote, setCancelNote] = useState("");
  const [advanceNote, setAdvanceNote] = useState("");
  const nextStatus = NEXT_STATUS[order.status];
  const canAdvance = (role === "STAFF" || role === "ADMIN") && !!nextStatus;
  const canCancel = (role === "STAFF" || role === "ADMIN") ||
    (role === "STUDENT" && ["PLACED", "PAYMENT_PENDING"].includes(order.status));

  async function doAdvance() {
    const { ok, body } = await apiFetch(`/orders/${order.id}/status`, {
      method: "PATCH",
      headers: headers(role, actorId),
      body: JSON.stringify({ new_status: nextStatus, note: advanceNote || undefined }),
    });
    setShowAdvance(false);
    if (ok) { onToast(`Order advanced to ${nextStatus}`, "success"); onRefresh(); }
    else onToast(body?.detail?.message || "Failed to advance", "error");
  }

  async function doCancel() {
    const { ok, body } = await apiFetch(`/orders/${order.id}/cancel`, {
      method: "POST",
      headers: headers(role, actorId),
      body: JSON.stringify({ reason_code: cancelReason, note: cancelNote || undefined }),
    });
    setShowCancel(false);
    if (ok) { onToast("Order cancelled", "success"); onRefresh(); }
    else onToast(body?.detail?.message || "Failed to cancel", "error");
  }

  return (
    <div data-testid="order-card" data-order-id={order.id} data-status={order.status}
      style={{
        background: "#111827", border: "1px solid #1F2937",
        borderRadius: 12, padding: 18, marginBottom: 12,
        transition: "border-color 0.2s",
      }}>

      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <StatusBadge status={order.status} />
        <span style={{ color: "#9CA3AF", fontSize: 12, fontFamily: "monospace" }}>
          #{order.id.slice(0, 8).toUpperCase()}
        </span>
        <span style={{ color: "#F9FAFB", fontWeight: 600, marginLeft: "auto" }}>
          {order.total_egp?.toFixed(2)} EGP
        </span>
        <span style={{ color: "#6B7280", fontSize: 12 }}>
          {new Date(order.placed_at).toLocaleTimeString()}
        </span>
      </div>

      {/* Items preview */}
      {order.items && (
        <div data-testid="order-items-list" style={{ marginTop: 10 }}>
          {order.items.map(item => (
            <div key={item.item_id} style={{
              display: "flex", justifyContent: "space-between",
              color: "#9CA3AF", fontSize: 13, paddingLeft: 4,
            }}>
              <span>{item.quantity}× {item.name}</span>
              <span>{item.subtotal_egp.toFixed(2)} EGP</span>
            </div>
          ))}
        </div>
      )}

      {/* Action buttons */}
      {(canAdvance || canCancel) && (
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          {canAdvance && (
            <button data-testid="advance-btn"
              onClick={() => setShowAdvance(true)}
              style={{
                background: "#1D4ED8", color: "#fff", border: "none",
                borderRadius: 7, padding: "7px 16px", cursor: "pointer",
                fontSize: 13, fontWeight: 600,
              }}>
              → {nextStatus}
            </button>
          )}
          {canCancel && !["COMPLETED","CANCELLED","PAYMENT_FAILED"].includes(order.status) && (
            <button data-testid="cancel-btn"
              onClick={() => setShowCancel(true)}
              style={{
                background: "transparent", color: "#F87171",
                border: "1px solid #F87171",
                borderRadius: 7, padding: "7px 16px", cursor: "pointer",
                fontSize: 13,
              }}>
              Cancel
            </button>
          )}
        </div>
      )}

      {/* Advance modal */}
      {showAdvance && (
        <Modal title={`Advance to ${nextStatus}`} onClose={() => setShowAdvance(false)}>
          <label style={{ color: "#9CA3AF", fontSize: 13 }}>Optional note</label>
          <input value={advanceNote} onChange={e => setAdvanceNote(e.target.value)}
            placeholder="e.g. Started at station 2"
            style={{
              width: "100%", marginTop: 6, marginBottom: 16,
              background: "#1F2937", border: "1px solid #374151",
              borderRadius: 7, padding: "8px 12px", color: "#F9FAFB",
              fontSize: 14, boxSizing: "border-box",
            }} />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button onClick={() => setShowAdvance(false)}
              style={{ background: "none", border: "1px solid #374151", color: "#9CA3AF", borderRadius: 7, padding: "8px 16px", cursor: "pointer" }}>
              Cancel
            </button>
            <button data-testid="confirm-advance-btn" onClick={doAdvance}
              style={{ background: "#1D4ED8", color: "#fff", border: "none", borderRadius: 7, padding: "8px 20px", cursor: "pointer", fontWeight: 600 }}>
              Confirm
            </button>
          </div>
        </Modal>
      )}

      {/* Cancel modal */}
      {showCancel && (
        <Modal title="Cancel Order" onClose={() => setShowCancel(false)}>
          <label style={{ color: "#9CA3AF", fontSize: 13 }}>Reason *</label>
          <select data-testid="cancel-reason-select"
            value={cancelReason} onChange={e => setCancelReason(e.target.value)}
            style={{
              width: "100%", marginTop: 6, marginBottom: 12,
              background: "#1F2937", border: "1px solid #374151",
              borderRadius: 7, padding: "8px 12px", color: "#F9FAFB", fontSize: 14,
            }}>
            {["CUSTOMER_REQUEST","OUT_OF_STOCK","STAFF_ERROR","SYSTEM_ERROR","SUSPICIOUS_ORDER"].map(r => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <label style={{ color: "#9CA3AF", fontSize: 13 }}>Note</label>
          <input data-testid="cancel-note" value={cancelNote}
            onChange={e => setCancelNote(e.target.value)}
            placeholder="Optional additional details"
            style={{
              width: "100%", marginTop: 6, marginBottom: 16,
              background: "#1F2937", border: "1px solid #374151",
              borderRadius: 7, padding: "8px 12px", color: "#F9FAFB", fontSize: 14,
              boxSizing: "border-box",
            }} />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button onClick={() => setShowCancel(false)}
              style={{ background: "none", border: "1px solid #374151", color: "#9CA3AF", borderRadius: 7, padding: "8px 16px", cursor: "pointer" }}>
              Back
            </button>
            <button data-testid="confirm-cancel-btn" onClick={doCancel}
              style={{ background: "#DC2626", color: "#fff", border: "none", borderRadius: 7, padding: "8px 20px", cursor: "pointer", fontWeight: 600 }}>
              Cancel Order
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Orders Tab ─────────────────────────────────────────────────────────────────

function OrdersTab({ role, actorId, toast }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [liveActive, setLiveActive] = useState(false);
  const esRefs = useRef({});

  const load = useCallback(async () => {
    setLoading(true);
    // Fetch all demo orders
    const ids = ["order-demo-1","order-demo-2","order-demo-3","order-demo-4","order-demo-5"];
    const results = await Promise.all(ids.map(id =>
      apiFetch(`/orders/${id}`, { headers: headers(role, actorId) })
    ));
    setOrders(results.filter(r => r.ok).map(r => r.body));
    setLoading(false);
  }, [role, actorId]);

  useEffect(() => { load(); }, [load]);

  // Subscribe to SSE for each order (FR36)
  useEffect(() => {
    orders.forEach(order => {
      if (esRefs.current[order.id]) return;
      const es = new EventSource(`${API}/orders/${order.id}/stream`);
      es.onmessage = (e) => {
        const data = JSON.parse(e.data);
        setOrders(prev => prev.map(o =>
          o.id === data.order_id ? { ...o, status: data.new_status } : o
        ));
        setLiveActive(true);
      };
      esRefs.current[order.id] = es;
    });
    return () => Object.values(esRefs.current).forEach(es => es.close());
  }, [orders.length]);

  const grouped = {
    Active: orders.filter(o => ["PLACED","PAYMENT_PENDING","CONFIRMED","PREPARING","READY","COLLECTED"].includes(o.status)),
    Completed: orders.filter(o => o.status === "COMPLETED"),
    Cancelled: orders.filter(o => ["CANCELLED","PAYMENT_FAILED"].includes(o.status)),
    Flagged: orders.filter(o => o.status === "FLAGGED"),
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: "#F9FAFB", fontFamily: "monospace" }}>Order Dashboard</h2>
        <div data-testid="live-indicator" style={{
          width: 10, height: 10, borderRadius: "50%",
          background: liveActive ? "#22C55E" : "#374151",
          boxShadow: liveActive ? "0 0 8px #22C55E" : "none",
          transition: "all 0.5s",
        }} title="Live SSE updates" />
        <span style={{ color: "#6B7280", fontSize: 12 }}>
          {liveActive ? "Live" : "Connecting..."}
        </span>
        <button onClick={load} style={{
          marginLeft: "auto", background: "none", border: "1px solid #374151",
          color: "#9CA3AF", borderRadius: 7, padding: "6px 14px",
          cursor: "pointer", fontSize: 13,
        }}>↻ Refresh</button>
      </div>

      {loading ? (
        <div style={{ color: "#6B7280", textAlign: "center", padding: 40 }}>Loading orders...</div>
      ) : (
        <div data-testid="orders-list">
          {Object.entries(grouped).map(([group, list]) => list.length > 0 && (
            <div key={group} style={{ marginBottom: 28 }}>
              <div style={{
                color: "#6B7280", fontSize: 11, fontWeight: 700,
                letterSpacing: 2, marginBottom: 10, fontFamily: "monospace",
              }}>
                {group.toUpperCase()} ({list.length})
              </div>
              {list.map(order => (
                <OrderCard key={order.id} order={order} role={role} actorId={actorId}
                  onRefresh={load} onToast={toast} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Reports Tab ───────────────────────────────────────────────────────────────

function ReportsTab({ role, actorId, toast }) {
  const [type, setType] = useState("revenue");
  const [from, setFrom] = useState("2026-04-01");
  const [to, setTo] = useState("2026-05-17");
  const [data, setData] = useState(null);
  const [asyncJob, setAsyncJob] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dateError, setDateError] = useState("");

  async function generate() {
    if (!from || !to) { setDateError("Both dates are required"); return; }
    setDateError("");
    setLoading(true);
    setData(null);
    setAsyncJob(null);
    const { ok, body } = await apiFetch(
      `/admin/reports?type=${type}&from=${from}&to=${to}`,
      { headers: headers(role, actorId) }
    );
    setLoading(false);
    if (!ok) { toast(body?.detail?.message || "Report failed", "error"); return; }
    if (body.job_id) setAsyncJob(body);
    else setData(body);
  }

  return (
    <div>
      <h2 style={{ margin: "0 0 20px", color: "#F9FAFB", fontFamily: "monospace" }}>Analytics Reports</h2>

      {/* Controls */}
      <div style={{
        background: "#111827", border: "1px solid #1F2937",
        borderRadius: 12, padding: 20, marginBottom: 20,
        display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end",
      }}>
        <div>
          <label style={{ display: "block", color: "#9CA3AF", fontSize: 12, marginBottom: 6 }}>Report Type</label>
          <select data-testid="report-type-select" value={type} onChange={e => setType(e.target.value)}
            style={{
              background: "#1F2937", border: "1px solid #374151",
              borderRadius: 7, padding: "8px 12px", color: "#F9FAFB", fontSize: 14,
            }}>
            {["revenue","top_items","cancellations","heatmap","ratings"].map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ display: "block", color: "#9CA3AF", fontSize: 12, marginBottom: 6 }}>From</label>
          <input data-testid="report-from" type="date" value={from}
            onChange={e => setFrom(e.target.value)}
            style={{
              background: "#1F2937", border: "1px solid #374151",
              borderRadius: 7, padding: "8px 12px", color: "#F9FAFB", fontSize: 14,
            }} />
        </div>
        <div>
          <label style={{ display: "block", color: "#9CA3AF", fontSize: 12, marginBottom: 6 }}>To</label>
          <input data-testid="report-to" type="date" value={to}
            onChange={e => setTo(e.target.value)}
            style={{
              background: "#1F2937", border: "1px solid #374151",
              borderRadius: 7, padding: "8px 12px", color: "#F9FAFB", fontSize: 14,
            }} />
        </div>
        <button data-testid="generate-report-btn" onClick={generate}
          style={{
            background: "#1D4ED8", color: "#fff", border: "none",
            borderRadius: 7, padding: "9px 22px", cursor: "pointer",
            fontSize: 14, fontWeight: 600,
          }}>
          Generate
        </button>
      </div>
      {dateError && <div data-testid="date-error" style={{ color: "#F87171", fontSize: 13, marginBottom: 12 }}>{dateError}</div>}

      {/* Results */}
      {loading && <div style={{ color: "#6B7280", padding: 20 }}>Generating report...</div>}

      {asyncJob && (
        <div data-testid="async-job-notice" style={{
          background: "#3b2a00", border: "1px solid #FCD34D",
          borderRadius: 10, padding: 18, color: "#FCD34D",
        }}>
          📋 Date range exceeds 90 days — report is being generated as a background job.<br />
          <strong>Job ID:</strong> {asyncJob.job_id}<br />
          <strong>Estimated completion:</strong> {new Date(asyncJob.estimated_completion).toLocaleTimeString()}
        </div>
      )}

      {data && (
        <div data-testid="report-results">
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            marginBottom: 14,
          }}>
            <span style={{ color: "#9CA3AF", fontSize: 13 }}>
              {data.report_type} · {data.from} → {data.to} · {data.data?.length || 0} rows
            </span>
          </div>
          {data.data?.length === 0 ? (
            <div style={{ color: "#6B7280", padding: 20, textAlign: "center" }}>No data for this period</div>
          ) : (
            <div style={{
              background: "#111827", border: "1px solid #1F2937",
              borderRadius: 10, overflow: "auto",
            }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: 13 }}>
                <thead>
                  <tr>
                    {data.data?.[0] && Object.keys(data.data[0]).map(k => (
                      <th key={k} style={{
                        padding: "10px 14px", textAlign: "left",
                        color: "#6B7280", borderBottom: "1px solid #1F2937",
                        fontWeight: 600, letterSpacing: 1, fontSize: 11,
                      }}>{k.toUpperCase()}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.data?.map((row, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #1F2937" }}>
                      {Object.values(row).map((v, j) => (
                        <td key={j} style={{ padding: "9px 14px", color: "#D1D5DB" }}>
                          {typeof v === "object" ? JSON.stringify(v) : String(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Flagged Orders Tab ─────────────────────────────────────────────────────────

function FlaggedTab({ role, actorId, toast }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState(null);
  const [decision, setDecision] = useState("APPROVED");
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, body } = await apiFetch("/admin/flagged-orders", { headers: headers(role, actorId) });
    setLoading(false);
    if (ok) setOrders(body);
  }, [role, actorId]);

  useEffect(() => { load(); }, [load]);

  async function submitReview() {
    if (!reason.trim()) { setReasonError("Reason is required"); return; }
    setReasonError("");
    const { ok, body } = await apiFetch(
      `/admin/flagged-orders/${reviewing.order_id}/review`,
      {
        method: "POST",
        headers: headers(role, actorId),
        body: JSON.stringify({ decision, reason }),
      }
    );
    setReviewing(null);
    setReason("");
    if (ok) { toast(`Order ${decision.toLowerCase()}`, "success"); load(); }
    else toast(body?.detail?.message || "Review failed", "error");
  }

  return (
    <div>
      <h2 style={{ margin: "0 0 20px", color: "#F9FAFB", fontFamily: "monospace" }}>
        Flagged Orders {orders.length > 0 && (
          <span style={{
            background: "#FDE68A", color: "#78350F",
            borderRadius: 99, padding: "2px 10px", fontSize: 12, marginLeft: 10,
          }}>{orders.length}</span>
        )}
      </h2>

      {loading ? (
        <div style={{ color: "#6B7280", padding: 20 }}>Loading...</div>
      ) : orders.length === 0 ? (
        <div style={{ color: "#6B7280", padding: 20, textAlign: "center" }}>No flagged orders 🎉</div>
      ) : (
        <div data-testid="flagged-orders-list">
          {orders.map(order => (
            <div key={order.order_id} data-testid="flagged-order-card" data-order-id={order.order_id}
              style={{
                background: "#111827", border: "1px solid #FDE68A33",
                borderRadius: 12, padding: 18, marginBottom: 12,
              }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
                <span style={{ color: "#FDE68A", fontWeight: 700, fontFamily: "monospace" }}>
                  ⚠ #{order.order_id.slice(0,8).toUpperCase()}
                </span>
                <span style={{ color: "#F9FAFB", marginLeft: "auto", fontWeight: 600 }}>
                  {order.total_egp?.toFixed(2)} EGP
                </span>
              </div>
              {order.items?.map(item => (
                <div key={item.item_id} style={{ color: "#9CA3AF", fontSize: 13 }}>
                  {item.quantity}× {item.name} — {item.subtotal_egp.toFixed(2)} EGP
                </div>
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <button data-testid="approve-btn"
                  onClick={() => { setReviewing(order); setDecision("APPROVED"); }}
                  style={{
                    background: "#166534", color: "#86EFAC", border: "none",
                    borderRadius: 7, padding: "7px 16px", cursor: "pointer", fontWeight: 600,
                  }}>
                  ✓ Approve
                </button>
                <button data-testid="reject-btn"
                  onClick={() => { setReviewing(order); setDecision("REJECTED"); }}
                  style={{
                    background: "#7F1D1D", color: "#FCA5A5", border: "none",
                    borderRadius: 7, padding: "7px 16px", cursor: "pointer", fontWeight: 600,
                  }}>
                  ✕ Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {reviewing && (
        <Modal title={`${decision} Order #${reviewing.order_id.slice(0,8).toUpperCase()}`}
          onClose={() => { setReviewing(null); setReason(""); setReasonError(""); }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            {["APPROVED","REJECTED"].map(d => (
              <button key={d} onClick={() => setDecision(d)}
                style={{
                  flex: 1, padding: "8px 0", borderRadius: 7, cursor: "pointer",
                  border: decision === d ? "none" : "1px solid #374151",
                  background: decision === d ? (d === "APPROVED" ? "#166534" : "#7F1D1D") : "none",
                  color: decision === d ? "#fff" : "#9CA3AF", fontWeight: 600,
                }}>
                {d}
              </button>
            ))}
          </div>
          <label style={{ color: "#9CA3AF", fontSize: 13 }}>Reason *</label>
          <textarea data-testid="review-reason"
            value={reason} onChange={e => setReason(e.target.value)}
            rows={3} placeholder="Provide a clear reason for your decision..."
            style={{
              width: "100%", marginTop: 6, marginBottom: 4,
              background: "#1F2937", border: "1px solid #374151",
              borderRadius: 7, padding: "8px 12px", color: "#F9FAFB",
              fontSize: 14, boxSizing: "border-box", resize: "vertical",
            }} />
          {reasonError && <div data-testid="reason-error" style={{ color: "#F87171", fontSize: 12, marginBottom: 8 }}>{reasonError}</div>}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
            <button onClick={() => { setReviewing(null); setReason(""); setReasonError(""); }}
              style={{ background: "none", border: "1px solid #374151", color: "#9CA3AF", borderRadius: 7, padding: "8px 16px", cursor: "pointer" }}>
              Cancel
            </button>
            <button data-testid="confirm-review-btn" onClick={submitReview}
              style={{
                background: decision === "APPROVED" ? "#1D4ED8" : "#DC2626",
                color: "#fff", border: "none", borderRadius: 7,
                padding: "8px 20px", cursor: "pointer", fontWeight: 600,
              }}>
              Confirm {decision}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Config Tab ─────────────────────────────────────────────────────────────────

function ConfigTab({ role, actorId, toast }) {
  const [configs, setConfigs] = useState([]);
  const [edits, setEdits] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { ok, body } = await apiFetch("/admin/config", { headers: headers(role, actorId) });
      setLoading(false);
      if (ok) setConfigs(body);
    })();
  }, []);

  async function save(key) {
    const value = edits[key];
    if (!value) return;
    const { ok, body } = await apiFetch(`/admin/config/${key}`, {
      method: "PATCH",
      headers: headers(role, actorId),
      body: JSON.stringify({ value }),
    });
    if (ok) {
      toast(`Config '${key}' updated`, "success");
      setConfigs(prev => prev.map(c => c.key === key ? { ...c, value } : c));
      setEdits(prev => { const n = { ...prev }; delete n[key]; return n; });
    } else toast(body?.detail?.message || "Update failed", "error");
  }

  return (
    <div>
      <h2 style={{ margin: "0 0 20px", color: "#F9FAFB", fontFamily: "monospace" }}>System Configuration</h2>
      <p style={{ color: "#6B7280", fontSize: 13, marginBottom: 20 }}>
        All thresholds are configurable at runtime — no restart required (FR54).
      </p>
      {loading ? (
        <div style={{ color: "#6B7280" }}>Loading config...</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {configs.map(cfg => (
            <div key={cfg.key} data-config-key={cfg.key}
              style={{
                background: "#111827", border: "1px solid #1F2937",
                borderRadius: 10, padding: 16,
                display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap",
              }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ color: "#93C5FD", fontFamily: "monospace", fontSize: 14, fontWeight: 600 }}>{cfg.key}</div>
                <div style={{ color: "#6B7280", fontSize: 12, marginTop: 2 }}>{cfg.description}</div>
              </div>
              <input
                defaultValue={cfg.value}
                onChange={e => setEdits(prev => ({ ...prev, [cfg.key]: e.target.value }))}
                style={{
                  background: "#1F2937", border: "1px solid #374151",
                  borderRadius: 7, padding: "7px 12px", color: "#F9FAFB",
                  fontSize: 14, width: 100, textAlign: "center",
                }}
              />
              <button data-testid="save-config" onClick={() => save(cfg.key)}
                disabled={!edits[cfg.key]}
                style={{
                  background: edits[cfg.key] ? "#1D4ED8" : "#1F2937",
                  color: edits[cfg.key] ? "#fff" : "#6B7280",
                  border: "none", borderRadius: 7,
                  padding: "7px 16px", cursor: edits[cfg.key] ? "pointer" : "default",
                  fontSize: 13, fontWeight: 600, transition: "all 0.2s",
                }}>
                Save
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Audit Log Tab ─────────────────────────────────────────────────────────────

function AuditTab({ role, actorId }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { ok, body } = await apiFetch("/admin/audit-log?limit=50", { headers: headers(role, actorId) });
      setLoading(false);
      if (ok) setLogs(body);
    })();
  }, []);

  return (
    <div>
      <h2 style={{ margin: "0 0 8px", color: "#F9FAFB", fontFamily: "monospace" }}>Audit Log</h2>
      <p style={{ color: "#6B7280", fontSize: 13, marginBottom: 20 }}>
        Immutable write-only record of all system actions (NFR20, NFR32). 2-year retention.
      </p>
      {loading ? (
        <div style={{ color: "#6B7280" }}>Loading audit log...</div>
      ) : logs.length === 0 ? (
        <div style={{ color: "#6B7280", textAlign: "center", padding: 40 }}>No audit entries yet — perform some actions first.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {logs.map(log => (
            <div key={log.id} style={{
              background: "#111827", border: "1px solid #1F2937",
              borderRadius: 8, padding: "10px 14px",
              display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap",
              fontFamily: "monospace", fontSize: 12,
            }}>
              <span style={{ color: "#6B7280", minWidth: 160 }}>
                {new Date(log.created_at).toLocaleString()}
              </span>
              <span style={{ color: "#60A5FA", minWidth: 80 }}>{log.actor_role}</span>
              <span style={{ color: "#A78BFA", minWidth: 200 }}>{log.action}</span>
              <span style={{ color: "#9CA3AF" }}>{log.entity_type}:{log.entity_id.slice(0,8)}</span>
              {log.detail && (
                <span style={{ color: "#6B7280", fontStyle: "italic" }}>{log.detail}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── App Root ──────────────────────────────────────────────────────────────────

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const [role, setRole] = useState(params.get("role") || "STAFF");
  const [actorId, setActorId] = useState(params.get("actor") || "staff-demo");
  const [tab, setTab] = useState("orders");
  const [toast, setToast] = useState({ msg: "", type: "success" });

  const showToast = (msg, type = "success") => setToast({ msg, type });

  const TABS = [
    { id: "orders",  label: "Orders",        roles: ["STUDENT","STAFF","ADMIN"] },
    { id: "reports", label: "Reports",       roles: ["ADMIN"] },
    { id: "flagged", label: "Flagged Orders",roles: ["ADMIN"] },
    { id: "config",  label: "Config",        roles: ["ADMIN"] },
    { id: "audit",   label: "Audit Log",     roles: ["ADMIN"] },
  ].filter(t => t.roles.includes(role));

  // Reset tab when role changes
  useEffect(() => {
    if (!TABS.find(t => t.id === tab)) setTab(TABS[0]?.id || "orders");
  }, [role]);

  return (
    <div style={{
      minHeight: "100vh",
      background: "#030712",
      color: "#F9FAFB",
      fontFamily: "'IBM Plex Mono', 'Fira Code', monospace",
    }}>
      {/* Header */}
      <div style={{
        background: "#0D1117",
        borderBottom: "1px solid #1F2937",
        padding: "14px 28px",
        display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap",
      }}>
        <div>
          <span style={{ fontSize: 18, fontWeight: 700, color: "#60A5FA", letterSpacing: 1 }}>
            🍽 Cafeteria OS
          </span>
          <span style={{ color: "#374151", marginLeft: 12, fontSize: 12 }}>
            feature/lifecycle-reports
          </span>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
          <select value={role} onChange={e => setRole(e.target.value)}
            style={{
              background: "#1F2937", border: "1px solid #374151",
              borderRadius: 7, padding: "6px 12px", color: "#F9FAFB", fontSize: 13,
            }}>
            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <span style={{ color: "#6B7280", fontSize: 12 }}>
            {role === "ADMIN" ? "🔴 Admin" : role === "STAFF" ? "🟡 Staff" : "🟢 Student"}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div style={{
        background: "#0D1117",
        borderBottom: "1px solid #1F2937",
        padding: "0 28px",
        display: "flex", gap: 4,
      }}>
        {TABS.map(t => (
          <button key={t.id} data-testid={`tab-${t.id}`}
            onClick={() => setTab(t.id)}
            style={{
              background: "none",
              border: "none",
              borderBottom: tab === t.id ? "2px solid #60A5FA" : "2px solid transparent",
              color: tab === t.id ? "#60A5FA" : "#6B7280",
              padding: "12px 16px",
              cursor: "pointer",
              fontSize: 13,
              fontFamily: "inherit",
              fontWeight: tab === t.id ? 600 : 400,
              transition: "all 0.15s",
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: "28px", maxWidth: 900, margin: "0 auto" }}>
        {tab === "orders"  && <OrdersTab  role={role} actorId={actorId} toast={showToast} />}
        {tab === "reports" && <ReportsTab role={role} actorId={actorId} toast={showToast} />}
        {tab === "flagged" && <FlaggedTab role={role} actorId={actorId} toast={showToast} />}
        {tab === "config"  && <ConfigTab  role={role} actorId={actorId} toast={showToast} />}
        {tab === "audit"   && <AuditTab   role={role} actorId={actorId} />}
      </div>

      <Toast msg={toast.msg} type={toast.type} onClose={() => setToast({ msg: "", type: "success" })} />
    </div>
  );
}
