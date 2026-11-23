// SCRUM-963. These are physical lines, including comments and blank lines.
export const DEFAULT_SOURCE_LINES = 600;
export const MAX_SOURCE_LINES = 800;

const sourceExtension = /\.(?:[cm]?[jt]sx?|css|s[ac]ss|less|html|kts?|java|gradle|py|sh|ps1|bat|cmd|sql)$/iu;

export function isHandwrittenSource(filePath, generated) {
  return sourceExtension.test(filePath) && !generated.has(filePath);
}

export function physicalLines(text) {
  if (text === "") return 0;
  const lines = text.split(/\r\n|\n|\r/u);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function checkOversizedSource(filePath, lines, previous) {
  if (previous === undefined || lines > previous) {
    return {
      error: `SOURCE-LINES-MAX ${filePath}: ${lines} physical lines. Split by responsibility and notify the owner. Maximum is ${MAX_SOURCE_LINES}; existing oversized files may only shrink.`,
    };
  }
  if (lines === previous) return { legacy: true };
  return {
    legacy: true,
    notice: `SOURCE-LINES-LEGACY ${filePath}: ${previous} → ${lines} physical lines, still above ${MAX_SOURCE_LINES}`,
  };
}

function checkSourceFile({ filePath, lines, previous, reason }) {
  if (lines > MAX_SOURCE_LINES) return checkOversizedSource(filePath, lines, previous);
  if (lines <= DEFAULT_SOURCE_LINES) return {};
  if (reason) {
    return {
      approved: true,
      notice: `SOURCE-LINES-EXCEPTION ${filePath}: ${lines} physical lines. ${reason}`,
    };
  }
  if (previous === undefined || lines > previous || previous > MAX_SOURCE_LINES) {
    return {
      error: `SOURCE-LINES-DEFAULT ${filePath}: ${lines} physical lines. Split at ${DEFAULT_SOURCE_LINES} or record the cohesion reason in sourceLineExceptions.`,
    };
  }
  return {};
}

export function compareSourceLines({ current, target, exceptions }) {
  const errors = [];
  const notices = [];
  const approved = new Set();
  let legacyAboveMaximum = 0;
  for (const [filePath, lines] of current) {
    const finding = checkSourceFile({
      filePath,
      lines,
      previous: target.get(filePath),
      reason: exceptions.get(filePath),
    });
    if (finding.error) errors.push(finding.error);
    if (finding.notice) notices.push(finding.notice);
    if (finding.approved) approved.add(filePath);
    if (finding.legacy) legacyAboveMaximum += 1;
  }
  for (const filePath of exceptions.keys()) {
    if (!approved.has(filePath)) {
      errors.push(`SOURCE-LINES-EXCEPTION ${filePath}: a documented exception applies only to source files with 601–800 physical lines.`);
    }
  }
  if (legacyAboveMaximum > 0) {
    notices.push(`SOURCE-LINES-LEGACY ${legacyAboveMaximum} existing source files exceed ${MAX_SOURCE_LINES} physical lines. Track remaining refactors in SCRUM-963.`);
  }
  return { errors, notices };
}
