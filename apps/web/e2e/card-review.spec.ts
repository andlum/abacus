import { expect, test, type Page } from "@playwright/test";

// Two cards, one story, in order. The bank is the fake Plaid in
// src/lib/e2e-plaid.ts (playwright.config.ts turns it on). Its dates are
// relative to the real clock, because the review page reads that rather than
// the sign-in stand-in's "today", so these tests sign in without pretending
// a date and never look at one.
test.describe.configure({ mode: "serial" });

const GROUP = "Card Club";

// The household story leaves Alex in more than one group, so there is more
// than one "Sign in as Alex": any will do, then the switcher picks the group.
async function signIn(page: Page, { groupExists = true } = {}) {
  await page.goto("/dev-sign-in");
  await page.getByRole("button", { name: "Sign in as Alex" }).first().click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  if (!groupExists) return;
  const switcher = page.getByRole("button", { name: /Switch group/ });
  if ((await switcher.textContent())?.trim() !== GROUP) {
    await switcher.click();
    await page.getByRole("list", { name: "Your groups" }).getByRole("button", { name: new RegExp(`^${GROUP}`) }).click();
  }
  await expect(switcher).toHaveText(GROUP);
}

// Plaid's own window cannot open here: its script is swapped for one whose
// window signs in at once with `token` (the fake Plaid knows "shared" and
// "personal").
async function connect(page: Page, token: "shared" | "personal") {
  await page.route("https://cdn.plaid.com/link/v2/stable/link-initialize.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.Plaid = { create: (c) => ({ open: () => setTimeout(() => c.onSuccess("${token}", {}), 0), destroy() {} }) };`,
    }),
  );
  await page.goto("/settings/accounts");
  await page.getByRole("button", { name: "Connect a bank" }).click();
  // A new card is asked about first, in Accounts.
  await expect(page).toHaveURL(/\/accounts$/);
}

// The payment arrives in the card's next sync, as it would by webhook.
async function syncBank(page: Page) {
  const res = await page.request.post("/api/e2e/sync");
  expect(res.ok()).toBe(true);
}

const ledger = (page: Page) => page.getByRole("region", { name: "Ledger" });
const card = (page: Page, name: string) => page.getByRole("listitem").filter({ hasText: name });

test("a shared card: its payment is one expense, and a review takes purchases out of it", async ({ page }) => {
  await signIn(page, { groupExists: false });
  await page.getByRole("button", { name: /Switch group/ }).click();
  await page.getByRole("link", { name: "Add a group" }).click();
  await page.getByLabel("Name", { exact: true }).fill(GROUP);
  await page.getByLabel("The other person's name").fill("Jo");
  await page.getByLabel("The other person's email").fill("jo@example.com");
  await page.getByRole("button", { name: "Add group" }).click();
  await expect(page.getByRole("button", { name: /Switch group/ })).toHaveText(GROUP);

  await connect(page, "shared");
  await expect(card(page, "Everyday Card 1234")).toContainText("Personal card");
  await page.getByRole("link", { name: "Everyday Card 1234" }).click();
  await page.getByLabel("Shared card").check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("paragraph").filter({ hasText: "Shared card" }).first()).toBeVisible();
  await syncBank(page);

  // One payment row, split the usual way, with nothing to review in the Ledger.
  await page.goto("/");
  const payment = ledger(page).getByRole("row").filter({ hasText: "Card payment" });
  await expect(payment).toHaveCount(1);
  await expect(payment).toContainText("$1,200.00");
  await expect(payment.getByRole("link", { name: /review/i })).toHaveCount(0);
  await expect(ledger(page).getByRole("row").filter({ hasText: "Grocer" })).toHaveCount(0);

  await page.getByRole("link", { name: "Accounts" }).first().click();
  await card(page, "Everyday Card 1234").getByRole("link", { name: "Review transactions" }).click();
  await expect(page.getByRole("heading", { name: "Pick purchases to split" })).toBeVisible();
  await page.getByLabel(/Grocer/).check();
  await page.getByLabel(/Hardware/).check();
  await expect(page.getByText("2 picked · $130.00 of $1,200.00")).toBeVisible();
  await page.getByRole("button", { name: "Next: split" }).click();

  // Hardware splits evenly; Grocer keeps the usual split.
  await page.getByRole("listitem").filter({ hasText: "$30.00" }).getByLabel("Split").selectOption({ label: "Evenly" });
  await page.getByRole("button", { name: "Next: check" }).click();
  await expect(page.getByText("The card payment becomes $1,070.00.")).toBeVisible();
  await page.getByRole("button", { name: "Split 2 separately · $130.00" }).click();

  await expect(page.getByRole("heading", { name: "Ledger" })).toBeVisible();
  await expect(ledger(page).getByRole("row").filter({ hasText: "Grocer" })).toContainText("$100.00");
  await expect(ledger(page).getByRole("row").filter({ hasText: "Hardware" })).toContainText("$30.00");
  await expect(ledger(page).getByRole("row").filter({ hasText: "Card payment" })).toContainText("$1,070.00");
});

test("a personal card: nothing reaches the Ledger until a review picks it", async ({ page }) => {
  await signIn(page);
  await connect(page, "personal");
  await expect(card(page, "Travel Card 4321")).toContainText("Personal card");
  await syncBank(page);

  // The card's $500.00 payment makes no expense; the shared card's rows stay.
  await page.goto("/");
  await expect(ledger(page).getByRole("row").filter({ hasText: "Card payment" })).toHaveCount(1);
  await expect(ledger(page).getByText("$500.00")).toHaveCount(0);
  await expect(ledger(page).getByText("Bookshop")).toHaveCount(0);

  await page.goto("/accounts");
  await card(page, "Travel Card 4321").getByRole("link", { name: "Review transactions" }).click();
  await page.getByLabel(/Bookshop/).check();
  await expect(page.getByText("1 picked · $45.00")).toBeVisible();
  await page.getByRole("button", { name: "Next: split" }).click();
  await page.getByRole("button", { name: "Next: check" }).click();
  await page.getByRole("button", { name: "Add 1 to the ledger · $45.00" }).click();

  await expect(page.getByRole("heading", { name: "Ledger" })).toBeVisible();
  await expect(ledger(page).getByRole("row").filter({ hasText: "Bookshop" })).toContainText("$45.00");
  await expect(ledger(page).getByText("Cafe")).toHaveCount(0);

  // Made shared afterwards, the card's earlier $500.00 payment can be shared
  // by hand, and its review opens on it.
  await page.goto("/accounts");
  await page.getByRole("link", { name: "Travel Card 4321" }).click();
  await page.getByLabel("Shared card").check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.goto("/accounts");
  await page.getByRole("link", { name: "Travel Card 4321" }).click();
  await page.getByRole("link", { name: "Find earlier payments" }).click();
  await expect(page.getByText("$500.00, made while the card was personal")).toBeVisible();
  await page.getByRole("button", { name: "Share and review" }).click();
  await expect(page).toHaveURL(/\/accounts\/[^/]+\/review\?payment=/);
  await expect(page.getByRole("heading", { name: "Pick purchases to split" })).toBeVisible();
  await expect(page.getByLabel(/Bookshop/)).toBeVisible();

  await page.goto("/");
  await expect(ledger(page).getByRole("row").filter({ hasText: "$500.00" })).toContainText("Card payment");
});
