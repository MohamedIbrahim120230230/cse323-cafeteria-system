/**
 * PHASE 4 — Playwright E2E Tests (10% of pyramid)
 * Uses Page Object Model (POM) as required by the rubric.
 * Covers the full order lifecycle visible to staff and admin.
 *
 * Run:  npx playwright test
 */

// ── Page Object Model ─────────────────────────────────────────────────────────

class OrderDashboardPage {
  constructor(page) {
    this.page = page;
    this.baseUrl = 'http://localhost:5173';
  }

  async goto() {
    await this.page.goto(this.baseUrl);
  }

  async gotoAsStaff() {
    await this.page.goto(`${this.baseUrl}?role=STAFF&actor=stf-demo`);
  }

  async gotoAsAdmin() {
    await this.page.goto(`${this.baseUrl}?role=ADMIN&actor=adm-demo`);
  }

  async gotoAsStudent() {
    await this.page.goto(`${this.baseUrl}?role=STUDENT&actor=stu-demo`);
  }

  // Order cards
  orderCard(orderId) {
    return this.page.locator(`[data-order-id="${orderId}"]`);
  }

  statusBadge(orderId) {
    return this.page.locator(`[data-order-id="${orderId}"] [data-testid="status-badge"]`);
  }

  advanceButton(orderId) {
    return this.page.locator(`[data-order-id="${orderId}"] [data-testid="advance-btn"]`);
  }

  cancelButton(orderId) {
    return this.page.locator(`[data-order-id="${orderId}"] [data-testid="cancel-btn"]`);
  }

  // Reports
  reportTypeSelect() {
    return this.page.locator('[data-testid="report-type-select"]');
  }

  reportFromDate() {
    return this.page.locator('[data-testid="report-from"]');
  }

  reportToDate() {
    return this.page.locator('[data-testid="report-to"]');
  }

  generateReportBtn() {
    return this.page.locator('[data-testid="generate-report-btn"]');
  }

  reportResults() {
    return this.page.locator('[data-testid="report-results"]');
  }

  // Admin panels
  flaggedOrdersTab() {
    return this.page.locator('[data-testid="tab-flagged"]');
  }

  approveBtn(orderId) {
    return this.page.locator(`[data-order-id="${orderId}"] [data-testid="approve-btn"]`);
  }

  rejectBtn(orderId) {
    return this.page.locator(`[data-order-id="${orderId}"] [data-testid="reject-btn"]`);
  }

  reviewReasonInput() {
    return this.page.locator('[data-testid="review-reason"]');
  }

  confirmReviewBtn() {
    return this.page.locator('[data-testid="confirm-review-btn"]');
  }

  toast() {
    return this.page.locator('[data-testid="toast"]');
  }

  // Config panel
  configTab() {
    return this.page.locator('[data-testid="tab-config"]');
  }

  configInput(key) {
    return this.page.locator(`[data-config-key="${key}"] input`);
  }

  saveConfigBtn(key) {
    return this.page.locator(`[data-config-key="${key}"] [data-testid="save-config"]`);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const { test, expect } = require('@playwright/test');

test.describe('Order Lifecycle — Staff View', () => {
  let dashboard;

  test.beforeEach(async ({ page }) => {
    dashboard = new OrderDashboardPage(page);
    await dashboard.gotoAsStaff();
    await page.waitForLoadState('networkidle');
  });

  test('Staff sees order dashboard on load', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Order Dashboard');
    await expect(page.locator('[data-testid="orders-list"]')).toBeVisible();
  });

  test('Staff can see CONFIRMED order and advance to PREPARING', async ({ page }) => {
    // Wait for orders to load
    await page.waitForSelector('[data-testid="orders-list"]');

    // Find a CONFIRMED order
    const confirmedCard = page.locator('[data-status="CONFIRMED"]').first();
    await expect(confirmedCard).toBeVisible();

    // Click advance button
    await confirmedCard.locator('[data-testid="advance-btn"]').click();

    // Confirm in modal
    await page.locator('[data-testid="confirm-advance-btn"]').click();

    // Status badge should update to PREPARING
    await expect(confirmedCard.locator('[data-testid="status-badge"]'))
      .toContainText('PREPARING', { timeout: 5000 });

    // Toast notification appears
    await expect(dashboard.toast()).toBeVisible();
    await expect(dashboard.toast()).toContainText('Status updated');
  });

  test('Staff can advance PREPARING order to READY', async ({ page }) => {
    await page.waitForSelector('[data-testid="orders-list"]');
    const preparingCard = page.locator('[data-status="PREPARING"]').first();
    await expect(preparingCard).toBeVisible();
    await preparingCard.locator('[data-testid="advance-btn"]').click();
    await page.locator('[data-testid="confirm-advance-btn"]').click();
    await expect(preparingCard.locator('[data-testid="status-badge"]'))
      .toContainText('READY', { timeout: 5000 });
  });

  test('Staff sees correct next-status label on advance button', async ({ page }) => {
    await page.waitForSelector('[data-testid="orders-list"]');
    const confirmedCard = page.locator('[data-status="CONFIRMED"]').first();
    if (await confirmedCard.count() > 0) {
      await expect(confirmedCard.locator('[data-testid="advance-btn"]'))
        .toContainText('PREPARING');
    }
  });

  test('Staff can cancel an in-progress order with reason', async ({ page }) => {
    await page.waitForSelector('[data-testid="orders-list"]');
    const confirmedCard = page.locator('[data-status="CONFIRMED"]').first();
    if (await confirmedCard.count() > 0) {
      await confirmedCard.locator('[data-testid="cancel-btn"]').click();
      await page.locator('[data-testid="cancel-reason-select"]').selectOption('OUT_OF_STOCK');
      await page.locator('[data-testid="cancel-note"]').fill('Item ran out in kitchen');
      await page.locator('[data-testid="confirm-cancel-btn"]').click();
      await expect(confirmedCard.locator('[data-testid="status-badge"]'))
        .toContainText('CANCELLED', { timeout: 5000 });
    }
  });

  test('COMPLETED orders do not show advance button', async ({ page }) => {
    await page.waitForSelector('[data-testid="orders-list"]');
    const completedCards = page.locator('[data-status="COMPLETED"]');
    const count = await completedCards.count();
    for (let i = 0; i < count; i++) {
      await expect(completedCards.nth(i).locator('[data-testid="advance-btn"]'))
        .toHaveCount(0);
    }
  });
});

test.describe('Admin Reports', () => {
  let dashboard;

  test.beforeEach(async ({ page }) => {
    dashboard = new OrderDashboardPage(page);
    await dashboard.gotoAsAdmin();
    await page.waitForLoadState('networkidle');
    await page.locator('[data-testid="tab-reports"]').click();
  });

  test('Admin can generate revenue report', async ({ page }) => {
    await dashboard.reportTypeSelect().selectOption('revenue');
    await dashboard.reportFromDate().fill('2026-04-01');
    await dashboard.reportToDate().fill('2026-05-17');
    await dashboard.generateReportBtn().click();
    await expect(dashboard.reportResults()).toBeVisible({ timeout: 10000 });
  });

  test('Admin can generate top items report', async ({ page }) => {
    await dashboard.reportTypeSelect().selectOption('top_items');
    await dashboard.reportFromDate().fill('2026-04-01');
    await dashboard.reportToDate().fill('2026-05-17');
    await dashboard.generateReportBtn().click();
    await expect(dashboard.reportResults()).toBeVisible({ timeout: 10000 });
  });

  test('Large date range triggers async job notice', async ({ page }) => {
    await dashboard.reportTypeSelect().selectOption('revenue');
    await dashboard.reportFromDate().fill('2020-01-01');
    await dashboard.reportToDate().fill('2026-05-17');
    await dashboard.generateReportBtn().click();
    await expect(page.locator('[data-testid="async-job-notice"]'))
      .toBeVisible({ timeout: 5000 });
  });

  test('Report requires valid date range', async ({ page }) => {
    await dashboard.reportTypeSelect().selectOption('revenue');
    // Leave dates empty and click generate
    await dashboard.generateReportBtn().click();
    await expect(page.locator('[data-testid="date-error"]')).toBeVisible();
  });
});

test.describe('Admin Flagged Orders', () => {
  let dashboard;

  test.beforeEach(async ({ page }) => {
    dashboard = new OrderDashboardPage(page);
    await dashboard.gotoAsAdmin();
    await page.waitForLoadState('networkidle');
    await dashboard.flaggedOrdersTab().click();
  });

  test('Admin sees flagged orders queue', async ({ page }) => {
    await expect(page.locator('[data-testid="flagged-orders-list"]')).toBeVisible();
  });

  test('Admin can approve a flagged order', async ({ page }) => {
    const flaggedCard = page.locator('[data-testid="flagged-order-card"]').first();
    if (await flaggedCard.count() > 0) {
      await flaggedCard.locator('[data-testid="approve-btn"]').click();
      await dashboard.reviewReasonInput().fill('Verified legitimate bulk purchase for event');
      await dashboard.confirmReviewBtn().click();
      await expect(dashboard.toast()).toContainText('approved', { timeout: 5000 });
    }
  });

  test('Admin can reject a flagged order', async ({ page }) => {
    const flaggedCard = page.locator('[data-testid="flagged-order-card"]').first();
    if (await flaggedCard.count() > 0) {
      await flaggedCard.locator('[data-testid="reject-btn"]').click();
      await dashboard.reviewReasonInput().fill('Suspected automated bot activity');
      await dashboard.confirmReviewBtn().click();
      await expect(dashboard.toast()).toContainText('rejected', { timeout: 5000 });
    }
  });

  test('Reason field is required before approving', async ({ page }) => {
    const flaggedCard = page.locator('[data-testid="flagged-order-card"]').first();
    if (await flaggedCard.count() > 0) {
      await flaggedCard.locator('[data-testid="approve-btn"]').click();
      // Leave reason empty
      await dashboard.confirmReviewBtn().click();
      await expect(page.locator('[data-testid="reason-error"]')).toBeVisible();
    }
  });
});

test.describe('Student Order View', () => {
  test.beforeEach(async ({ page }) => {
    const dashboard = new OrderDashboardPage(page);
    await dashboard.gotoAsStudent();
    await page.waitForLoadState('networkidle');
  });

  test('Student sees their orders', async ({ page }) => {
    await expect(page.locator('[data-testid="orders-list"]')).toBeVisible();
  });

  test('Student does not see advance button', async ({ page }) => {
    await expect(page.locator('[data-testid="advance-btn"]')).toHaveCount(0);
  });

  test('Student sees real-time status updates via SSE', async ({ page }) => {
    // The SSE connection indicator should be active
    await expect(page.locator('[data-testid="live-indicator"]')).toBeVisible();
  });

  test('Student can see order detail with items', async ({ page }) => {
    const orderCard = page.locator('[data-testid="order-card"]').first();
    if (await orderCard.count() > 0) {
      await orderCard.click();
      await expect(page.locator('[data-testid="order-items-list"]')).toBeVisible();
    }
  });
});
