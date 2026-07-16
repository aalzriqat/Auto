/// <reference types="jest" />

import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { useQuery } from "convex/react";
import * as SecureStore from "expo-secure-store";

jest.mock("convex/react", () => ({
  useQuery: jest.fn(),
}));

jest.mock("../features/workspace/modules/messages", () => ({
  MessagesModule: () => {
    const { Text: MockText } = jest.requireActual<typeof import("react-native")>("react-native");
    return <MockText>mock-messages-module</MockText>;
  },
}));

import { LocaleProvider } from "../providers/LocaleProvider";
import { FloatingMessengerFAB, getFabPressedStyle } from "./FloatingMessengerFAB";

const mockUseQuery = useQuery as jest.MockedFunction<typeof useQuery>;
const getItemAsync = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;

describe("FloatingMessengerFAB", () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
    getItemAsync.mockReset();
    getItemAsync.mockResolvedValue(null);
  });

  test("computes pressed style", () => {
    expect(getFabPressedStyle(false)).toBeNull();
    expect(getFabPressedStyle(true)).not.toBeNull();
  });

  test("renders English labels when the locale is English", async () => {
    getItemAsync.mockResolvedValueOnce("en");
    mockUseQuery.mockReturnValue([] as unknown as ReturnType<typeof useQuery>);

    const rendered = await render(
      <LocaleProvider>
        <FloatingMessengerFAB bottomOffset={80} orgId="org1" />
      </LocaleProvider>,
    );

    await waitFor(() => expect(rendered.getByLabelText("Messages")).toBeTruthy());
    fireEvent.press(rendered.getByLabelText("Messages"));
    await waitFor(() => expect(rendered.getByLabelText("Close")).toBeTruthy());
  });

  test("shows an unread badge, opens the messenger sheet, and closes it again", async () => {
    mockUseQuery.mockReturnValue([
      { _id: "c1", hasUnread: true },
      { _id: "c2", hasUnread: false },
      { _id: "c3", hasUnread: true },
    ] as unknown as ReturnType<typeof useQuery>);

    const rendered = await render(
      <LocaleProvider>
        <FloatingMessengerFAB bottomOffset={80} orgId="org1" />
      </LocaleProvider>,
    );

    expect(rendered.getByText("2")).toBeTruthy();
    expect(rendered.queryByText("mock-messages-module")).toBeNull();

    fireEvent.press(rendered.getByLabelText("الرسائل"));
    await waitFor(() => expect(rendered.getByText("mock-messages-module")).toBeTruthy());

    fireEvent.press(rendered.getByLabelText("إغلاق"));
    await waitFor(() => expect(rendered.queryByText("mock-messages-module")).toBeNull());
  });

  test("hides the badge and stops pulsing when there is nothing unread", async () => {
    mockUseQuery.mockReturnValue([{ _id: "c1", hasUnread: false }] as unknown as ReturnType<typeof useQuery>);

    const rendered = await render(
      <LocaleProvider>
        <FloatingMessengerFAB bottomOffset={80} orgId="org1" />
      </LocaleProvider>,
    );

    expect(rendered.queryByText("9+")).toBeNull();
  });

  test("caps the badge at 9+", async () => {
    mockUseQuery.mockReturnValue(
      Array.from({ length: 12 }, (_, index) => ({ _id: `c${index}`, hasUnread: true })) as unknown as ReturnType<
        typeof useQuery
      >,
    );

    const rendered = await render(
      <LocaleProvider>
        <FloatingMessengerFAB bottomOffset={80} orgId="org1" />
      </LocaleProvider>,
    );

    expect(rendered.getByText("9+")).toBeTruthy();
  });

  test("treats an undefined conversations query as zero unread", async () => {
    mockUseQuery.mockReturnValue(undefined as unknown as ReturnType<typeof useQuery>);

    const rendered = await render(
      <LocaleProvider>
        <FloatingMessengerFAB bottomOffset={80} orgId="org1" />
      </LocaleProvider>,
    );

    expect(rendered.queryByText("9+")).toBeNull();
    expect(rendered.getByLabelText("الرسائل")).toBeTruthy();
  });
});
