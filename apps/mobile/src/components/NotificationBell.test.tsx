/// <reference types="jest" />

import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { useMutation, useQuery } from "convex/react";
import * as SecureStore from "expo-secure-store";

const mockPush = jest.fn();

jest.mock("convex/react", () => ({
  useMutation: jest.fn(),
  useQuery: jest.fn(),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

import { api, type MobileNotification } from "../convexApi";
import { LocaleProvider } from "../providers/LocaleProvider";
import { getBellPressedStyle, getRowPressedStyle, NotificationBell, parseNotificationLink } from "./NotificationBell";

const mockUseQuery = useQuery as jest.MockedFunction<typeof useQuery>;
const mockUseMutation = useMutation as jest.MockedFunction<typeof useMutation>;
const getItemAsync = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;

function makeNotification(overrides: Partial<MobileNotification>): MobileNotification {
  return {
    _id: "n1",
    _creationTime: Date.now() - 60_000,
    orgId: "org1",
    userId: "user1",
    isRead: false,
    ...overrides,
  };
}

function mockQueries({
  unreadCount,
  notifications,
}: {
  unreadCount: number | undefined;
  notifications: MobileNotification[] | undefined;
}) {
  mockUseQuery.mockImplementation((queryRef: unknown, ..._args: unknown[]) => {
    if (queryRef === api.notifications.unreadCount) {
      return unreadCount as unknown as ReturnType<typeof useQuery>;
    }
    if (queryRef === api.notifications.list) {
      return notifications as unknown as ReturnType<typeof useQuery>;
    }
    return undefined as unknown as ReturnType<typeof useQuery>;
  });
}

describe("NotificationBell", () => {
  test("computes pressed styles", () => {
    expect(getBellPressedStyle(false)).toBeNull();
    expect(getBellPressedStyle(true)).not.toBeNull();
    expect(getRowPressedStyle(false)).toBeNull();
    expect(getRowPressedStyle(true)).not.toBeNull();
  });

  describe("parseNotificationLink", () => {
    test("returns null for an undefined link", () => {
      expect(parseNotificationLink(undefined, "org1")).toBeNull();
    });

    test("returns null for a link that does not belong to this org", () => {
      expect(parseNotificationLink("/org2/leads", "org1")).toBeNull();
    });

    test("returns null for a segment that isn't a known module", () => {
      expect(parseNotificationLink("/org1/whats-new", "org1")).toBeNull();
    });

    test("parses a plain module link with no query string", () => {
      expect(parseNotificationLink("/org1/accounting", "org1")).toEqual({
        moduleId: "accounting",
        highlightId: undefined,
      });
    });

    test("parses a module link with an unrelated query param", () => {
      expect(parseNotificationLink("/org1/vehicles?approvals=true", "org1")).toEqual({
        moduleId: "vehicles",
        highlightId: undefined,
      });
    });

    test("extracts highlightId from the query string", () => {
      expect(parseNotificationLink("/org1/leads?highlightId=lead-9", "org1")).toEqual({
        moduleId: "leads",
        highlightId: "lead-9",
      });
    });
  });

  const markAsRead = jest.fn().mockResolvedValue(null);
  const markAllAsRead = jest.fn().mockResolvedValue(null);

  beforeEach(() => {
    mockUseQuery.mockReset();
    mockPush.mockReset();
    markAsRead.mockReset().mockResolvedValue(null);
    markAllAsRead.mockReset().mockResolvedValue(null);
    mockUseMutation.mockImplementation((mutationRef: unknown, ..._args: unknown[]) => {
      if (mutationRef === api.notifications.markAsRead) {
        return markAsRead as unknown as ReturnType<typeof useMutation>;
      }
      if (mutationRef === api.notifications.markAllAsRead) {
        return markAllAsRead as unknown as ReturnType<typeof useMutation>;
      }
      return jest.fn() as unknown as ReturnType<typeof useMutation>;
    });
    getItemAsync.mockReset();
    getItemAsync.mockResolvedValue(null);
  });

  test("shows no badge and no mark-all-read action when nothing is unread", async () => {
    mockQueries({ unreadCount: 0, notifications: [] });

    const rendered = await render(
      <LocaleProvider>
        <NotificationBell orgId="org1" />
      </LocaleProvider>,
    );

    await waitFor(() => expect(rendered.getByLabelText("الإشعارات")).toBeTruthy());
    expect(rendered.queryByText("9+")).toBeNull();

    fireEvent.press(rendered.getByLabelText("الإشعارات"));
    await waitFor(() => expect(rendered.getByText("لا توجد إشعارات.")).toBeTruthy());
    expect(rendered.queryByText("تحديد الكل كمقروء")).toBeNull();
  });

  test("treats an undefined unread count as zero", async () => {
    mockQueries({ unreadCount: undefined, notifications: [] });

    const rendered = await render(
      <LocaleProvider>
        <NotificationBell orgId="org1" />
      </LocaleProvider>,
    );

    await waitFor(() => expect(rendered.getByLabelText("الإشعارات")).toBeTruthy());
    expect(rendered.queryByText("9+")).toBeNull();
  });

  test("caps the badge at 9+ and shows a loading state before the list resolves", async () => {
    mockQueries({ unreadCount: 15, notifications: undefined });

    const rendered = await render(
      <LocaleProvider>
        <NotificationBell orgId="org1" />
      </LocaleProvider>,
    );

    await waitFor(() => expect(rendered.getByText("9+")).toBeTruthy());

    fireEvent.press(rendered.getByLabelText("الإشعارات"));
    await waitFor(() => expect(rendered.getByText("جارٍ التحميل...")).toBeTruthy());
  });

  test("renders English copy when the locale is English", async () => {
    getItemAsync.mockResolvedValueOnce("en");
    mockQueries({ unreadCount: 2, notifications: [] });

    const rendered = await render(
      <LocaleProvider>
        <NotificationBell orgId="org1" />
      </LocaleProvider>,
    );

    await waitFor(() => expect(rendered.getByLabelText("Notifications")).toBeTruthy());
    fireEvent.press(rendered.getByLabelText("Notifications"));
    await waitFor(() => expect(rendered.getByText("No notifications yet.")).toBeTruthy());
    expect(rendered.getByText("Mark all read")).toBeTruthy();
  });

  test("shows an English loading state while the list is pending", async () => {
    getItemAsync.mockResolvedValueOnce("en");
    mockQueries({ unreadCount: 1, notifications: undefined });

    const rendered = await render(
      <LocaleProvider>
        <NotificationBell orgId="org1" />
      </LocaleProvider>,
    );

    await waitFor(() => expect(rendered.getByLabelText("Notifications")).toBeTruthy());
    fireEvent.press(rendered.getByLabelText("Notifications"));
    await waitFor(() => expect(rendered.getByText("Loading...")).toBeTruthy());
  });

  test("falls back to a generic English title when a notification has no title or template", async () => {
    getItemAsync.mockResolvedValueOnce("en");
    mockQueries({ unreadCount: 1, notifications: [makeNotification({ _id: "n1", isRead: false })] });

    const rendered = await render(
      <LocaleProvider>
        <NotificationBell orgId="org1" />
      </LocaleProvider>,
    );

    await waitFor(() => expect(rendered.getByLabelText("Notifications")).toBeTruthy());
    fireEvent.press(rendered.getByLabelText("Notifications"));
    await waitFor(() => expect(rendered.getByText("Notification")).toBeTruthy());
  });

  test("renders a mix of read/unread rows, marks an unread row read on tap, and leaves a read row untouched", async () => {
    const templated = makeNotification({
      _id: "n-templated",
      isRead: false,
      type: "vehicle.updated",
      data: { actorName: "Sara", vehicleLabel: "2024 Toyota Camry" },
    });
    const custom = makeNotification({
      _id: "n-custom",
      isRead: true,
      title: "عنوان مخصص",
      message: "رسالة مخصصة",
    });
    const fallback = makeNotification({
      _id: "n-fallback",
      isRead: false,
    });
    mockQueries({ unreadCount: 2, notifications: [templated, custom, fallback] });

    const rendered = await render(
      <LocaleProvider>
        <NotificationBell orgId="org1" />
      </LocaleProvider>,
    );

    fireEvent.press(rendered.getByLabelText("الإشعارات"));

    await waitFor(() => expect(rendered.getByText("تم تحديث بيانات السيارة")).toBeTruthy());
    expect(rendered.getByText("قام Sara بتحديث بيانات سيارة 2024 Toyota Camry")).toBeTruthy();
    expect(rendered.getByText("عنوان مخصص")).toBeTruthy();
    expect(rendered.getByText("رسالة مخصصة")).toBeTruthy();
    expect(rendered.getByText("إشعار")).toBeTruthy();

    fireEvent.press(rendered.getByText("تم تحديث بيانات السيارة"));
    await waitFor(() => expect(markAsRead).toHaveBeenCalledWith({ orgId: "org1", notificationId: "n-templated" }));

    markAsRead.mockClear();
    fireEvent.press(rendered.getByText("عنوان مخصص"));
    expect(markAsRead).not.toHaveBeenCalled();
  });

  test("tapping an unread notification with a routable link marks it read, navigates, and closes the panel", async () => {
    const routable = makeNotification({
      _id: "n-routable",
      isRead: false,
      title: "عميل محتمل جديد",
      link: "/org1/leads?highlightId=lead-9",
    });
    mockQueries({ unreadCount: 1, notifications: [routable] });

    const rendered = await render(
      <LocaleProvider>
        <NotificationBell orgId="org1" />
      </LocaleProvider>,
    );

    fireEvent.press(rendered.getByLabelText("الإشعارات"));
    await waitFor(() => expect(rendered.getByText("عميل محتمل جديد")).toBeTruthy());

    fireEvent.press(rendered.getByText("عميل محتمل جديد"));
    await waitFor(() => expect(markAsRead).toHaveBeenCalledWith({ orgId: "org1", notificationId: "n-routable" }));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/org/[orgId]/module/[moduleId]",
      params: { orgId: "org1", moduleId: "leads", highlightId: "lead-9" },
    });
    await waitFor(() => expect(rendered.queryByText("عميل محتمل جديد")).toBeNull());
  });

  test("tapping an already-read notification with a routable link still navigates without marking it read again", async () => {
    const routable = makeNotification({
      _id: "n-routable-read",
      isRead: true,
      title: "محاسبة",
      link: "/org1/accounting",
    });
    mockQueries({ unreadCount: 0, notifications: [routable] });

    const rendered = await render(
      <LocaleProvider>
        <NotificationBell orgId="org1" />
      </LocaleProvider>,
    );

    fireEvent.press(rendered.getByLabelText("الإشعارات"));
    await waitFor(() => expect(rendered.getByText("محاسبة")).toBeTruthy());

    fireEvent.press(rendered.getByText("محاسبة"));
    expect(markAsRead).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith({
        pathname: "/org/[orgId]/module/[moduleId]",
        params: { orgId: "org1", moduleId: "accounting" },
      }),
    );
  });

  test("marks all as read from the panel header", async () => {
    mockQueries({
      unreadCount: 1,
      notifications: [makeNotification({ _id: "n1", isRead: false, title: "شيء ما", message: "تفاصيل" })],
    });

    const rendered = await render(
      <LocaleProvider>
        <NotificationBell orgId="org1" />
      </LocaleProvider>,
    );

    fireEvent.press(rendered.getByLabelText("الإشعارات"));
    await waitFor(() => expect(rendered.getByText("تحديد الكل كمقروء")).toBeTruthy());

    fireEvent.press(rendered.getByText("تحديد الكل كمقروء"));
    await waitFor(() => expect(markAllAsRead).toHaveBeenCalledWith({ orgId: "org1" }));
  });

  test("surfaces mark-as-read and mark-all-read failures without crashing", async () => {
    markAsRead.mockRejectedValueOnce(new Error("network down"));
    markAllAsRead.mockRejectedValueOnce(new Error("network down"));
    mockQueries({
      unreadCount: 1,
      notifications: [makeNotification({ _id: "n1", isRead: false, title: "شيء ما", message: "تفاصيل" })],
    });

    const rendered = await render(
      <LocaleProvider>
        <NotificationBell orgId="org1" />
      </LocaleProvider>,
    );

    fireEvent.press(rendered.getByLabelText("الإشعارات"));
    await waitFor(() => expect(rendered.getByText("شيء ما")).toBeTruthy());

    fireEvent.press(rendered.getByText("شيء ما"));
    await waitFor(() => expect(markAsRead).toHaveBeenCalled());

    fireEvent.press(rendered.getByText("تحديد الكل كمقروء"));
    await waitFor(() => expect(markAllAsRead).toHaveBeenCalled());
  });

  test("closes via the backdrop and navigates to Alerts via View all", async () => {
    mockQueries({ unreadCount: 0, notifications: [] });

    const rendered = await render(
      <LocaleProvider>
        <NotificationBell orgId="org1" />
      </LocaleProvider>,
    );

    fireEvent.press(rendered.getByLabelText("الإشعارات"));
    await waitFor(() => expect(rendered.getByText("عرض الكل")).toBeTruthy());

    fireEvent.press(rendered.getByText("عرض الكل"));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/org/[orgId]/finance",
      params: { orgId: "org1", segment: "alerts" },
    });
    await waitFor(() => expect(rendered.queryByText("عرض الكل")).toBeNull());

    fireEvent.press(rendered.getByLabelText("الإشعارات"));
    await waitFor(() => expect(rendered.getByLabelText("إغلاق")).toBeTruthy());
    fireEvent.press(rendered.getByLabelText("إغلاق"));
    await waitFor(() => expect(rendered.queryByText("عرض الكل")).toBeNull());
  });
});
