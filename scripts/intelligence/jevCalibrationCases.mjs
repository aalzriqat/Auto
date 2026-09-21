export const JEV_CALIBRATION_CASES = Object.freeze([
  Object.freeze({
    id: "pr319-pre-first-review",
    prNumber: 319,
    baseSha: "ee86c4703891aa7c246ee54ed06fccff331a7562",
    headSha: "2aab6f0af2f8cd7114513d01488e26252581b7a3",
    snapshotAt: "2026-09-20T00:16:27Z",
  }),
  Object.freeze({
    id: "pr321-pre-governance-review",
    prNumber: 321,
    baseSha: "ee86c4703891aa7c246ee54ed06fccff331a7562",
    headSha: "be0456357dc9efbcf22ff42fdfb450d5f02346f3",
    snapshotAt: "2026-09-20T21:46:55Z",
  }),
]);

export function calibrationCaseById(id) {
  return JEV_CALIBRATION_CASES.find((entry) => entry.id === id);
}
