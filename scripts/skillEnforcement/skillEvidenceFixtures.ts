/**
 * Shared fixtures for the skill-evidence tests: a PR body whose "## Skill evidence"
 * section is complete, with any field overridden.
 */
export const fill = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    "Skills run": "tdd, blast-radius, two-axis-review, engineering-principles, technical-writing, unslop",
    "Seat 1 session": "https://claude.ai/code/session_SEAT1abc",
    "Seat 1 model": "claude-opus-5-5",
    "Seat 1 SHA": "abc1234",
    "Seat 2 model": "gpt-6-sol",
    "Seat 2 effort": "medium",
    "Seat 2 SHA": "abc1234",
    ...over,
  };
  return `intro\nhttps://claude.ai/code/session_IMPL999\n\n## Skill evidence
- Skills run: ${base["Skills run"]}
- Red run:
\`\`\`
FAIL convex/sales.test.ts > refuses X
AssertionError: expected 5 to be 0
\`\`\`
- /simplify output:
\`\`\`
Reviewed abc1234 for reuse, simplification and efficiency: no changes needed
\`\`\`
- Seat 1 session: ${base["Seat 1 session"]}
- Seat 1 model: ${base["Seat 1 model"]}
- Seat 1 SHA: ${base["Seat 1 SHA"]}
- Seat 2 model: ${base["Seat 2 model"]}
- Seat 2 effort: ${base["Seat 2 effort"]}
- Seat 2 SHA: ${base["Seat 2 SHA"]}
`;
};
