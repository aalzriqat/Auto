/// <reference types="jest" />

import { fireEvent, render, waitFor } from "@testing-library/react-native";

import type { SavedVehicle } from "../marketplace/savedVehiclesStore";

const mockLoad = jest.fn<Promise<SavedVehicle[]>, []>();
const mockRemove = jest.fn<Promise<SavedVehicle[]>, [string]>();

jest.mock("../marketplace/savedVehiclesStore", () => ({
  loadSavedVehicles: () => mockLoad(),
  removeSavedVehicleById: (id: string) => mockRemove(id),
}));

import { LocaleProvider } from "../../providers/LocaleProvider";
import { ThemeProvider } from "../../providers/ThemeProvider";
import { BuyerSavedScreen } from "./BuyerSavedScreen";

function renderSaved() {
  return render(
    <ThemeProvider>
      <LocaleProvider>
        <BuyerSavedScreen />
      </LocaleProvider>
    </ThemeProvider>,
  );
}

const car: SavedVehicle = {
  id: "v1",
  orgId: "org1",
  title: "Toyota Camry 2024",
  price: 23500,
  dealershipName: "Bloom Cars",
  savedAt: 1,
};

describe("BuyerSavedScreen", () => {
  beforeEach(() => {
    mockLoad.mockReset();
    mockRemove.mockReset();
  });

  test("shows the empty state when nothing is saved", async () => {
    mockLoad.mockResolvedValue([]);
    const { getByText } = await renderSaved();
    await waitFor(() => expect(getByText("لا سيارات محفوظة بعد")).toBeTruthy());
  });

  test("lists saved cars and removes one", async () => {
    mockLoad.mockResolvedValue([car]);
    mockRemove.mockResolvedValue([]);
    const { getByText, getByLabelText } = await renderSaved();

    await waitFor(() => expect(getByText("Toyota Camry 2024")).toBeTruthy());
    expect(getByText("Bloom Cars")).toBeTruthy();

    fireEvent.press(getByLabelText("إزالة"));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith("v1"));
  });
});
