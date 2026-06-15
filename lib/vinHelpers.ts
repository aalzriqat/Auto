export function decodeVinYear(char: string): number | null {
  const base: Record<string, number> = {
    A: 1980, B: 1981, C: 1982, D: 1983, E: 1984, F: 1985, G: 1986, H: 1987,
    J: 1988, K: 1989, L: 1990, M: 1991, N: 1992, P: 1993, R: 1994, S: 1995,
    T: 1996, V: 1997, W: 1998, X: 1999, Y: 2000,
    "1": 2001, "2": 2002, "3": 2003, "4": 2004, "5": 2005,
    "6": 2006, "7": 2007, "8": 2008, "9": 2009,
  };
  const year = base[char?.toUpperCase()];
  if (!year) return null;
  const now = new Date().getFullYear();
  return year + 30 <= now + 2 ? year + 30 : year;
}

export function toCarBrand(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

export function cleanMfrName(mfr: string): string {
  const cleaned = mfr
    .replace(/\b(CORPORATION|CORP|COMPANY|CO|LIMITED|LTD|INC|AUTO|MOTOR|MOTORS|AUTOMOTIVE|MANUFACTURING|AG|GROUP)\b\.?,?/gi, " ")
    .replace(/[,./\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || mfr.split(/\s+/)[0];
}
