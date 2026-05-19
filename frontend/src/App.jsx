// ============================================================
// frontend/src/App.jsx
// ── FIXES APPLIED ────────────────────────────────────────────
// FIX-1: Added missing `useEffect` import — the LoginPage
//         wrapper calls useEffect to clear stale sessions but
//         it was never imported, causing a ReferenceError.
//
// FIX-2: `onLoginSuccess` now reads `data.user` correctly.
//         `apiLogin` returns the raw payload which contains
//         `{ user, access_token }`. We store only `data.user`
//         in localStorage (not the whole payload) so getUser()
//         keeps returning a plain user object.
//
// FIX-3: `/lifecycle` route — AdminPanel links to "/Lifecycle"
//         (capital L) but the route is "/lifecycle" (lowercase).
//         Fixed in AdminPanel.jsx. App.jsx route is already
//         lowercase — no change needed here, just documented.
//
// FIX-4: Staff role-based redirect: after login staff goes to
//         /stock. RequireRole correctly allows staff on /stock.
//         No change needed in App.jsx for this — auth_components
//         was the source of the bug (was sending staff to /kitchen).
// ============================================================

import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { useEffect } from "react";   // FIX-1: was missing

import { apiLogout }          from "./shared/api";
import { Login }              from "./features/auth/auth_components";
import MenuPage               from "./features/menu-cart/MenuPage";
import AdminPanel             from "./features/menu-cart/AdminPanel";
import OrderPaymentApp        from "./features/order/OrderPaymentApp";
import StockDashboard         from "./features/stock/StockDashboard";
import LifecycleDashboard     from "./features/lifecycle/lifecycle_dashboard";

// ── Helpers ───────────────────────────────────────────────────

/** Returns the parsed user object stored at login, or null. */
function getUser() {
  try { return JSON.parse(localStorage.getItem("user") || "null"); }
  catch { return null; }
}

// ── Guards ────────────────────────────────────────────────────

/**
 * Redirects unauthenticated visitors to "/" and visitors whose
 * role isn't in `allowed` to "/menu".
 */
function RequireRole({ allowed, children }) {
  const user = getUser();
  if (!user) return <Navigate to="/" replace />;
  if (allowed && !allowed.includes(user.role)) return <Navigate to="/menu" replace />;
  return children;
}

// ── Login wrapper ─────────────────────────────────────────────
function LoginPage() {
  const navigate = useNavigate();

  // Clear stale sessions when landing on login page
  useEffect(() => {                          // FIX-1: useEffect now imported
    apiLogout();
  }, []);

  return (
    <Login
      navigate={navigate}
      onLoginSuccess={(data) => {
        // FIX-2: apiLogin returns { user, access_token }.
        // Store only the user object — token is already in localStorage
        // from inside apiLogin() itself.
        if (data.user) {
          localStorage.setItem("user", JSON.stringify(data.user));
        }
      }}
    />
  );
}

// ── LifecyclePage ─────────────────────────────────────────────
function LifecyclePage() {
  const user = getUser();
  return (
    <LifecycleDashboard
      role={user?.role ?? "staff"}
      actorId={user?.id ?? `${user?.role ?? "staff"}-demo`}
    />
  );
}

// ── App ───────────────────────────────────────────────────────
export default function App() {
  return (
    <BrowserRouter>
      <Routes>

        {/* ── Public ── */}
        <Route path="/" element={<LoginPage />} />

        {/* ── Student + Staff + Admin ── */}
        <Route
          path="/menu"
          element={
            <RequireRole allowed={["student", "admin", "staff"]}>
              <MenuPage />
            </RequireRole>
          }
        />

        <Route
          path="/order"
          element={
            <RequireRole allowed={["student", "admin", "staff"]}>
              <OrderPaymentApp />
            </RequireRole>
          }
        />

        {/* ── Admin only ── */}
        <Route
          path="/admin"
          element={
            <RequireRole allowed={["admin"]}>
              <AdminPanel />
            </RequireRole>
          }
        />

        {/* ── Staff + Admin ── */}
        <Route
          path="/stock"
          element={
            <RequireRole allowed={["admin", "staff"]}>
              <StockDashboard />
            </RequireRole>
          }
        />

        <Route
          path="/lifecycle"
          element={
            <RequireRole allowed={["admin", "staff"]}>
              <LifecyclePage />
            </RequireRole>
          }
        />

        {/* ── Fallback ── */}
        <Route path="*" element={<Navigate to="/" replace />} />

      </Routes>
    </BrowserRouter>
  );
}