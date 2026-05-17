// ============================================================
// frontend/src/features/menu-cart/AdminPanel.jsx
// Member 2 — Menu & Cart Admin
// FR18 FR19 FR52
// TDP-M2-03 Max Qty enforcement in forms
// Theme: matches Login.jsx dark design system exactly
// ============================================================

import React, { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../../shared/api";
import { useNavigate } from "react-router-dom";

// ── Google Fonts & Icons ──────────────────────────────────────
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
const CATEGORIES = ["meals", "beverages", "snacks"];

const EMPTY_FORM = {
  name: "", category: "meals", price: "",
  stock_qty: "", max_order_qty: 10, active: true,
  description: "",
};

// ── Toast ─────────────────────────────────────────────────────
function Toast({ toasts, removeToast }) {
  return (
    <div style={{ position:"fixed", bottom:24, right:24, zIndex:9999, display:"flex", flexDirection:"column", gap:8 }}>
      {toasts.map(t => (
        <div key={t.id} className={`uc-toast uc-toast--${t.type}`}>
          <i className={`bi ${t.type==="success" ? "bi-check-circle-fill" : t.type==="warn" ? "bi-exclamation-triangle-fill" : "bi-x-circle-fill"}`} />
          <span>{t.message}</span>
          <button onClick={() => removeToast(t.id)} className="uc-toast-close"><i className="bi bi-x" /></button>
        </div>
      ))}
    </div>
  );
}

function useToast() {
  const [toasts, setToasts] = useState([]);
  const add    = useCallback((message, type="success") => {
    const id = Date.now();
    setToasts(p => [...p, { id, message, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3500);
  }, []);
  const remove = useCallback(id => setToasts(p => p.filter(t => t.id !== id)), []);
  return { toasts, addToast: add, removeToast: remove };
}

// ── Confirm dialog ────────────────────────────────────────────
function ConfirmModal({ message, onConfirm, onCancel }) {
  return (
    <>
      <div className="ap-modal-backdrop" onClick={onCancel} />
      <div className="ap-modal" role="dialog" aria-modal="true">
        <div className="ap-modal-inner">
          <div className="ap-modal-icon"><i className="bi bi-exclamation-triangle-fill" /></div>
          <h3 className="ap-modal-title">Confirm Action</h3>
          <p className="ap-modal-msg">{message}</p>
          <div className="ap-modal-actions">
            <button className="ap-cancel-btn" onClick={onCancel}>Cancel</button>
            <button className="ap-danger-btn" onClick={onConfirm}>Confirm</button>
          </div>
        </div>
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════
export default function AdminPanel() {
  const navigate                  = useNavigate();
  const { toasts, addToast, removeToast } = useToast();

  const [items,      setItems]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [form,       setForm]       = useState(EMPTY_FORM);
  const [editingId,  setEditingId]  = useState(null);
  const [errors,     setErrors]     = useState({});
  const [filterCat,  setFilterCat]  = useState("");
  const [search,     setSearch]     = useState("");
  const [confirm,    setConfirm]    = useState(null);
  const [showForm,   setShowForm]   = useState(false);

  // ── Fetch items ───────────────────────────────────────────
  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/menu/items");
      setItems(data.items || data || []);
    } catch {
      addToast("Failed to load menu items.", "error");
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line

  useEffect(() => { fetchItems(); }, []);

  // ── Form helpers ──────────────────────────────────────────
  const handleChange = e => {
    const { name, type, value, checked } = e.target;
    setForm(prev => ({ ...prev, [name]: type === "checkbox" ? checked : value }));
    if (errors[name]) setErrors(prev => ({ ...prev, [name]: "" }));
  };

  // ── Validation ────────────────────────────────────────────
  const validate = () => {
    const e = {};
    if (!form.name.trim())                    e.name      = "Item name is required.";
    if (!form.price || isNaN(form.price) || parseFloat(form.price) <= 0)
                                               e.price     = "Enter a valid price > 0.";
    if (!form.stock_qty || isNaN(form.stock_qty) || parseInt(form.stock_qty) < 0)
                                               e.stock_qty = "Stock quantity must be ≥ 0.";
    if (!form.max_order_qty || isNaN(form.max_order_qty) || parseInt(form.max_order_qty) < 1)
                                               e.max_order_qty = "Max order qty must be ≥ 1.";
    return e;
  };

  // ── Submit ────────────────────────────────────────────────
  const handleSubmit = async () => {
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setSaving(true);
    try {
      const payload = {
        ...form,
        name:          form.name.trim(),
        description:   form.description.trim(),
        price:         parseFloat(form.price),
        stock_qty:     parseInt(form.stock_qty, 10),
        max_order_qty: parseInt(form.max_order_qty, 10),
      };

      if (editingId) {
        await apiFetch(`/admin/menu/${editingId}`, { method: "PUT", body: JSON.stringify(payload) });
        addToast(`"${payload.name}" updated successfully.`, "success");
      } else {
        await apiFetch("/admin/menu", { method: "POST", body: JSON.stringify(payload) });
        addToast(`"${payload.name}" published to menu.`, "success");
      }

      setForm(EMPTY_FORM);
      setEditingId(null);
      setErrors({});
      setShowForm(false);
      fetchItems();
    } catch (err) {
      addToast(err?.message || "Failed to save item.", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (item) => {
    setForm({
      name:          item.name,
      category:      item.category,
      price:         item.price,
      stock_qty:     item.stock_qty,
      max_order_qty: item.max_order_qty,
      active:        item.active,
      description:   item.description || "",
    });
    setEditingId(item.id);
    setErrors({});
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleCancelEdit = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setErrors({});
    setShowForm(false);
  };

  const handleDeactivate = (item) => {
    setConfirm({ id: item.id, name: item.name });
  };

  const confirmDeactivate = async () => {
    const { id, name } = confirm;
    setConfirm(null);
    try {
      await apiFetch(`/admin/menu/${id}`, { method: "DELETE" });
      addToast(`"${name}" deactivated.`, "warn");
      fetchItems();
    } catch (err) {
      addToast(err?.message || "Failed to deactivate item.", "error");
    }
  };

  // ── Logout ────────────────────────────────────────────────
  const handleLogout = async () => {
    try { await apiFetch("/auth/logout", { method: "POST" }); } catch (_) {}
    localStorage.removeItem("jwt_token");
    localStorage.removeItem("user");
    navigate("/");
  };

  // ── Filtered list ─────────────────────────────────────────
  const filtered = items.filter(item => {
    const matchCat    = !filterCat || item.category === filterCat;
    const matchSearch = !search || item.name.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  const stats = {
    total:    items.length,
    active:   items.filter(i => i.active).length,
    inactive: items.filter(i => !i.active).length,
    oos:      items.filter(i => i.stock_qty === 0).length,
  };

  return (
    <>
      <style>{ADMIN_CSS}</style>
      <div className="ap-page">
        <div className="uc-mesh"  aria-hidden="true" />
        <div className="uc-grid"  aria-hidden="true" />

        {/* ── SINGLE Navbar ── */}
        <nav className="mp-nav">
          {/* Brand */}
          <div className="mp-nav-brand">
            <div className="mp-nav-logo">🍽️</div>
            <span className="mp-nav-name">CampusBite</span>
            <span className="ap-admin-tag">Admin</span>
          </div>

          {/* Centre: tab switcher */}
          <div className="mp-nav-tabs">
            <button className="mp-nav-tab" onClick={() => navigate("/menu")}>
              <i className="bi bi-storefront" /> Menu
            </button>
            <button className="mp-nav-tab mp-nav-tab--active">
              <i className="bi bi-gear-fill" /> Admin
            </button>
          </div>

          {/* Right: logout */}
          <div className="mp-nav-actions">
            <button className="mp-logout-btn" onClick={handleLogout} title="Sign out">
              <i className="bi bi-box-arrow-right" />
            </button>
          </div>
        </nav>

        <div className="ap-body">

          {/* ── Stats row ── */}
          <div className="ap-stats">
            {[
              { label:"Total Items",  value:stats.total,    icon:"bi-grid-3x3-gap-fill", color:"var(--uc-acc)"  },
              { label:"Active",       value:stats.active,   icon:"bi-check-circle-fill", color:"var(--uc-acc2)" },
              { label:"Inactive",     value:stats.inactive, icon:"bi-x-circle-fill",     color:"var(--uc-danger)"},
              { label:"Out of Stock", value:stats.oos,      icon:"bi-exclamation-circle-fill", color:"var(--uc-warn)" },
            ].map(s => (
              <div key={s.label} className="ap-stat">
                <i className={`bi ${s.icon}`} style={{ color:s.color }} />
                <div>
                  <div className="ap-stat-val" style={{ color:s.color }}>{s.value}</div>
                  <div className="ap-stat-label">{s.label}</div>
                </div>
              </div>
            ))}
          </div>

          {/* ── Form card ── */}
          {showForm && (
            <div className="ap-form-card">
              <div className="ap-form-hd">
                <h2 className="ap-form-title">
                  <i className={`bi ${editingId ? "bi-pencil-square" : "bi-plus-circle-fill"}`} />
                  {editingId ? "Edit Menu Item" : "Add New Item"}
                </h2>
                <button className="mp-cart-close" onClick={handleCancelEdit} aria-label="Close form">
                  <i className="bi bi-x-lg" />
                </button>
              </div>

              <div className="ap-form-grid">

                {/* Name */}
                <div className="ap-field ap-field--wide">
                  <label className="ap-label">Item Name *</label>
                  <input
                    name="name" className={`ap-input${errors.name ? " ap-input--err" : ""}`}
                    placeholder="e.g. Grilled Chicken Bowl"
                    value={form.name} onChange={handleChange}
                  />
                  {errors.name && <span className="ap-field-err">{errors.name}</span>}
                </div>

                {/* Description */}
                <div className="ap-field ap-field--wide">
                  <label className="ap-label">Description</label>
                  <input
                    name="description" className="ap-input"
                    placeholder="Short description (optional)"
                    value={form.description} onChange={handleChange}
                  />
                </div>

                {/* Category */}
                <div className="ap-field">
                  <label className="ap-label">Category *</label>
                  <select name="category" className="ap-input" value={form.category} onChange={handleChange}>
                    {CATEGORIES.map(c => (
                      <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                    ))}
                  </select>
                </div>

                {/* Price */}
                <div className="ap-field">
                  <label className="ap-label">Price (EGP) *</label>
                  <div className="ap-input-prefix-wrap">
                    <span className="ap-input-prefix">EGP</span>
                    <input
                      name="price" type="number" min="0" step="0.01"
                      className={`ap-input ap-input--prefixed${errors.price ? " ap-input--err" : ""}`}
                      placeholder="0.00"
                      value={form.price} onChange={handleChange}
                    />
                  </div>
                  {errors.price && <span className="ap-field-err">{errors.price}</span>}
                </div>

                {/* Stock qty */}
                <div className="ap-field">
                  <label className="ap-label">Stock Quantity *</label>
                  <input
                    name="stock_qty" type="number" min="0"
                    className={`ap-input${errors.stock_qty ? " ap-input--err" : ""}`}
                    placeholder="0"
                    value={form.stock_qty} onChange={handleChange}
                  />
                  {errors.stock_qty && <span className="ap-field-err">{errors.stock_qty}</span>}
                </div>

                {/* Max order qty */}
                <div className="ap-field">
                  <label className="ap-label">
                    Max Order Qty *
                    <span className="ap-label-hint"> (per-item cap)</span>
                  </label>
                  <input
                    name="max_order_qty" type="number" min="1"
                    className={`ap-input${errors.max_order_qty ? " ap-input--err" : ""}`}
                    placeholder="10"
                    value={form.max_order_qty} onChange={handleChange}
                  />
                  {errors.max_order_qty
                    ? <span className="ap-field-err">{errors.max_order_qty}</span>
                    : <span className="ap-field-hint">Students can't order more than this per transaction</span>
                  }
                </div>

                {/* Active toggle */}
                <div className="ap-field ap-field--toggle">
                  <label className="ap-toggle-label">
                    <span className="ap-label">Visible to students</span>
                    <span className="ap-label-hint">Inactive items are hidden from the menu</span>
                  </label>
                  <button
                    type="button"
                    className={`ap-toggle ${form.active ? "ap-toggle--on" : ""}`}
                    onClick={() => setForm(p => ({ ...p, active: !p.active }))}
                    aria-pressed={form.active}
                    aria-label="Toggle item visibility"
                  >
                    <span className="ap-toggle-thumb" />
                  </button>
                </div>
              </div>

              {/* Form actions */}
              <div className="ap-form-actions">
                <button className="ap-cancel-btn" onClick={handleCancelEdit} disabled={saving}>
                  Cancel
                </button>
                <button className="ap-submit-btn" onClick={handleSubmit} disabled={saving}>
                  {saving
                    ? <><span className="mp-spinner-sm" /> Saving…</>
                    : editingId
                      ? <><i className="bi bi-check-lg" /> Save Changes</>
                      : <><i className="bi bi-plus-circle-fill" /> Publish Item</>
                  }
                </button>
              </div>
            </div>
          )}

          {/* ── Table section ── */}
          <div className="ap-table-card">
            <div className="ap-table-hd">
              <div className="ap-table-hd-left">
                <h2 className="ap-form-title">
                  <i className="bi bi-list-ul" /> Menu Items
                </h2>
                <span className="ap-count">{filtered.length} item{filtered.length !== 1 ? "s" : ""}</span>
              </div>
              <div className="ap-table-hd-right">
                {/* Search */}
                <div style={{ position:"relative" }}>
                  <i className="bi bi-search" style={{ position:"absolute", left:11, top:"50%", transform:"translateY(-50%)", color:"var(--uc-muted)", fontSize:13, pointerEvents:"none" }} />
                  <input
                    className="ap-input ap-search"
                    placeholder="Search items…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    style={{ paddingLeft:32 }}
                  />
                </div>
                {/* Category filter */}
                <select className="ap-input ap-filter-select" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
                  <option value="">All categories</option>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase()+c.slice(1)}</option>)}
                </select>
                {/* Add button */}
                {!showForm && (
                  <button className="ap-add-new-btn" onClick={() => { handleCancelEdit(); setShowForm(true); }}>
                    <i className="bi bi-plus-lg" /> Add Item
                  </button>
                )}
              </div>
            </div>

            {loading ? (
              <div className="mp-loading"><div className="mp-spinner" /><span>Loading items…</span></div>
            ) : filtered.length === 0 ? (
              <div className="mp-empty">
                <span style={{ fontSize:40 }}>📋</span>
                <p>No items found.</p>
              </div>
            ) : (
              <div className="ap-table-wrap">
                <table className="ap-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Category</th>
                      <th>Price</th>
                      <th>Stock</th>
                      <th>Max Qty</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(item => (
                      <tr key={item.id} className={!item.active ? "ap-row--inactive" : ""}>
                        <td>
                          <span className="ap-item-name">{item.name}</span>
                          {item.description && <span className="ap-item-desc">{item.description}</span>}
                        </td>
                        <td><span className="ap-cat-badge">{item.category}</span></td>
                        <td className="ap-price">{Number(item.price).toFixed(2)} <small>EGP</small></td>
                        <td>
                          <span className={`ap-stock ${item.stock_qty === 0 ? "ap-stock--oos" : item.stock_qty <= 5 ? "ap-stock--low" : ""}`}>
                            {item.stock_qty === 0 ? "Out of stock" : item.stock_qty}
                          </span>
                        </td>
                        <td className="ap-max-qty">
                          <span className="ap-max-badge">{item.max_order_qty}</span>
                        </td>
                        <td>
                          <span className={`ap-status ${item.active ? "ap-status--active" : "ap-status--inactive"}`}>
                            <span className="ap-status-dot" />
                            {item.active ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td>
                          <div className="ap-row-actions">
                            <button className="ap-edit-btn" onClick={() => handleEdit(item)} title="Edit item">
                              <i className="bi bi-pencil-fill" />
                            </button>
                            {item.active && (
                              <button className="ap-deactivate-btn" onClick={() => handleDeactivate(item)} title="Deactivate item">
                                <i className="bi bi-eye-slash-fill" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {confirm && (
          <ConfirmModal
            message={`Deactivate "${confirm.name}"? It will be hidden from students immediately.`}
            onConfirm={confirmDeactivate}
            onCancel={() => setConfirm(null)}
          />
        )}

        <Toast toasts={toasts} removeToast={removeToast} />
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════════
// CSS
// ════════════════════════════════════════════════════════════
const ADMIN_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
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
  .ap-page { min-height:100vh; background:var(--uc-bg); color:var(--uc-text); font-family:var(--fb); position:relative; }
  .uc-mesh { position:fixed; inset:0; z-index:0; pointer-events:none; overflow:hidden; }
  .uc-mesh::before {
    content:''; position:absolute; inset:-40%;
    background:
      radial-gradient(ellipse 65% 55% at 15% 25%,rgba(59,158,218,.08) 0%,transparent 60%),
      radial-gradient(ellipse 45% 55% at 85% 75%,rgba(34,201,147,.06) 0%,transparent 55%);
    animation:meshMove 18s ease-in-out infinite alternate;
  }
  @keyframes meshMove{from{transform:translate(0,0) rotate(0)}to{transform:translate(2%,1.5%) rotate(2deg)}}
  .uc-grid {
    position:fixed; inset:0; z-index:0; pointer-events:none;
    background-image:linear-gradient(rgba(255,255,255,.012) 1px,transparent 1px),
                     linear-gradient(90deg,rgba(255,255,255,.012) 1px,transparent 1px);
    background-size:52px 52px;
  }

  /* ── Nav (shared classes with MenuPage) ── */
  .mp-nav {
    position:sticky; top:0; z-index:200;
    display:flex; align-items:center; justify-content:space-between;
    padding:0 clamp(16px,3vw,32px); height:60px;
    background:rgba(8,13,20,.9); backdrop-filter:blur(16px);
    border-bottom:1px solid var(--uc-brd);
  }
  .mp-nav-brand { display:flex; align-items:center; gap:10px; }
  .mp-nav-logo {
    width:36px; height:36px; border-radius:10px;
    background:linear-gradient(135deg,var(--uc-acc),var(--uc-acc2));
    display:flex; align-items:center; justify-content:center; font-size:16px;
  }
  .mp-nav-name { font-family:var(--fd); font-size:16px; font-weight:700; letter-spacing:-.02em; }
  .ap-admin-tag {
    font-size:10px; font-weight:700; letter-spacing:.08em; text-transform:uppercase;
    background:rgba(246,201,14,.12); color:var(--uc-gold); border:1px solid rgba(246,201,14,.25);
    border-radius:100px; padding:3px 9px;
  }
  .mp-nav-actions { display:flex; align-items:center; gap:8px; }

  /* Tab switcher */
  .mp-nav-tabs {
    display:flex; gap:4px;
    background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    padding:3px;
  }
  .mp-nav-tab {
    display:flex; align-items:center; gap:6px;
    background:none; border:none; border-radius:7px;
    color:var(--uc-muted); font-family:var(--fb); font-size:12.5px; font-weight:600;
    padding:5px 14px; cursor:pointer; transition:all .2s; white-space:nowrap;
  }
  .mp-nav-tab:hover { color:var(--uc-text); background:rgba(255,255,255,.05); }
  .mp-nav-tab--active {
    background:var(--uc-card); color:var(--uc-text);
    box-shadow:0 1px 4px rgba(0,0,0,.35);
  }

  .mp-logout-btn {
    width:36px; height:36px; display:flex; align-items:center; justify-content:center;
    background:none; border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-muted); cursor:pointer; font-size:15px; transition:all .2s;
  }
  .mp-logout-btn:hover { border-color:var(--uc-danger); color:var(--uc-danger); }

  /* Body */
  .ap-body { position:relative; z-index:1; padding:clamp(16px,3vw,32px); max-width:1400px; display:flex; flex-direction:column; gap:20px; }

  /* Stats */
  .ap-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; }
  .ap-stat { display:flex; align-items:center; gap:12px; background:var(--uc-card); border:1px solid var(--uc-brd); border-radius:var(--uc-r); padding:16px; transition:border-color .25s; }
  .ap-stat:hover { border-color:var(--uc-brd-hi); }
  .ap-stat i { font-size:22px; flex-shrink:0; }
  .ap-stat-val { font-family:var(--fd); font-size:22px; font-weight:700; line-height:1; }
  .ap-stat-label { font-size:11px; color:var(--uc-muted); margin-top:3px; }

  /* Form card */
  .ap-form-card { background:var(--uc-card); border:1px solid var(--uc-brd-hi); border-radius:var(--uc-r); padding:clamp(20px,3vw,28px); animation:fadeUp .3s ease both; }
  @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
  .ap-form-hd { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
  .ap-form-title { font-family:var(--fd); font-size:16px; font-weight:700; display:flex; align-items:center; gap:8px; }
  .mp-cart-close { width:30px; height:30px; display:flex; align-items:center; justify-content:center; background:none; border:1px solid var(--uc-brd); border-radius:var(--uc-rs); color:var(--uc-muted); cursor:pointer; font-size:13px; transition:all .2s; }
  .mp-cart-close:hover { border-color:var(--uc-danger); color:var(--uc-danger); }
  .ap-form-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:14px; margin-bottom:20px; }
  .ap-field { display:flex; flex-direction:column; gap:5px; }
  .ap-field--wide { grid-column:1/-1; }
  .ap-field--toggle { flex-direction:row; align-items:center; justify-content:space-between; grid-column:1/-1; }
  .ap-label { font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:var(--uc-muted); }
  .ap-label-hint { font-size:10px; letter-spacing:0; text-transform:none; color:var(--uc-muted); opacity:.7; margin-left:4px; }
  .ap-toggle-label { display:flex; flex-direction:column; gap:3px; }
  .ap-input { background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs); color:var(--uc-text); font-family:var(--fb); font-size:13.5px; padding:10px 12px; outline:none; transition:border-color .2s,box-shadow .2s; width:100%; -webkit-appearance:none; }
  .ap-input::placeholder { color:rgba(107,122,144,.5); }
  .ap-input:focus { border-color:var(--uc-acc); box-shadow:0 0 0 3px rgba(59,158,218,.12); }
  .ap-input--err { border-color:var(--uc-danger) !important; }
  .ap-input-prefix-wrap { position:relative; display:flex; align-items:center; }
  .ap-input-prefix { position:absolute; left:12px; font-size:11px; font-weight:700; color:var(--uc-muted); pointer-events:none; letter-spacing:.04em; }
  .ap-input--prefixed { padding-left:42px; }
  .ap-field-err { font-size:11px; color:var(--uc-danger); }
  .ap-field-hint { font-size:11px; color:var(--uc-muted); opacity:.75; }

  /* Toggle */
  .ap-toggle { width:44px; height:24px; border-radius:12px; position:relative; flex-shrink:0; background:var(--uc-inp); border:1px solid var(--uc-brd); cursor:pointer; transition:background .2s,border-color .2s; }
  .ap-toggle--on { background:rgba(34,201,147,.2); border-color:var(--uc-acc2); }
  .ap-toggle-thumb { position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:var(--uc-muted); transition:transform .2s,background .2s; }
  .ap-toggle--on .ap-toggle-thumb { transform:translateX(20px); background:var(--uc-acc2); }

  .ap-form-actions { display:flex; justify-content:flex-end; gap:10px; }
  .ap-cancel-btn { background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs); color:var(--uc-muted); font-family:var(--fb); font-size:13.5px; font-weight:600; padding:10px 20px; cursor:pointer; transition:all .2s; }
  .ap-cancel-btn:hover { border-color:var(--uc-acc); color:var(--uc-text); }
  .ap-submit-btn { display:flex; align-items:center; gap:7px; background:linear-gradient(135deg,var(--uc-acc),#2878be); border:none; border-radius:var(--uc-rs); color:#fff; font-family:var(--fb); font-size:13.5px; font-weight:700; padding:10px 22px; cursor:pointer; box-shadow:0 4px 16px rgba(59,158,218,.28); transition:transform .15s,opacity .2s; }
  .ap-submit-btn:hover:not(:disabled) { transform:translateY(-1px); }
  .ap-submit-btn:disabled { opacity:.45; cursor:not-allowed; transform:none; }

  /* Table card */
  .ap-table-card { background:var(--uc-card); border:1px solid var(--uc-brd); border-radius:var(--uc-r); overflow:hidden; }
  .ap-table-hd { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; padding:16px 20px; border-bottom:1px solid var(--uc-brd); }
  .ap-table-hd-left { display:flex; align-items:center; gap:10px; }
  .ap-count { font-size:11px; color:var(--uc-muted); background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:100px; padding:2px 9px; }
  .ap-table-hd-right { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .ap-search { width:180px; padding:8px 12px; font-size:12.5px; }
  .ap-filter-select { width:150px; padding:8px 12px; font-size:12.5px; }
  .ap-add-new-btn { display:flex; align-items:center; gap:6px; background:linear-gradient(135deg,var(--uc-acc),#2878be); border:none; border-radius:var(--uc-rs); color:#fff; font-family:var(--fb); font-size:12.5px; font-weight:700; padding:8px 16px; cursor:pointer; white-space:nowrap; box-shadow:0 3px 12px rgba(59,158,218,.25); transition:opacity .2s; }
  .ap-add-new-btn:hover { opacity:.88; }

  .ap-table-wrap { overflow-x:auto; }
  .ap-table { width:100%; border-collapse:collapse; }
  .ap-table th { background:rgba(255,255,255,.025); padding:10px 14px; font-size:10.5px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; color:var(--uc-muted); text-align:left; white-space:nowrap; border-bottom:1px solid var(--uc-brd); }
  .ap-table td { padding:12px 14px; border-bottom:1px solid rgba(255,255,255,.04); font-size:13px; vertical-align:middle; }
  .ap-table tr:last-child td { border-bottom:none; }
  .ap-table tr:hover td { background:rgba(255,255,255,.02); }
  .ap-row--inactive td { opacity:.55; }
  .ap-item-name { display:block; font-weight:600; font-size:13.5px; margin-bottom:2px; }
  .ap-item-desc { display:block; font-size:11px; color:var(--uc-muted); }
  .ap-cat-badge { font-size:10.5px; font-weight:600; padding:3px 9px; border-radius:100px; background:rgba(59,158,218,.1); color:var(--uc-acc); border:1px solid rgba(59,158,218,.2); text-transform:capitalize; }
  .ap-price { font-family:var(--fd); font-size:14px; font-weight:700; color:var(--uc-acc); }
  .ap-price small { font-size:10px; font-weight:500; opacity:.6; }
  .ap-stock { font-size:12.5px; font-weight:600; }
  .ap-stock--oos { color:var(--uc-danger); }
  .ap-stock--low { color:var(--uc-warn); }
  .ap-max-badge { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; border-radius:var(--uc-rs); background:var(--uc-inp); border:1px solid var(--uc-brd); font-size:12px; font-weight:700; color:var(--uc-text); }
  .ap-status { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; }
  .ap-status-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
  .ap-status--active  .ap-status-dot { background:var(--uc-acc2); box-shadow:0 0 6px var(--uc-acc2); }
  .ap-status--inactive .ap-status-dot { background:var(--uc-muted); }
  .ap-status--active   { color:var(--uc-acc2); }
  .ap-status--inactive { color:var(--uc-muted); }
  .ap-row-actions { display:flex; gap:6px; }
  .ap-edit-btn, .ap-deactivate-btn { width:30px; height:30px; display:flex; align-items:center; justify-content:center; background:none; border:1px solid var(--uc-brd); border-radius:var(--uc-rs); cursor:pointer; font-size:13px; transition:all .2s; }
  .ap-edit-btn { color:var(--uc-acc); }
  .ap-edit-btn:hover { background:rgba(59,158,218,.1); border-color:var(--uc-acc); }
  .ap-deactivate-btn { color:var(--uc-warn); }
  .ap-deactivate-btn:hover { background:rgba(246,173,85,.1); border-color:var(--uc-warn); }
  .ap-danger-btn { background:linear-gradient(135deg,var(--uc-danger),#c53030); border:none; border-radius:var(--uc-rs); color:#fff; font-family:var(--fb); font-size:13.5px; font-weight:700; padding:10px 22px; cursor:pointer; transition:opacity .2s; }
  .ap-danger-btn:hover { opacity:.88; }

  /* Modal */
  .ap-modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.6); backdrop-filter:blur(4px); z-index:500; }
  .ap-modal { position:fixed; inset:0; z-index:501; display:flex; align-items:center; justify-content:center; padding:20px; }
  .ap-modal-inner { background:var(--uc-card); border:1px solid var(--uc-brd); border-radius:var(--uc-r); padding:28px; max-width:380px; width:100%; text-align:center; box-shadow:0 24px 48px rgba(0,0,0,.6); animation:fadeUp .25s ease both; }
  .ap-modal-icon { font-size:32px; color:var(--uc-warn); margin-bottom:12px; }
  .ap-modal-title { font-family:var(--fd); font-size:17px; font-weight:700; margin-bottom:8px; }
  .ap-modal-msg { font-size:13.5px; color:var(--uc-muted); line-height:1.5; margin-bottom:20px; }
  .ap-modal-actions { display:flex; gap:10px; justify-content:center; }

  /* Shared loading/empty/spinner */
  .mp-loading { display:flex; flex-direction:column; align-items:center; gap:14px; padding:60px 20px; color:var(--uc-muted); }
  .mp-spinner { width:32px; height:32px; border:3px solid var(--uc-brd); border-top-color:var(--uc-acc); border-radius:50%; animation:spin .7s linear infinite; }
  .mp-spinner-sm { display:inline-block; width:14px; height:14px; border:2px solid rgba(255,255,255,.3); border-top-color:#fff; border-radius:50%; animation:spin .7s linear infinite; }
  @keyframes spin{to{transform:rotate(360deg)}}
  .mp-empty { display:flex; flex-direction:column; align-items:center; gap:12px; padding:60px 20px; color:var(--uc-muted); }

  /* Toast */
  .uc-toast { display:flex; align-items:center; gap:10px; padding:11px 16px; border-radius:var(--uc-rs); font-size:13px; font-weight:500; min-width:260px; max-width:380px; box-shadow:0 8px 24px rgba(0,0,0,.4); animation:fadeUp .3s ease both; }
  .uc-toast--success { background:#0e2e20; border:1px solid rgba(34,201,147,.3); color:var(--uc-acc2); }
  .uc-toast--warn    { background:#2b1f0a; border:1px solid rgba(246,173,85,.3);  color:var(--uc-warn); }
  .uc-toast--error   { background:#2b0e0e; border:1px solid rgba(245,101,101,.3); color:var(--uc-danger); }
  .uc-toast-close { margin-left:auto; background:none; border:none; cursor:pointer; color:inherit; opacity:.7; font-size:16px; padding:0; }
  @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}

  @media(max-width:640px) {
    .ap-table th:nth-child(2), .ap-table td:nth-child(2) { display:none; }
    .ap-table th:nth-child(7), .ap-table td:nth-child(7) { display:none; }
    .mp-nav-tabs { display:none; }
  }
`;