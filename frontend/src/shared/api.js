// ============================================================
// frontend/src/shared/api.js
// ── FIXES APPLIED ────────────────────────────────────────────
// FIX-1: apiLogin now reads `data.access_token` (what the backend
//         actually returns) AND falls back to `json.token` so
//         both backend shapes work.
// FIX-2: apiLogin sends { email, password } not { username, password }
//         to match the /auth/login contract used in auth_components.
// FIX-3: apiFetch now parses text first (like auth_components did
//         locally) so it never crashes on empty/non-JSON responses.
// FIX-4: 401 auto-logout added to apiFetch so every feature file
//         gets session expiry handling for free.
// FIX-5: apiLogout calls the backend logout endpoint before clearing
//         local storage so the server can invalidate the token.
// ============================================================

const BASE = import.meta.env.VITE_API_BASE || "/api/v1";

// ── Core fetch wrapper ────────────────────────────────────────
export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("jwt_token");
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  // FIX-3: read as text first — never crash on empty/non-JSON body
  const text = await res.text();
  if (!text) {
    if (!res.ok) throw { code: "EMPTY_RESPONSE", message: "Server returned no data." };
    return null;
  }

  let json;
  try { json = JSON.parse(text); }
  catch { throw { code: "INVALID_JSON", message: "Unexpected server response." }; }

  // FIX-4: auto-logout on 401 so every feature file gets it for free
  if (res.status === 401) {
    localStorage.removeItem("jwt_token");
    localStorage.removeItem("user");
    window.location.href = "/";
    return;
  }

  if (!res.ok) throw json.error ?? json;

  return json.data !== undefined ? json.data : json;
}

// ── Auth helpers ──────────────────────────────────────────────

// FIX-1 + FIX-2: correct field names + correct token key
export async function apiLogin(email, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // FIX-2: backend expects `email`, not `username`
    body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
  });

  const text = await res.text();
  if (!text) throw { code: "EMPTY_RESPONSE", message: "Server returned no data." };

  let json;
  try { json = JSON.parse(text); }
  catch { throw { code: "INVALID_JSON", message: "Unexpected server response." }; }

  if (!res.ok) throw json.error ?? json;

  // FIX-1: backend returns `access_token` inside a `data` envelope.
  // Support both shapes: { data: { access_token, user } } and { token, user }
  const payload = json.data ?? json;
  const token   = payload.access_token ?? payload.token ?? null;

  if (token) localStorage.setItem("jwt_token", token);

  // Always return a consistent shape: { user, access_token }
  return payload;
}

// FIX-5: hit the logout endpoint first so the server can blacklist the token
export async function apiLogout() {
  try {
    const token = localStorage.getItem("jwt_token");
    if (token) {
      await fetch(`${BASE}/auth/logout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
    }
  } catch {
    // fire-and-forget — always clear local state regardless
  } finally {
    localStorage.removeItem("jwt_token");
    localStorage.removeItem("user");
  }
}