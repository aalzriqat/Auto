export const JEV_CALIBRATION_CASES = Object.freeze([
  Object.freeze({
    id: "pr285-add-vehicle-wizard",
    prNumber: 285,
    baseSha: "65debcaa5c9132fd175492efcb6a9c0e08ac17f3",
    headSha: "03fbdb2a6240b5c4d3e7dc61a99f1fd90623fab2",
    snapshotAt: "2026-09-06T06:34:32Z",
  }),
  Object.freeze({
    id: "pr309-pricing-copy",
    prNumber: 309,
    baseSha: "a0486e4803dd3ab4f24ecd4f1adfe9cea9db1581",
    headSha: "f18da057dc369595d97d983573552e58cef42b30",
    snapshotAt: "2026-09-14T20:48:50Z",
  }),
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
