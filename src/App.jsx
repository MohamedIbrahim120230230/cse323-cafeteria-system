import { BrowserRouter, Routes, Route } from "react-router-dom";
import Login from "../frontend/auth/auth_components";
function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Login />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;