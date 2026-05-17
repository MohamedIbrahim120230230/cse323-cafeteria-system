// App.jsx
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import Login from "./features/auth/auth_components";
import MenuPage from "./features/menu-cart/MenuPage";
import AdminPanel from "./features/menu-cart/AdminPanel";
import StockDashboard from "./features/stock/StockDashboard";
// import KitchenPage from "./features/kitchen/KitchenPage"; // uncomment when ready

function CafeteriaLayout() {
  return (
    <div>
      <nav className="navbar navbar-dark bg-dark px-4">
        <span className="navbar-brand">🍴 Cafeteria System</span>
        <div>
          <NavLink 
            to="/menu" 
            className={({ isActive }) => `btn me-2 ${isActive ? 'btn-light' : 'btn-outline-light'}`}
          >
            Menu
          </NavLink>
          <NavLink 
            to="/admin" 
            className={({ isActive }) => `btn ${isActive ? 'btn-light' : 'btn-outline-light'}`}
          >
            Admin
          </NavLink>
          <NavLink 
            to="/stock" 
            className={({ isActive }) => `btn ms-2 ${isActive ? 'btn-light' : 'btn-outline-light'}`}
          >
            Stock
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

function RequireRole({ allowed, children }) {
  const user = JSON.parse(localStorage.getItem("user") || "null");
  if (!user) return <Navigate to="/" replace />;
  if (!allowed.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LoginPage />} />
<Route path="/stock" element={
          <RequireRole allowed={["admin"]}>
            <StockDashboard />
          </RequireRole>
        } />
        {/* student + admin */}
        <Route path="/menu" element={
          <RequireRole allowed={["student", "admin"]}>
            <MenuPage />
          </RequireRole>
        } />
        {/* admin only */}
        <Route path="/admin" element={
          <RequireRole allowed={["admin"]}>
            <AdminPanel />
          </RequireRole>
        } />
        {/* staff only — swap placeholder div for <KitchenPage /> when built */}
        <Route path="/kitchen" element={
          <RequireRole allowed={["staff"]}>
            <div style={{color:"white",padding:40}}>Kitchen panel coming soon</div>
            {/* <KitchenPage /> */}
          </RequireRole>
        } />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;