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
  await slots.selectOption((await slots.locator("option:not([disabled])").first().getAttribute("value"))!);
  await page.getByRole("button", { name: "Get current total" }).click();
  await expect(page.getByRole("heading", { name: "Review your total" })).toBeVisible();
  await expect(page.getByText("MOCK CHECKOUT", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /Accept & simulate/ })).toBeVisible();
  await page.getByRole("button", { name: /Accept & simulate/ }).click();
  await expect(page).toHaveURL(/\/orders\/[A-Za-z0-9_-]{43}$/);
  await expect(page.getByRole("heading", { name: /We’re checking your payment.|Thanks for stopping by./ })).toBeVisible();
});

test("invalid modifiers are rejected by the server, not only by the dialog", async ({ request, baseURL }) => {
  const slots = await (await request.get("/api/slots")).json();
  const available = slots.slots.find((slot: { remaining: number }) => slot.remaining > 0);
  expect(available).toBeTruthy();
  const response = await request.post("/api/quotes", {
    headers: { origin: baseURL! },
    data: {
      lines: [{ productId: "latte", quantity: 1, modifiers: [{ modifierId: "not-a-real-modifier", quantity: 1 }] }],
      slotId: available.id, tip: 0,
      customer: { name: "Demo", email: "demo@example.invalid", phone: "+33123456789" },
    },
  });
  expect(response.status()).toBe(409);
  expect((await response.json()).error.code).toBe("UNKNOWN_MODIFIER");
});

test("product and promotion evaluation endpoints use current catalog prices", async ({ request, baseURL }) => {
  const result = await request.get("/api/products/croissant");
  expect(result.status()).toBe(200);
  const { product } = await result.json();
  const evaluation = await request.post("/api/promotions/evaluate", {
    headers: { origin: baseURL! },
    data: { lines: [{ productId: "croissant", quantity: 1, modifiers: [] }], tip: 0, code: "WELCOME10" },
  });
  expect(evaluation.status()).toBe(200);
  const body = await evaluation.json();
  expect(body.reservation).toBe(false);
  expect(body.payableQuote).toBe(false);
  expect(body.pricing.subtotal).toBe(product.price);
  expect(body.pricing.discount).toBeGreaterThan(0);
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

test("a lost checkout response retries the original order instead of creating another", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Customize Butter croissant" }).click();
  await page.getByRole("button", { name: /Add to bag/ }).click();
  await page.getByRole("button", { name: /Review checkout/ }).click();
  await page.getByLabel("Your name", { exact: true }).fill("Recovery Demo");
  await page.getByLabel("Email", { exact: true }).fill("recovery@example.invalid");
  await page.getByLabel("Contact number", { exact: true }).fill("+33123456789");
  const slots = page.getByRole("combobox", { name: /Pickup time/ });
  await expect(slots.locator("option")).not.toHaveCount(1);
  await slots.selectOption((await slots.locator("option:not([disabled])").first().getAttribute("value"))!);
  await page.getByRole("button", { name: "Get current total" }).click();
  let originalToken = "";
  await page.route("**/api/checkout", async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    originalToken = (await response.json()).trackingToken;
    await route.abort("connectionreset");
  }, { times: 1 });
  await page.getByRole("button", { name: /Accept & simulate/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Retry uses the same payment reference" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change details / refresh quote" })).toBeDisabled();
  await page.getByRole("button", { name: /Accept & simulate/ }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${originalToken}$`));
});

test("expired unsubmitted recovery allows a fresh quote after reload", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("yafi.pending.v1", JSON.stringify({
      quoteId: "expired-demo", idempotencyKey: "prior-submission-key", mockScenario: "SUCCESS", trackingToken: "A".repeat(43),
    }));
    localStorage.setItem("yafi.cart.v1", JSON.stringify([{ productId: "croissant", quantity: 1, modifiers: [] }]));
  });
  await page.route("**/api/checkout", route => route.fulfill({
    status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "QUOTE_EXPIRED", message: "Quote expired" } }),
  }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Review checkout/ })).toBeDisabled();
  await page.getByRole("button", { name: "Retry original submission safely" }).click();
  await expect(page.getByRole("region", { name: "Payment recovery" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: /Review checkout/ })).toBeEnabled();
});

test("staff retries an uncertain refund using its persisted original key", async ({ page }) => {
  const keys: string[] = [];
  await page.route("**/api/admin/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/refund")) {
      keys.push(route.request().postDataJSON().idempotencyKey);
      if (keys.length === 1) await route.abort("connectionreset");
      else await route.fulfill({ json: { id: "original-refund", status: "PENDING" }, status: 202 });
      return;
    }
    if (path === "/api/admin/orders") {
      await route.fulfill({ json: { orders: [{
        id: "demo-order", createdAt: new Date().toISOString(), paymentState: "PARTIALLY_REFUNDED", integrationState: "SYNCED",
        fulfillmentState: "SUBMITTED", total: 1000,
      }] } }); return;
    }
    if (path.endsWith("/integration")) await route.fulfill({ json: { liveIntegration: "BLOCKED", intake: "STAFF_WEB_QUEUE", printing: "REQUEST_ACCEPTANCE_ONLY", deadLetters: [] } });
    else if (path.endsWith("/promotions")) await route.fulfill({ json: { promotions: [] } });
    else await route.fulfill({ json: { slots: [] } });
  });
  page.on("dialog", dialog => dialog.type() === "prompt" ? dialog.accept("100") : dialog.accept());
  await page.goto("/admin");
  await expect(page.getByRole("button", { name: "Accept order", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refund…", exact: true }).click();
  await expect(page.getByRole("region", { name: "Sensitive action recovery" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refund…", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry original refund request" }).click();
  await expect(page.getByRole("region", { name: "Sensitive action recovery" })).not.toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});
