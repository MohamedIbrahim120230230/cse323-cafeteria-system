// App.jsx — CSE323 Cafeteria System
// Fixed: Login is a named export, not a default export
import { BrowserRouter, Routes, Route, NavLink, Outlet, useNavigate } from "react-router-dom";
import { Login } from "./features/auth/auth_components";   // ← named export (was: default)
import MenuPage from "./features/menu-cart/MenuPage";
import AdminPanel from "./features/menu-cart/AdminPanel";
import OrderPaymentApp from "./OrderPaymentApp";

function CafeteriaLayout() {
  const role = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "{}").role || "student"; }
    catch { return "student"; }
  })();

  return (
    <div style={{ minHeight: "100vh", background: "#080d14" }}>
      <nav className="navbar navbar-dark px-4" style={{ background: "#111825", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
        <span className="navbar-brand fw-bold" style={{ fontFamily: "'Sora',sans-serif" }}>🍽️ CampusBite</span>
        <div className="d-flex gap-2">
          <NavLink to="/menu" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-light" : "btn-outline-light"}`}>Menu</NavLink>
          {role === "admin" && (
            <NavLink to="/admin" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-light" : "btn-outline-light"}`}>Admin</NavLink>
          )}
          <NavLink to="/order" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-light" : "btn-outline-light"}`}>Order & Pay</NavLink>
          <button
            className="btn btn-sm btn-outline-danger"
            onClick={() => { localStorage.removeItem("jwt_token"); localStorage.removeItem("user"); window.location.href = "/"; }}
          >
            Sign Out
          </button>
        </div>
      </nav>
      <div className="p-4">
        <Outlet />
      </div>
    </div>
  );
}

function LoginPage() {
  const navigate = useNavigate();
  return (
    <Login
      navigate={navigate}
      onLoginSuccess={(data) => {
        // apiFetch already unwraps { success, data } envelope
        // so data here = { access_token, refresh_token, user, ... }
        localStorage.setItem("jwt_token", data.access_token);
        localStorage.setItem("user", JSON.stringify(data.user));
      }}
    />
  );
}

function ProtectedRoute({ children }) {
  const token = localStorage.getItem("jwt_token");
  if (!token) { window.location.href = "/"; return null; }
  return children;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/" element={<LoginPage />} />

        {/* Protected — share CafeteriaLayout navbar */}
        <Route element={<ProtectedRoute><CafeteriaLayout /></ProtectedRoute>}>
          <Route path="/menu"  element={<MenuPage />} />
          <Route path="/admin" element={<AdminPanel />} />
        </Route>

        {/* Order & Payment has its own navbar — rendered outside CafeteriaLayout */}
        <Route path="/order" element={<ProtectedRoute><OrderPaymentApp /></ProtectedRoute>} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
