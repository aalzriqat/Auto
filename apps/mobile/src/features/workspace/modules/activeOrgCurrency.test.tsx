/// <reference types="jest" />

/**
 * SCRUM-85 (B3): the organization currency `money()` reads is published by a screen's
 * `useSyncActiveOrgCurrency`. It used to be assigned DURING RENDER into a module variable, so it
 * leaked: after the screen unmounted (an org switch, a sign-out) the previous organization's
 * currency stayed published and a later `money()` call formatted another tenant's figures in it.
 * It is now published from a layout effect, cleared on unmount, and the screen re-renders when it
 * changes. Evidence boundary: jest-expo render with a mocked Convex client, not a device.
 */
import React from "react";
import { Text } from "react-native";
import { act, render, screen } from "@testing-library/react-native";

jest.mock("convex/react", () => ({ useQuery: jest.fn() }));

import { useQuery } from "convex/react";
import { currencyNotConfiguredLabel, money, setActiveOrgCurrency, useSyncActiveOrgCurrency } from "./moduleShared";

const mockedUseQuery = useQuery as unknown as jest.Mock;

function Screen({ orgId }: Readonly<{ orgId: string | null }>) {
  useSyncActiveOrgCurrency(orgId);
  return <Text testID="amount">{money(12.5, "en")}</Text>;
}

afterEach(() => {
  mockedUseQuery.mockReset();
  setActiveOrgCurrency(null);
});

describe("useSyncActiveOrgCurrency", () => {
  test("the screen's own children format in the stored currency once it is known", async () => {
    mockedUseQuery.mockReturnValue({ currency: "USD" });
    await render(<Screen orgId="org1" />);
    expect(screen.getByTestId("amount").props.children).toBe("$12.50");
  });

  test("with no stored currency the children print the not-configured text, never a guess", async () => {
    mockedUseQuery.mockReturnValue({ currency: null });
    await render(<Screen orgId="org1" />);
    expect(screen.getByTestId("amount").props.children).toBe(currencyNotConfiguredLabel("en"));
  });

  test("a changed stored currency re-renders the screen's children in it", async () => {
    mockedUseQuery.mockReturnValue({ currency: "USD" });
    const view = await render(<Screen orgId="org1" />);
    mockedUseQuery.mockReturnValue({ currency: "KWD" });
    await view.rerender(<Screen orgId="org1" />);
    expect(screen.getByTestId("amount").props.children).toContain("12.500");
  });

  test("when the screen unmounts the organization's currency is no longer published", async () => {
    mockedUseQuery.mockReturnValue({ currency: "USD" });
    const view = await render(<Screen orgId="org1" />);
    expect(money(12.5, "en")).toBe("$12.50");

    await act(async () => { await view.unmount(); });

    expect(money(12.5, "en")).toBe(currencyNotConfiguredLabel("en"));
  });

  test("a screen stacked above another leaves the lower screen's currency published when it unmounts", async () => {
    mockedUseQuery.mockReturnValue({ currency: "USD" });
    function Detail() {
      useSyncActiveOrgCurrency("org1");
      return <Text>detail</Text>;
    }
    function Stack({ showDetail }: Readonly<{ showDetail: boolean }>) {
      return (
        <>
          <Screen orgId="org1" />
          {showDetail ? <Detail /> : null}
        </>
      );
    }
    const view = await render(<Stack showDetail />);
    await view.rerender(<Stack showDetail={false} />);

    expect(money(12.5, "en")).toBe("$12.50");
  });});
