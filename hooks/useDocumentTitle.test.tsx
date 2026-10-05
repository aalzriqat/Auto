/**
 * SCRUM-631: dealer tabs all read "AutoFlow | The Modern Dealership OS". The hook
 * must set the section title, hold it when Next rewrites <head>, and leave the
 * route's own metadata alone when there is no section title.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useDocumentTitle } from "./useDocumentTitle";

const ROOT = "AutoFlow | The Modern Dealership OS";

/** Next's metadata writes the <title> element's text, not document.title. */
async function nextRewritesTitle(text: string) {
  let el = document.head.querySelector("title");
  if (!el) {
    el = document.createElement("title");
    document.head.appendChild(el);
  }
  el.textContent = text;
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the MutationObserver deliver
}

beforeEach(() => {
  document.head.innerHTML = `<title>${ROOT}</title>`;
});
afterEach(cleanup);

describe("SCRUM-631: useDocumentTitle", () => {
  test("sets the section title, in whatever language it is given", () => {
    const { rerender } = renderHook(({ title }) => useDocumentTitle(title), {
      initialProps: { title: "Vehicles | AutoFlow" as string | null },
    });
    expect(document.title).toBe("Vehicles | AutoFlow");
    rerender({ title: "المركبات | AutoFlow" });
    expect(document.title).toBe("المركبات | AutoFlow");
  });

  test("re-applies the title after Next writes the route's static metadata title", async () => {
    renderHook(() => useDocumentTitle("الصفقات | AutoFlow"));
    await nextRewritesTitle("Deals | AutoFlow");
    expect(document.title).toBe("الصفقات | AutoFlow");
  });

  test("null leaves the route's own metadata title in place", async () => {
    renderHook(() => useDocumentTitle(null));
    expect(document.title).toBe(ROOT);
    await nextRewritesTitle("Finance deal | AutoFlow");
    expect(document.title).toBe("Finance deal | AutoFlow");
  });

  test("stops holding the title once unmounted", async () => {
    const { unmount } = renderHook(() => useDocumentTitle("Sales | AutoFlow"));
    unmount();
    await nextRewritesTitle(ROOT);
    expect(document.title).toBe(ROOT);
  });
});
