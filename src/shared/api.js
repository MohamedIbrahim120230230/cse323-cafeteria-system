const BASE = import.meta.env.VITE_API_BASE || "/api/v1";

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
  const json = await res.json();
  if (!res.ok) throw json.error;
  return json.data;
}
