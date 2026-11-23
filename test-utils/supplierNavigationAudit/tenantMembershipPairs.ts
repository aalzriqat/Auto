export const tenantMembershipPairs = [
  [
    "requireTenantAuth/if:! org",
    [
      [
        "ordinary",
        "missing-org"
      ]
    ]
  ],
  [
    "requireTenantAuth/negation:! org",
    [
      [
        "ordinary",
        "missing-org"
      ]
    ]
  ],
  [
    "requireTenantAuth/if:org . suspended",
    [
      [
        "ordinary",
        "suspended"
      ]
    ]
  ],
  [
    "requireTenantAuth/if:! membership",
    [
      [
        "ordinary",
        "missing-membership"
      ]
    ]
  ],
  [
    "requireTenantAuth/negation:! membership",
    [
      [
        "ordinary",
        "missing-membership"
      ]
    ]
  ],
  [
    "requireTenantAuth/if:membership . offboardingStatus",
    [
      [
        "ordinary",
        "pending"
      ],
      [
        "ordinary",
        "retrying"
      ]
    ]
  ],
  [
    "requireTenantAuth/if:! role",
    [
      [
        "ordinary",
        "missing-role"
      ]
    ]
  ],
  [
    "requireTenantAuth/negation:! role",
    [
      [
        "ordinary",
        "missing-role"
      ]
    ]
  ],
  [
    "requireTenantAuth/if:requiredPermissions . length > 0 && ! isSystemOwnerRole ( role )",
    [
      [
        "empty-no-requirement",
        "empty-required"
      ],
      [
        "flagged",
        "missing-flag-empty"
      ]
    ]
  ],
  [
    "requireTenantAuth/logical:requiredPermissions . length > 0 && ! isSystemOwnerRole ( role )",
    [
      [
        "empty-no-requirement",
        "empty-required"
      ],
      [
        "flagged",
        "missing-flag-empty"
      ]
    ]
  ],
  [
    "requireTenantAuth/atom:requiredPermissions . length > 0",
    [
      [
        "empty-no-requirement",
        "empty-required"
      ],
      [
        "flagged",
        "missing-flag-empty"
      ]
    ]
  ],
  [
    "requireTenantAuth/atom:! isSystemOwnerRole ( role )",
    [
      [
        "flagged",
        "missing-flag-empty"
      ]
    ]
  ],
  [
    "requireTenantAuth/comparison:requiredPermissions . length > 0",
    [
      [
        "empty-no-requirement",
        "empty-required"
      ],
      [
        "flagged",
        "missing-flag-empty"
      ]
    ]
  ],
  [
    "requireTenantAuth/negation:! isSystemOwnerRole ( role )",
    [
      [
        "flagged",
        "missing-flag-empty"
      ]
    ]
  ],
  [
    "requireTenantAuth/predicate-filter:! role . permissions . includes ( p )",
    [
      [
        "ordinary",
        "empty-required"
      ],
      [
        "ordinary",
        "one-missing"
      ]
    ]
  ],
  [
    "requireTenantAuth/negation:! role . permissions . includes ( p )",
    [
      [
        "ordinary",
        "empty-required"
      ],
      [
        "ordinary",
        "one-missing"
      ]
    ]
  ],
  [
    "requireTenantAuth/if:missing . length > 0",
    [
      [
        "ordinary",
        "empty-required"
      ],
      [
        "ordinary",
        "one-missing"
      ]
    ]
  ],
  [
    "requireTenantAuth/comparison:missing . length > 0",
    [
      [
        "ordinary",
        "empty-required"
      ],
      [
        "ordinary",
        "one-missing"
      ]
    ]
  ],
] as const;
