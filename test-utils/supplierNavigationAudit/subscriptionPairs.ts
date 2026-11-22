export const subscriptionPairs = [
  [
    "requireFeature/if:await hasPlanFeature ( ctx , orgId , gate )",
    [
      [
        "enterprise-plan",
        "free-plan"
      ]
    ]
  ],
  [
    "hasPlanFeature/lookup:PLANS [ planId ] . gates [ gate ]",
    [
      [
        "enterprise-plan",
        "free-plan"
      ]
    ]
  ],
  [
    "hasPlanFeature/lookup:PLANS [ planId ]",
    [
      [
        "enterprise-plan",
        "free-plan"
      ]
    ]
  ],
  [
    "getOrgPlan/if:! sub",
    [
      [
        "enterprise-plan",
        "no-subscription"
      ]
    ]
  ],
  [
    "getOrgPlan/negation:! sub",
    [
      [
        "enterprise-plan",
        "no-subscription"
      ]
    ]
  ],
  [
    "getOrgPlan/if:sub . status !== \"active\"",
    [
      [
        "enterprise-plan",
        "expired-plan"
      ]
    ]
  ],
  [
    "getOrgPlan/comparison:sub . status !== \"active\"",
    [
      [
        "enterprise-plan",
        "expired-plan"
      ]
    ]
  ],
] as const;
