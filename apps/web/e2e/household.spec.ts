import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

// One story, in order, against one database: each test continues from the
// state the previous one left.
test.describe.configure({ mode: "serial" });

async function signIn(page: Page, who: "Alex" | "Sam", today: string) {
  await page.goto("/dev-sign-in");
  await page.getByLabel(/Pretend today is/).fill(today);
  await page.getByRole("button", { name: `Sign in as ${who}` }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
}

// The balance sentence: one line per debt, or "You are all square."
const headline = (page: Page) => page.locator("[data-balance-line]");

test("a new household is all square", async ({ page }) => {
  await signIn(page, "Alex", "2027-03-01");
  await expect(headline(page)).toHaveText("You are all square.");
  // The breakdown that repeated the Ledger is gone.
  await expect(page.getByText("How the balance adds up")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "See payments in the Ledger" })).toHaveCount(0);
  await page.getByRole("button", { name: "Getting started · 1 of 3" }).click();
  const start = page.getByRole("dialog", { name: "Getting started" });
  await expect(start).toContainText("1 of 3 done");
  await expect(start).toContainText("Sam has joined");
  await expect(start.getByRole("link", { name: "Add a recurring cost" })).toHaveAttribute("href", "/expenses/new?kind=recurring");
});

test("on a desktop the balance is a detail beside the title; on a phone it is a card", async ({ page }) => {
  await signIn(page, "Alex", "2027-03-01");
  const title = page.getByRole("heading", { level: 1, name: "Home" });
  const balance = page.getByRole("region", { name: "Balance" });
  const line = headline(page);
  const box = async (l: typeof title) => (await l.boundingBox())!;

  await page.setViewportSize({ width: 1000, height: 800 });
  const [t, b] = [await box(title), await box(line)];
  // Same row: the sentence starts to the right of the title and overlaps it vertically.
  expect(b.x).toBeGreaterThan(t.x + t.width);
  expect(b.y).toBeLessThan(t.y + t.height);
  expect(b.y + b.height).toBeGreaterThan(t.y);
  await expect(line).toHaveCSS("font-size", "16px");
  // The Ledger is the next thing under that row.
  const ledger = await box(page.getByRole("heading", { level: 2, name: "Ledger" }));
  expect(ledger.y - (t.y + t.height)).toBeLessThan(80);

  await page.setViewportSize({ width: 639, height: 800 });
  const [t2, b2, card] = [await box(title), await box(line), await box(balance)];
  expect(b2.y).toBeGreaterThan(t2.y + t2.height);
  expect(card.width).toBeGreaterThan(550);
  await expect(line).toHaveCSS("font-size", "36px");

  // /balance still lands on the balance.
  await page.goto("/balance");
  await expect(page).toHaveURL(/#balance$/);
  await expect(balance).toBeInViewport();
});

test("rent is entered by itself on its due date, split evenly by default", async ({ page }) => {
  await signIn(page, "Alex", "2027-03-01");
  await page.getByRole("link", { name: "Add expense" }).click();
  const form = page.locator("form").filter({ hasText: "Add expense" });
  await form.getByLabel("Recurring").check();
  await form.getByLabel("Description").fill("Rent");
  await form.getByLabel("Category").selectOption({ label: "Housing" });
  await form.getByLabel("Amount", { exact: true }).fill("2000.00");
  await form.getByLabel("Paid by").selectOption({ label: "Alex" });
  await form.getByLabel("Starts").fill("2027-03-01");
  await form.getByRole("button", { name: "Add expense" }).click();
  await expect(page.getByRole("heading", { name: "Recurring costs" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Rent" })).toBeVisible();

  await page.goto("/");
  await expect(headline(page)).toHaveText("Sam owes Alex $1,000.00");

  // The old month page lands on the Ledger on Home with its month picked.
  await page.goto("/month/2027-03");
  await expect(page).toHaveURL(/\/\?month=2027-03$/);
  await expect(page.getByRole("region", { name: "Month summary" })).toContainText("Total of split expenses in March 2027");
  const row = page.getByRole("row").filter({ hasText: "Rent" });
  await expect(row).toContainText("even-split default");
  await expect(row).toContainText("$2,000.00");
});

test("a bill whose amount varies waits for its amount", async ({ page }) => {
  await signIn(page, "Sam", "2027-03-01");
  await page.goto("/expenses/new");
  const form = page.locator("form").filter({ hasText: "Add expense" });
  await form.getByLabel("Recurring").check();
  await form.getByLabel("Description").fill("Utilities");
  await form.getByLabel("Category").selectOption({ label: "Utilities" });
  await form.getByLabel("Due day of the month").fill("15");
  await form.getByLabel("Paid by").selectOption({ label: "Sam" });
  await form.getByLabel("Starts").fill("2027-03-01");
  await form.getByRole("button", { name: "Add expense" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Utilities" })).toContainText("varies");

  await signIn(page, "Sam", "2027-03-15");
  const todo = page.getByRole("region", { name: "To do" });
  await expect(todo.getByRole("region", { name: "Bills waiting for an amount" })).toContainText("Utilities, due 15 Mar");
  // Not in the balance until the amount is known.
  await expect(headline(page)).toHaveText("Sam owes Alex $1,000.00");
  await expect(page.getByRole("region", { name: "Balance" })).toContainText("Not counted yet: 1 expense");

  await todo.getByLabel("Amount of this bill").fill("150.00");
  await todo.getByRole("button", { name: "Enter amount" }).click();
  await expect(page.getByLabel("Amount of this bill")).toHaveCount(0);
  await expect(headline(page)).toHaveText("Sam owes Alex $925.00");
  await expect(page.getByRole("region", { name: "Balance" })).not.toContainText("Not counted yet");
  // With nothing left to do the card goes, and the bill is in the Ledger below.
  await expect(todo).toHaveCount(0);
  const ledger = page.getByRole("region", { name: "Ledger" });
  await expect(ledger).toContainText("Last 30 days:");
  await expect(ledger.getByRole("row").filter({ hasText: "Utilities" })).toContainText("$150.00");

  // The old pages send people to Home.
  await page.goto("/attention");
  await expect(page).toHaveURL(/\/#to-do$/);
  await page.goto("/balance");
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
});

test("a one-off expense is split and can be explained", async ({ page }) => {
  await signIn(page, "Sam", "2027-03-20");
  await page.goto("/expenses?month=2027-03");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Add expense" }).click();
  const form = page.locator("form").filter({ hasText: "Add expense" });
  // One-time is the starting choice, and the recurring details stay out of the way.
  await expect(form.getByLabel("One-time")).toBeChecked();
  await expect(form.getByLabel("Due day of the month")).toBeHidden();
  await form.getByLabel("Date").fill("2027-03-20");
  await form.getByLabel("Description").fill("Groceries");
  await form.getByLabel("Category").selectOption({ label: "Groceries" });
  await form.getByLabel("Amount", { exact: true }).fill("90.00");
  await form.getByRole("button", { name: "Add expense" }).click();

  const row = page.getByRole("row").filter({ hasText: "Groceries" });
  await expect(row).toContainText("$45.00");
  await row.getByText("Show the maths").click();
  await expect(row.getByRole("listitem").first()).toBeVisible();
  await expect(row).toContainText(/(Sam and Alex|Alex and Sam): \$90\.00 ÷ 2 = \$45\.00 each\./);
  await expect(row).toContainText("So Alex owes Sam $45.00 for this.");

  await page.goto("/");
  await expect(headline(page)).toHaveText("Sam owes Alex $880.00");
});

test("a refused entry says why and keeps what was typed", async ({ page }) => {
  await signIn(page, "Sam", "2027-03-20");
  await page.goto("/expenses/new");
  const form = page.locator("form").filter({ hasText: "Add expense" });
  await form.getByLabel("Description").fill("Takeaway");
  await form.getByLabel("Amount", { exact: true }).fill("twelve");
  await form.getByRole("button", { name: "Add expense" }).click();
  await expect(form.getByRole("alert")).toContainText("Not saved");
  await expect(form.getByLabel("Description")).toHaveValue("Takeaway");
});

test("the split is shown before saving", async ({ page }) => {
  await signIn(page, "Sam", "2027-03-20");
  await page.goto("/expenses/new");
  const preview = page.getByRole("region", { name: "Split preview" });
  await expect(preview).toContainText("Enter an amount");
  await page.getByLabel("Amount", { exact: true }).fill("30.00");
  await expect(preview).toContainText("Alex will owe Sam $15.00 for this.");
  await expect(preview).toContainText("falls back to an even split");
});

// Opens the form to add or change one person's income in Settings.
async function openIncomeForm(page: Page, name: string) {
  const row = page.getByRole("region", { name: "Income" }).getByRole("row").filter({ hasText: name });
  await row.getByText(/^(Add|Edit)$/).click();
}

test("a change to split by income counts once saved, and applies only from its start date", async ({ page }) => {
  await signIn(page, "Alex", "2027-03-20");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: /^People/ }).click();
  await openIncomeForm(page, "Alex");
  await page.getByLabel("Your income per year").fill("120000");
  await page.getByRole("button", { name: "Save income" }).click();
  await expect(page.getByRole("cell", { name: "$120,000.00" })).toBeVisible();

  await signIn(page, "Sam", "2027-03-20");
  await page.goto("/settings/people#income");
  await openIncomeForm(page, "Sam");
  await page.getByLabel("Your income per year").fill("80000");
  await page.getByRole("button", { name: "Save income" }).click();
  await expect(page.getByRole("cell", { name: "$80,000.00" })).toBeVisible();

  await page.goto("/settings/people#split");
  const addRule = page.locator("form").filter({ has: page.getByRole("button", { name: "Save rule" }) });
  await addRule.getByLabel("Covers").selectOption({ label: "Everything without a more specific rule" });
  await addRule.getByLabel("How to split").selectOption({ label: "By income" });
  await addRule.getByLabel("Counts from").fill("2027-04-01");
  await addRule.getByRole("button", { name: "Save rule" }).click();
  await expect(page.locator('[data-slot="toaster"]')).toHaveText("Rule saved");
  await expect(page.getByRole("row").filter({ hasText: "Everything else" })).toContainText("upcoming");

  // Alex sees the rule at once, with nothing to accept, and Sam's amount.
  await signIn(page, "Alex", "2027-03-20");
  await page.goto("/settings/people#split");
  await expect(page.getByRole("row").filter({ hasText: "Everything else" })).toContainText("1 Apr");
  await expect(page.getByRole("cell", { name: "$80,000.00" })).toBeVisible();

  // March is untouched.
  await page.goto("/");
  await expect(headline(page)).toHaveText("Sam owes Alex $880.00");
  // Both have joined, rent repeats and there is a rule: setup is over.
  await expect(page.getByRole("button", { name: /Getting started/ })).toHaveCount(0);

  // April's rent uses the new rule: Sam's share is 800.00.
  await signIn(page, "Alex", "2027-04-01");
  await expect(headline(page)).toHaveText("Sam owes Alex $1,680.00");
  await page.goto("/expenses?month=2027-04");
  await expect(page.getByRole("row").filter({ hasText: "Rent" })).not.toContainText("even-split default");
  await page.goto("/expenses?month=2027-03");
  await expect(page.getByRole("row").filter({ hasText: "Rent" })).toContainText("even-split default");
});

test("settling up clears the balance; an edited payment counts its new amount, and a voided one brings the balance back", async ({ page }) => {
  await signIn(page, "Sam", "2027-04-01");
  // Record payment, beside Add expense, opens a form filled in with what is owed.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Record payment" }).click();
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("1680.00");
  await page.getByRole("button", { name: "Record payment" }).click();
  // Recorded, it lands on Home, which has no payment form of its own.
  await expect(headline(page)).toHaveText("You are all square.");
  const balance = page.getByRole("region", { name: "Balance" });
  await expect(balance.getByLabel("Amount", { exact: true })).toHaveCount(0);

  // The payment is in the Ledger, and opens to be edited.
  await page.getByRole("region", { name: "Ledger" }).getByRole("row").filter({ hasText: "Sam paid Alex" }).getByRole("link", { name: "Sam paid Alex" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payment");
  await page.getByLabel("Amount", { exact: true }).fill("1600.00");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("This payment replaced an earlier one")).toContainText("Sam paid Alex $1,680.00");
  await page.goto("/");
  await expect(headline(page)).toHaveText("Sam owes Alex $80.00");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Activity" }).click();
  await expect(page.getByRole("region", { name: "Recent activity" })).toContainText("Edited a payment: Sam paid Alex");

  // The old Ledger address lands on Home, which lists the last 30 days.
  await page.goto("/expenses");
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("row").filter({ hasText: "Sam paid Alex" }).getByRole("link", { name: "Sam paid Alex" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Void this payment" }).click();
  await expect(page.getByText("This payment was voided and no longer counts.")).toBeVisible();
  await page.goto("/");
  await expect(headline(page)).toHaveText("Sam owes Alex $1,680.00");

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Record payment" }).click();
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(headline(page)).toHaveText("You are all square.");
});

test("an export, imported again, is re-split by today's rules after a preview", async ({ page }, testInfo) => {
  await signIn(page, "Alex", "2027-04-01");
  await page.goto("/settings/transfer");
  await page.getByLabel("From", { exact: true }).fill("2027-03-01");
  await page.getByLabel("To", { exact: true }).fill("2027-03-31");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  const file = testInfo.outputPath("march.csv");
  await (await download).saveAs(file);

  const lines = (await readFile(file, "utf8")).trim().split("\r\n");
  expect(lines[0]).toBe(
    "id,date,description,category,amount,payer,status,account,account_kind,share: alex@example.com,share: sam@example.com,rule_source",
  );
  expect(lines).toHaveLength(4);
  expect(lines.some((l) => l.includes(",2027-03-01,Rent,housing,2000.00,alex@example.com,posted,,,1000.00,1000.00,default"))).toBe(true);

  await page.goto("/settings/transfer");
  await page.getByLabel("CSV file").setInputFiles(file);
  await page.getByRole("button", { name: "Check the file" }).click();
  // Rent 2000 by Alex: Sam's share 1000 -> 800. Utilities 150 and groceries
  // 90, both by Sam: Alex's share 75 -> 90 and 45 -> 54. Alex is 224 worse off.
  const summary = page.getByRole("list", { name: "Import summary" });
  await expect(summary).toContainText("0 new expenses, and 3 expenses already here replaced, of which 3 would split differently.");
  await expect(summary).toContainText("Sam's position moves by $224.00");
  await expect(headline(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Import these 3 expenses" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Imported" })).toHaveText("Imported 3 expenses.");
  await page.goto("/");
  await expect(headline(page)).toHaveText("Alex owes Sam $224.00");

  await page.goto("/expenses?month=2027-03&status=superseded");
  await expect(page.getByRole("row").filter({ hasText: "replaced" })).toHaveCount(3);

  // The re-split rent keeps the old version on record.
  await page.goto("/expenses?month=2027-03");
  await page.getByRole("row").filter({ hasText: "Rent" }).getByRole("link", { name: "Rent" }).click();
  const history = page.getByRole("table").filter({ hasText: "Entered" });
  await expect(history.getByRole("row")).toHaveCount(3);
  await expect(history.getByRole("row").nth(1)).toContainText("current");
  await expect(history.getByRole("row").nth(2)).toContainText("replaced");
  await expect(history.getByRole("row").nth(2)).toContainText("Clementine, on its due date");
});

test("a recurring cost can be added with its own split, which counts at once", async ({ page }) => {
  await signIn(page, "Alex", "2027-04-01");
  await page.goto("/expenses/new?kind=recurring");
  const form = page.locator("form").filter({ hasText: "Add expense" });
  await form.getByLabel("Description").fill("Gym");
  await form.getByLabel("Category").selectOption({ label: "Other" });
  await form.getByLabel("Amount", { exact: true }).fill("50.00");
  await form.getByLabel("Starts").fill("2027-05-01");
  await form.getByLabel("Repeats").selectOption({ label: "Every 3 months" });
  await form.getByLabel("A month it falls in").selectOption({ label: "May" });
  const split = form.locator("details").filter({ hasText: "Choose a split for this cost" });
  await split.locator("summary").click();
  await split.getByLabel("How to split").selectOption({ label: "Evenly" });
  await form.getByRole("button", { name: "Add expense" }).click();

  const gym = page.getByRole("row").filter({ hasText: "Gym" });
  await expect(gym).toContainText("split evenly from 1 May");
  await expect(gym).toContainText("day 1 of February, May, August and November");
});

test("a bill that cannot be split shows the fix before it is saved", async ({ page }) => {
  // Sam pays the first 200.00 of utilities, more than April's bill.
  await signIn(page, "Sam", "2027-04-01");
  await page.goto("/settings/people#split");
  const rule = page.locator("form").filter({ has: page.getByRole("button", { name: "Save rule" }) });
  await rule.getByLabel("Covers").selectOption({ label: "Recurring cost: Utilities" });
  await rule.getByLabel("How to split").selectOption({ label: "A fixed amount first, then the rest" });
  await rule.getByLabel("Sam pays first").fill("200.00");
  await rule.getByLabel("Counts from").fill("2027-04-01");
  await rule.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByRole("row").filter({ hasText: 'Recurring cost "Utilities"' })).toContainText("1 Apr");

  await signIn(page, "Sam", "2027-04-15");
  // The Ledger below lists the bill too, with its own amount box.
  const todo = page.getByRole("region", { name: "To do" });
  await todo.getByLabel("Amount of this bill").fill("150.00");
  await todo.getByRole("button", { name: "Enter amount" }).click();

  const stuck = todo.getByRole("listitem").filter({ hasText: "Utilities" });
  await expect(stuck.getByRole("region", { name: "Split preview" })).toContainText("It could not be split");
  await expect(stuck.getByRole("link", { name: "Add a lasting rule" })).toHaveAttribute("href", /cover=template%3A/);
  await stuck.getByText("Pick a split for this one").click();
  await stuck.getByLabel("How to split").selectOption({ label: "Evenly" });
  await expect(stuck.getByRole("region", { name: "Split preview" })).toContainText("Alex will owe Sam $75.00 for this.");
  await stuck.getByRole("button", { name: "Split it now" }).click();
  await expect(todo.getByRole("listitem").filter({ hasText: "Utilities" })).toHaveCount(0);
});

test("a device connected in Settings can use the API, until it is disconnected", async ({ page, request }) => {
  await signIn(page, "Sam", "2027-04-15");
  await page.goto("/settings/agents#devices");
  await page.getByLabel("Device name").fill("Sam's phone");
  await page.getByRole("button", { name: "Connect a device" }).click();
  const token = (await page.getByTestId("new-token").textContent())!.trim();
  expect(token).toMatch(/^abk_/);
  await expect(page.getByRole("row").filter({ hasText: "Sam's phone" })).toContainText("active");

  const headers = { authorization: `Bearer ${token}`, "x-abacus-today": "2027-04-15" };
  const me = await request.get("/api/v1/me", { headers });
  expect((await me.json()).me.displayName).toBe("Sam");

  const added = await request.post("/api/v1/expenses", {
    headers,
    data: { description: "Takeout from the phone", totalCents: 4000, date: "2027-04-15", category: "dining" },
  });
  expect(added.status()).toBe(201);
  await page.goto("/expenses?month=2027-04");
  await expect(page.getByRole("row").filter({ hasText: "Takeout from the phone" })).toContainText("$40.00");

  await page.goto("/settings/agents#devices");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("row").filter({ hasText: "Sam's phone" }).getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Sam's phone" })).toContainText("disconnected");
  expect((await request.get("/api/v1/me", { headers })).status()).toBe(401);
});

// Last, because it leaves Alex in two groups and the sign-in page lists both.
test("someone can add a second group, switch between them, and pick a default", async ({ page }) => {
  await signIn(page, "Alex", "2027-04-15");
  const switcher = page.getByRole("button", { name: /Switch group/ });
  await expect(switcher).toHaveText("Maple Street");

  await switcher.click();
  await page.getByRole("link", { name: "Add a group" }).click();
  await page.getByLabel("What it is").selectOption({ label: "A small business" });
  await page.getByLabel("Name", { exact: true }).fill("Corner Bakery");
  await page.getByLabel("The other person's name").fill("Lee");
  await page.getByLabel("The other person's email").fill("lee@example.com");
  await page.getByRole("button", { name: "Add group" }).click();

  // The new group is empty and is now the one on screen.
  await expect(switcher).toHaveText("Corner Bakery");
  await expect(headline(page)).toHaveText("You are all square.");

  await switcher.click();
  await page.getByRole("button", { name: "Make Corner Bakery your default group" }).click();
  await expect(page.getByRole("button", { name: "Corner Bakery is your default group" })).toBeDisabled();

  // Back to the household, with its own balance.
  await page.getByRole("list", { name: "Your groups" }).getByRole("button", { name: /Maple Street/ }).first().click();
  await expect(switcher).toHaveText("Maple Street");
  await expect(headline(page)).not.toHaveText("You are all square.");
});

test("a business can be just one person, with nothing to split or agree", async ({ page }) => {
  // Sam, because the test above left Alex in two groups, each with its own sign-in button.
  await signIn(page, "Sam", "2027-04-15");
  const switcher = page.getByRole("button", { name: /Switch group/ });
  await switcher.click();
  await page.getByRole("link", { name: "Add a group" }).click();
  await page.getByLabel("What it is").selectOption({ label: "A small business" });
  await page.getByLabel("Name", { exact: true }).fill("Solo Studio");
  await page.getByRole("button", { name: "Add group" }).click();
  await expect(switcher).toHaveText("Solo Studio");

  // Only the recurring-cost step: nobody to wait for, no split to agree.
  await page.getByRole("button", { name: "Getting started · 0 of 1" }).click();
  const started = page.getByRole("dialog", { name: "Getting started" });
  await expect(started).toContainText("0 of 1 done");
  await expect(started).not.toContainText("Agree how to split");
  await started.getByRole("button", { name: "Close" }).click();
  await expect(started).toHaveCount(0);

  // Nobody to pay, but what the business owes back is still on Home.
  await expect(page.getByRole("link", { name: "Record payment" })).toHaveCount(0);
  await page.getByRole("link", { name: "Paid personally" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Paid personally");
  await expect(page.getByRole("region", { name: "Owed back" })).toContainText("Nothing paid from a personal account yet.");
});
