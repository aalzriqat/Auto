/** Visit overlapping viewport slices so lazy rows intersect before readiness is measured. */
export async function scrollAuditContent(main: HTMLElement): Promise<void> {
  const root = /^(auto|scroll)$/.test(getComputedStyle(main).overflowY) ? main : document.scrollingElement;
  if (!(root instanceof HTMLElement)) throw new Error("Audit scroll container is unavailable.");
  const paint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  root.scrollTo({ top: 0, behavior: "instant" });
  try {
    await paint();
    for (let step = 0; step < 1_000; step += 1) {
      const bottom = Math.max(0, root.scrollHeight - root.clientHeight);
      if (root.scrollTop >= bottom) return;
      const previous = root.scrollTop;
      root.scrollTo({ top: Math.min(bottom, previous + Math.max(1, Math.floor(root.clientHeight / 2))), behavior: "instant" });
      await paint();
      if (root.scrollTop <= previous) throw new Error("Audit could not advance through the screen.");
    }
    throw new Error("Audit did not reach the bottom of the screen within the scroll bound.");
  } finally {
    root.scrollTo({ top: 0, behavior: "instant" });
    await paint();
  }
}
