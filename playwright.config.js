import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"]  } },
    { name: "firefox",  use: { ...devices["Desktop Firefox"] } },
    { name: "mobile",   use: { ...devices["Pixel 5"]         } },
  ],
});