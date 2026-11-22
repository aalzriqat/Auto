export const identityAndOwnershipPairs = [
  [
    "requireAuth/if:! identity",
    [
      [
        "ordinary-query",
        "no-identity-query"
      ],
      [
        "ordinary",
        "no-identity-mutation"
      ]
    ]
  ],
  [
    "requireAuth/negation:! identity",
    [
      [
        "ordinary-query",
        "no-identity-query"
      ],
      [
        "ordinary",
        "no-identity-mutation"
      ]
    ]
  ],
  [
    "requireAuth/if:! user",
    [
      [
        "ordinary-query",
        "missing-user-query"
      ],
      [
        "ordinary",
        "missing-user-mutation"
      ]
    ]
  ],
  [
    "requireAuth/negation:! user",
    [
      [
        "ordinary-query",
        "missing-user-query"
      ],
      [
        "ordinary",
        "missing-user-mutation"
      ]
    ]
  ],
  [
    "requireAuth/if:user . disabled",
    [
      [
        "ordinary-query",
        "disabled-user-query"
      ],
      [
        "ordinary",
        "disabled-user-mutation"
      ]
    ]
  ],
  [
    "isMutationCtx/return:\"insert\" in ctx . db",
    [
      [
        "live-query",
        "live-mutation"
      ]
    ]
  ],
  [
    "isMutationCtx/comparison:\"insert\" in ctx . db",
    [
      [
        "live-query",
        "live-mutation"
      ]
    ]
  ],
  [
    "requireOwnedRow/if:! doc || ( doc as { orgId ? : Id < \"organizations\" > } ) . orgId !== orgId",
    [
      [
        "local-supplier",
        "missing-supplier"
      ],
      [
        "local-supplier",
        "foreign-supplier"
      ]
    ]
  ],
  [
    "requireOwnedRow/logical:! doc || ( doc as { orgId ? : Id < \"organizations\" > } ) . orgId !== orgId",
    [
      [
        "local-supplier",
        "missing-supplier"
      ],
      [
        "local-supplier",
        "foreign-supplier"
      ]
    ]
  ],
  [
    "requireOwnedRow/atom:! doc",
    [
      [
        "local-supplier",
        "missing-supplier"
      ]
    ]
  ],
  [
    "requireOwnedRow/atom:( doc as { orgId ? : Id < \"organizations\" > } ) . orgId !== orgId",
    [
      [
        "local-supplier",
        "foreign-supplier"
      ]
    ]
  ],
  [
    "requireOwnedRow/negation:! doc",
    [
      [
        "local-supplier",
        "missing-supplier"
      ]
    ]
  ],
  [
    "requireOwnedRow/comparison:( doc as { orgId ? : Id < \"organizations\" > } ) . orgId !== orgId",
    [
      [
        "local-supplier",
        "foreign-supplier"
      ]
    ]
  ],
] as const;
