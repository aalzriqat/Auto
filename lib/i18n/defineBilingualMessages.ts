type BilingualMessageMap = Record<string, readonly [english: string, arabic: string]>;
type LocaleMessages<Messages extends BilingualMessageMap> = {
  [Key in keyof Messages]: string;
};

/**
 * Define a UI message once while preserving the flat `en` and `ar` dictionaries
 * consumed by LanguageProvider. Keeping each pair together makes missing
 * translations visible during review and avoids parallel catalog blocks
 * drifting apart.
 */
export function defineBilingualMessages<const Messages extends BilingualMessageMap>(messages: Messages): {
  en: LocaleMessages<Messages>;
  ar: LocaleMessages<Messages>;
} {
  const entries = Object.entries(messages);
  return {
    en: Object.fromEntries(entries.map(([key, [english]]) => [key, english])) as LocaleMessages<Messages>,
    ar: Object.fromEntries(entries.map(([key, [, arabic]]) => [key, arabic])) as LocaleMessages<Messages>,
  };
}
