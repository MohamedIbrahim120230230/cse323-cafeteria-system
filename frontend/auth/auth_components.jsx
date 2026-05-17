// ============================================================
// frontend/auth/Login.jsx
// Auth & Identity — FR01 FR02 FR03 FR04 FR06 FR08
// Includes university email domain validation (@ejust.edu.eg)
// ============================================================

import React, { useState, useEffect, useCallback, useRef } from "react";

// ── Google Fonts & Bootstrap Icons ───────────────────────────
if (typeof document !== "undefined") {
  const f = document.createElement("link");
  f.rel  = "stylesheet";
  f.href = "https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&family=DM+Sans:wght@400;500;600&display=swap";
  document.head.appendChild(f);
  const i = document.createElement("link");
  i.rel  = "stylesheet";
  i.href = "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css";
  document.head.appendChild(i);
}

// ── University domain config ──────────────────────────────────
const ALLOWED_DOMAINS = ["ejust.edu.eg"];

function isUniversityEmail(email) {
  try {
    const domain = email.trim().split("@")[1]?.toLowerCase();
    return ALLOWED_DOMAINS.includes(domain);
  } catch {
    return false;
  }
}

// ── API helper ────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("jwt_token");
  const res = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const text = await res.text();
  if (!text) throw { code: "EMPTY_RESPONSE", message: "Server returned an empty response." };
  let json;
  try { json = JSON.parse(text); }
  catch { throw { code: "INVALID_JSON", message: "Server returned an unexpected response." }; }
  if (!res.ok) throw json.error ?? { code: "HTTP_ERROR", message: `HTTP ${res.status}` };
  return json.data;
}

// ── Lockout countdown ─────────────────────────────────────────
function useLockoutTimer(unlocksAt) {
  const [secondsLeft, setSecondsLeft] = useState(0);
  useEffect(() => {
    if (!unlocksAt) { setSecondsLeft(0); return; }
    const tick = () =>
      setSecondsLeft(Math.max(0, Math.ceil((new Date(unlocksAt) - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [unlocksAt]);
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");
  return { secondsLeft, display: `${mm}:${ss}` };
}

// ── Password strength ─────────────────────────────────────────
function getStrength(pw) {
  if (!pw) return { score: 0, label: "", cls: "" };
  let s = 0;
  if (pw.length >= 8)           s++;
  if (/[A-Z]/.test(pw))        s++;
  if (/[0-9]/.test(pw))        s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return {
    score: s,
    label: ["", "Weak", "Weak", "Fair", "Strong"][s],
    cls:   ["", "weak", "weak", "medium", "strong"][s],
  };
}

// ── Step dots ─────────────────────────────────────────────────
function StepDots({ current, total }) {
  return (
    <div className="uc-steps" role="progressbar" aria-valuenow={current} aria-valuemax={total}>
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} className={`uc-dot ${i === current ? "active" : i < current ? "done" : ""}`} />
      ))}
    </div>
  );
}

// ── Floating food icons ───────────────────────────────────────
function FloatingIcons() {
  const icons = ["🍕","🥗","☕","🍱","🥪","🍜","🥤","🍔"];
  return (
    <div className="uc-float-icons" aria-hidden="true">
      {icons.map((ic, i) => (
        <span key={i} className={`uc-fi uc-fi--${i}`}>{ic}</span>
      ))}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN EXPORT
// ════════════════════════════════════════════════════════════
export function Login({ onLoginSuccess, navigate }) {
  const [view,      setView]      = useState("login");
  const [email,     setEmail]     = useState("");
  const [password,  setPassword]  = useState("");
  const [showPass,  setShowPass]  = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);
  const [unlocksAt, setUnlocksAt] = useState(null);
  const [shake,     setShake]     = useState(false);
  const emailRef = useRef(null);

  const { secondsLeft, display: lockDisplay } = useLockoutTimer(unlocksAt);

  useEffect(() => { emailRef.current?.focus(); }, []);

  const triggerShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 600);
  };

  const handleLogin = useCallback(async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // ── Frontend domain validation (instant, before API call) ──
    if (!isUniversityEmail(email)) {
      const domainList = ALLOWED_DOMAINS.map(d => `@${d}`).join(", ");
      setError({
        code: "INVALID_EMAIL_DOMAIN",
        message: `Only university email addresses are allowed (${domainList}).`,
      });
      triggerShake();
      setLoading(false);
      return;
    }

    try {
      const data = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });
      localStorage.setItem("jwt_token", data.access_token);
      if (onLoginSuccess) onLoginSuccess(data);
      if (navigate) {
        const map = { student: "/menu", staff: "/kitchen", admin: "/admin" };
        navigate(map[data.user.role] ?? "/");
      }
    } catch (err) {
      setError(err);
      triggerShake();
      if (err?.code === "ACCOUNT_LOCKED" && err?.details?.unlocks_at) {
        setUnlocksAt(err.details.unlocks_at);
      }
    } finally {
      setLoading(false);
    }
  }, [email, password, navigate, onLoginSuccess]);

  return (
    <>
      <style>{CSS}</style>
      <div className="uc-page">
        <div className="uc-mesh"  aria-hidden="true" />
        <div className="uc-grid"  aria-hidden="true" />
        <FloatingIcons />

        <div className="uc-center">
          {/* Logo */}
          <div className="uc-logo">
            <div className="uc-logo-mark">🍽️</div>
            <span className="uc-logo-name">CampusBite</span>
          </div>

          {/* ── LOGIN ── */}
          {view === "login" && (
            <div className={`uc-card ${shake ? "uc-shake" : ""}`}>
              <div className="uc-card-head">
                <h1 className="uc-heading">Welcome back</h1>
                <p className="uc-sub">
                  Sign in with your <strong>@ejust.edu.eg</strong> account
                </p>
              </div>

              {error && <ErrorBanner error={error} lockDisplay={lockDisplay} />}

              <form onSubmit={handleLogin} noValidate data-testid="login-form">

                {/* Email */}
                <div className="uc-field">
                  <label htmlFor="uc-email" className="uc-label">University Email</label>
                  <div className="uc-iw">
                    <i className="bi bi-envelope uc-iico" aria-hidden="true" />
                    <input
                      ref={emailRef}
                      id="uc-email"
                      data-testid="email-input"
                      type="email"
                      className={`uc-input${error ? " uc-input--err" : ""}`}
                      placeholder="name.ID@ejust.edu.eg"
                      value={email}
                      onChange={e => { setEmail(e.target.value); setError(null); }}
                      disabled={loading || secondsLeft > 0}
                      required
                      autoComplete="username"
                    />
                    {/* Live domain badge */}
                    {email.includes("@") && (
                      <span className={`uc-domain-badge ${isUniversityEmail(email) ? "valid" : "invalid"}`}>
                        <i className={`bi ${isUniversityEmail(email) ? "bi-check-circle-fill" : "bi-x-circle-fill"}`} />
                        {isUniversityEmail(email) ? " University" : " Invalid domain"}
                      </span>
                    )}
                  </div>
                </div>

                {/* Password */}
                <div className="uc-field">
                  <div className="uc-field-row">
                    <label htmlFor="uc-pw" className="uc-label" style={{ marginBottom: 0 }}>Password</label>
                    <button type="button" className="uc-link-btn"
                      onClick={() => setView("reset-request")}
                      data-testid="forgot-password-link">
                      Forgot password?
                    </button>
                  </div>
                  <div className="uc-iw">
                    <i className="bi bi-lock uc-iico" aria-hidden="true" />
                    <input
                      id="uc-pw"
                      data-testid="password-input"
                      type={showPass ? "text" : "password"}
                      className={`uc-input${error ? " uc-input--err" : ""}`}
                      placeholder="Min. 8 characters"
                      value={password}
                      onChange={e => { setPassword(e.target.value); setError(null); }}
                      disabled={loading || secondsLeft > 0}
                      required
                      autoComplete="current-password"
                    />
                    <button type="button" className="uc-eye"
                      onClick={() => setShowPass(v => !v)}
                      aria-label={showPass ? "Hide password" : "Show password"}>
                      <i className={`bi ${showPass ? "bi-eye-slash" : "bi-eye"}`} aria-hidden="true" />
                    </button>
                  </div>
                  {password.length > 0 && <StrengthBar pw={password} />}
                </div>

                {/* Submit */}
                <button
                  type="submit"
                  data-testid="login-submit"
                  className={`uc-btn${secondsLeft > 0 ? " uc-btn--locked" : ""}`}
                  disabled={loading || secondsLeft > 0 || !email || !password}
                >
                  {loading ? (
                    <><span className="uc-spinner" /><span>Signing in…</span></>
                  ) : secondsLeft > 0 ? (
                    <><i className="bi bi-lock-fill" aria-hidden="true" />
                      <span>Locked — <span className="uc-mono">{lockDisplay}</span></span></>
                  ) : (
                    <><i className="bi bi-box-arrow-in-right" aria-hidden="true" /><span>Sign In</span></>
                  )}
                </button>

              </form>

              {/* Domain hint */}
              <p className="uc-hint">
                <i className="bi bi-info-circle me-1" />
                Only <strong>@ejust.edu.eg</strong> email addresses are accepted
              </p>
            </div>
          )}

          {/* ── RESET REQUEST ── */}
          {view === "reset-request" && (
            <ResetRequest onBack={() => setView("login")} onSent={() => setView("reset-sent")} />
          )}

          {/* ── RESET SENT ── */}
          {view === "reset-sent" && (
            <ResetSent onBack={() => setView("login")} />
          )}

          <p className="uc-footer">
            Need help? <a href="mailto:helpdesk@ejust.edu.eg">Contact IT Helpdesk</a>
            <span className="uc-sep">·</span>
            <a href="/privacy">Privacy</a>
          </p>
        </div>
      </div>
    </>
  );
}

// ── Error banner ──────────────────────────────────────────────
function ErrorBanner({ error, lockDisplay }) {
  const map = {
    INVALID_EMAIL_DOMAIN: {
      type: "warn", icon: "bi-envelope-x-fill",
      title: "Invalid email domain",
      body: error.message || `Only @${ALLOWED_DOMAINS.join(", @")} addresses are allowed.`,
    },
    ACCOUNT_LOCKED: {
      type: "warn", icon: "bi-lock-fill",
      title: "Account temporarily locked",
      body: <>Too many failed attempts. Unlocks in{" "}
        <span className="uc-mono" style={{ color: "var(--uc-gold)" }}>{lockDisplay}</span></>,
    },
    ACCOUNT_SUSPENDED: {
      type: "danger", icon: "bi-slash-circle-fill",
      title: "Account suspended",
      body: "Contact the university helpdesk to resolve this issue.",
    },
    INVALID_CREDENTIALS: {
      type: "danger", icon: "bi-exclamation-triangle-fill",
      title: "Invalid credentials",
      body: error.message || "Please check your email and password.",
    },
    EMPTY_RESPONSE: {
      type: "danger", icon: "bi-wifi-off",
      title: "Cannot reach server",
      body: "Make sure the backend is running on port 8000.",
    },
    INVALID_JSON: {
      type: "danger", icon: "bi-bug-fill",
      title: "Server error",
      body: "Check the terminal for errors.",
    },
  };

  const cfg = map[error?.code] ?? {
    type: "danger", icon: "bi-exclamation-circle",
    title: "Something went wrong",
    body: error?.message || "Please try again.",
  };

  return (
    <div role="alert" aria-live="assertive" className={`uc-alert uc-alert--${cfg.type}`}>
      <i className={`bi ${cfg.icon} uc-alert-ico`} aria-hidden="true" />
      <div>
        <strong className="uc-alert-title">{cfg.title}</strong>
        <span className="uc-alert-body">{cfg.body}</span>
      </div>
    </div>
  );
}

// ── Strength bar ──────────────────────────────────────────────
function StrengthBar({ pw }) {
  const { score, label, cls } = getStrength(pw);
  return (
    <div className="uc-str-wrap" role="meter" aria-label={`Password strength: ${label}`}>
      <div className="uc-str-bars">
        {[0,1,2,3].map(i => (
          <div key={i} className={`uc-str-bar${i < score ? ` uc-str-bar--${cls}` : ""}`} />
        ))}
      </div>
      {label && <span className={`uc-str-label uc-str-label--${cls}`}>{label}</span>}
    </div>
  );
}

// ── Reset request ─────────────────────────────────────────────
function ResetRequest({ onBack, onSent }) {
  const [email,   setEmail]   = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  const handle = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await apiFetch("/auth/password-reset/request", {
        method: "POST",
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      onSent();
    } catch {
      onSent(); // always show success (anti-enumeration)
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="uc-card" data-testid="reset-request-form">
      <StepDots current={0} total={2} />
      <div className="uc-card-head">
        <h2 className="uc-heading">Reset password</h2>
        <p className="uc-sub">Enter your university email — we'll send a link valid for 15 minutes.</p>
      </div>
      <form onSubmit={handle} noValidate>
        <div className="uc-field">
          <label htmlFor="uc-rem" className="uc-label">University Email</label>
          <div className="uc-iw">
            <i className="bi bi-envelope uc-iico" aria-hidden="true" />
            <input id="uc-rem" data-testid="reset-email-input" type="email"
              className="uc-input" placeholder="name.ID@ejust.edu.eg"
              value={email} onChange={e => setEmail(e.target.value)}
              required disabled={loading} autoFocus />
          </div>
        </div>
        <button type="submit" data-testid="reset-submit" className="uc-btn" disabled={loading || !email}>
          {loading
            ? <><span className="uc-spinner" /><span>Sending…</span></>
            : <><i className="bi bi-send" aria-hidden="true" /><span>Send Reset Link</span></>}
        </button>
      </form>
      <div className="uc-divider">or</div>
      <button type="button" className="uc-ghost-btn" onClick={onBack}>
        <i className="bi bi-arrow-left" aria-hidden="true" /> Back to Sign In
      </button>
    </div>
  );
}

// ── Reset sent ────────────────────────────────────────────────
function ResetSent({ onBack }) {
  return (
    <div className="uc-card">
      <StepDots current={1} total={2} />
      <div className="uc-success">
        <div className="uc-success-icon">✉️</div>
        <h2 className="uc-heading" style={{ fontSize: 20 }}>Check your inbox</h2>
        <p className="uc-sub" style={{ marginBottom: 24 }}>
          A reset link has been sent if your email is registered.
          It expires in <strong style={{ color: "var(--uc-text)" }}>15 minutes</strong>.
        </p>
        <button type="button" data-testid="back-to-login" className="uc-btn"
          onClick={onBack} style={{ maxWidth: 200, margin: "0 auto" }}>
          <i className="bi bi-arrow-left" aria-hidden="true" /><span>Back to Sign In</span>
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// CSS
// ════════════════════════════════════════════════════════════
const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --uc-bg:    #080d14; --uc-card:  #111825;
    --uc-brd:   rgba(255,255,255,0.07); --uc-brd-hi: rgba(99,179,237,0.4);
    --uc-acc:   #3b9eda; --uc-acc2:  #22c993; --uc-gold: #f6c90e;
    --uc-text:  #e8edf5; --uc-muted: #6b7a90;
    --uc-danger:#f56565; --uc-warn:  #f6ad55;
    --uc-inp:   rgba(255,255,255,0.035);
    --uc-r:14px; --uc-rs:9px;
    --fd:'Sora',sans-serif; --fb:'DM Sans',sans-serif;
  }
  .uc-page {
    min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:var(--uc-bg); font-family:var(--fb); color:var(--uc-text);
    position:relative; overflow:hidden; padding:24px 16px;
  }
  .uc-mesh { position:fixed; inset:0; z-index:0; pointer-events:none; overflow:hidden; }
  .uc-mesh::before {
    content:''; position:absolute; inset:-40%;
    background:
      radial-gradient(ellipse 65% 55% at 15% 25%,rgba(59,158,218,.14) 0%,transparent 60%),
      radial-gradient(ellipse 55% 45% at 85% 75%,rgba(34,201,147,.10) 0%,transparent 55%),
      radial-gradient(ellipse 45% 55% at 55% 5%, rgba(246,201,14,.07) 0%,transparent 50%);
    animation:meshMove 18s ease-in-out infinite alternate;
  }
  @keyframes meshMove { from{transform:translate(0,0) rotate(0)} to{transform:translate(2%,1.5%) rotate(2deg)} }
  .uc-grid {
    position:fixed; inset:0; z-index:0; pointer-events:none;
    background-image:linear-gradient(rgba(255,255,255,.016) 1px,transparent 1px),
                     linear-gradient(90deg,rgba(255,255,255,.016) 1px,transparent 1px);
    background-size:52px 52px;
  }
  .uc-float-icons { position:fixed; inset:0; z-index:0; pointer-events:none; }
  .uc-fi { position:absolute; font-size:clamp(16px,2vw,24px); opacity:.055; filter:blur(.4px); animation:drift ease-in-out infinite; }
  .uc-fi--0{top:6%;left:4%;animation-duration:22s;animation-delay:0s}
  .uc-fi--1{top:14%;right:5%;animation-duration:19s;animation-delay:3s}
  .uc-fi--2{top:72%;left:3%;animation-duration:25s;animation-delay:6s}
  .uc-fi--3{top:82%;right:4%;animation-duration:20s;animation-delay:1s}
  .uc-fi--4{top:42%;left:2%;animation-duration:23s;animation-delay:8s}
  .uc-fi--5{top:58%;right:3%;animation-duration:21s;animation-delay:4s}
  .uc-fi--6{top:28%;left:8%;animation-duration:18s;animation-delay:10s}
  .uc-fi--7{top:91%;left:50%;animation-duration:24s;animation-delay:2s}
  @keyframes drift{0%,100%{transform:translate(0,0) rotate(0)}25%{transform:translate(7px,-10px) rotate(4deg)}50%{transform:translate(-5px,7px) rotate(-3deg)}75%{transform:translate(9px,5px) rotate(3deg)}}
  .uc-center {
    position:relative; z-index:1; width:100%; max-width:440px;
    display:flex; flex-direction:column; align-items:center;
    animation:fadeUp .45s ease both;
  }
  @keyframes fadeUp { from{opacity:0;transform:translateY(18px)} to{opacity:1;transform:translateY(0)} }
  .uc-logo { display:flex; align-items:center; gap:10px; margin-bottom:24px; }
  .uc-logo-mark {
    width:48px; height:48px; border-radius:14px;
    background:linear-gradient(135deg,var(--uc-acc),var(--uc-acc2));
    display:flex; align-items:center; justify-content:center; font-size:22px;
    box-shadow:0 6px 20px rgba(59,158,218,.28);
  }
  .uc-logo-name { font-family:var(--fd); font-size:22px; font-weight:700; letter-spacing:-.02em; }
  .uc-card {
    width:100%; background:var(--uc-card); border:1px solid var(--uc-brd);
    border-radius:var(--uc-r); padding:clamp(24px,5vw,36px);
    box-shadow:0 28px 60px rgba(0,0,0,.55); backdrop-filter:blur(14px);
    transition:border-color .25s;
  }
  .uc-card:focus-within { border-color:var(--uc-brd-hi); }
  .uc-shake { animation:shake .5s ease; }
  @keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}
  .uc-card-head { margin-bottom:20px; }
  .uc-heading { font-family:var(--fd); font-size:clamp(20px,3vw,26px); font-weight:700; letter-spacing:-.025em; margin-bottom:5px; }
  .uc-sub { font-size:13.5px; color:var(--uc-muted); line-height:1.5; }
  .uc-field { margin-bottom:16px; }
  .uc-field-row { display:flex; justify-content:space-between; align-items:center; margin-bottom:7px; }
  .uc-label { display:block; font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:var(--uc-muted); margin-bottom:7px; }
  .uc-iw { position:relative; display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
  .uc-iico { position:absolute; left:13px; z-index:1; color:var(--uc-muted); font-size:14px; pointer-events:none; transition:color .2s; }
  .uc-iw:focus-within .uc-iico { color:var(--uc-acc); }
  .uc-input {
    width:100%; background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-text); font-family:var(--fb); font-size:14.5px; padding:11.5px 42px;
    outline:none; transition:border-color .2s,box-shadow .2s,background .2s; -webkit-appearance:none;
  }
  .uc-input::placeholder { color:rgba(107,122,144,.55); }
  .uc-input:focus { border-color:var(--uc-acc); background:rgba(59,158,218,.045); box-shadow:0 0 0 3px rgba(59,158,218,.13); }
  .uc-input:disabled { opacity:.45; cursor:not-allowed; }
  .uc-input--err { border-color:var(--uc-danger) !important; }
  .uc-input--err:focus { box-shadow:0 0 0 3px rgba(245,101,101,.14) !important; }
  .uc-eye { position:absolute; right:11px; background:none; border:none; cursor:pointer; color:var(--uc-muted); font-size:14px; padding:4px; transition:color .2s; }
  .uc-eye:hover { color:var(--uc-acc); }
  .uc-link-btn { background:none; border:none; cursor:pointer; padding:0; font-family:var(--fb); font-size:12px; font-weight:600; color:var(--uc-acc); transition:opacity .2s; }
  .uc-link-btn:hover { opacity:.72; }

  /* Domain badge shown after @ is typed */
  .uc-domain-badge {
    display:inline-flex; align-items:center; gap:4px;
    font-size:11px; font-weight:600; padding:3px 9px; border-radius:100px;
    margin-top:5px; width:100%;
  }
  .uc-domain-badge.valid   { background:rgba(34,201,147,.1);  color:var(--uc-acc2); border:1px solid rgba(34,201,147,.25); }
  .uc-domain-badge.invalid { background:rgba(245,101,101,.1); color:var(--uc-danger); border:1px solid rgba(245,101,101,.25); }

  /* Hint text */
  .uc-hint { font-size:11.5px; color:var(--uc-muted); margin-top:14px; text-align:center; line-height:1.5; }
  .uc-hint strong { color:var(--uc-text); }

  .uc-str-wrap { display:flex; align-items:center; gap:8px; margin-top:7px; }
  .uc-str-bars { display:flex; gap:4px; flex:1; }
  .uc-str-bar  { flex:1; height:3px; border-radius:2px; background:var(--uc-brd); transition:background .3s; }
  .uc-str-bar--weak   { background:var(--uc-danger); }
  .uc-str-bar--medium { background:var(--uc-warn); }
  .uc-str-bar--strong { background:var(--uc-acc2); }
  .uc-str-label { font-size:11px; font-weight:600; min-width:38px; }
  .uc-str-label--weak   { color:var(--uc-danger); }
  .uc-str-label--medium { color:var(--uc-warn); }
  .uc-str-label--strong { color:var(--uc-acc2); }

  .uc-btn {
    width:100%; display:flex; align-items:center; justify-content:center; gap:8px;
    background:linear-gradient(135deg,var(--uc-acc) 0%,#2878be 100%);
    border:none; border-radius:var(--uc-rs); color:#fff;
    font-family:var(--fb); font-size:14.5px; font-weight:600;
    padding:13px 20px; cursor:pointer; letter-spacing:.01em;
    box-shadow:0 4px 18px rgba(59,158,218,.32);
    transition:transform .15s,box-shadow .15s,opacity .2s;
    position:relative; overflow:hidden; margin-top:6px;
  }
  .uc-btn::after { content:''; position:absolute; inset:0; background:linear-gradient(rgba(255,255,255,.13),transparent); opacity:0; transition:opacity .2s; }
  .uc-btn:hover:not(:disabled)::after { opacity:1; }
  .uc-btn:hover:not(:disabled) { transform:translateY(-1px); box-shadow:0 8px 26px rgba(59,158,218,.42); }
  .uc-btn:active:not(:disabled) { transform:translateY(0); }
  .uc-btn:disabled { opacity:.45; cursor:not-allowed; transform:none; box-shadow:none; }
  .uc-btn--locked { background:linear-gradient(135deg,#4a3728,#6b4c38) !important; box-shadow:0 4px 14px rgba(246,173,85,.18) !important; }
  .uc-ghost-btn {
    width:100%; background:var(--uc-inp); border:1px solid var(--uc-brd); border-radius:var(--uc-rs);
    color:var(--uc-muted); font-family:var(--fb); font-size:13.5px; padding:11px;
    cursor:pointer; transition:border-color .2s,color .2s;
  }
  .uc-ghost-btn:hover { border-color:var(--uc-acc); color:var(--uc-text); }
  .uc-spinner { width:15px; height:15px; flex-shrink:0; border:2px solid rgba(255,255,255,.3); border-top-color:#fff; border-radius:50%; animation:spin .7s linear infinite; }
  @keyframes spin { to{transform:rotate(360deg)} }
  .uc-mono { font-family:monospace; font-size:15px; font-weight:700; color:var(--uc-gold); }
  .uc-alert {
    display:flex; align-items:flex-start; gap:10px; border-radius:var(--uc-rs);
    padding:11px 13px; margin-bottom:16px; line-height:1.5; animation:fadeUp .25s ease both;
  }
  .uc-alert--danger { background:rgba(245,101,101,.08); border:1px solid rgba(245,101,101,.22); color:#fc8181; }
  .uc-alert--warn   { background:rgba(246,173,85,.08);  border:1px solid rgba(246,173,85,.22);  color:var(--uc-warn); }
  .uc-alert-ico   { font-size:15px; flex-shrink:0; margin-top:1px; }
  .uc-alert-title { display:block; font-size:12.5px; font-weight:700; color:#fff; margin-bottom:2px; }
  .uc-alert-body  { display:block; font-size:12px; opacity:.85; }
  .uc-steps { display:flex; gap:6px; justify-content:center; margin-bottom:18px; }
  .uc-dot { width:6px; height:6px; border-radius:50%; background:var(--uc-brd); transition:all .3s; }
  .uc-dot.active { background:var(--uc-acc); width:20px; border-radius:3px; }
  .uc-dot.done   { background:var(--uc-acc2); }
  .uc-divider { display:flex; align-items:center; gap:10px; margin:16px 0; color:var(--uc-muted); font-size:11px; }
  .uc-divider::before,.uc-divider::after { content:''; flex:1; height:1px; background:var(--uc-brd); }
  .uc-success { text-align:center; padding:8px 0; }
  .uc-success-icon {
    width:60px; height:60px; border-radius:50%;
    background:rgba(34,201,147,.1); border:2px solid rgba(34,201,147,.28);
    display:flex; align-items:center; justify-content:center; font-size:26px;
    margin:0 auto 14px; animation:popIn .4s cubic-bezier(.175,.885,.32,1.275) both;
  }
  @keyframes popIn { from{transform:scale(.55);opacity:0} to{transform:scale(1);opacity:1} }
  .uc-footer { margin-top:18px; font-size:11.5px; color:var(--uc-muted); text-align:center; }
  .uc-footer a { color:var(--uc-acc); text-decoration:none; font-weight:500; }
  .uc-footer a:hover { text-decoration:underline; }
  .uc-sep { margin:0 7px; opacity:.3; }
  @media(max-width:480px) { .uc-card{padding:20px 18px;border-radius:12px} }
`;

export default Login;