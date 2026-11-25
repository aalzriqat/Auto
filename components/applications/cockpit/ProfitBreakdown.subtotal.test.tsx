import React from "react";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ProfitBreakdown } from "./DealProfitPresentation";

const money = (minor: number) => `${minor / 1000} JOD`;
const t = (key: string) => key;
const lines = [
  { key: "APPROVED_PURCHASE", sign: 1, amountMinor: 12_000_000 },
  { key: "SUPPLIER_SETTLEMENT", sign: -1, amountMinor: 9_900_000 },
  { key: "PREPARATION_EXPENSES", sign: -1, amountMinor: 300_000 },
  { key: "COMMISSIONS", sign: -1, amountMinor: 110_000 },
];
const profit = (list: typeof lines) =>
  ({ available: true, basis: "MANAGEMENT_NET", amountMinor: 1_690_000, currency: "JOD", lines: list, postable: false }) as never;

test("the working states the served profit before commissions between the costs and the commission line", () => {
  const view = render(
    <ProfitBreakdown profit={profit(lines)} money={money} t={t} beforeCommissions={{ amountMinor: 1_800_000 }} />,
  );
  const rows = Array.from(view.container.querySelectorAll("dt")).map((node) => node.textContent);
  expect(rows).toEqual([
    "LineApprovedPurchase", "LineSupplierSettlement", "LinePreparationExpenses",
    "ProfitBeforeCommissionsSubtotal", "DealCommissionsTotal",
  ]);
  expect(screen.getByText("1800 JOD")).toBeTruthy();
});

test("without a served subtotal (no commission access, or an older server) the working is unchanged", () => {
  const view = render(<ProfitBreakdown profit={profit(lines)} money={money} t={t} />);
  expect(Array.from(view.container.querySelectorAll("dt")).map((node) => node.textContent)).toEqual([
    "LineApprovedPurchase", "LineSupplierSettlement", "LinePreparationExpenses", "DealCommissionsTotal",
  ]);
});
