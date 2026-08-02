/// <reference types="jest" />

import { type MobileLeadStage } from "../../../convexApi";
import {
  LEAD_STAGES,
  OPEN_LEAD_STAGES,
  TERMINAL_LEAD_STAGES,
  commitLeadStageChange,
  isTerminalLeadStage,
  leadStageConfirmation,
  leadStageDirection,
  leadStageErrorMessage,
  leadStageIndex,
  leadStageLabel,
} from "./leadStage";

function makeDeps(applyStage: (stage: MobileLeadStage) => Promise<unknown>) {
  const optimistic: Array<MobileLeadStage | null> = [];
  const onError = jest.fn();
  return {
    onError,
    optimistic,
    deps: {
      applyStage,
      onError,
      setOptimisticStage: (stage: MobileLeadStage | null) => {
        optimistic.push(stage);
      },
    },
  };
}

describe("lead stage table", () => {
  test("offers every backend stage exactly once, open stages before terminal ones", () => {
    const backendStages: MobileLeadStage[] = [
      "NEW",
      "CONTACTED",
      "INTERESTED",
      "TEST_DRIVE",
      "NEGOTIATION",
      "RESERVED",
      "WON",
      "LOST",
    ];

    expect([...LEAD_STAGES].sort()).toEqual([...backendStages].sort());
    expect(new Set(LEAD_STAGES).size).toBe(LEAD_STAGES.length);
    expect(LEAD_STAGES.slice(0, OPEN_LEAD_STAGES.length)).toEqual([...OPEN_LEAD_STAGES]);
    expect(LEAD_STAGES.slice(OPEN_LEAD_STAGES.length)).toEqual([...TERMINAL_LEAD_STAGES]);
  });

  test("every stage has a distinct label in both locales", () => {
    for (const locale of ["en", "ar"] as const) {
      const labels = LEAD_STAGES.map((stage) => leadStageLabel(stage, locale));
      expect(new Set(labels).size).toBe(LEAD_STAGES.length);
      for (const label of labels) {
        expect(label.trim().length).toBeGreaterThan(0);
        // A raw enum key leaking into the UI is the bug this table exists to
        // prevent, so assert no label is just the key.
        expect(LEAD_STAGES).not.toContain(label);
      }
    }
  });

  test("falls back to the raw key for a stage mobile does not know yet", () => {
    const unknown = "ESCALATED" as MobileLeadStage;
    expect(leadStageLabel(unknown, "en")).toBe("ESCALATED");
    expect(leadStageIndex(unknown)).toBe(-1);
  });

  test("classifies only WON and LOST as terminal", () => {
    expect(isTerminalLeadStage("WON")).toBe(true);
    expect(isTerminalLeadStage("LOST")).toBe(true);
    for (const stage of OPEN_LEAD_STAGES) {
      expect(isTerminalLeadStage(stage)).toBe(false);
    }
  });
});

describe("leadStageDirection", () => {
  test("reports forward, backward and same", () => {
    expect(leadStageDirection("NEW", "NEGOTIATION")).toBe("forward");
    expect(leadStageDirection("NEGOTIATION", "NEW")).toBe("backward");
    expect(leadStageDirection("NEW", "NEW")).toBe("same");
  });

  test("treats an unknown stage on either side as same rather than guessing", () => {
    const unknown = "ESCALATED" as MobileLeadStage;
    expect(leadStageDirection(unknown, "NEW")).toBe("same");
    expect(leadStageDirection("NEW", unknown)).toBe("same");
  });
});

describe("leadStageConfirmation", () => {
  test("returns null for routine moves so they apply on a single tap", () => {
    for (const stage of OPEN_LEAD_STAGES) {
      expect(leadStageConfirmation(stage, "en")).toBeNull();
      expect(leadStageConfirmation(stage, "ar")).toBeNull();
    }
  });

  test("confirms both terminal stages in both locales", () => {
    for (const stage of TERMINAL_LEAD_STAGES) {
      for (const locale of ["en", "ar"] as const) {
        const confirmation = leadStageConfirmation(stage, locale);
        expect(confirmation).not.toBeNull();
        expect(confirmation?.title).toContain(leadStageLabel(stage, locale));
        expect(confirmation?.body.trim().length).toBeGreaterThan(0);
        expect(confirmation?.cancelLabel.trim().length).toBeGreaterThan(0);
        expect(confirmation?.confirmLabel).toContain(leadStageLabel(stage, locale));
      }
    }
  });

  test("marks only LOST as destructive", () => {
    expect(leadStageConfirmation("LOST", "en")?.destructive).toBe(true);
    expect(leadStageConfirmation("WON", "en")?.destructive).toBe(false);
  });
});

describe("leadStageErrorMessage", () => {
  test("surfaces a string ConvexError payload", () => {
    expect(leadStageErrorMessage({ data: "  Lead not found in this organization.  " }, "fallback")).toBe(
      "Lead not found in this organization.",
    );
  });

  test("surfaces a structured ConvexError payload", () => {
    expect(leadStageErrorMessage({ data: { message: "Not allowed." } }, "fallback")).toBe("Not allowed.");
  });

  test("never leaks a raw runtime error and falls back instead", () => {
    const raw = new Error("TypeError: cannot read property 'orgId' of undefined");
    expect(leadStageErrorMessage(raw, "fallback")).toBe("fallback");
    expect(leadStageErrorMessage(null, "fallback")).toBe("fallback");
    expect(leadStageErrorMessage(undefined, "fallback")).toBe("fallback");
    expect(leadStageErrorMessage({ data: "   " }, "fallback")).toBe("fallback");
    expect(leadStageErrorMessage({ data: { message: 42 } }, "fallback")).toBe("fallback");
    expect(leadStageErrorMessage({ data: 42 }, "fallback")).toBe("fallback");
  });
});

describe("commitLeadStageChange", () => {
  test("writes nothing when the chosen stage is the current one", async () => {
    const applyStage = jest.fn(async () => undefined);
    const { deps, onError, optimistic } = makeDeps(applyStage);

    await expect(commitLeadStageChange("NEW", "NEW", deps)).resolves.toBe("unchanged");

    expect(applyStage).not.toHaveBeenCalled();
    expect(optimistic).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  test("paints the target stage before the write and hands over to the server after", async () => {
    const seenWhileInFlight: Array<MobileLeadStage | null> = [];
    const { deps, onError, optimistic } = makeDeps(async () => {
      seenWhileInFlight.push(...optimistic);
      return undefined;
    });

    await expect(commitLeadStageChange("NEW", "NEGOTIATION", deps)).resolves.toBe("committed");

    // Optimistic value is visible for the whole duration of the write...
    expect(seenWhileInFlight).toEqual(["NEGOTIATION"]);
    // ...then cleared so the reactive query value takes over.
    expect(optimistic).toEqual(["NEGOTIATION", null]);
    expect(onError).not.toHaveBeenCalled();
  });

  test("rolls the optimistic stage back when the server rejects the write", async () => {
    const rejection = { data: "Lead not found in this organization." };
    const { deps, onError, optimistic } = makeDeps(async () => {
      throw rejection;
    });

    await expect(commitLeadStageChange("NEW", "WON", deps)).resolves.toBe("failed");

    // The rollback: the optimistic stage is cleared, so the UI falls back to
    // the server's stage and never keeps showing the rejected one.
    expect(optimistic).toEqual(["WON", null]);
    expect(optimistic[optimistic.length - 1]).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(rejection);
    expect(leadStageErrorMessage(rejection, "fallback")).toBe("Lead not found in this organization.");
  });

  test("rolls back on a synchronous throw as well as a rejected promise", async () => {
    const boom = new Error("network down");
    const { deps, onError, optimistic } = makeDeps(() => {
      throw boom;
    });

    await expect(commitLeadStageChange("RESERVED", "LOST", deps)).resolves.toBe("failed");

    expect(optimistic).toEqual(["LOST", null]);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  test("supports moving backwards, which the replaced Advance button could not do", async () => {
    const applyStage = jest.fn(async () => undefined);
    const { deps } = makeDeps(applyStage);

    await expect(commitLeadStageChange("WON", "CONTACTED", deps)).resolves.toBe("committed");

    expect(applyStage).toHaveBeenCalledWith("CONTACTED");
  });
});
