// ============================================================
// frontend/src/features/stock/StockDashboard.jsx
// ── FIXES APPLIED ────────────────────────────────────────────
// FIX-1: Removed the entire local `apiFetch` definition that
//         hardcoded "/api/v1/stock" as the base. This means every
//         call was hitting "/api/v1/stock/api/v1/stock/..." when
//         combined with the path argument. Now imports the shared
//         `apiFetch` and `apiLogout` from "../../shared/api".
//         All paths are adjusted: "/availability" → "/stock/availability"
//         so they resolve correctly against the shared BASE = "/api/v1".
//
// FIX-2: handleLogout now uses shared `apiLogout` — consistent
//         with every other feature file.
//
// FIX-3: Added a "Lifecycle" nav link in the navbar so staff/admin
//         can navigate there directly from StockDashboard.
// ============================================================

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, apiLogout } from "../../shared/api";  // FIX-1 + FIX-2

// ── Fonts & Icons (same as Login) ─────────────────────────────
if (typeof document !== "undefined") {
  if (!document.querySelector('link[href*="Sora"]')) {
    const f = document.createElement("link");
    f.rel = "stylesheet";
    f.href = "https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&family=DM+Sans:wght@400;500;600&display=swap";
    document.head.appendChild(f);
  }
  if (!document.querySelector('link[href*="bootstrap-icons"]')) {
    const i = document.createElement("link");
    i.rel = "stylesheet";
    i.href = "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css";
    document.head.appendChild(i);
  }
}

// ── Stock helpers ─────────────────────────────────────────────
function stockStatus(available, total) {
  if (available <= 0)                        return { label: "Out of Stock", color: "var(--uc-danger)", cls: "oos" };
  if (available / (total || 1) < 0.2)       return { label: "Low Stock",    color: "var(--uc-warn)",   cls: "low" };
  return                                            { label: "Available",    color: "var(--uc-acc2)",   cls: "ok"  };
}

// ── Toast ─────────────────────────────────────────────────────
function Toast({ toasts, removeToast }) {
  return (
    <div style={{ position:"fixed", bottom:24, right:24, zIndex:9999, display:"flex", flexDirection:"column", gap:8 }}>
      {toasts.map(t => (
        <div key={t.id} className={`sd-toast sd-toast--${t.type}`}>
          <i className={`bi ${t.type==="success"?"bi-check-circle-fill":t.type==="warn"?"bi-exclamation-triangle-fill":"bi-x-circle-fill"}`} />
          <span>{t.message}</span>
          <button onClick={() => removeToast(t.id)} className="sd-toast-close"><i className="bi bi-x" /></button>
        </div>
      ))}
    </div>
  );
}

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

// ── Confirm modal ─────────────────────────────────────────────
function ConfirmModal({ title, message, confirmLabel, danger, onConfirm, onCancel, loading, children }) {
  return (
    <>
      <div className="sd-backdrop" onClick={onCancel} />
      <div className="sd-modal-wrap" role="dialog" aria-modal="true">
        <div className="sd-modal">
          <div className="sd-modal-hd">
            <h3 className="sd-modal-title">{title}</h3>
            <button className="sd-icon-btn" onClick={onCancel} aria-label="Close"><i className="bi bi-x-lg" /></button>
          </div>
          {message && <p className="sd-modal-msg">{message}</p>}
          {children}
          <div className="sd-modal-actions">
            <button className="sd-ghost-btn" onClick={onCancel} disabled={loading}>Cancel</button>
            <button
              className={`sd-action-btn ${danger ? "sd-action-btn--danger" : "sd-action-btn--primary"}`}
              onClick={onConfirm}
              disabled={loading}
            >
              {loading ? <><span className="sd-spinner-sm" /> Processing…</> : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Stock bar ─────────────────────────────────────────────────
function StockBar({ available, total, locked }) {
  const pct  = total > 0 ? Math.max(0, (available / total) * 100) : 0;
  const lpct = total > 0 ? Math.min(100, (locked  / total) * 100) : 0;
  const { color } = stockStatus(available, total);
  return (
    <div>
      <div className="sd-bar-track">
        <div className="sd-bar-fill" style={{ width:`${pct}%`, background:color }} />
        {lpct > 0 && <div className="sd-bar-locked" style={{ width:`${lpct}%` }} />}
      </div>
      <div className="sd-bar-labels">
        <span>{available} free</span>
        {locked > 0 && <span className="sd-lock-chip"><i className="bi bi-lock-fill" /> {locked} locked</span>}
        <span>{total} total</span>
      </div>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────
function StatCard({ icon, label, value, color, sub }) {
  return (
    <div className="sd-stat">
      <i className={`bi ${icon}`} style={{ color, fontSize:22 }} />
      <div>
        <div className="sd-stat-val" style={{ color }}>{value}</div>
        <div className="sd-stat-label">{label}</div>
        {sub && <div className="sd-stat-sub">{sub}</div>}
      </div>
    </div>
  );
}

// ── Txn badge ─────────────────────────────────────────────────
function TxnBadge({ type }) {
  const map = {
    RESERVE:      { color:"var(--uc-acc)",    icon:"bi-lock-fill"       },
    DEDUCT:       { color:"var(--uc-danger)", icon:"bi-dash-circle-fill" },
    RELEASE:      { color:"var(--uc-acc2)",   icon:"bi-unlock-fill"     },
    RESTOCK:      { color:"#a78bfa",          icon:"bi-plus-circle-fill" },
    CORRECTION:   { color:"var(--uc-warn)",   icon:"bi-pencil-fill"     },
    ADMIN_DEDUCT: { color:"var(--uc-muted)",  icon:"bi-trash-fill"      },
  };
  const m = map[type] || { color:"var(--uc-muted)", icon:"bi-question-circle" };
  return (
    <span className="sd-txn-badge" style={{ color:m.color, borderColor:`${m.color}33`, background:`${m.color}11` }}>
      <i className={`bi ${m.icon}`} /> {type}
    </span>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ════════════════════════════════════════════════════════════
export default function StockDashboard() {
  const navigate = useNavigate();
  const { toasts, addToast, removeToast } = useToast();

  const [tab,          setTab]          = useState("overview");
  const [items,        setItems]        = useState([]);
  const [activeLocks,  setActiveLocks]  = useState([]);
  const [flagged,      setFlagged]      = useState([]);
  const [config,       setConfig]       = useState([]);
  const [ledger,       setLedger]       = useState({ transactions:[], total:0 });
  const [ledgerItem,   setLedgerItem]   = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [search,       setSearch]       = useState("");

  // Modals
  const [restockModal, setRestockModal] = useState(null);
  const [restockQty,   setRestockQty]   = useState(1);
  const [restockNote,  setRestockNote]  = useState("");
  const [correctModal, setCorrectModal] = useState(null);
  const [correctQty,   setCorrectQty]   = useState(0);
  const [correctNote,  setCorrectNote]  = useState("");
  const [configEdit,   setConfigEdit]   = useState({});
  const [releaseModal, setReleaseModal] = useState(null);

  // ── Loaders ───────────────────────────────────────────────
  // FIX-1: all paths now prefixed with "/stock/" to resolve against BASE="/api/v1"
  const loadItems = useCallback(async () => {
    try {
      const data = await apiFetch("/stock/availability");
      setItems(Array.isArray(data) ? data : []);
    } catch (e) { addToast(e.message || "Failed to load stock.", "error"); }
  }, [addToast]);

  const loadLocks = useCallback(async () => {
    try {
      const data = await apiFetch("/stock/locks/active");
      setActiveLocks(data.active_locks || []);
    } catch (e) { addToast(e.message || "Failed to load locks.", "error"); }
  }, [addToast]);

  const loadFlagged = useCallback(async () => {
    try {
      const data = await apiFetch("/stock/flagged?status=PENDING");
      setFlagged(Array.isArray(data) ? data : []);
    } catch (e) { addToast(e.message || "Failed to load flagged orders.", "error"); }
  }, [addToast]);

  const loadConfig = useCallback(async () => {
    try {
      const data = await apiFetch("/stock/config");
      setConfig(Array.isArray(data) ? data : []);
    } catch (e) { addToast(e.message || "Failed to load config.", "error"); }
  }, [addToast]);

  const loadLedger = useCallback(async (itemId) => {
    if (!itemId) return;
    try {
      const data = await apiFetch(`/stock/transactions/${itemId}`);
      setLedger(data);
    } catch (e) { addToast(e.message || "Failed to load ledger.", "error"); }
  }, [addToast]);

  useEffect(() => {
    loadItems();
    const id = setInterval(loadItems, 30000);
    return () => clearInterval(id);
  }, [loadItems]);

  useEffect(() => {
    if (tab === "locks")   loadLocks();
    if (tab === "flagged") loadFlagged();
    if (tab === "config")  loadConfig();
    if (tab === "ledger" && ledgerItem) loadLedger(ledgerItem);
  }, [tab, loadLocks, loadFlagged, loadConfig, loadLedger, ledgerItem]);

  // ── Restock ────────────────────────────────────────────────
  const handleRestock = async () => {
    if (!restockModal) return;
    setLoading(true);
    try {
      const data = await apiFetch(`/stock/${restockModal.menu_item_id}/restock`, {
        method: "POST",
        body: JSON.stringify({ quantity: restockQty, note: restockNote || null }),
      });
      addToast(`Restocked "${restockModal.item_name}" — new total: ${data.new_stock_qty}`, "success");
      setRestockModal(null);
      setRestockQty(1);
      setRestockNote("");
      loadItems();
    } catch (e) { addToast(e.message || "Restock failed.", "error"); }
    finally { setLoading(false); }
  };

  // ── Correction ─────────────────────────────────────────────
  const handleCorrection = async () => {
    if (!correctModal) return;
    setLoading(true);
    try {
      const data = await apiFetch(`/stock/${correctModal.menu_item_id}/correction`, {
        method: "POST",
        body: JSON.stringify({ new_quantity: correctQty, note: correctNote }),
      });
      addToast(`Corrected "${correctModal.item_name}": ${data.old_qty} → ${data.new_qty}`, "warn");
      setCorrectModal(null);
      setCorrectQty(0);
      setCorrectNote("");
      loadItems();
    } catch (e) { addToast(e.message || "Correction failed.", "error"); }
    finally { setLoading(false); }
  };

  // ── Flagged order review ───────────────────────────────────
  const handleReview = async (flaggedId, action, reason) => {
    setLoading(true);
    try {
      await apiFetch(`/stock/flagged/${flaggedId}/review`, {
        method: "POST",
        body: JSON.stringify({ action, reason: reason || null }),
      });
      addToast(`Order ${action === "approve" ? "approved" : "rejected"}.`, "success");
      loadFlagged();
    } catch (e) { addToast(e.message || "Review failed.", "error"); }
    finally { setLoading(false); }
  };

  // ── Expire stale locks ─────────────────────────────────────
  const handleExpireLocks = async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/stock/locks/expire", { method: "POST" });
      addToast(
        `Expired ${data.locks_expired} lock(s). Auto-cancelled ${data.flagged_orders_cancelled} order(s).`,
        "warn",
      );
      loadLocks();
    } catch (e) { addToast(e.message || "Expire job failed.", "error"); }
    finally { setLoading(false); }
  };

  // ── Release single lock ────────────────────────────────────
  const handleReleaseLock = async () => {
    if (!releaseModal) return;
    setLoading(true);
    try {
      await apiFetch(`/stock/locks/${releaseModal.id}/release`, { method: "DELETE" });
      addToast(`Lock released — ${releaseModal.quantity} unit(s) of "${releaseModal.item_name}" freed.`, "success");
      setReleaseModal(null);
      loadLocks();
      loadItems();
    } catch (e) { addToast(e.message || "Release failed.", "error"); }
    finally { setLoading(false); }
  };

  // ── Config update ──────────────────────────────────────────
  const handleConfigSave = async (key) => {
    const value = configEdit[key];
    if (value === undefined) return;
    setLoading(true);
    try {
      await apiFetch(`/stock/config/${key}`, {
        method: "PATCH",
        body: JSON.stringify({ value: String(value) }),
      });
      addToast(`"${key}" updated.`, "success");
      setConfigEdit(e => { const c = {...e}; delete c[key]; return c; });
      loadConfig();
    } catch (e) { addToast(e.message || "Config update failed.", "error"); }
    finally { setLoading(false); }
  };

  // FIX-2: use shared apiLogout
  const handleLogout = async () => {
    await apiLogout();
    navigate("/");
  };

  // ── Stats ──────────────────────────────────────────────────
  const totalItems  = items.length;
  const oos         = items.filter(i => i.available_qty <= 0).length;
  const lowStock    = items.filter(i => i.available_qty > 0 && i.available_qty / (i.total_qty || 1) < 0.2).length;
  const totalLocked = items.reduce((s, i) => s + (i.locked_qty || 0), 0);

  const filtered = items.filter(i =>
    i.item_name?.toLowerCase().includes(search.toLowerCase())
  );

  const TABS = [
    { key:"overview", icon:"bi-grid-3x3-gap-fill", label:"Overview"       },
    { key:"locks",    icon:"bi-lock-fill",          label:"Active Locks"   },
    { key:"flagged",  icon:"bi-flag-fill",          label:"Flagged", badge: flagged.length || null },
    { key:"ledger",   icon:"bi-journal-text",       label:"Ledger"         },
    { key:"config",   icon:"bi-sliders",            label:"Config (FR54)"  },
  ];

  return (
    <>
      <style>{SD_CSS}</style>
      <div className="sd-page">
        <div className="uc-mesh" aria-hidden="true" />
        <div className="uc-grid" aria-hidden="true" />

        {/* ── Navbar ── */}
        <nav className="mp-nav">
          <div className="mp-nav-brand">
            <div className="mp-nav-logo">📦</div>
            <span className="mp-nav-name">Stock Control</span>
          </div>

          {/* FIX-3: added Lifecycle nav link */}
          <div className="mp-nav-tabs">
            <button className="mp-nav-tab" onClick={() => navigate("/menu")}>
              <i className="bi bi-storefront" /> Menu
            </button>
                <button className="mp-nav-tab" onClick={() => navigate("/admin")}>
                  <i className="bi bi-gear-fill" /> Admin
                </button>
            <button className="mp-nav-tab mp-nav-tab--active">
              <i className="bi bi-boxes" /> Stock
            </button>
            <button className="mp-nav-tab" onClick={() => navigate("/lifecycle")}>
              <i className="bi bi-arrow-repeat" /> Lifecycle
            </button>
          </div>

          <div className="mp-nav-actions">
            <button className="mp-logout-btn" onClick={handleLogout} title="Sign out">
              <i className="bi bi-box-arrow-right" />
            </button>
          </div>
        </nav>

        <div className="sd-body">

          {/* ── Stats ── */}
          <div className="sd-stats">
            <StatCard icon="bi-box-seam"              label="Total Items"   value={totalItems}  color="var(--uc-acc)"    />
            <StatCard icon="bi-x-circle-fill"         label="Out of Stock"  value={oos}         color="var(--uc-danger)" sub={oos > 0 ? "Action needed" : "All stocked"} />
            <StatCard icon="bi-exclamation-triangle-fill" label="Low Stock" value={lowStock}    color="var(--uc-warn)"   sub="< 20% remaining" />
            <StatCard icon="bi-lock-fill"             label="Locked Units"  value={totalLocked} color="#a78bfa"          sub="Active locks" />
          </div>

          {/* ── Tabs ── */}
          <div className="sd-tabs" role="tablist">
            {TABS.map(t => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                className={`sd-tab ${tab === t.key ? "sd-tab--active" : ""}`}
                onClick={() => setTab(t.key)}
              >
                <i className={`bi ${t.icon}`} aria-hidden="true" />
                {t.label}
                {t.badge ? <span className="sd-tab-badge">{t.badge}</span> : null}
              </button>
            ))}
          </div>

          {/* ══ TAB: Overview ══ */}
          {tab === "overview" && (
            <div>
              <div className="sd-search-wrap">
                <i className="bi bi-search sd-search-ico" />
                <input
                  className="sd-search"
                  placeholder="Search items…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>

              {filtered.length === 0 ? (
                <div className="sd-empty">
                  <span style={{fontSize:40}}>📦</span>
                  <p>No stock items found.</p>
                </div>
              ) : (
                <div className="sd-grid">
                  {filtered.map(item => {
                    const s = stockStatus(item.available_qty, item.total_qty);
                    return (
                      <div key={item.menu_item_id} className="sd-card">
                        <div className="sd-card-hd">
                          <div>
                            <div className="sd-item-name">{item.item_name}</div>
                            <div className="sd-item-sub">Max order: {item.max_order_qty} / item</div>
                          </div>
                          <span className="sd-status-badge" style={{ color:s.color, borderColor:`${s.color}33`, background:`${s.color}11` }}>
                            {s.label}
                          </span>
                        </div>

                        <StockBar
                          available={item.available_qty}
                          total={item.total_qty}
                          locked={item.locked_qty}
                        />

                        <div className="sd-card-actions">
                          <button className="sd-action-btn sd-action-btn--primary" onClick={() => { setRestockModal(item); setRestockQty(1); setRestockNote(""); }}>
                            <i className="bi bi-plus-circle-fill" /> Restock
                          </button>
                          <button className="sd-action-btn sd-action-btn--warn" onClick={() => { setCorrectModal(item); setCorrectQty(item.total_qty); setCorrectNote(""); }}>
                            <i className="bi bi-pencil-fill" /> Correct
                          </button>
                          <button className="sd-icon-btn" onClick={() => { setLedgerItem(item.menu_item_id); setTab("ledger"); }} title="View ledger">
                            <i className="bi bi-journal-text" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ══ TAB: Active Locks ══ */}
          {tab === "locks" && (
            <div>
              <div className="sd-tab-hd">
                <div>
                  <span className="sd-tab-hd-title">Active Stock Locks</span>
                  <span className="sd-tab-hd-sub">FR22 — Pessimistic locks · 10-min TTL</span>
                </div>
                <div className="sd-tab-hd-actions">
                  <button className="sd-ghost-btn" onClick={loadLocks}><i className="bi bi-arrow-clockwise me-1" />Refresh</button>
                  <button className="sd-action-btn sd-action-btn--danger" onClick={handleExpireLocks} disabled={loading}>
                    <i className="bi bi-clock-history" /> Expire Stale
                  </button>
                </div>
              </div>

              {activeLocks.length === 0 ? (
                <div className="sd-empty-card">
                  <i className="bi bi-unlock-fill" style={{fontSize:32, color:"var(--uc-acc2)"}} />
                  <p>No active stock locks.</p>
                </div>
              ) : (
                <div className="sd-table-card">
                  <div className="sd-table-wrap">
                    <table className="sd-table">
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th>Order ID</th>
                          <th>Qty</th>
                          <th>Locked At</th>
                          <th>Expires</th>
                          <th>Remaining</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeLocks.map(lock => {
                          const secs = lock.seconds_remaining;
                          const urgent = secs < 60;
                          return (
                            <tr key={lock.id}>
                              <td className="sd-td-name">{lock.item_name}</td>
                              <td><code className="sd-code">{lock.order_id?.slice(0,8)}…</code></td>
                              <td>{lock.quantity}</td>
                              <td className="sd-td-muted">{new Date(lock.locked_at).toLocaleTimeString()}</td>
                              <td className="sd-td-muted">{new Date(lock.expires_at).toLocaleTimeString()}</td>
                              <td>
                                {secs > 0 ? (
                                  <span className="sd-time-badge" style={{ color: urgent?"var(--uc-danger)":"var(--uc-acc)", borderColor: urgent?"rgba(245,101,101,.3)":"rgba(59,158,218,.3)", background: urgent?"rgba(245,101,101,.08)":"rgba(59,158,218,.08)" }}>
                                    {Math.floor(secs/60)}m {secs%60}s
                                  </span>
                                ) : (
                                  <span className="sd-time-badge" style={{color:"var(--uc-muted)"}}>Expiring…</span>
                                )}
                              </td>
                              <td>
                                <button
                                  className="sd-action-btn sd-action-btn--danger"
                                  style={{padding:"5px 12px", fontSize:12}}
                                  onClick={() => setReleaseModal(lock)}
                                  disabled={loading}
                                >
                                  <i className="bi bi-unlock-fill" /> Release
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══ TAB: Flagged Orders ══ */}
          {tab === "flagged" && (
            <div>
              <div className="sd-tab-hd">
                <div>
                  <span className="sd-tab-hd-title">Flagged Orders</span>
                  <span className="sd-tab-hd-sub">FR24 FR25 — Pending admin review</span>
                </div>
                <button className="sd-ghost-btn" onClick={loadFlagged}><i className="bi bi-arrow-clockwise me-1" />Refresh</button>
              </div>

              {flagged.length === 0 ? (
                <div className="sd-empty-card">
                  <i className="bi bi-check-circle-fill" style={{fontSize:32, color:"var(--uc-acc2)"}} />
                  <p>No pending flagged orders.</p>
                </div>
              ) : (
                <div className="sd-flag-list">
                  {flagged.map(f => (
                    <FlaggedCard key={f.id} item={f} onReview={handleReview} loading={loading} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ══ TAB: Ledger ══ */}
          {tab === "ledger" && (
            <div>
              <div className="sd-tab-hd">
                <div>
                  <span className="sd-tab-hd-title">Stock Ledger</span>
                  <span className="sd-tab-hd-sub">FR41 — Immutable transaction log</span>
                </div>
                <select
                  className="sd-select"
                  value={ledgerItem || ""}
                  onChange={e => { const v = parseInt(e.target.value); setLedgerItem(v||null); if(v) loadLedger(v); }}
                >
                  <option value="">— Select item —</option>
                  {items.map(i => <option key={i.menu_item_id} value={i.menu_item_id}>{i.item_name}</option>)}
                </select>
              </div>

              {!ledgerItem ? (
                <div className="sd-empty-card">
                  <i className="bi bi-journal-text" style={{fontSize:32, color:"var(--uc-muted)"}} />
                  <p>Select an item to view its ledger.</p>
                </div>
              ) : (
                <div className="sd-table-card">
                  <div className="sd-table-wrap">
                    <table className="sd-table">
                      <thead>
                        <tr>
                          <th>Type</th><th>Delta</th><th>Before</th><th>After</th>
                          <th>Order</th><th>Note</th><th>Timestamp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(ledger.transactions || []).map(txn => (
                          <tr key={txn.id}>
                            <td><TxnBadge type={txn.txn_type} /></td>
                            <td className={txn.quantity_delta < 0 ? "sd-td-danger" : "sd-td-success"}>
                              {txn.quantity_delta > 0 ? "+" : ""}{txn.quantity_delta}
                            </td>
                            <td className="sd-td-muted">{txn.quantity_before}</td>
                            <td className="sd-td-name">{txn.quantity_after}</td>
                            <td>{txn.order_id ? <code className="sd-code">{txn.order_id.slice(0,8)}…</code> : <span className="sd-td-muted">—</span>}</td>
                            <td className="sd-td-note">{txn.note || <span className="sd-td-muted">—</span>}</td>
                            <td className="sd-td-muted" style={{whiteSpace:"nowrap"}}>{new Date(txn.created_at).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="sd-table-footer">{ledger.total} total transaction{ledger.total !== 1 ? "s" : ""}</div>
                </div>
              )}
            </div>
          )}

          {/* ══ TAB: Config ══ */}
          {tab === "config" && (
            <div>
              <div className="sd-tab-hd">
                <div>
                  <span className="sd-tab-hd-title">System Configuration</span>
                  <span className="sd-tab-hd-sub">FR54 — Live reload ≤ 60 sec · all changes audit-logged</span>
                </div>
                <button className="sd-ghost-btn" onClick={loadConfig}><i className="bi bi-arrow-clockwise me-1" />Refresh</button>
              </div>

              <div className="sd-info-banner">
                <i className="bi bi-info-circle-fill" />
                Changes take effect within 60 seconds without a system restart. All edits are immutably audit-logged.
              </div>

              <div className="sd-table-card">
                <div className="sd-table-wrap">
                  <table className="sd-table">
                    <thead>
                      <tr><th>Parameter</th><th>Description</th><th>Value</th><th /></tr>
                    </thead>
                    <tbody>
                      {config.map(c => (
                        <tr key={c.key}>
                          <td><code className="sd-code">{c.key}</code></td>
                          <td className="sd-td-muted sd-td-note">{c.description}</td>
                          <td>
                            <input
                              className="sd-inline-input"
                              value={configEdit[c.key] !== undefined ? configEdit[c.key] : c.value}
                              onChange={e => setConfigEdit(p => ({ ...p, [c.key]: e.target.value }))}
                            />
                          </td>
                          <td>
                            {configEdit[c.key] !== undefined && configEdit[c.key] !== c.value ? (
                              <button className="sd-action-btn sd-action-btn--primary" style={{padding:"5px 12px",fontSize:12}} onClick={() => handleConfigSave(c.key)} disabled={loading}>
                                Save
                              </button>
                            ) : <span className="sd-td-muted">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* ══ RESTOCK MODAL ══ */}
        {restockModal && (
          <ConfirmModal
            title={`Restock — ${restockModal.item_name}`}
            confirmLabel="Restock"
            onCancel={() => { setRestockModal(null); setRestockQty(1); setRestockNote(""); }}
            onConfirm={handleRestock}
            loading={loading}
          >
            <div className="sd-modal-field">
              <label className="sd-field-label">Quantity to add</label>
              <input type="number" min="1" className="sd-input"
                value={restockQty} onChange={e => setRestockQty(Math.max(1, parseInt(e.target.value)||1))} />
              <span className="sd-field-hint">Current: {restockModal.total_qty} · Locked: {restockModal.locked_qty}</span>
            </div>
            <div className="sd-modal-field">
              <label className="sd-field-label">Note <span className="sd-field-opt">(optional)</span></label>
              <input type="text" className="sd-input" placeholder="e.g. Weekly delivery"
                value={restockNote} onChange={e => setRestockNote(e.target.value)} />
            </div>
          </ConfirmModal>
        )}

        {/* ══ CORRECTION MODAL ══ */}
        {correctModal && (
          <ConfirmModal
            title={`Correct Stock — ${correctModal.item_name}`}
            confirmLabel="Apply Correction"
            onCancel={() => { setCorrectModal(null); setCorrectQty(0); setCorrectNote(""); }}
            onConfirm={handleCorrection}
            loading={loading}
          >
            <div className="sd-warn-banner">
              <i className="bi bi-exclamation-triangle-fill" />
              FR41: Corrections are permanently logged. A mandatory reason is required.
            </div>
            <div className="sd-modal-field">
              <label className="sd-field-label">New exact quantity</label>
              <input type="number" min="0" className="sd-input"
                value={correctQty} onChange={e => setCorrectQty(Math.max(0, parseInt(e.target.value)||0))} />
              <span className="sd-field-hint">
                Current: {correctModal.total_qty} → Delta: {correctQty - correctModal.total_qty >= 0 ? "+" : ""}{correctQty - correctModal.total_qty}
              </span>
            </div>
            <div className="sd-modal-field">
              <label className="sd-field-label">Reason <span style={{color:"var(--uc-danger)"}}>*</span></label>
              <textarea className={`sd-input sd-textarea ${correctNote.length > 0 && correctNote.trim().length < 5 ? "sd-input--err" : ""}`}
                rows={2} placeholder="e.g. Physical count revealed discrepancy due to spoilage"
                value={correctNote} onChange={e => setCorrectNote(e.target.value)} />
              {correctNote.length > 0 && correctNote.trim().length < 5 && (
                <span className="sd-field-err">Reason must be at least 5 characters.</span>
              )}
            </div>
          </ConfirmModal>
        )}

        {/* ══ RELEASE LOCK MODAL ══ */}
        {releaseModal && (
          <ConfirmModal
            title="Release Stock Lock"
            message={`Release the lock on ${releaseModal.quantity} unit(s) of "${releaseModal.item_name}"? This will cancel the associated order and free the stock.`}
            confirmLabel="Release Lock"
            danger
            onCancel={() => setReleaseModal(null)}
            onConfirm={handleReleaseLock}
            loading={loading}
          />
        )}

        <Toast toasts={toasts} removeToast={removeToast} />
      </div>
    </>
  );
}

// ── Flagged order card ─────────────────────────────────────────
function FlaggedCard({ item, onReview, loading }) {
  const [rejectReason, setRejectReason] = useState("");
  const [showReject,   setShowReject]   = useState(false);
  const timeLeft = Math.max(0, Math.ceil((new Date(item.auto_cancel_at) - Date.now()) / 60000));
  const urgent   = timeLeft < 15;

  return (
    <div className="sd-flag-card">
      <div className="sd-flag-hd">
        <div className="sd-flag-meta">
          <span className="sd-flag-chip"><i className="bi bi-flag-fill" /> Flagged</span>
          <code className="sd-code">{item.order_id?.slice(0,8)}…</code>
        </div>
        <div className="sd-flag-timer">
          <span className="sd-td-muted" style={{fontSize:11}}>Auto-cancels in</span>
          <span className="sd-time-badge" style={{
            color: urgent ? "var(--uc-danger)" : "var(--uc-warn)",
            borderColor: urgent ? "rgba(245,101,101,.3)" : "rgba(246,173,85,.3)",
            background: urgent ? "rgba(245,101,101,.08)" : "rgba(246,173,85,.08)",
          }}>{timeLeft}m</span>
        </div>
      </div>
      <p className="sd-flag-reason"><strong>Reason:</strong> {item.flagged_reason}</p>
      {item.flag_details && (
        <div className="sd-flag-tags">
          {item.flag_details.max_qty_exceeded && (
            <span className="sd-tag"><i className="bi bi-cart-x me-1" />Qty threshold exceeded</span>
          )}
          {item.flag_details.total_exceeded && (
            <span className="sd-tag"><i className="bi bi-cash-coin me-1" />Total threshold exceeded</span>
          )}
        </div>
      )}
      {showReject && (
        <div className="sd-modal-field" style={{marginBottom:10}}>
          <input className="sd-input" placeholder="Rejection reason (required)"
            value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
        </div>
      )}
      <div className="sd-flag-actions">
        <button className="sd-action-btn sd-action-btn--success" disabled={loading}
          onClick={() => onReview(item.id, "approve", null)}>
          <i className="bi bi-check-lg" /> Approve
        </button>
        {!showReject ? (
          <button className="sd-action-btn sd-action-btn--danger" onClick={() => setShowReject(true)}>
            <i className="bi bi-x-lg" /> Reject
          </button>
        ) : (
          <>
            <button className="sd-action-btn sd-action-btn--danger"
              disabled={loading || !rejectReason.trim()}
              onClick={() => onReview(item.id, "reject", rejectReason)}>
              Confirm Reject
            </button>
            <button className="sd-ghost-btn" onClick={() => { setShowReject(false); setRejectReason(""); }}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// CSS — unchanged from original
// ════════════════════════════════════════════════════════════
const SD_CSS = `
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
  .sd-page { min-height:100vh; background:var(--uc-bg); color:var(--uc-text); font-family:var(--fb); position:relative; }
  .uc-mesh { position:fixed; inset:0; z-index:0; pointer-events:none; overflow:hidden; }
  .uc-mesh::before { content:''; position:absolute; inset:-40%;
    background: radial-gradient(ellipse 60% 50% at 10% 20%,rgba(59,158,218,.09) 0%,transparent 60%),
                radial-gradient(ellipse 50% 40% at 90% 80%,rgba(34,201,147,.07) 0%,transparent 55%);
    animation:meshMove 18s ease-in-out infinite alternate; }
  @keyframes meshMove{from{transform:translate(0,0)}to{transform:translate(2%,1.5%)}}
  .uc-grid { position:fixed; inset:0; z-index:0; pointer-events:none;
    background-image:linear-gradient(rgba(255,255,255,.013) 1px,transparent 1px),
                     linear-gradient(90deg,rgba(255,255,255,.013) 1px,transparent 1px);
    background-size:52px 52px; }
  .mp-nav { position:sticky; top:0; z-index:200; display:flex; align-items:center; justify-content:space-between;
    padding:0 clamp(16px,3vw,32px); height:60px;
    background:rgba(8,13,20,.9); backdrop-filter:blur(16px); border-bottom:1px solid var(--uc-brd); }
  .mp-nav-brand { display:flex; align-items:center; gap:10px; }
  .mp-nav-logo { width:36px; height:36px; border-radius:10px; background:linear-gradient(135deg,var(--uc-acc),var(--uc-acc2));
    display:flex; align-items:center; justify-content:center; font-size:16px; }
  .mp-nav-name { font-family:var(--fd); font-size:16px; font-weight:700; letter-spacing:-.02em; }
  .mp-nav-tabs { display:flex; gap:4px; background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs); padding:3px; }
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
  .sd-body { position:relative; z-index:1; padding:clamp(16px,3vw,28px); display:flex; flex-direction:column; gap:18px; max-width:1400px; }
  .sd-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .sd-stat { display:flex; align-items:center; gap:12px; background:var(--uc-card); border:1px solid var(--uc-brd); border-radius:var(--uc-r); padding:16px; transition:border-color .25s; }
  .sd-stat:hover { border-color:var(--uc-brd-hi); }
  .sd-stat-val { font-family:var(--fd); font-size:22px; font-weight:700; line-height:1; }
  .sd-stat-label { font-size:11px; color:var(--uc-muted); margin-top:2px; }
  .sd-stat-sub { font-size:10px; color:var(--uc-muted); opacity:.7; margin-top:1px; }
  .sd-tabs { display:flex; gap:2px; flex-wrap:wrap; border-bottom:1px solid var(--uc-brd); }
  .sd-tab { display:flex; align-items:center; gap:6px; background:none; border:none; border-bottom:2px solid transparent;
    color:var(--uc-muted); font-family:var(--fb); font-size:12.5px; font-weight:600;
    padding:10px 14px; cursor:pointer; transition:all .2s; white-space:nowrap; }
  .sd-tab:hover { color:var(--uc-text); }
  .sd-tab--active { color:var(--uc-acc); border-bottom-color:var(--uc-acc); }
  .sd-tab-badge { background:var(--uc-danger); color:#fff; font-size:10px; font-weight:700; padding:1px 6px; border-radius:100px; }
  .sd-tab-hd { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:14px; }
  .sd-tab-hd-title { font-family:var(--fd); font-size:15px; font-weight:700; margin-right:8px; }
  .sd-tab-hd-sub { font-size:12px; color:var(--uc-muted); }
  .sd-tab-hd-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .sd-search-wrap { position:relative; margin-bottom:16px; max-width:340px; }
  .sd-search-ico { position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--uc-muted); font-size:13px; pointer-events:none; }
  .sd-search { width:100%; background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-text); font-family:var(--fb); font-size:13.5px; padding:9px 12px 9px 34px;
    outline:none; transition:border-color .2s,box-shadow .2s; }
  .sd-search:focus { border-color:var(--uc-acc); box-shadow:0 0 0 3px rgba(59,158,218,.12); }
  .sd-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:14px; }
  .sd-card { background:var(--uc-card); border:1px solid var(--uc-brd); border-radius:var(--uc-r);
    padding:18px; display:flex; flex-direction:column; gap:12px; transition:border-color .25s,transform .2s; }
  .sd-card:hover { border-color:var(--uc-brd-hi); transform:translateY(-2px); }
  .sd-card-hd { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
  .sd-item-name { font-family:var(--fd); font-size:14px; font-weight:700; margin-bottom:3px; }
  .sd-item-sub { font-size:11px; color:var(--uc-muted); }
  .sd-status-badge { font-size:10.5px; font-weight:700; padding:3px 9px; border-radius:100px; border:1px solid; white-space:nowrap; flex-shrink:0; }
  .sd-bar-track { height:6px; border-radius:99px; background:var(--uc-brd); overflow:hidden; position:relative; }
  .sd-bar-fill { height:100%; border-radius:99px; transition:width .4s ease; }
  .sd-bar-locked { height:100%; border-radius:99px; background:rgba(59,158,218,.35); position:absolute; top:0; right:0; }
  .sd-bar-labels { display:flex; justify-content:space-between; align-items:center; margin-top:5px; font-size:11px; color:var(--uc-muted); }
  .sd-lock-chip { display:inline-flex; align-items:center; gap:3px; font-size:10px; font-weight:700;
    padding:2px 7px; border-radius:100px; background:rgba(59,158,218,.1); color:var(--uc-acc); border:1px solid rgba(59,158,218,.25); }
  .sd-card-actions { display:flex; gap:8px; }
  .sd-action-btn { display:inline-flex; align-items:center; gap:6px; border:none; border-radius:var(--uc-rs);
    font-family:var(--fb); font-size:12.5px; font-weight:600; padding:8px 14px; cursor:pointer; transition:opacity .2s,transform .15s; }
  .sd-action-btn:hover:not(:disabled) { opacity:.88; transform:translateY(-1px); }
  .sd-action-btn:disabled { opacity:.4; cursor:not-allowed; transform:none; }
  .sd-action-btn--primary { background:linear-gradient(135deg,var(--uc-acc),#2878be); color:#fff; box-shadow:0 3px 12px rgba(59,158,218,.25); }
  .sd-action-btn--warn    { background:rgba(246,173,85,.12); color:var(--uc-warn); border:1px solid rgba(246,173,85,.3); }
  .sd-action-btn--danger  { background:rgba(245,101,101,.12); color:var(--uc-danger); border:1px solid rgba(245,101,101,.3); }
  .sd-action-btn--success { background:rgba(34,201,147,.12); color:var(--uc-acc2); border:1px solid rgba(34,201,147,.3); }
  .sd-ghost-btn { display:inline-flex; align-items:center; gap:4px; background:var(--uc-inp); border:1px solid var(--uc-brd);
    border-radius:var(--uc-rs); color:var(--uc-muted); font-family:var(--fb); font-size:12.5px; padding:7px 13px; cursor:pointer; transition:all .2s; }
  .sd-ghost-btn:hover { border-color:var(--uc-acc); color:var(--uc-text); }
  .sd-icon-btn { width:32px; height:32px; display:flex; align-items:center; justify-content:center;
    background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-muted); cursor:pointer; font-size:14px; transition:all .2s; }
  .sd-icon-btn:hover { border-color:var(--uc-acc); color:var(--uc-acc); }
  .sd-table-card { background:var(--uc-card); border:1px solid var(--uc-brd); border-radius:var(--uc-r); overflow:hidden; }
  .sd-table-wrap { overflow-x:auto; }
  .sd-table { width:100%; border-collapse:collapse; }
  .sd-table th { background:rgba(255,255,255,.025); padding:10px 14px; font-size:10.5px; font-weight:700;
    letter-spacing:.07em; text-transform:uppercase; color:var(--uc-muted); text-align:left; white-space:nowrap; border-bottom:1px solid var(--uc-brd); }
  .sd-table td { padding:11px 14px; border-bottom:1px solid rgba(255,255,255,.04); font-size:13px; vertical-align:middle; }
  .sd-table tr:last-child td { border-bottom:none; }
  .sd-table tr:hover td { background:rgba(255,255,255,.018); }
  .sd-table-footer { padding:10px 14px; font-size:11.5px; color:var(--uc-muted); border-top:1px solid var(--uc-brd); }
  .sd-td-name   { font-weight:600; }
  .sd-td-muted  { color:var(--uc-muted); }
  .sd-td-danger { color:var(--uc-danger); font-weight:700; }
  .sd-td-success{ color:var(--uc-acc2);  font-weight:700; }
  .sd-td-note   { max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sd-code      { font-size:11px; font-family:monospace; background:rgba(255,255,255,.05); padding:2px 6px; border-radius:4px; color:var(--uc-muted); }
  .sd-time-badge { display:inline-flex; align-items:center; font-size:11px; font-weight:700; padding:3px 9px; border-radius:100px; border:1px solid; }
  .sd-txn-badge { display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:700; padding:3px 9px; border-radius:100px; border:1px solid; white-space:nowrap; }
  .sd-flag-list { display:flex; flex-direction:column; gap:12px; }
  .sd-flag-card { background:var(--uc-card); border:1px solid rgba(246,201,14,.2); border-radius:var(--uc-r); padding:18px; }
  .sd-flag-hd { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
  .sd-flag-meta { display:flex; align-items:center; gap:10px; }
  .sd-flag-chip { display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:700;
    padding:3px 10px; border-radius:100px; background:rgba(246,201,14,.1); color:var(--uc-gold); border:1px solid rgba(246,201,14,.25); }
  .sd-flag-timer { display:flex; flex-direction:column; align-items:flex-end; gap:3px; }
  .sd-flag-reason { font-size:13px; color:var(--uc-muted); margin-bottom:10px; }
  .sd-flag-tags { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px; }
  .sd-tag { font-size:11px; padding:3px 10px; border-radius:100px; background:var(--uc-inp); border:1px solid var(--uc-brd); color:var(--uc-muted); }
  .sd-flag-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .sd-empty { display:flex; flex-direction:column; align-items:center; gap:12px; padding:70px 20px; color:var(--uc-muted); text-align:center; }
  .sd-empty-card { display:flex; flex-direction:column; align-items:center; gap:12px; padding:60px 20px;
    background:var(--uc-card); border:1px solid var(--uc-brd); border-radius:var(--uc-r); color:var(--uc-muted); text-align:center; }
  .sd-info-banner { display:flex; align-items:center; gap:10px; background:rgba(59,158,218,.07);
    border:1px solid rgba(59,158,218,.2); border-radius:var(--uc-rs); padding:12px 16px; font-size:13px; color:var(--uc-acc); margin-bottom:14px; }
  .sd-warn-banner { display:flex; align-items:flex-start; gap:10px; background:rgba(246,173,85,.08);
    border:1px solid rgba(246,173,85,.25); border-radius:var(--uc-rs); padding:12px;
    font-size:12.5px; color:var(--uc-warn); margin-bottom:14px; line-height:1.5; }
  .sd-select { background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-text); font-family:var(--fb); font-size:13px; padding:8px 12px; outline:none; cursor:pointer; min-width:200px; }
  .sd-select:focus { border-color:var(--uc-acc); }
  .sd-select option { background:#1e2433; color:#e2e8f0; padding:8px; }
  .sd-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.6); backdrop-filter:blur(4px); z-index:500; }
  .sd-modal-wrap { position:fixed; inset:0; z-index:501; display:flex; align-items:center; justify-content:center; padding:20px; }
  .sd-modal { background:var(--uc-card); border:1px solid var(--uc-brd-hi); border-radius:var(--uc-r);
    padding:24px; width:100%; max-width:440px; box-shadow:0 24px 48px rgba(0,0,0,.6);
    animation:fadeUp .25s ease both; display:flex; flex-direction:column; gap:16px; }
  @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
  .sd-modal-hd { display:flex; justify-content:space-between; align-items:center; }
  .sd-modal-title { font-family:var(--fd); font-size:16px; font-weight:700; }
  .sd-modal-msg { font-size:13.5px; color:var(--uc-muted); line-height:1.5; }
  .sd-modal-actions { display:flex; justify-content:flex-end; gap:10px; }
  .sd-modal-field { display:flex; flex-direction:column; gap:5px; }
  .sd-input { background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-text); font-family:var(--fb); font-size:13.5px; padding:10px 12px;
    outline:none; transition:border-color .2s,box-shadow .2s; width:100%; }
  .sd-input:focus { border-color:var(--uc-acc); box-shadow:0 0 0 3px rgba(59,158,218,.12); }
  .sd-input--err { border-color:var(--uc-danger) !important; }
  .sd-textarea { resize:vertical; min-height:72px; }
  .sd-inline-input { background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-text); font-family:var(--fb); font-size:13px; padding:7px 10px; outline:none; transition:border-color .2s; width:100%; }
  .sd-inline-input:focus { border-color:var(--uc-acc); }
  .sd-field-label { font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:var(--uc-muted); }
  .sd-field-opt   { font-size:10px; letter-spacing:0; text-transform:none; opacity:.7; }
  .sd-field-hint  { font-size:11px; color:var(--uc-muted); }
  .sd-field-err   { font-size:11px; color:var(--uc-danger); }
  .sd-spinner-sm { display:inline-block; width:14px; height:14px; border:2px solid rgba(255,255,255,.3); border-top-color:#fff; border-radius:50%; animation:spin .7s linear infinite; }
  @keyframes spin{to{transform:rotate(360deg)}}
  .sd-toast { display:flex; align-items:center; gap:10px; padding:11px 16px; border-radius:var(--uc-rs);
    font-size:13px; font-weight:500; min-width:260px; max-width:380px; box-shadow:0 8px 24px rgba(0,0,0,.4); animation:fadeUp .3s ease both; }
  .sd-toast--success { background:#0e2e20; border:1px solid rgba(34,201,147,.3); color:var(--uc-acc2); }
  .sd-toast--warn    { background:#2b1f0a; border:1px solid rgba(246,173,85,.3);  color:var(--uc-warn); }
  .sd-toast--error   { background:#2b0e0e; border:1px solid rgba(245,101,101,.3); color:var(--uc-danger); }
  .sd-toast-close    { margin-left:auto; background:none; border:none; cursor:pointer; color:inherit; opacity:.7; font-size:16px; padding:0; }
  @media(max-width:640px) {
    .sd-stats { grid-template-columns:1fr 1fr; }
    .sd-grid  { grid-template-columns:1fr; }
    .mp-nav-tabs { display:none; }
  }
`;