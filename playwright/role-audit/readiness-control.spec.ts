import { test, expect, type Page } from "@playwright/test";
import { requireReadyScreen } from "./readiness";

// Synthetic DOM controls use no application identity or backend.
test.use({ storageState: { cookies: [], origins: [] } });

async function mountLazyFigures(page: Page, delayed: boolean): Promise<void> {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent('<main><button>Deals</button><p id="pending">Loading rows...</p><div style="height: 1400px"></div><section id="rows"></section></main>');
  await page.evaluate((appendAfterPass) => {
    const appendRows = () => {
      const rows = document.querySelector("#rows");
      if (!rows) throw new Error("Synthetic rows container is unavailable");
      rows.innerHTML = '<div data-testid="lazy-row" class="animate-pulse"><span>Loading</span></div>';
      document.querySelector("#pending")?.remove();
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.remove("animate-pulse");
            entry.target.textContent = "QA TEST ready figures";
            observer.unobserve(entry.target);
          }
        }
      }, { rootMargin: "200px" });
      const row = rows.firstElementChild;
      if (!row) throw new Error("Synthetic lazy row is unavailable");
      observer.observe(row);
    };
    if (!appendAfterPass) {
      appendRows();
      return;
    }
    // SCRUM-926: append only AFTER a traversal has returned to the top,
    // plus a delay. A single pass followed by assertion retries cannot resolve it.
    let scrolled = false;
    const afterPass = () => {
      if (window.scrollY > 0) scrolled = true;
      if (scrolled && window.scrollY === 0) {
        document.removeEventListener("scroll", afterPass);
        setTimeout(appendRows, 1_000);
      }
    };
    document.addEventListener("scroll", afterPass);
  }, delayed);
}

test("SCRUM-925: readiness resolves figures below the viewport without caller scrolling", async ({ page }) => {
  await mountLazyFigures(page, false);
  await expect(page.getByTestId("lazy-row")).toContainText("Loading");
  await requireReadyScreen(page, 5_000);
  await expect(page.getByTestId("lazy-row")).toHaveText("QA TEST ready figures");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("SCRUM-926: readiness revisits lazy rows appended after a completed scroll pass", async ({ page }) => {
  await mountLazyFigures(page, true);
  await expect(page.getByTestId("lazy-row")).toHaveCount(0);
  await expect(page.locator("#pending")).toHaveText("Loading rows...");
  await requireReadyScreen(page, 5_000);
  await expect(page.getByTestId("lazy-row")).toHaveText("QA TEST ready figures");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("screen readiness refuses a persistent scroll failure despite resolved content", async ({ page }) => {
  await page.setContent('<main style="height: 100px; overflow-y: auto"><button>Loaded deals</button><div style="height: 300px"></div></main>');
  await page.locator("main").evaluate((main) => { main.scrollTo = () => {}; });
  await expect(requireReadyScreen(page, 500)).rejects.toThrow("Audit could not advance");
});

test("screen readiness refuses permanent English, Arabic and spinner loading states", async ({ page }) => {
  for (const loading of [
    "<p>Loading customers...</p>",
    "<p>جاري تحميل العملاء...</p>",
    '<div class="animate-spin">Pending</div>',
    '<div class="animate-pulse">Loading</div>',
    '<div hidden class="animate-pulse">Pending</div>',
    '<div aria-busy="true"><table><tbody><tr><td>Old row</td></tr></tbody></table></div>',
  ]) {
    // Stale rows plus a heading must not hide the ongoing loading state.
    await page.setContent(`<main><h2>Customers</h2><table><tbody><tr><td>Old row</td></tr></tbody></table>${loading}</main>`);
    await expect(requireReadyScreen(page, 200), loading).rejects.toThrow();
  }
  await page.setContent("<main><h2>Customers</h2></main>");
  await expect(requireReadyScreen(page, 200)).rejects.toThrow();
  for (const busy of ['aria-busy="true"', 'data-loading="true"']) {
    await page.setContent(`<main ${busy}><table><tbody><tr><td>Old row</td></tr></tbody></table></main>`);
    await expect(requireReadyScreen(page, 200), busy).rejects.toThrow();
  }
});

test("screen readiness accepts resolved rows and a recognized empty table", async ({ page }) => {
  for (const content of ["<tr><td>QA TEST customer</td></tr>", "<tr><td>No customers found</td></tr>"]) {
    await page.setContent(`<main><h2>Customers</h2><table><tbody>${content}</tbody></table></main>`);
    await requireReadyScreen(page, 200);
  }
});

test("ready content on an unexpected route cannot certify the requested screen", async ({ page }) => {
  await page.route("https://audit.invalid/**", (route) => route.fulfill({
    contentType: "text/html", body: "<main><table><tbody><tr><td>Loaded customer</td></tr></tbody></table></main>",
  }));
  await page.goto("https://audit.invalid/org/customers");
  await expect(requireReadyScreen(page, 200, "/org/deals")).rejects.toThrow();
  await requireReadyScreen(page, 200, "/org/customers");
});

test("a redirect while content loads cannot certify the original destination", async ({ page }) => {
  await page.route("https://audit.invalid/**", (route) => route.fulfill({
    contentType: "text/html", body: '<main><div aria-busy="true"><table><tbody><tr><td>Loaded customer</td></tr></tbody></table></div></main>',
  }));
  await page.goto("https://audit.invalid/org/deals");
  await page.evaluate(() => {
    setTimeout(() => {
      history.replaceState(null, "", "/org/customers");
      document.querySelector("[aria-busy]")?.removeAttribute("aria-busy");
    }, 200);
  });
  await expect(requireReadyScreen(page, 1_000, "/org/deals")).rejects.toThrow();
});
