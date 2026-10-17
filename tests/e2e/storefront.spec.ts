import { expect, test } from "@playwright/test";

test("mobile menu supports search, customization, and a persistent bag", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Simulated orders & payments only.", { exact: false })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search menu" }).fill("latte");
  await page.getByRole("button", { name: "Customize Caffè latte" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Whole milk", { exact: false }).check();
  const size = page.getByRole("radio", { name: /regular/i });
  if (await size.count()) await size.first().check();
  const hot = page.getByRole("radio", { name: /^hot/i });
  if (await hot.count()) await hot.first().check();
  await page.getByRole("button", { name: /Add to bag/ }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.reload();
  await expect(page.locator("#bag")).toContainText("1 × Caffè latte");
});

test("guest can quote a pastry for another pickup recipient without US-only phone validation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Customize Butter croissant" }).click();
  await page.getByRole("button", { name: /Add to bag/ }).click();
  await page.getByRole("button", { name: /Review checkout/ }).click();
  await page.getByLabel("Your name", { exact: true }).fill("Demo Purchaser");
  await page.getByLabel("Email", { exact: true }).fill("demo@example.invalid");
  await page.getByLabel("Contact number", { exact: true }).fill("+44 20 7946 0000");
  await page.getByLabel("Pickup recipient, if different").fill("Demo Recipient");
  const slots = page.getByRole("combobox", { name: /Pickup time/ });
  await expect(slots.locator("option")).not.toHaveCount(1);
  await slots.selectOption({ index: 1 });
  await page.getByRole("button", { name: "Get current total" }).click();
  await expect(page.getByRole("heading", { name: "Review your total" })).toBeVisible();
  await expect(page.getByText("MOCK CHECKOUT", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /Accept & simulate/ })).toBeVisible();
});

test("invalid modifiers are rejected by the server, not only by the dialog", async ({ request, baseURL }) => {
  const slots = await (await request.get("/api/slots")).json();
  expect(slots.slots.length).toBeGreaterThan(0);
  const response = await request.post("/api/quotes", {
    headers: { origin: baseURL! },
    data: {
      lines: [{ productId: "latte", quantity: 1, modifiers: [{ modifierId: "not-a-real-modifier", quantity: 1 }] }],
      slotId: slots.slots[0].id, tip: 0,
      customer: { name: "Demo", email: "demo@example.invalid", phone: "+33123456789" },
    },
  });
  expect(response.status()).toBe(409);
  expect((await response.json()).error.code).toBeTruthy();
});

test("staff queue does not expose orders to an unauthenticated visitor", async ({ page, request }) => {
  const result = await request.get("/api/admin/orders");
  expect(result.status()).toBe(401);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Staff sign in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept order" })).not.toBeVisible();
});

test("a contact number is required before a checkout quote can be requested", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Customize Butter croissant" }).click();
  await page.getByRole("button", { name: /Add to bag/ }).click();
  await page.getByRole("button", { name: /Review checkout/ }).click();
  await expect(page.getByLabel("Contact number", { exact: true })).toHaveAttribute("required", "");
  await page.getByRole("button", { name: "Get current total" }).click();
  await expect(page.getByRole("heading", { name: "Review your total" })).not.toBeVisible();
});
