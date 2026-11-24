// @vitest-environment node
import { describe, expect, it } from "vitest";
import { github, load, publishInput, recordIdOf, success, swarm, type Rec } from "./trustedPrE2eGateHub";


// SCRUM-990: one admission invocation published initialize then finish about
// 2 s apart; the commit listing had not caught up, so finish POSTed a second
// record and every later begin quarantined the head.
describe("SCRUM-990 own-record continuity", () => {
  const failure = { conclusion: "failure", reason: "preflight did not succeed" };

  it("updates the record this invocation created even when the listing lags", async () => {
    const hub = github();
    hub.lagNextPosts(1);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    expect(first.outcome).toBe("written");
    const second = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: failure,
      ownRecordId: recordIdOf(first),
    });
    expect(second.outcome).toBe("written");
    expect(hub.records).toHaveLength(1);
    expect(hub.records[0].conclusion).toBe("failure");
    expect(hub.records[0].output?.title).toBe(failure.reason);
    expect(hub.writes()).toEqual(["POST /check-runs", "PATCH /check-runs/9"]);
  });

  it("updates the record normally when the listing has caught up and own id is passed", async () => {
    const hub = github();
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    const second = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success, ownRecordId: recordIdOf(first),
    });
    expect(second.outcome).toBe("written");
    expect(hub.records).toHaveLength(1);
    expect(hub.records[0].conclusion).toBe("success");
    expect(hub.writes()).toEqual(["POST /check-runs", "PATCH /check-runs/9"]);
  });

  // Round 2 (both review seats): listing lag plus an own-record read that also
  // fails must never fall through to a second POST.
  const noSleep = { sleep: async () => {}, confirmDelaysMs: [1000, 2000] };
  it.each([
    ["a 5xx or timeout", 99],
    ["a 404 lag that outlasts every attempt", 3],
  ])("refuses with no second POST when the listing lags and GET by id fails (%s)", async (_label, failures) => {
    const hub = github();
    hub.lagNextPosts(100);
    hub.failGetById(failures);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    const ownId = recordIdOf(first);
    expect(ownId).toBe(9);
    const delays: number[] = [];
    const second = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success, ownRecordId: ownId,
      sleep: async (ms: number) => { delays.push(ms); }, confirmDelaysMs: [1000, 2000],
    });
    expect(second.outcome).toBe("unconfirmed");
    expect(hub.writes()).toEqual(["POST /check-runs"]);
    expect(hub.records).toHaveLength(1);
    expect(hub.records[0].conclusion).toBe("failure");
    expect(delays).toEqual([1000, 2000]);
  });

  it("confirms by id after a transient GET failure and updates without a second POST", async () => {
    const hub = github();
    hub.lagNextPosts(100);
    hub.failGetById(1);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    const second = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: failure, ownRecordId: recordIdOf(first), ...noSleep,
    });
    expect(second.outcome).toBe("written");
    expect(hub.writes()).toEqual(["POST /check-runs", "PATCH /check-runs/9"]);
    expect(hub.records).toHaveLength(1);
  });

  it("confirms through a later listing when GET by id keeps failing", async () => {
    const hub = github();
    hub.lagNextPosts(3); // hidden from the initial listing and the first two re-lists
    hub.failGetById(99);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    const second = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: failure, ownRecordId: recordIdOf(first), ...noSleep,
    });
    expect(second.outcome).toBe("written");
    expect(hub.writes()).toEqual(["POST /check-runs", "PATCH /check-runs/9"]);
    expect(hub.records).toHaveLength(1);
  });

  it("still quarantines a really existing second record even when ownRecordId is passed", async () => {
    const hub = github();
    hub.lagNextPosts(1);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    hub.insert({}, swarm(300)); // created by someone else in between
    const second = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success, ownRecordId: recordIdOf(first),
    });
    expect(second.outcome).toBe("quarantined");
    expect(hub.records).toHaveLength(2);
    expect(hub.records.map((record) => record.conclusion)).toEqual(["failure", "failure"]);
  });

  it.each([
    ["a foreign-app record", { app: { slug: "other-app" } }],
    ["a differently named record", { name: "something-else" }],
    ["a record for another head", { head_sha: "f".repeat(40) }],
  ])("refuses with zero writes when ownRecordId points to %s", async (_label, overrides) => {
    const hub = github();
    const foreign = hub.insert(overrides, undefined);
    hub.hide(foreign, 5);
    const before = structuredClone(foreign);
    const result = await (await load()).publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success,
      ownRecordId: foreign.id as number, ...noSleep,
    });
    expect(result.outcome).toBe("unconfirmed");
    expect(hub.writes()).toEqual([]);
    expect(foreign).toEqual(before);
    expect(hub.records).toHaveLength(1);
  });

  it("refuses with zero writes when GET by id answers with a different id", async () => {
    const hub = github();
    hub.lagNextPosts(100);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    hub.answerGetWith({ ...(hub.records[0] as Rec), id: 7777 });
    const second = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success, ownRecordId: recordIdOf(first), ...noSleep,
    });
    expect(second.outcome).toBe("unconfirmed");
    expect(hub.writes()).toEqual(["POST /check-runs"]);
  });

  it("refuses with zero writes when ownRecordId cannot be read at all", async () => {
    const hub = github();
    const result = await (await load()).publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success, ownRecordId: 424242, ...noSleep,
    });
    expect(result.outcome).toBe("unconfirmed");
    expect(hub.writes()).toEqual([]);
    expect(hub.records).toHaveLength(0);
  });

  it("recovers after a refusal: a fresh initialize on the same head ends with one record", async () => {
    const hub = github();
    hub.lagNextPosts(100);
    hub.failGetById(99);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    const refused = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success, ownRecordId: recordIdOf(first), ...noSleep,
    });
    expect(refused.outcome).toBe("unconfirmed");
    expect(hub.records).toHaveLength(1);
    expect(hub.records[0].conclusion).toBe("failure");
    // The listing catches up; the rerun has no ownRecordId.
    hub.clearLag();
    const rerun = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100, 2), mode: "initialize" });
    expect(rerun.outcome).toBe("written");
    expect(hub.records).toHaveLength(1);
    expect(hub.records[0].conclusion).toBe("failure");
    expect(hub.writes().filter((call) => call === "POST /check-runs")).toHaveLength(1);
  });

  it("recovers after a refusal: a rerun with a NEW runKey PATCHes the one record in both publications", async () => {
    const hub = github();
    hub.lagNextPosts(100);
    hub.failGetById(99);
    const gate = await load();
    const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
    const refused = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100), mode: "finish", verdict: success, ownRecordId: recordIdOf(first), ...noSleep,
    });
    expect(refused.outcome).toBe("unconfirmed");
    hub.clearLag();
    hub.failGetById(0);
    const rerun = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100, 2), mode: "initialize" });
    expect(rerun.outcome).toBe("written");
    const final = await gate.publishPrE2eCheck(hub.api, {
      ...publishInput(100, 2), mode: "finish", verdict: failure, ownRecordId: recordIdOf(rerun),
    });
    expect(final.outcome).toBe("written");
    expect(hub.records).toHaveLength(1);
    expect(hub.records[0].external_id).toBe("g5:42:100:2");
    expect(hub.writes()).toEqual(["POST /check-runs", "PATCH /check-runs/9", "PATCH /check-runs/9"]);
  });

  // Round 3: every distinct same-name record observed anywhere in the
  // publication (initial listing, any re-list, a read by id) is counted once.
  describe("duplicates observed across different reads", () => {
    async function ownAndOther() {
      const hub = github();
      hub.lagNextPosts(100);
      const gate = await load();
      const first = await gate.publishPrE2eCheck(hub.api, { ...publishInput(100), mode: "initialize" });
      const other = hub.insert({}, swarm(300));
      return { hub, gate, own: recordIdOf(first), other: other.id as number };
    }
    const finishWith = (gate: Awaited<ReturnType<typeof load>>, hub: ReturnType<typeof github>, own: number) =>
      gate.publishPrE2eCheck(hub.api, {
        ...publishInput(100), mode: "finish", verdict: success, ownRecordId: own, ...noSleep,
      });

    it("quarantines when the initial list is empty, GET fails, a re-list shows only the other record, then GET confirms", async () => {
      const { hub, gate, own, other } = await ownAndOther();
      hub.scriptListings([], [other]);
      hub.failGetById(1);
      const result = await finishWith(gate, hub, own);
      expect(result.outcome).toBe("quarantined");
      expect(hub.records.map((record) => record.conclusion)).toEqual(["failure", "failure"]);
      expect(hub.writes().filter((call) => call.startsWith("POST"))).toHaveLength(1);
    });

    it("quarantines when the initial list shows only the other record and a later re-list shows only the own record", async () => {
      const { hub, gate, own, other } = await ownAndOther();
      hub.scriptListings([other], [own]);
      hub.failGetById(1);
      const result = await finishWith(gate, hub, own);
      expect(result.outcome).toBe("quarantined");
      expect(hub.records.map((record) => record.conclusion)).toEqual(["failure", "failure"]);
    });

    it("quarantines when a re-list shows both records together", async () => {
      const { hub, gate, own, other } = await ownAndOther();
      hub.scriptListings([], [own, other]);
      hub.failGetById(1);
      const result = await finishWith(gate, hub, own);
      expect(result.outcome).toBe("quarantined");
      expect(hub.records.map((record) => record.conclusion)).toEqual(["failure", "failure"]);
    });

    it("counts a record seen in several observations once", async () => {
      const { hub, gate, own, other } = await ownAndOther();
      hub.scriptListings([other], [other], [other]);
      hub.failGetById(2);
      const result = await finishWith(gate, hub, own);
      expect(result.outcome).toBe("quarantined");
      // The own record is already failed; the other is revoked once, not once
      // per observation (each listing hands back a fresh copy, as GitHub does).
      expect(hub.writes()).toEqual(["POST /check-runs", `PATCH /check-runs/${other}`]);
    });

    it("still writes when only the own record is ever observed, however often", async () => {
      const { hub, gate, own } = await ownAndOther();
      hub.records.pop(); // the other record never existed
      hub.scriptListings([], [own]);
      hub.failGetById(1);
      const result = await finishWith(gate, hub, own);
      expect(result.outcome).toBe("written");
      expect(hub.writes()).toEqual(["POST /check-runs", `PATCH /check-runs/${own}`]);
    });

    // Round 4: confirmation never decides on an incomplete observation.
    it("refuses when a later page of a re-list throws, even if the next read by id confirms", async () => {
      const { hub, gate, own, other } = await ownAndOther();
      const foreignIds = Array.from({ length: 99 }, () => hub.insert({ app: { slug: "other-app" } }, undefined).id as number);
      hub.scriptListings([], [other, ...foreignIds]);
      hub.failGetById(1);
      hub.failListingPage(2, 1);
      const result = await finishWith(gate, hub, own);
      expect(result.outcome).toBe("unconfirmed");
      expect(hub.writes()).toEqual(["POST /check-runs"]);
      expect(hub.records.find((record) => record.id === other)?.conclusion).toBe("success");
    });

    it("refuses when the first page of a re-list throws", async () => {
      const { hub, gate, own } = await ownAndOther();
      hub.failGetById(1);
      hub.scriptListings([]);
      hub.failListingPage(1, 1, 1); // pass the initial listing, fail the re-list
      const result = await finishWith(gate, hub, own);
      expect(result.outcome).toBe("unconfirmed");
      expect(hub.writes()).toEqual(["POST /check-runs"]);
    });

    it("still confirms after a GET failure followed by a complete re-list", async () => {
      const { hub, gate, own } = await ownAndOther();
      hub.records.pop(); // no other record
      hub.scriptListings([], [own]);
      hub.failGetById(1);
      const result = await finishWith(gate, hub, own);
      expect(result.outcome).toBe("written");
      expect(hub.writes()).toEqual(["POST /check-runs", `PATCH /check-runs/${own}`]);
    });

    it("refuses an anomaly immediately: one read by id, no sleep, no re-list", async () => {
      const hub = github();
      const foreign = hub.insert({ app: { slug: "other-app" } }, undefined);
      hub.hide(foreign, 5);
      const gate = await load();
      const before = hub.calls.length;
      let sleeps = 0;
      const result = await gate.publishPrE2eCheck(hub.api, {
        ...publishInput(100), mode: "finish", verdict: success, ownRecordId: foreign.id as number,
        sleep: async () => { sleeps++; }, confirmDelaysMs: [1000, 2000],
      });
      expect(result.outcome).toBe("unconfirmed");
      expect(sleeps).toBe(0);
      expect(hub.calls.slice(before).map((call) => call.split("/").slice(0, 2).join("/"))).toEqual([
        "GET /commits", "GET /check-runs",
      ]);
    });
  });
});
