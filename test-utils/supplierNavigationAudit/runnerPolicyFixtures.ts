import ts from "typescript";
import { navigationFingerprint } from "./fingerprints";

// Complete helper declarations and fixture constants are reviewed tripwires, not correctness proofs.
export const RUNNER_FINGERPRINTS = [
  {
    "name": "modules",
    "hash": "fd49d3761efc39499490aaa5a2a7417efae346c683e592dbcba7b69a0f9edbae"
  },
  {
    "name": "NOW",
    "hash": "ae6487bd2fc018a526e87de0723ab23b1a3b6b29ed74b7215a83f2c10b642bec"
  },
  {
    "name": "vehicles",
    "hash": "079e9ff58899e99060e5639b0b62da2ab7cb4d0075aa54f82222fda6c0207771"
  },
  {
    "name": "callerAudits",
    "hash": "f6f323808f532e2862a1efa11630e2b7b37718016ca7e0763250b90e8f4099c4"
  },
  {
    "name": "EXPECTED_CALLER_RECEIPTS",
    "hash": "80ed939aead98d553a448216224b4a5155dea9183e87703407c6c608b00e36bc"
  },
  {
    "name": "afterEach",
    "hash": "3c058576479bcf77e7240d4a593a145fa895513122666e2ad2fead0065f5c90e"
  },
  {
    "name": "beginCallerAssertions",
    "hash": "8cb10404fa5732764c2decf4ddabd577cf52913870d4b1af4843bd91f0cf2bcc"
  },
  {
    "name": "verifyCallerAssertions",
    "hash": "85c342b129e5562f334011bb86ad81d5ea7b0435847f54a0719dbcff270ee98f"
  },
  {
    "name": "assertCallerResult",
    "hash": "b75a023dca3d468185de49ff0951e462865b26367380dfb059c3b36f49f25e92"
  },
  {
    "name": "seed",
    "hash": "4aae6a4ddacc3ee94ac3aa45e971d44b101a67ce256d2e2b22cda553d5ebfbc6"
  },
  {
    "name": "payable",
    "hash": "cc86f7c102f970fc3267124ed6be10ac2e8f6bc3ab76d9cbac327d5c5415d25e"
  },
  {
    "name": "outstanding",
    "hash": "187e607517885707f2f75d82610caa9751eda740851de195c0d38c1598b6cfe7"
  },
  {
    "name": "related",
    "hash": "36519e0b06a2feffff90db21d0785818f196a9531ae04f731c8ff4e068805331"
  },
  {
    "name": "financedSale",
    "hash": "b8e67723c77ed07c3552588babf87f8d42cbf0647bbc273c1229423c5f6a7825"
  },
  {
    "name": "seedViewer",
    "hash": "c614ce5a237a74a0c966fa158e458619784ed0f7f6e39c5bec1b05edc70536e8"
  },
  {
    "name": "hideVehicle",
    "hash": "f5e1bd15f686078027132fad39100356f5c502aadb108352af6034a0f30eb384"
  },
  {
    "name": "expectNoVehicleLabel",
    "hash": "3cf43713277ca9dc08b77631ec63ad65b710817d052d716751300c41990c9b99"
  },
  {
    "name": "expectNoVehicle",
    "hash": "8d18975f65619c1262977e31342dec18d2959596c980763f5b05dce9469b7b9b"
  },
  {
    "name": "expectHiddenSale",
    "hash": "c5d4209c948ec7bf06c1696a669882c19a777092c7b2cf6412fe3283c7159cf5"
  },
  {
    "name": "openingFixture",
    "hash": "2c6404c0b0f8436d4e4800ac7d0fb5c6aee5cf3dc74174e57af4ae26c22daebd"
  },
  {
    "name": "expenseVehicleFixture",
    "hash": "1a1b612d1353dfa11e28c6b01577b7d54716a8fe6a6000cd2c18abdd44212dc7"
  },
  {
    "name": "expectHiddenExpenseVehicle",
    "hash": "13d0c81483a62167e78591d22dd0899d3aa26c6da8a305d259802384eb7134c8"
  },
  {
    "name": "expectHiddenNativeVehicle",
    "hash": "34dd0a0ffb3f48f12973e29de9c89fa1231cf5ef49c052f2888da4fc309df22d"
  },
  {
    "name": "expectHiddenSaleVehicle",
    "hash": "a1ebfd3ad76092c3aa79fbfc0704da2440dcc68fe81d58094f6c2661b47f70d9"
  },
  {
    "name": "expectedSaleVehicleCell",
    "hash": "8ecd929f681ba0f510e088cfe57d86923390a021522909a3e2612505e63f197a"
  },
  {
    "name": "expectedNativeVehicleCell",
    "hash": "9b666e39c764d5fcb5202977b6026381cc3a0433b5c02d26643a09df77126096"
  },
  {
    "name": "expectVehicleCell",
    "hash": "22ce7eeb7af53aa41bd3aa1affe815f6693dd5a2cc53cbc09ac936964dc4d339"
  },
  {
    "name": "expectUnpostedOpening",
    "hash": "9362e5f2b232cfc1bcb0212e661e168dab49ef943987f9c2410728bbea6693d4"
  },
  {
    "name": "measureHandler",
    "hash": "71cfcd69ddb61e82545bf7f71018e47f1a05c7583cafa3a1c9018363730452d4"
  },
  {
    "name": "seedReadBound",
    "hash": "8e38490669d485be2ca3efe2e0ffadbfe5e3005b9f8b13b8ecd911a06188d805"
  },
  {
    "name": "settleReadBound",
    "hash": "9a22ebf391d6b45f8a4fc8f16cb26abc859c50dfcabea1d20eb4b70c43785892"
  },
  {
    "name": "NAVIGATION_DEAL_NUMBERS",
    "hash": "ca68692ce425ae728f80f13f5528a0159394628de751bbfd079f955cb08b6fe0"
  },
  {
    "name": "NAVIGATION_PERMISSIONS",
    "hash": "5400cedb24582de79a2b7a751701b9b1c339e5b11579449162413fc39627e7ee"
  },
  {
    "name": "navigationPermissions",
    "hash": "9b5a4da7d1e9eb8f7d283079ad0cab0cca0e861189455292648957b3e29e1ca8"
  },
  {
    "name": "assertNavigationTarget",
    "hash": "ed4fb57643969c47d9452ca0d4eb3d3e9aafb74787ffd3296e5aa2f6311ae35e"
  },
  {
    "name": "navigationTargets",
    "hash": "922f2b5c5bac7f9f6041b6336b8237c30312c35bf8ffeb5eb7754249727b374b"
  },
  {
    "name": "seedNavigationOpening",
    "hash": "f0bf8ea5c97b5f390c69152cb86cfd2e07a2e57691e1e3a53dbb06c7433ebc20"
  },
  {
    "name": "seedNavigationCell",
    "hash": "0278e650f9bb6839311e86ffd51d926f2d6736e9e3869178f1cb7fd99e47b256"
  },
  {
    "name": "readBackNavigationIdentity",
    "hash": "ff554aa94a13fc5275d645228a6a20fed325f8025726430a09fe776f0dba0757"
  },
  {
    "name": "readBackNavigationCell",
    "hash": "7c0bec72f56acc054730c7482b29f2066e82063d7669c748acd3422a369743d6"
  },
  {
    "name": "readBackNavigationDocumentFields",
    "hash": "3b0dfb518ce55ef80d32e7c6da6d42ef8b5935138bd914989030799eae86c392"
  },
  {
    "name": "expectedNavigationOutcome",
    "hash": "f45ed39722c82df0bb81eab819fb48957397b26f7fa49215cfd216b59be26c5f"
  },
  {
    "name": "duplicateNavigationObligation",
    "hash": "941dcb7be57905f58e6d1d14a34b86e0bc6ecee338e640ccd6ecda008e1da4c6"
  },
  {
    "name": "duplicateNavigationPayable",
    "hash": "620a7245f81639a0f08fd5172fd44f4fad61620af083704479f4142013f414b8"
  },
  {
    "name": "duplicateNavigationClaim",
    "hash": "3a60396484b796a564cc96995f5c51b3864df24a06ae1bd46dbd3d89b964ece2"
  },
  {
    "name": "assertPartialRecovery",
    "hash": "8777b9616cd01a38f0a0027374f7a08d4e813a4d278d7686f0552c0048aa93e4"
  },
  {
    "name": "validateRelationshipCell",
    "hash": "fdd67f8b1f7dbb1d19854b89e3e1b928bd60fb887786fdc3933645e6a09ca238"
  },
  {
    "name": "seedRelationshipCell",
    "hash": "12b5cc92b6fdbbeef22cb7930f06fde1da5de9858cae46d3dad0f6a9313cc401"
  },
  {
    "name": "relationshipCells",
    "hash": "ff6dbfd788a7cefbf4f07c3b9d0632e56c499664e792f4b447acc736d270536a"
  },
  {
    "name": "relationshipPagination",
    "hash": "524ab181cf1f07ffc52c73fecc23cda5f281af066d6cc188c9faba06d732c028"
  },
  {
    "name": "duplicateRelationship",
    "hash": "6e80d1760e07840292522eeac7c25505d9e04b4d8be5b3dfb909f88b0d4f622e"
  },
  {
    "name": "prepareNavigationState",
    "hash": "a16b9892167005357236956cb49128a4de34aa1c7888c1fd2b2ad0042473a41d"
  },
  {
    "name": "assertNavigationAmounts",
    "hash": "1a08ef4b88d4369a35741a477e0d40acd9432d3800c0564b529253fe8089ce2b"
  },
  {
    "name": "navigationCell",
    "hash": "1af8e6e811505701617559492e3e48d0b9f8a36288e4207c2efa2e7ece44d12d"
  },
  {
    "name": "navigationCells",
    "hash": "051c5eb140381f49e0a0d8d59c231bd2ca7c60df4a25ec0ee26bf9bc9b79edf0"
  },
  {
    "name": "NAVIGATION_PERMISSION_UNIVERSE",
    "hash": "eb5c666845608358095788cb66694f7ab6a21ec2331db1bd9044bdb230b4cc0e"
  },
  {
    "name": "assertAdditionalReceivable",
    "hash": "fec7b556c8dd1f0fe974d0f0e2e8b925bbc5b6d0b31184853c0a035c6e5069dc"
  },
  {
    "name": "distinctNavigationVehicle",
    "hash": "481109e3dca74af508f122fb6ff41e6be11bf2564ebc10c639ccea3e3add1fee"
  },
  {
    "name": "mixedExpectedSections",
    "hash": "45cca5ed5f2d56f0cb003f383a54c89da6e78cf62dd746fdec4dbc803007c7ef"
  },
  {
    "name": "seedMixedPhase",
    "hash": "21dd30977a883d8b05d569c8a6138803ad9c2126df8e47c994fff1fc7be8c051"
  },
  {
    "name": "assertMixedPhaseReads",
    "hash": "98401dee4cdd262b0fc76a91f0cac8b2e067dcca19b63e2a682dd0a645772ce2"
  },
  {
    "name": "mixedPhaseExpected",
    "hash": "357f94c3b5d164d876d338314459781c74bbfee9e88b87d161d1e9479f9960a2"
  },
  {
    "name": "mixedNavigationPhase",
    "hash": "79b982169106ac0d709a90d04c7aebb9576516532b367e7c5792cb66a515ad43"
  },
  {
    "name": "mixedNavigationCell",
    "hash": "7faaf25211fe1346bfe4d259fe654cc78d355568ad9de97a880fc668a26084de"
  },
  {
    "name": "prepareRelationshipVariation",
    "hash": "191f50a76c800653e71fc6bc7f4c2366d8bce04e00431737ee4c753dc8fb9ff8"
  },
  {
    "name": "crossSectionNavigationCell",
    "hash": "3991c529cc9f78ea8e1aa54796c5e499b31ed3ce76b6d14cc5be2e7637ded6fc"
  },
  {
    "name": "settledFamilyReadBound",
    "hash": "413497cf207a21e3763a05e2dc5da3b9c3e1ead5ea9e5df525d28052e3259786"
  }
];

export const RUNNER_IMPORTS = [
  "b1a5edf634bcc077ef81fdb1587e535896ad62843795de051344e2bae784913c",
  "29f52adfb5477df879b7daf0ebb54ac1d11b20d3a878ba41748f99929f5cc349",
  "56d37a548acb0ca09ce17a1fe75979aa6621e08e4765d7c1d5691e8bf2571fce",
  "1d24588be79419701477735ebf1a15265811f40fbcf64f989fd87bbf3a32428f",
  "801101403874f89a4fb73e5218cfba4663adebde5809f5f260da52b010aadf8a",
  "bc79507e1407facfbd1d26c71d764480a4d79f5b562c4c9234d8d64601a16ea7",
  "2e51ef393b8a135f438084288ba83ebc31b6f0e78e4e06c8726fbe5598635a0e",
  "9cda4ea18978108f13502324effd434f59c3bae61699907d9c403f0d0c4bb47b",
  "7bc02c75159560963e6c480d3908f59f28c8f4acd7e9103254113fa66469c4a7",
  "f041614ce768aa271376dd4353d815be0e7fd58e9f3e68b8f34c3922fb87246a",
  "c8212891ce9be0db845562d22e4ac6547b511081894b088ba8c43c31bb04a6f2"
];

export const RUNNER_TYPES = [
  {
    "name": "CallerAudit",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "Seed",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "TargetPermission",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "HiddenState",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "NavigationCell",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "NavigationOutcome",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "NavigationLabel",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "NavigationTarget",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "NavigationFixture",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "RelationshipKind",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "RelationshipCondition",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "RelationshipBase",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "RelationshipCell",
    "kind": "TypeAliasDeclaration"
  }
];

export const READ_BOUND_FIXTURE_HOOKS: readonly { group: string; hash: string }[] = [
  {
    "group": "distinct outstanding read fixture",
    "hash": "91a40e38ed4d8e77531a8cef469c55b5036cb617aa58787964a05a972babdd2b"
  },
  {
    "group": "distinct settled read fixture",
    "hash": "1ef49284bfaff83124585767666ed5b6be188cda709c693a2c8a4ba35efa6546"
  },
  {
    "group": "distinct settled read fixture",
    "hash": "db90f7b6708d3a54bb5cc6a8179b501d4e1c8d4418123383fb7ad802fdf90416"
  }
];

export function reviewedRunnerFixtureHook(source: ts.SourceFile, node: ts.Node): boolean {
  const statement = node.parent;
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "beforeAll" ||
    !statement || !ts.isExpressionStatement(statement)) return false;
  const group = ts.findAncestor(node, ancestor => ts.isCallExpression(ancestor) && ancestor.expression.getText(source) === "describe");
  const title = group && ts.isCallExpression(group) ? group.arguments[0] : undefined;
  return !!title && ts.isStringLiteral(title) && READ_BOUND_FIXTURE_HOOKS.some(pin =>
    title.text === pin.group && navigationFingerprint(statement, source) === pin.hash);
}
