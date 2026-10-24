/** SCRUM-760 c23526: uncertified distribution stays closed; this grants no profit allowance. */
export const PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED = true as const;

export const PARTNER_PROFIT_DISTRIBUTION_UNAVAILABLE = {
  en: "Profit distribution is not available during the pilot. No equity or cash has been changed.",
  ar: "توزيع الأرباح غير متاح خلال التشغيل التجريبي. لم تتغير حقوق الملكية أو النقد.",
} as const;