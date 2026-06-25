import { expect, test, describe } from "vitest";
import { Id } from "../_generated/dataModel";
import { matchVehicleFromText, suggestVehiclesFromText } from "./vehicleTextMatch";

function vehicle(
  id: string,
  overrides: Partial<{
    year: number;
    make: string;
    model: string;
    trim: string;
    vin: string;
    isDeleted: boolean;
  }> = {}
) {
  return {
    _id: id as Id<"vehicles">,
    year: 2025,
    make: "BYD",
    model: "Song Pro",
    trim: "Zero",
    vin: "1HGCM82633A004352",
    ...overrides,
  };
}

describe("matchVehicleFromText", () => {
  test("matches a vehicle from a concatenated make-model-year hashtag", () => {
    const songPro = vehicle("vehicle_song_pro");
    const qin = vehicle("vehicle_qin", { model: "Qin L", trim: undefined });

    expect(matchVehicleFromText("Interested in #BYDSongPro2025", [songPro, qin])).toBe(songPro._id);
  });

  test("matches caption text that uses Arabic-Indic digits for the year", () => {
    const songPro = vehicle("vehicle_song_pro");

    expect(matchVehicleFromText("#byd SONG PRO ZERO ٢٠٢٥", [songPro])).toBe(songPro._id);
  });

  test("does not auto-match a weak make-only hashtag", () => {
    const songPro = vehicle("vehicle_song_pro");

    expect(matchVehicleFromText("#BYD", [songPro])).toBeUndefined();
  });

  test("does not auto-match a model-only hashtag", () => {
    const songPro = vehicle("vehicle_song_pro");

    expect(matchVehicleFromText("#SongPro", [songPro])).toBeUndefined();
  });

  test("does not auto-match an internal id-like hashtag", () => {
    const songPro = vehicle("vehicle_song_pro");

    expect(matchVehicleFromText("#vehicle_song_pro", [songPro])).toBeUndefined();
  });

  test("does not auto-match when multiple vehicles share the same details", () => {
    const firstSongPro = vehicle("vehicle_song_pro_1");
    const secondSongPro = vehicle("vehicle_song_pro_2", { vin: "1HGCM82633A004353" });

    expect(matchVehicleFromText("#BYDSongPro2025", [firstSongPro, secondSongPro])).toBeUndefined();
  });

  test("suggests candidate vehicles from partial make-model details", () => {
    const songPro2025 = vehicle("vehicle_song_pro_2025");
    const songPro2024 = vehicle("vehicle_song_pro_2024", { year: 2024, vin: "1HGCM82633A004353" });
    const qin = vehicle("vehicle_qin", { model: "Qin L", trim: undefined, vin: "1HGCM82633A004354" });

    const suggestions = suggestVehiclesFromText("#byd SONG PRO", [songPro2025, songPro2024, qin]);

    expect(suggestions.map((suggestion) => suggestion.vehicleId)).toEqual([songPro2025._id, songPro2024._id]);
    expect(suggestions[0].matchedDetails).toContain("BYD");
    expect(suggestions[0].matchedDetails).toContain("Song Pro");
    expect(suggestions[0].missingDetails).toContain("year");
  });
});
