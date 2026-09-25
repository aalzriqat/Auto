import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DealVehicleCard } from "./DealVehicleCard";

const t = (key: string) => key;

afterEach(() => {
  cleanup();
});

describe("DealVehicleCard (SCRUM-372)", () => {
  it("shows the served profile: photo, title, VIN, colour, mileage and ownership", () => {
    render(
      <DealVehicleCard
        t={t}
        vehicle={{
          label: "Toyota Corolla 2023",
          vin: "JTDBE3KEXP0123456",
          consigned: false,
          profile: { make: "Toyota", model: "Corolla", year: 2023, color: "أبيض", mileage: 18450, photoUrl: "https://files.example/p.jpg" },
        }}
      />,
    );
    expect(screen.getByTestId("deal-vehicle-photo").getAttribute("src")).toBe("https://files.example/p.jpg");
    expect(screen.getByText("Toyota Corolla 2023")).toBeTruthy();
    expect(screen.getByText("JTDBE3KEXP0123456")).toBeTruthy();
    expect(screen.getByText("أبيض")).toBeTruthy();
    expect(screen.getByText("18,450")).toBeTruthy();
    expect(screen.getByText("OwnershipWithDealership")).toBeTruthy();
  });

  it("falls back to the silhouette when the photo fails to load", () => {
    render(
      <DealVehicleCard
        t={t}
        vehicle={{
          label: "Toyota Corolla 2023",
          consigned: true,
          profile: { make: "Toyota", model: "Corolla", year: 2023, color: "", mileage: 0, photoUrl: "https://files.example/broken.jpg" },
        }}
      />,
    );
    fireEvent.error(screen.getByTestId("deal-vehicle-photo"));
    expect(screen.queryByTestId("deal-vehicle-photo")).toBeNull();
    expect(screen.getByTestId("deal-vehicle-photo-placeholder")).toBeTruthy();
    // An empty colour is "not recorded", never a blank cell.
    expect(screen.getByText("FactUnavailable")).toBeTruthy();
    expect(screen.getByText("OwnershipWithSupplier")).toBeTruthy();
  });

  it("degrades to the label alone when the server withheld the profile", () => {
    render(<DealVehicleCard t={t} vehicle={{ label: "Kia Rio 2019", consigned: false, profile: null }} />);
    expect(screen.getByText("Kia Rio 2019")).toBeTruthy();
    expect(screen.getByTestId("deal-vehicle-photo-placeholder")).toBeTruthy();
    expect(screen.queryByText("DealVehicleColor")).toBeNull();
    expect(screen.queryByText("DealVehicleMileage")).toBeNull();
  });
});
