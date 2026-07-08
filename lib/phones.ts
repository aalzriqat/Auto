// lib/phones.ts

/** Joins a phone-number list into one-per-line text for a textarea field. */
export function phonesToText(phones: string[] | null | undefined): string {
  return (phones ?? []).join("\n");
}

/** Parses one-per-line textarea text back into a trimmed, non-empty phone-number list. */
export function parsePhoneLines(text: string): string[] {
  return text.split("\n").map((phone) => phone.trim()).filter(Boolean);
}
