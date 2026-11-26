/**
 * The reviewed postimages.
 *
 * ⚠️ These are computed from the approved files themselves. Do not copy them
 * from a report, a Jira comment or a chat message — a truncated or restated
 * digest pins nothing.
 */
// For past renewals, see docs/architecture/protected-source-pin-renewal-history.md.
export const PINS = [
  {
    file: "convex/applications.ts",
    bytes: 22782,
    sha256: "47c6675ef3b7afd792136a5a2707a69c900f427dfbd65ae56d46bed9425d702b",
  },
  {
    file: "convex/domains/deal/applicationReads.ts",
    bytes: 13629,
    sha256: "db860d569f72310e31f7a4c15b2cacc5ccde0dab001b9da6bc48f7a41f4ebdd2",
  },
  {
    file: "convex/domains/deal/applicationStatus.ts",
    bytes: 15216,
    sha256: "507e125e33c2b0dd7174735fe3deaf4c3f2d472b35cfed21f312dfad2e3d9672",
  },
  {
    file: "convex/domains/deal/cancellation.ts",
    bytes: 13265,
    sha256: "d433b9d1ffd72a0b7c41a0aefb0dc72b3bf7b4b5e8d7a4a0bb2e50ecb3052ff8",
  },
  {
    file: "convex/domains/deal/cancellationTeardown.ts",
    bytes: 16120,
    sha256: "b2b04b27e1d76132935555ca0c52b6d3677e2826790f8d04ee137716f4520cb2",
  },
  {
    file: "convex/domains/deal/closingReadiness.ts",
    bytes: 9710,
    sha256: "4693b7dbe010986f663a776c4f5485222bf20d37559842521a5a81db052cbe0c",
  },
  {
    file: "convex/domains/deal/cockpitMoney.ts",
    bytes: 23826,
    sha256: "83e24248fc545e782aa7e7771868a6db499d018f156d2e95824e031e07880575",
  },
  {
    file: "convex/domains/deal/cockpitProjection.ts",
    bytes: 20966,
    sha256: "57925a69382caa59c062a2fab7677744c5e766f9c271db857544859215c4c845",
  },
  {
    file: "convex/domains/deal/cockpitSettlement.ts",
    bytes: 18993,
    sha256: "f36c40b67fed7eb26c1f736971a1ef4d294118259a1a618c7196a726e8f5836c",
  },
  {
    file: "convex/domains/deal/cockpitWorkflow.ts",
    bytes: 6606,
    sha256: "52450397fa36c42ac37c885dd791745d2eef4243d6f314faaed1e1bbaeac19a9",
  },
  {
    file: "convex/domains/deal/dealDeposits.ts",
    bytes: 1854,
    sha256: "c3a3cd3bf5892124b22cc7985fc882c0edd466932c3767e5308e57e43e63ec1d",
  },
  {
    file: "convex/domains/deal/expectedPayment.ts",
    bytes: 13730,
    sha256: "9f570d0ea2e5f76dfa005b1eee8d85018fd282ba5b8c3c97d9bc93a6981082a1",
  },
  {
    file: "convex/domains/deal/finalizationPosting.ts",
    bytes: 9194,
    sha256: "57cb151478c4a4a9640f512e72bf1d791e98adfe7a85e130d3bfc5a167fcd19b",
  },
  {
    file: "convex/domains/deal/finalizeDeal.ts",
    bytes: 22905,
    sha256: "da4ba4dca57ef3fbec5af553a5c6cde519c5b2b6782085771563d503cde3dd96",
  },
  {
    file: "convex/domains/deal/financeReceipt.ts",
    bytes: 16885,
    sha256: "47b990fba7f2c4232d98c85c3686dbb2cabddaf18b4a802bfe1cc165fbe17cfd",
  },
  {
    file: "convex/domains/deal/financeReceivables.ts",
    bytes: 10124,
    sha256: "a5bcfff0162b5fbf25b18d92c1d4cbea003d347141441bcd59738722a5bf8278",
  },
  {
    file: "convex/domains/deal/financeReturn.ts",
    bytes: 10358,
    sha256: "cd64ae0e101f52ac17ab62cc12aa0e7866e899fca90adf4dae5c84cc24593859",
  },
  {
    file: "convex/domains/deal/handover.ts",
    bytes: 12639,
    sha256: "862a78f4caff57e94c9bf34b62c511c93f302bf1148e66df2f61b4a5c1244c18",
  },
  {
    file: "convex/domains/deal/index.ts",
    bytes: 2308,
    sha256: "bee61dcc2727c68ae1fd2b98aa8068b5f56ba88f2562ffffd71046d18be9266e",
  },
  {
    file: "convex/domains/deal/quoteIntake.ts",
    bytes: 21647,
    sha256: "38967afa63dadbaa8f8a23bff046633c253baca69c318045cff97bcbe3b2a737",
  },
  {
    file: "convex/domains/deal/settlementRouting.ts",
    bytes: 16665,
    sha256: "908afc953eeced135c132f7dff3b766914e4249945d582c51c2cd11ceb41e14a",
  },
  {
    file: "convex/domains/deal/supplierAdvice.ts",
    bytes: 26577,
    sha256: "acd95e434e84274284f1559a5874ae1c6495d8c5ada92a4ac81b7ffd67c4a500",
  },
  {
    file: "convex/utils/receivableDocumentWriter.ts",
    bytes: 3609,
    sha256: "fc845a57d7c198565a7a2864a097dc914621e3ad93a1694a61c969d7251b2648",
  },
  {
    file: "convex/dealWorkspace.ts",
    bytes: 10142,
    sha256: "9b3110fb3e3d79b783c09acb18bd9c7b9fdc060edc0385b4561cc501324d4ce1",
  },
  {
    file: "convex/utils/dealSettlementFigures.ts",
    bytes: 18814,
    sha256: "02fc4aaa0ab2c6d134c962b0662e5553cfeb729ad83d1e7dc287761528abd11f",
  },
] as const;
