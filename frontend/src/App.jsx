// ============================================================
// frontend/src/App.jsx
// Root router — wires all four feature areas:
//   /            → Login
//   /menu        → MenuPage        (student / admin)
//   /admin       → AdminPanel      (admin only)
//   /order       → OrderPaymentApp (student / admin)
//   /stock       → StockDashboard  (admin only)
// ============================================================

import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";

import { Login }          from "./features/auth/auth_components";
import MenuPage           from "./features/menu-cart/MenuPage";
import AdminPanel         from "./features/menu-cart/AdminPanel";
import OrderPaymentApp    from "./features/order/OrderPaymentApp";
import StockDashboard     from "./features/stock/StockDashboard";

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

// ── Login wrapper (needs useNavigate inside BrowserRouter) ────
function LoginPage() {
  const navigate = useNavigate();
  return (
    <Login
      navigate={navigate}
      onLoginSuccess={(data) => {
        localStorage.setItem("user", JSON.stringify(data.user));
      }}
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

        {/* ── Student + Admin ── */}
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

        <Route
          path="/stock"
          element={
            <RequireRole allowed={["admin", "staff"]}>
              <StockDashboard />
            </RequireRole>
          }
        />

        {/* ── Fallback ── */}
        <Route path="*" element={<Navigate to="/" replace />} />

      </Routes>
    </BrowserRouter>
  );
}