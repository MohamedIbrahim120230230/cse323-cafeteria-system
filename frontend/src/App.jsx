import { BrowserRouter, Routes, Route, NavLink, Outlet, useNavigate } from "react-router-dom";
import Login from "./features/auth/auth_components";
import MenuPage from "./features/menu-cart/MenuPage";
import AdminPanel from "./features/menu-cart/AdminPanel";
import OrderPaymentApp from "./OrderPaymentApp";

function CafeteriaLayout() {
  return (
    <div>
      <nav className="navbar navbar-dark bg-dark px-4">
        <span className="navbar-brand">🍴 Cafeteria System</span>
        <div>
          <NavLink
            to="/menu"
            className={({ isActive }) => `btn me-2 ${isActive ? "btn-light" : "btn-outline-light"}`}
          >
            Menu
          </NavLink>
          <NavLink
            to="/admin"
            className={({ isActive }) => `btn me-2 ${isActive ? "btn-light" : "btn-outline-light"}`}
          >
            Admin
          </NavLink>
          <NavLink
            to="/order"
            className={({ isActive }) => `btn ${isActive ? "btn-light" : "btn-outline-light"}`}
          >
            Order & Pay
          </NavLink>
        </div>
      </nav>
      <div className="p-4">
        <Outlet />
      </div>
    </div>
  );
}

// Separate wrapper so we can call useNavigate (hooks need to be inside BrowserRouter)
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

// Wraps OrderPaymentApp so its own internal navbar renders without the
// CafeteriaLayout double-navbar issue, while still living inside BrowserRouter.
function OrderPaymentPage() {
  return <OrderPaymentApp />;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public route */}
        <Route path="/" element={<LoginPage />} />

        {/* Routes that share the CafeteriaLayout navbar */}
        <Route element={<CafeteriaLayout />}>
          <Route path="/menu"  element={<MenuPage />} />
          <Route path="/admin" element={<AdminPanel />} />
        </Route>

        {/* Order & Payment — rendered standalone because OrderPaymentApp
            has its own navbar, step indicator, and Bootstrap styles built in.
            Mounting it inside CafeteriaLayout would produce a double navbar. */}
        <Route path="/order" element={<OrderPaymentPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
