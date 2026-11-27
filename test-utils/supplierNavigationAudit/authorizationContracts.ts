export const AUTH_HELPER_CONTRACTS: readonly { file: string; name: string; hash: string; killRows: readonly string[] }[] = [
  {
    "file": "convex/utils/tenancy.ts",
    "name": "requireTenantAuth",
    "hash": "dda8e0f54a12b1104dfd810a9f14c63f655fa3fbc4835c1f4d061dc52f3e52e9",
    "killRows": [
      "ordinary",
      "empty-required"
    ]
  },
  {
    "file": "convex/utils/tenancy.ts",
    "name": "requireAuth",
    "hash": "4a23d5e2e4cbeb99b1d1745ee3cc7db0ad6b1c5e2e2272f539e676cce382413e",
    "killRows": [
      "ordinary-query",
      "no-identity-query",
      "missing-user-query",
      "disabled-user-query",
      "disabled-user-mutation"
    ]
  },
  {
    "file": "convex/utils/errors.ts",
    "name": "throwAppError",
    "hash": "f569f7c702d5539bbddef83bb0e1bc47920f867e6671520cf7a6651df50cac63",
    "killRows": [
      "disabled-user-query",
      "missing-user-query"
    ]
  },
  {
    "file": "convex/utils/permissions.ts",
    "name": "isSystemOwnerRole",
    "hash": "4a00524573bbe24dbbe562cddf1582d5161383f03573a54bac3242cb4a7821fc",
    "killRows": [
      "legacy-full",
      "false-full",
      "deleted-flagged"
    ]
  },
  {
    "file": "convex/utils/permissions.ts",
    "name": "holdsTheFrozenOwnerSet",
    "hash": "4be0c7835b3d0ed33087fed48bac1fdcf8fea8a32d5dd8af1b67a16e16f7e303",
    "killRows": [
      "legacy-full",
      "legacy-duplicate"
    ]
  },
  {
    "file": "convex/utils/tenancy.ts",
    "name": "enforceImpersonationGrant",
    "hash": "f9996eb8d69ef8134916dcbcbf113974e3dc9fe4b47be6d176f82f43ca1c6d66",
    "killRows": [
      "missing-query",
      "revoked-query",
      "boundary-mutation",
      "live-mutation"
    ]
  },
  {
    "file": "convex/utils/tenancy.ts",
    "name": "isMutationCtx",
    "hash": "44479e4535580cf90a356c1edcbccafedf2f4aa113e3818d4e0955346404f942",
    "killRows": [
      "live-query",
      "live-mutation"
    ]
  },
  {
    "file": "convex/utils/auditLog.ts",
    "name": "writeAuditLog",
    "hash": "caa90bed8944c20c0163ca86920fd0f7363cbb8d8a22ed39be06491743086795",
    "killRows": [
      "live-query",
      "live-mutation",
      "empty-audit-label"
    ]
  },
  {
    "file": "convex/utils/tenancy.ts",
    "name": "requireOwnedRow",
    "hash": "9f0dd1a5adcef54418a6e468157879bfc2184ef7c78fd5878213d4e0bad0f52f",
    "killRows": [
      "local-supplier",
      "missing-supplier",
      "foreign-supplier"
    ]
  },
  {
    "file": "convex/subscriptions.ts",
    "name": "requireFeature",
    "hash": "9e2746d9de23fbbadc80299b697729b9ab8f3dfa980388a27d874568b0cf7017",
    "killRows": [
      "enterprise-plan",
      "free-plan"
    ]
  },
  {
    "file": "convex/utils/subscriptionFeatures.ts",
    "name": "requirePlanFeature",
    "hash": "bbc495be4417271570180a29a0e6b9e8f748486c0ead4192d65507052a5d93ef",
    "killRows": [
      "enterprise-plan",
      "free-plan"
    ]
  },
  {
    "file": "convex/utils/subscriptionFeatures.ts",
    "name": "hasPlanFeature",
    "hash": "aacb0d0f516afea65afe5463392649818f819bb954ca6565a6bd0cde0d1bd4ad",
    "killRows": [
      "enterprise-plan",
      "free-plan"
    ]
  },
  {
    "file": "convex/utils/subscriptionFeatures.ts",
    "name": "getOrgPlan",
    "hash": "c7362c04f0c4abaae34f9d74087ad14d4a2b8397a29469500a19d7b744f619dc",
    "killRows": [
      "enterprise-plan",
      "no-subscription",
      "expired-plan"
    ]
  }
];

export const AUTH_MODULE_INITIALIZERS: readonly { file: string; hashes: readonly string[] }[] = [
  {
    "file": "convex/utils/tenancy.ts",
    "hashes": [
      "8d58acef59fbadf646b260154742396961195be2bc19fdf0dbbd9a67350a9051",
      "8d4dc1ea5bb90e2b26b00d6c32be2f663de02c085b5acc9b9a4461976d4cf946",
      "805f295a7374c9017a1ccf092f0d0618311781e906a7644c5e2c131ea4dcd737",
      "714c7f35bdbad8d988523562503554d38cc1180d03ae709bd9091b37e233c8cd",
      "bfd08f4c7b77640fe896a31b8237d624b36ead56493ddf28aba94b73e4070d7d",
      "58a0d4d4cad8b7c2dfff6776f03974e5d5558a819aee59e9db37d1f5a509d96e",
      "dc4daa21a63c6829391c088d5d7e8e79fb659cfef5e786625666660957a2ac04"
    ]
  },
  {
    "file": "convex/utils/errors.ts",
    "hashes": [
      "805f295a7374c9017a1ccf092f0d0618311781e906a7644c5e2c131ea4dcd737",
      // SCRUM-956 adds the bank and invalid payout-time refusal codes to AppErrorCode.
      // SCRUM-980 adds AI_KEY_FORMAT_INVALID, AI_KEY_ENCRYPTION_NOT_CONFIGURED and AI_KEY_SAVE_FAILED
      // (refusal codes only; no authorization helper or decision changes).
      // Superseded 7f748baa...: re-measured from the analyser at this commit.
      // SCRUM-967 adds nine localized deposit and handover refusal codes.
      // SCRUM-613 adds APPROVAL_EXCESS_NOT_POSTABLE (refusal code only; no authorization helper or decision changes).
      // Superseded 26c4d34a...: re-measured from the analyser at this commit.
      // SCRUM-1012 adds nine LATE_BANK_OPENING_* refusal codes to AppErrorCode (additive; no authorization helper or decision changes).
      // Superseded ed9716b9...: re-measured from the analyser at this commit.
      // SCRUM-1012 review F1/F3 adds three more LATE_BANK_OPENING_* refusal codes (additive; no authorization helper or decision changes).
      // Superseded d9baf2ab...: re-measured from the analyser at this commit.
      // The AI draft writer (PR 880) adds AI_DRAFT_NOT_ENABLED, AI_DRAFT_NO_CONVERSATION, AI_DRAFT_NOT_FOUND and AI_DRAFT_RATE_LIMITED (refusal codes only).
      // Merge of main 3d2735d45 into PR 880: both additions combined; superseded 5762305d... and 4f61fd57...; re-measured from the analyser at this commit.
      // SCRUM-961 adds seventeen PREPAID_RECLASS_* refusal codes to AppErrorCode (additive; no authorization helper or decision changes).
      // Superseded ee00d417...: re-measured from the analyser at this commit.
      "4a4f8b1ca518e76d4798d8b60ded3cd53d13685cd7a12dd4cccba50e94ee59d2"
    ]
  },
  {
    "file": "convex/utils/permissions.ts",
    "hashes": [
      "01f99c9e668d4ac697f8cb3a192dd2bc983c6ae1f9d2691cfbb04326ab3f0383",
      "7b167e2fde5073fb500bb8f9a6eb898d9a34811e3fa2c4f2499c0f7fc5ac60ec",
      "8d3a474879ca972656bd9577ffb12ca354154ef38de6ded1bccde35d5a102e0b",
      "1a9ed4a736bdf8cfdcd319bc666464a93b2d1db976060b0874a2eeb56f3796f4",
      "7282ed2a43092bfe298619a76488ea8cdaa59575c7834046d1ee32dab9781716",
      "8491ae69627ad84858664c9354e53893086d4517ae9eba69765073df15a8d867",
      "bd8a3fb6f0777319634c1916b24e12949d87f5bdce71827dbe0427a8ec623bb9",
      "3faddb3af18be7a9589d10d251a309ccdbc26b583673b035e90a3ed21cf69818",
      "55acf83315f7c6a8cf56304243e29c0a174003ae347ab59647fcced40aeecc7f",
      "c97862b491f53bce0eb051be0cad9909dd492ca80c905ebf101bf7dc7a169675",
      "f51da5c30092bfb655ef96cc23feea645fc0a811520e43949160204dab4a76ef",
      "1ac74a14117e8964cb85da661e647abcadcea1add99887df7a37f9394e6b3792",
      "8f30576c2c9ef5b8783fe584d9ba3ed29da593bf6b04465a81762f98ec87837c",
      "a76a38eaec7b3a17feffed43f814b6256aa7e503c902d91b6b530b405a31b978"
    ]
  },
  {
    "file": "convex/utils/auditLog.ts",
    "hashes": [
      "2575aa40738f31640c0b00397a7626f5299a443872e3d07406b3bfa83e779f0e",
      "b1e6cf92c958edc7ea4625983d94539615cb7696c40e1c70549b444345819021"
    ]
  },
  {
    "file": "convex/subscriptions.ts",
    "hashes": [
      "4c6873cadae704cacee340892151d567863f487a1396ca420fa8cbf0e1ec079b",
      "f7e94cf7a7d23049ff2e00096f078b08d2172b5871102978e0bb32e2425e34c0",
      "d5c910c321cb5c59228b73a9ab249f23b12de23d4d0992edd80d8edfb3240fbd",
      "1467fa23bb00f11c8331e4f01be0c52b349b3cf18b63fc9850ce58f95637b5f0",
      "a060d2c24f1dba6e5152b9fd4eabc074fbfda19430d440ac2149f2810ba9ddd8",
      "c749a5007b90f4da050848cc537dfa2d68291000f7278944c8dc13b6dcfdb7a4",
      "02abb3f89916bd28f393d9c3eac2c4f5d4d45efbe4da46552e1e170a2365ffea",
      "65b26b96e24eeed802db5e437d49862398cb82179db0320a49354c1c8cf0c346",
      "ee9d7b3b0f0d313a95697562a4963018a63ba9e36d0d645890bdc43a5b061e20",
      "319f9b7fd29667c59c5fd69aea74a5e7c57ccd1016cc42604d509b57babe76fd",
      "35a0f19d9dcc3c5882ec3ca3c968dd71ebba5860983215c4386e88df76ad0f6d",
      "c89fda3e449f5176a7ec9dc9a924a61c6551492663c27484a83cb6d6a9236c75",
      "ed1459756a409cf7b13e949df3d5a0c48b1cafbde54bbcc0300a9ba30a1c2bff",
      "19cb4bf54a190d58eb4eb4951ce6a8714773388d8e6dfa42cb0f46bae358e5e8",
      "e52746ab290f640fbeb5a968902dbe1f8de2efe3fb1549aa994eb989cffc3ec3",
      "67c892c86045a11a9389387d387b88cfc2e90de29d6678438ec9daaae05ec4ec",
      "1236f00e7199d58380d1a474e00b0ff84c6387d54dec6208bab8ab657645c2e5",
      "86dfd25bb894df429e7ecc93e4590b3c948e30c020691f5bba5ce644bb0d1d7d",
      "d598afa00d13e39e2d7292a022152b2211e54b2707f5f9a2c75804ba52b27b05",
      "2f4a276a51488b5c448799325850da3460feaae9152b12192ad5b8ebcfd4b144",
      "669c31fd76a98da05f8ba1184ddc07d27c6c01f9241dcbb9bf99ea3650edf98d",
      "61b7c857af16597ee0a463e0b2cc5dd082fd48933aca6d46808ba5de6ac30949",
      "b758cbda57965d282a168eb825686ffc9eb4cc4cb3ba6d78d5e5602196219261",
      "31cc9127d2bbda05fb8281ffbf51e07335f947ecc656abd71aca4d8cc534c3bc",
      "ca085afe6b8180e68ad217cac2a7c2ad715c3386e1213f9b297964a3452724b2",
      "d2954fc6d88ffe8e0bfe40bfcf2ab08b3bbc40f70756c573742e3946c8895448",
      "083b4c2ed6f541c30bf7c2c4bb7279aad3150a9a5f06f6c55da1be3e9256bd27",
      "dfbc4032db5a939fdc5941ad07443ab05677411d39bafb30171db66c8d55c7a1",
      "5a633ca89a967de6c90016fc946f77285faa7d557044952ce0c894de30f8e9eb",
      "48f83776acbaf2e027fcdadcb8adad11c40ac2de7aa2c07dc49307ac10014d15",
      "8a99c690c74e4466b93f580c293f4cdf53f134cfaae98c8e39dbf16ccbbd399a"
    ]
  },
  {
    "file": "convex/utils/subscriptionFeatures.ts",
    "hashes": [
      "805f295a7374c9017a1ccf092f0d0618311781e906a7644c5e2c131ea4dcd737",
      "8bb803d1c621ad664d29dd7e75939dffe04fdd20cbe555a09351e61d8b617990",
      "5e6eb3566941f2f8793157561cfdbf32465b0146c69bbccff0e296997cd9431b",
      "068ae0f181472c2c7629ccb7eabedd7738c60d3256e588d7734698f9f41be093",
      "fe71d758929bbe875d3e8cc976f8c1b7ea241ec7bd9742751e5899602a13da1c"
    ]
  }
];
