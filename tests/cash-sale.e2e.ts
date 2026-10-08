import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The pilot's core flow (SCRUM-760 narrowed pilot): a salesperson sells a vehicle for cash and
// lands on the deal. Self-contained like playwright/tests/sales.spec.ts: it creates its own vehicle
// and customer, so it never sells real stock or depends on other runs.
//
// Goals are plain language so the agent follows the screens as they are; the end state is checked
// with exact assertions, not only the agent's judgment.
test('a salesperson completes a cash sale and lands on the deal', { session: 'sales', timeout: 600_000 }, async ({ app, agent, browser, screen }) => {
  const suffix = Date.now().toString(36);
  const model = `E2E-${suffix}`;
  const vin = `1HG0${Number.parseInt(suffix, 36).toString().padStart(13, '0')}`;
  const lastName = `Buyer-${suffix}`;

  // `/` is the public landing page; `/dashboard` routes a member to their dealership.
  await app.open('/dashboard');
  await browser.waitForURL(/\/[^/]+\/(dashboard|sales|leads|accounting)/, { timeout: 30_000 });

  await agent.act(
    `Add a new vehicle to inventory: VIN "${vin}", make Toyota, model "${model}", year 2022, ` +
      'asking price 10000. Fill any other required field with a sensible value and save it.',
  );
  await agent.act(
    `Start a new cash sale. Pick the available vehicle whose model is "${model}". ` +
      `Create a new customer with first name "Agentic" and last name "${lastName}" and select them. ` +
      'Generate the quote, then tap Submit Sale once. Stop after the tap; the test will wait for the save to finish.',
  );

  // Submission leaves the wizard open. The completed sale replaces Submit Sale with a
  // persistent link to its deal; the success toast can disappear before this step runs.
  const openDeal = screen.getByRole('link', 'Open Deal');
  await expect(openDeal).toBeVisible({ timeout: 60_000 });
  await expect(openDeal).toHaveAttribute('href', /\/sales\/[^/]+\/deal$/);
  await openDeal.tap();

  await expect(browser).toHaveURL(/\/sales\/[^/]+\/deal$/);
  await expect(screen.getByText('Status history')).toBeVisible();
  await agent.assert(`This deal page is for the Toyota "${model}" and the customer "Agentic ${lastName}".`);
});
