/**
 * ## A MOUNTED dialog whose command is in flight is not closable by any route it exposes (R9)
 *
 * Every submit of an open dialog carries the attempt's `intentId`; closing
 * the dialog ABANDONS the attempt and the container retires that identity
 * (`onAbandonMove` and its siblings). Only Cancel was disabled while busy:
 * Escape, the overlay and the corner X still went through `onOpenChange`,
 * so an operator could abandon an attempt whose request was still on the
 * wire. If that request then landed, the money moved under an identity the
 * screen had already forgotten — and the next dialog for the same figures
 * was a NEW command, so a genuine retry paid twice with no replay to stop
 * it. So while `busy`, every close route is refused: the controlled
 * `onOpenChange(false)` is dropped (which is what the X asks for), and the
 * escape and outside-interaction events are cancelled at the layer so the
 * primitive never asks. The dialog reopens its close routes the moment the
 * attempt settles — success closes it through the container, a lost
 * response keeps it open with the failure shown and the SAME identity for
 * the retry, and a definitive refusal is the container's to retire.
 *
 * One rule for every custody dialog, so no door is guarded differently.
 *
 * ⚠️ WHAT THIS DOES NOT COVER (AF-R10-01). The guard only exists while the
 * dialog is mounted. A same-tab route change while the request is on the
 * wire unmounts the whole cockpit: no dismissal event fires, nothing here
 * runs, and the attempt's identity — the panel's per-dialog `intentId` and
 * the mount-scoped map in `useCommandIdentity` — dies with the tree. If the
 * request then lands, cash moved under a key no screen remembers, and the
 * next attempt on return is a NEW command. The operator does see the first
 * movement (the panel is fed by a live query) before they can resubmit, so
 * this is the ordinary re-submit exposure every economic command in the app
 * carries through the same hook — not the silent "lost" signal R8 fixed —
 * but it is a gap in this guard, not a route it refuses. Pinned by the
 * unmount characterization in `DealCockpitCustodyIdentity.test.tsx`.
 */
export function busyCloseGuard(busy: boolean, onOpenChange: (open: boolean) => void) {
  const refuse = (event: { preventDefault: () => void }) => {
    if (busy) event.preventDefault();
  };
  return {
    onOpenChange: (open: boolean) => {
      if (!open && busy) return;
      onOpenChange(open);
    },
    /** Spread onto `DialogContent`: the routes the primitive would otherwise dismiss on. */
    content: { onEscapeKeyDown: refuse, onPointerDownOutside: refuse, onInteractOutside: refuse },
  };
}
