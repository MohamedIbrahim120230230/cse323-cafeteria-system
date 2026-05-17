import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, NavLink, Outlet, useNavigate, Navigate } from "react-router-dom";
import Login from "./features/auth/auth_components";
import MenuPage from "./features/menu-cart/MenuPage";
import AdminPanel from "./features/menu-cart/AdminPanel";

// TEMPORARY BYPASS - Defines the component here so Vite stops looking for a missing file
function OrderPaymentApp() {
  return (
    <div className="container mt-5 text-center">
      <div className="card p-5 shadow">
        <h3>🛒 Order & Payment Page</h3>
        <p className="text-muted">Placeholder active. Frontend code compiled successfully!</p>
      </div>
    </div>
  );
}

// 1. Route Protector: Kicks unauthenticated users back to login
function ProtectedRoute({ user, children }) {
  if (!user) return <Navigate to="/" replace />;
  return children;
}

function CafeteriaLayout({ user, handleLogout }) {
  return (
    <div>
      <nav className="navbar navbar-dark bg-dark px-4 d-flex justify-content-between">
        <span className="navbar-brand">🍴 Cafeteria System</span>
        <div className="d-flex align-items-center">
          <NavLink to="/menu" className={({ isActive }) => `btn me-2 ${isActive ? "btn-light" : "btn-outline-light"}`}>
            Menu
          </NavLink>
          {user?.role === "admin" && (
            <NavLink to="/admin" className={({ isActive }) => `btn me-2 ${isActive ? "btn-light" : "btn-outline-light"}`}>
              Admin
            </NavLink>
          )}
          <NavLink to="/order" className={({ isActive }) => `btn me-2 ${isActive ? "btn-light" : "btn-outline-light"}`}>
            Cart & Pay
          </NavLink>
          <button className="btn btn-danger ms-3" onClick={handleLogout}>Logout</button>
        </div>
      </nav>
      <div className="p-4">
        <Outlet />
      </div>
    </div>
  );
}

function LoginPage({ setUser }) {
  const navigate = useNavigate();
  return (
    <Login
      onLoginSuccess={(data) => {
        localStorage.setItem("user", JSON.stringify(data.user));
        setUser(data.user);
        navigate("/menu");
      }}
    />
  );
}

export default function App() {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem("user");
    return saved ? JSON.parse(saved) : null;
  });
  const [cart, setCart] = useState([]);

  const handleLogout = () => {
    localStorage.removeItem("user");
    localStorage.removeItem("jwt_token");
    setUser(null);
    setCart([]);
  };

  return (
    <BrowserRouter>
      <Routes>
        {/* Public Route */}
        <Route path="/" element={<LoginPage setUser={setUser} />} />

        {/* Protected Routes inside the Layout */}
        <Route element={<ProtectedRoute user={user}><CafeteriaLayout user={user} handleLogout={handleLogout} /></ProtectedRoute>}>
          <Route path="/menu" element={<MenuPage cart={cart} setCart={setCart} />} />
          <Route path="/admin" element={<AdminPanel />} />
        </Route>

        {/* Standalone Order Route using local component */}
        <Route 
          path="/order" 
          element={
            <ProtectedRoute user={user}>
              <OrderPaymentApp 
                user={user} 
                cart={cart} 
                clearCart={() => setCart([])} 
              />
            </ProtectedRoute>
          } 
        />
      </Routes>
    </BrowserRouter>
  );
}