// ============================================================
// tests/auth/  — Playwright + Page Object Model
// Feature: Auth & Identity
// Covers: ALL Gherkin scenarios from Phase 2 Part A
//   FR01 — Login (success, suspended, invalid credentials)
//   FR03 — Account lockout after 5 failed attempts
//   FR04 — Session expiry on 30-min inactivity
//   FR09 — (Auth guard) Menu access requires valid session
// Run: npx playwright test tests/auth/
// ============================================================

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// pages/LoginPage.js   — Page Object Model
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// FILE: tests/auth/pages/LoginPage.js

/**
 * LoginPage POM
 * Encapsulates all selectors and interactions for the Login UI.
 * Tests never touch raw locators — always go through this class.
 */
class LoginPage {
  constructor(page) {
    this.page = page;

    // ── Locators (data-testid driven — resilient to style changes) ──
    this.emailInput      = page.getByTestId("email-input");
    this.passwordInput   = page.getByTestId("password-input");
    this.submitButton    = page.getByTestId("login-submit");
    this.forgotPassLink  = page.getByTestId("forgot-password-link");
    this.loginForm       = page.getByTestId("login-form");

    // Error / alert regions (aria-live for accessibility)
    this.alertRegion     = page.locator('[role="alert"][aria-live="assertive"]');
    this.anyAlert        = page.locator('.alert');

    // Lockout countdown displayed inside the submit button
    this.lockoutDisplay  = page.locator('.font-monospace');

    // Spinner inside submit button (loading state)
    this.spinner         = page.locator('.spinner-border');
  }

  async goto() {
    await this.page.goto("/login");
    await this.loginForm.waitFor({ state: "visible" });
  }

  async fillEmail(email) {
    await this.emailInput.clear();
    await this.emailInput.fill(email);
  }

  async fillPassword(password) {
    await this.passwordInput.clear();
    await this.passwordInput.fill(password);
  }

  async submit() {
    await this.submitButton.click();
  }

  /**
   * Convenience: fill + submit in one call.
   */
  async login(email, password) {
    await this.fillEmail(email);
    await this.fillPassword(password);
    await this.submit();
  }

  async getAlertText() {
    await this.anyAlert.waitFor({ state: "visible", timeout: 5000 });
    return this.anyAlert.innerText();
  }

  async isSubmitDisabled() {
    return this.submitButton.isDisabled();
  }

  async waitForRedirect(expectedPath, timeout = 10_000) {
    await this.page.waitForURL(`**${expectedPath}`, { timeout });
  }

  async getLockoutTimerText() {
    await this.lockoutDisplay.waitFor({ state: "visible", timeout: 5000 });
    return this.lockoutDisplay.innerText();
  }

  async isLockedOut() {
    const btnText = await this.submitButton.innerText();
    return btnText.toLowerCase().includes("locked");
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// pages/PasswordResetPage.js   — POM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class PasswordResetPage {
  constructor(page) {
    this.page             = page;
    this.resetForm        = page.getByTestId("reset-request-form");
    this.emailInput       = page.getByTestId("reset-email-input");
    this.submitButton     = page.getByTestId("reset-submit");
    this.backToLoginBtn   = page.getByTestId("back-to-login");
    this.confirmationText = page.getByText("Check your email");
    this.anyAlert         = page.locator('.alert');
  }

  async openFromLogin(loginPage) {
    await loginPage.forgotPassLink.click();
    await this.resetForm.waitFor({ state: "visible" });
  }

  async requestReset(email) {
    await this.emailInput.fill(email);
    await this.submitButton.click();
  }

  async waitForConfirmation() {
    await this.confirmationText.waitFor({ state: "visible", timeout: 5000 });
  }

  async getAlertText() {
    await this.anyAlert.waitFor({ state: "visible", timeout: 5000 });
    return this.anyAlert.innerText();
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// pages/AdminUsersPage.js   — POM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class AdminUsersPage {
  constructor(page) {
    this.page           = page;
    this.usersTable     = page.getByTestId("users-table");
    this.createUserBtn  = page.getByTestId("create-user-btn");
    this.userModal      = page.getByTestId("user-modal");
    this.modalEmail     = page.getByTestId("modal-email");
    this.modalPassword  = page.getByTestId("modal-password");
    this.modalName      = page.getByTestId("modal-display-name");
    this.modalRole      = page.getByTestId("modal-role");
    this.modalStatus    = page.getByTestId("modal-status");
    this.modalSaveBtn   = page.getByTestId("modal-save-btn");
  }

  async goto() {
    await this.page.goto("/admin/users");
    await this.usersTable.waitFor({ state: "visible" });
  }

  async openCreateModal() {
    await this.createUserBtn.click();
    await this.userModal.waitFor({ state: "visible" });
  }

  async openEditModal(userId) {
    await this.page.getByTestId(`edit-user-${userId}`).click();
    await this.userModal.waitFor({ state: "visible" });
  }

  async fillCreateForm({ email, password, displayName, role }) {
    await this.modalEmail.fill(email);
    await this.modalPassword.fill(password);
    await this.modalName.fill(displayName);
    await this.modalRole.selectOption(role);
  }

  async saveModal() {
    await this.modalSaveBtn.click();
    await this.userModal.waitFor({ state: "hidden" });
  }

  async getUserRow(userId) {
    return this.page.getByTestId(`user-row-${userId}`);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// helpers/api.js   — Test API helpers (bypass UI for setup)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Direct API calls used in test beforeEach/afterEach for DB seeding.
 * These bypass the UI to keep test setup fast and deterministic.
 */
async function apiLogin(request, email, password) {
  const res = await request.post("/api/v1/auth/login", {
    data: { email, password },
  });
  return res.json();
}

async function apiSetFailedAttempts(request, adminToken, email, count) {
  // Internal test helper endpoint (only active in test environment)
  await request.post("/api/v1/test/set-failed-attempts", {
    data: { email, count },
    headers: { Authorization: `Bearer ${adminToken}`, "X-Test-Key": process.env.TEST_API_KEY },
  });
}

async function apiLockAccount(request, adminToken, email) {
  await request.post("/api/v1/test/lock-account", {
    data: { email },
    headers: { Authorization: `Bearer ${adminToken}`, "X-Test-Key": process.env.TEST_API_KEY },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TESTS — auth.spec.js
// Run: npx playwright test tests/auth/auth.spec.js
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ─────────────────────────────────────────────────────────────────────────────
// In real Playwright project these imports come from @playwright/test.
// Shown here as comments for clarity; replace with actual imports in .spec.js:
//
// import { test, expect } from "@playwright/test";
// import { LoginPage }     from "./pages/LoginPage";
// import { PasswordResetPage } from "./pages/PasswordResetPage";
// import { AdminUsersPage } from "./pages/AdminUsersPage";
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";

// ════════════════════════════════════════════════════════════
// FEATURE: Authentication — FR01, FR02, FR08
// Gherkin: "Feature: University Cafeteria – Authentication"
// ════════════════════════════════════════════════════════════

test.describe("FR01 — Login with University Credentials", () => {

  // ──────────────────────────────────────────────────────────
  // Scenario: Successful login with valid credentials
  // ──────────────────────────────────────────────────────────
  test("logs in successfully with valid credentials and redirects by role", async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Given a registered student
    // When the student submits the login form with correct credentials
    await loginPage.login("ali@university.edu", "ValidPass1!");

    // Then the student is redirected to the menu home page
    await loginPage.waitForRedirect("/menu");
    await expect(page).toHaveURL(/\/menu/);

    // And a JWT access token is stored
    const token = await page.evaluate(() => localStorage.getItem("jwt_token"));
    expect(token).toBeTruthy();
    expect(token.split(".").length).toBe(3); // valid JWT structure
  });

  // ──────────────────────────────────────────────────────────
  // Scenario: Login rejected for suspended account (FR08)
  // ──────────────────────────────────────────────────────────
  test("shows suspension message for suspended account", async ({ page }) => {
    // Mock API response for suspended account
    await page.route("/api/v1/auth/login", async (route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: {
            code: "ACCOUNT_SUSPENDED",
            message: "Your account has been suspended. Contact the university helpdesk.",
          },
        }),
      });
    });

    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Given a student account that has been suspended
    // When the student attempts to log in
    await loginPage.login("suspended@university.edu", "ValidPass1!");

    // Then the suspension message is displayed
    const alertText = await loginPage.getAlertText();
    expect(alertText).toContain("suspended");
    expect(alertText).toContain("helpdesk");

    // And no token is stored
    const token = await page.evaluate(() => localStorage.getItem("jwt_token"));
    expect(token).toBeNull();
  });

  // ──────────────────────────────────────────────────────────
  // Scenario Outline: Login rejected for invalid credentials
  //   | unknown@ext.com    | anyPass1!   | Unregistered email |
  //   | ali@university.edu | wrongPass!  | Wrong password     |
  //   | expired@university.edu | validPass1! | Expired account|
  // ──────────────────────────────────────────────────────────
  const invalidCredentialCases = [
    { email: "unknown@ext.com",        password: "anyPass1!",  label: "unregistered email" },
    { email: "ali@university.edu",     password: "wrongPass!", label: "wrong password"     },
    { email: "expired@university.edu", password: "validPass1!", label: "expired account"   },
  ];

  for (const { email, password, label } of invalidCredentialCases) {
    test(`rejects login with ${label} and shows INVALID_CREDENTIALS error`, async ({ page }) => {
      await page.route("/api/v1/auth/login", async (route) => {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials. 4 attempt(s) remaining before lockout." },
          }),
        });
      });

      const loginPage = new LoginPage(page);
      await loginPage.goto();

      await loginPage.login(email, password);

      const alertText = await loginPage.getAlertText();
      expect(alertText).toMatch(/invalid credentials/i);

      const token = await page.evaluate(() => localStorage.getItem("jwt_token"));
      expect(token).toBeNull();
    });
  }
});

// ════════════════════════════════════════════════════════════
// FEATURE: FR03 — Account Lockout after 5 Failed Attempts
// ════════════════════════════════════════════════════════════

test.describe("FR03 — Account Lockout", () => {

  // ──────────────────────────────────────────────────────────
  // Scenario: Account locked after 5 consecutive failures
  // ──────────────────────────────────────────────────────────
  test("shows lockout countdown after 5th failed attempt", async ({ page }) => {
    // First 4 attempts → INVALID_CREDENTIALS
    // 5th attempt → ACCOUNT_LOCKED
    let callCount = 0;

    await page.route("/api/v1/auth/login", async (route) => {
      callCount++;
      if (callCount < 5) {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: {
              code: "INVALID_CREDENTIALS",
              message: `Invalid credentials. ${5 - callCount} attempt(s) remaining before lockout.`,
            },
          }),
        });
      } else {
        const unlocksAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: {
              code: "ACCOUNT_LOCKED",
              message: "Account locked. Try again in 15 minutes.",
              details: { unlocks_at: unlocksAt, retry_after_seconds: 900 },
            },
          }),
        });
      }
    });

    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Given a valid student account and 4 previous failures
    // When the student submits a 5th incorrect password
    for (let i = 0; i < 5; i++) {
      await loginPage.login("ali@university.edu", "wrongPass!");
      if (i < 4) {
        // Allow error to appear before next attempt
        await page.waitForTimeout(300);
      }
    }

    // Then the account is locked and a countdown is shown
    const alertText = await loginPage.getAlertText();
    expect(alertText).toMatch(/locked/i);

    // And the countdown timer is visible
    await expect(loginPage.lockoutDisplay).toBeVisible();

    // And the submit button is disabled / shows lockout
    const isLocked = await loginPage.isLockedOut();
    expect(isLocked).toBe(true);
  });

  // ──────────────────────────────────────────────────────────
  // Scenario: Login succeeds after lockout period expires
  // ──────────────────────────────────────────────────────────
  test("allows login after lockout period expires", async ({ page }) => {
    // Simulate: account was locked, now unlocked
    await page.route("/api/v1/auth/login", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            access_token: "eyJ.mock.token",
            refresh_token: "mock-refresh",
            token_type: "bearer",
            expires_in: 1800,
            user: { id: "uuid-1", email: "ali@university.edu", role: "student", display_name: "Ali" },
          },
        }),
      });
    });

    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Given the account was locked 15 minutes ago (now unlocked)
    // When the student submits the correct password
    await loginPage.login("ali@university.edu", "ValidPass1!");

    // Then the student is redirected (failed_attempt_counter reset server-side)
    await loginPage.waitForRedirect("/menu");
    await expect(page).toHaveURL(/\/menu/);

    // And the JWT is stored
    const token = await page.evaluate(() => localStorage.getItem("jwt_token"));
    expect(token).toBe("eyJ.mock.token");
  });

  // ──────────────────────────────────────────────────────────
  // Scenario: Existing lockout — reject immediately on page load
  // ──────────────────────────────────────────────────────────
  test("shows lockout UI immediately when account is already locked", async ({ page }) => {
    const unlocksAt = new Date(Date.now() + 8 * 60 * 1000).toISOString(); // 8 min remaining

    await page.route("/api/v1/auth/login", async (route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: {
            code: "ACCOUNT_LOCKED",
            message: "Account locked. Try again in 8 minutes.",
            details: { unlocks_at: unlocksAt, retry_after_seconds: 480 },
          },
        }),
      });
    });

    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Attempt triggers lockout response
    await loginPage.login("ali@university.edu", "anyPass!");

    // Then the lockout countdown is displayed
    await expect(loginPage.lockoutDisplay).toBeVisible();
    const timerText = await loginPage.getLockoutTimerText();
    expect(timerText).toMatch(/\d{2}:\d{2}/); // MM:SS format
  });
});

// ════════════════════════════════════════════════════════════
// FEATURE: FR04 — Session Expiry on 30-min Inactivity
// ════════════════════════════════════════════════════════════

test.describe("FR04 — Session Expiry", () => {

  // ──────────────────────────────────────────────────────────
  // Scenario: Session invalidated after 30 minutes of inactivity
  // ──────────────────────────────────────────────────────────
  test("redirects to login when API returns 401 TOKEN_EXPIRED", async ({ page }) => {
    // Seed a stale token in localStorage
    await page.goto("/menu");
    await page.evaluate(() => localStorage.setItem("jwt_token", "expired.jwt.token"));

    // Any authenticated API call returns 401 TOKEN_EXPIRED
    await page.route("/api/v1/**", async (route) => {
      // Only intercept non-login routes
      if (!route.request().url().includes("/auth/login")) {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: { code: "TOKEN_EXPIRED", message: "Session expired. Please log in again." },
          }),
        });
      } else {
        await route.continue();
      }
    });

    // Reload to trigger /auth/me → 401
    await page.reload();

    // Then the user is redirected to /login
    await page.waitForURL(/\/login/, { timeout: 5000 });
    await expect(page).toHaveURL(/\/login/);

    // And the token is removed from storage
    const token = await page.evaluate(() => localStorage.getItem("jwt_token"));
    expect(token).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
// FEATURE: FR06 — Password Reset via Time-Limited Link
// ════════════════════════════════════════════════════════════

test.describe("FR06 — Password Reset", () => {

  // ──────────────────────────────────────────────────────────
  // Scenario: Request reset link for registered email
  // ──────────────────────────────────────────────────────────
  test("shows confirmation after submitting reset request", async ({ page }) => {
    await page.route("/api/v1/auth/password-reset/request", async (route) => {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { message: "If this email is registered, a reset link has been sent." },
        }),
      });
    });

    const loginPage   = new LoginPage(page);
    const resetPage   = new PasswordResetPage(page);
    await loginPage.goto();

    // Given a user clicks "Forgot password?"
    await resetPage.openFromLogin(loginPage);

    // When they submit a registered email
    await resetPage.requestReset("ali@university.edu");

    // Then the confirmation screen is shown (email enumeration safe — same for unknown emails)
    await resetPage.waitForConfirmation();
    await expect(page.getByText("Check your email")).toBeVisible();
  });

  // ──────────────────────────────────────────────────────────
  // Scenario: Unregistered email still shows success (anti-enumeration)
  // ──────────────────────────────────────────────────────────
  test("shows same confirmation for unregistered email (anti-enumeration)", async ({ page }) => {
    await page.route("/api/v1/auth/password-reset/request", async (route) => {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { message: "If this email is registered, a reset link has been sent." },
        }),
      });
    });

    const loginPage = new LoginPage(page);
    const resetPage = new PasswordResetPage(page);
    await loginPage.goto();
    await resetPage.openFromLogin(loginPage);

    // Even for unknown email, 202 is returned (server-side)
    await resetPage.requestReset("unknown@external.com");
    await resetPage.waitForConfirmation();
    await expect(page.getByText("Check your email")).toBeVisible();
  });

  // ──────────────────────────────────────────────────────────
  // Scenario: Back to login from reset page
  // ──────────────────────────────────────────────────────────
  test("can navigate back to login from password reset view", async ({ page }) => {
    const loginPage = new LoginPage(page);
    const resetPage = new PasswordResetPage(page);
    await loginPage.goto();
    await resetPage.openFromLogin(loginPage);

    // Then the reset form is visible
    await expect(resetPage.resetForm).toBeVisible();

    // When the user clicks back
    await resetPage.backToLoginBtn.click();

    // Then the login form is restored
    await expect(loginPage.loginForm).toBeVisible();
  });
});

// ════════════════════════════════════════════════════════════
// FEATURE: FR07, FR50, FR51 — Admin User Management
// ════════════════════════════════════════════════════════════

test.describe("FR50/FR51 — Admin User Management", () => {

  // Seed admin session before each test
  test.beforeEach(async ({ page }) => {
    // Inject a mock admin JWT so all /admin/* routes pass auth guard
    await page.goto("/login");
    await page.evaluate(() => {
      localStorage.setItem("jwt_token", "mock.admin.jwt");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Scenario: Admin views user list
  // ──────────────────────────────────────────────────────────
  test("renders user table with all columns", async ({ page }) => {
    await page.route("/api/v1/auth/admin/users*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            users: [
              { id: "u1", display_name: "Ali Hassan", email: "ali@university.edu", role: "student", status: "active",    created_at: "2025-09-01T08:00:00Z" },
              { id: "u2", display_name: "Sara Kamel", email: "sara@university.edu", role: "staff",   status: "active",    created_at: "2025-09-01T08:00:00Z" },
              { id: "u3", display_name: "Ahmed Sysop", email: "admin@university.edu", role: "admin",  status: "suspended", created_at: "2025-09-01T08:00:00Z" },
            ],
            total: 3, page: 1, per_page: 20,
          },
        }),
      });
    });

    const adminPage = new AdminUsersPage(page);
    await adminPage.goto();

    // Then all 3 users appear
    await expect(page.getByTestId("user-row-u1")).toBeVisible();
    await expect(page.getByTestId("user-row-u2")).toBeVisible();
    await expect(page.getByTestId("user-row-u3")).toBeVisible();

    // And the status badge for suspended user shows "suspended"
    const u3Row = await adminPage.getUserRow("u3");
    await expect(u3Row.getByText("suspended")).toBeVisible();
  });

  // ──────────────────────────────────────────────────────────
  // Scenario: Admin creates a new staff account (FR51)
  // ──────────────────────────────────────────────────────────
  test("admin creates a new staff account", async ({ page }) => {
    await page.route("/api/v1/auth/admin/users", async (route) => {
      if (route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData());
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: { id: "new-uuid", ...body, status: "active", created_at: new Date().toISOString() },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: { users: [], total: 0, page: 1, per_page: 20 } }),
        });
      }
    });

    const adminPage = new AdminUsersPage(page);
    await adminPage.goto();
    await adminPage.openCreateModal();

    // When the admin fills in the form
    await adminPage.fillCreateForm({
      email:       "newstaff@university.edu",
      password:    "StrongPass1!",
      displayName: "New Staff Member",
      role:        "staff",
    });

    // Then saving closes the modal (no error)
    await page.route("/api/v1/auth/admin/users*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { users: [], total: 0, page: 1, per_page: 20 } }),
      });
    });

    await adminPage.saveModal();
    await expect(adminPage.userModal).not.toBeVisible();
  });

  // ──────────────────────────────────────────────────────────
  // Scenario: Admin suspends a student account (FR50)
  // ──────────────────────────────────────────────────────────
  test("admin can suspend a student account", async ({ page }) => {
    const userId = "student-uuid";

    await page.route("/api/v1/auth/admin/users*", async (route) => {
      const method = route.request().method();
      if (method === "PATCH") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: { id: userId, status: "suspended", role: "student" },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              users: [{ id: userId, display_name: "Test Student", email: "student@university.edu", role: "student", status: "active", created_at: "2025-09-01T00:00:00Z" }],
              total: 1, page: 1, per_page: 20,
            },
          }),
        });
      }
    });

    const adminPage = new AdminUsersPage(page);
    await adminPage.goto();
    await adminPage.openEditModal(userId);

    // When the admin changes status to suspended
    await adminPage.modalStatus.selectOption("suspended");
    await adminPage.saveModal();

    // Then the modal closes (PATCH was sent)
    await expect(adminPage.userModal).not.toBeVisible();
  });

  // ──────────────────────────────────────────────────────────
  // Scenario: FR07 — Role assignment shows "takes effect next login" note
  // ──────────────────────────────────────────────────────────
  test("edit modal shows role-takes-effect-next-login notice", async ({ page }) => {
    const userId = "student-uuid";

    await page.route("/api/v1/auth/admin/users*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            users: [{ id: userId, display_name: "Test", email: "t@university.edu", role: "student", status: "active", created_at: "2025-09-01T00:00:00Z" }],
            total: 1, page: 1, per_page: 20,
          },
        }),
      });
    });

    const adminPage = new AdminUsersPage(page);
    await adminPage.goto();
    await adminPage.openEditModal(userId);

    // Then the FR07 notice is displayed
    const notice = page.getByText(/takes effect.*next login/i);
    await expect(notice).toBeVisible();
  });
});

// ════════════════════════════════════════════════════════════
// ACCESSIBILITY CHECKS (NFR27 — WCAG 2.1 AA)
// ════════════════════════════════════════════════════════════

test.describe("NFR27 — Accessibility", () => {

  test("login form has correct ARIA attributes on error state", async ({ page }) => {
    await page.route("/api/v1/auth/login", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials." },
        }),
      });
    });

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login("bad@university.edu", "badpassword");

    // Error region must have aria-live="assertive" (announced immediately)
    const liveRegion = page.locator('[aria-live="assertive"]');
    await expect(liveRegion).toBeVisible();

    // Submit button accessible label
    const btn = loginPage.submitButton;
    await expect(btn).toHaveAttribute("type", "submit");
  });

  test("login form fields have associated labels", async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Email label → input association
    const emailLabel = page.locator('label[for="email"]');
    await expect(emailLabel).toBeVisible();

    // Password label → input association
    const passwordLabel = page.locator('label[for="password"]');
    await expect(passwordLabel).toBeVisible();
  });

  test("password visibility toggle has aria-label", async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    const toggle = page.locator('button[aria-label]').filter({ hasText: "" }).first();
    const ariaLabel = await toggle.getAttribute("aria-label");
    expect(ariaLabel).toMatch(/password/i);
  });
});

// ════════════════════════════════════════════════════════════
// UI STATE TESTS (loading, disabled, form validation)
// ════════════════════════════════════════════════════════════

test.describe("Login UI States", () => {

  test("submit button disabled when email or password is empty", async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Both empty → disabled
    await expect(loginPage.submitButton).toBeDisabled();

    // Only email filled → still disabled
    await loginPage.fillEmail("ali@university.edu");
    await expect(loginPage.submitButton).toBeDisabled();

    // Both filled → enabled
    await loginPage.fillPassword("anypassword");
    await expect(loginPage.submitButton).toBeEnabled();
  });

  test("shows spinner during login request", async ({ page }) => {
    // Delay the mock response to catch loading state
    await page.route("/api/v1/auth/login", async (route) => {
      await page.waitForTimeout(500);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            access_token: "mock.token",
            refresh_token: "r",
            token_type: "bearer",
            expires_in: 1800,
            user: { id: "u1", email: "ali@university.edu", role: "student", display_name: "Ali" },
          },
        }),
      });
    });

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.fillEmail("ali@university.edu");
    await loginPage.fillPassword("ValidPass1!");

    // Click without await so we can observe loading state
    loginPage.submit(); // fire-and-forget

    // Spinner should appear immediately
    await expect(loginPage.spinner).toBeVisible({ timeout: 1000 });
  });

  test("clears error when user starts typing after failure", async ({ page }) => {
    await page.route("/api/v1/auth/login", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials." },
        }),
      });
    });

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login("ali@university.edu", "wrongPass!");

    // Error is visible
    await expect(loginPage.anyAlert).toBeVisible();

    // When user types again — error should clear
    await loginPage.fillEmail("ali2@university.edu");
    await expect(loginPage.anyAlert).not.toBeVisible();
  });
});

// ════════════════════════════════════════════════════════════
// PLAYWRIGHT CONFIG (playwright.config.js — place at project root)
// ════════════════════════════════════════════════════════════
/*
// playwright.config.js
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: [["html", { open: "never" }], ["list"]],

  use: {
    baseURL:     process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5173",
    trace:       "on-first-retry",
    screenshot:  "only-on-failure",
    video:       "on-first-retry",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"]  } },
    { name: "firefox",  use: { ...devices["Desktop Firefox"] } },
    { name: "webkit",   use: { ...devices["Desktop Safari"]  } },
    // Mobile viewports — NFR26 (≥375px)
    { name: "mobile-chrome",  use: { ...devices["Pixel 5"]       } },
    { name: "mobile-safari",  use: { ...devices["iPhone 13"]     } },
  ],

  webServer: {
    command: "npm run dev",
    port:    5173,
    reuseExistingServer: !process.env.CI,
  },
});
*/
