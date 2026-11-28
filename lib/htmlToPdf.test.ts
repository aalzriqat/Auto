import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { html2canvas, save, addImage, captureException } = vi.hoisted(() => ({
  html2canvas: vi.fn(),
  save: vi.fn(),
  addImage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("html2canvas", () => ({ default: html2canvas }));
vi.mock("jspdf", () => ({
  jsPDF: class {
    internal = { pageSize: { getWidth: () => 210 } };
    addImage = addImage;
    save = save;
  },
}));
vi.mock("@sentry/nextjs", () => ({ captureException }));

import { downloadElementAsPdf } from "./htmlToPdf";

const ID = "pdf-test-element";
const FILENAME = "Doc_1.pdf";

function mountHiddenElement(): HTMLElement {
  const element = document.createElement("div");
  element.id = ID;
  element.className = "hidden print:block";
  document.body.appendChild(element);
  return element;
}

function expectRestored(element: HTMLElement): void {
  expect(element.classList.contains("hidden")).toBe(true);
  expect(element.style.display).toBe("");
  expect(element.style.position).toBe("");
  expect(element.style.left).toBe("");
  expect(element.style.top).toBe("");
}

describe("downloadElementAsPdf (SCRUM-1030)", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    document.body.innerHTML = "";
  });

  afterEach(() => consoleError.mockRestore());

  test("capture failure: returns false, logs and reports the real error, restores the element", async () => {
    const element = mountHiddenElement();
    const failure = new Error('Attempting to parse an unsupported color function "oklch"');
    html2canvas.mockRejectedValue(failure);

    await expect(downloadElementAsPdf(ID, FILENAME)).resolves.toBe(false);

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(ID), failure);
    expect(captureException).toHaveBeenCalledWith(failure, expect.objectContaining({ tags: expect.objectContaining({ elementId: ID }) }));
    expect(save).not.toHaveBeenCalled();
    expectRestored(element);
  });

  test("missing element: returns false and logs it without capturing", async () => {
    await expect(downloadElementAsPdf("does-not-exist", FILENAME)).resolves.toBe(false);

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("does-not-exist"));
    expect(html2canvas).not.toHaveBeenCalled();
  });

  test("success: saves the PDF under the filename, reports nothing, restores the element", async () => {
    const element = mountHiddenElement();
    html2canvas.mockResolvedValue({ width: 100, height: 200, toDataURL: () => "data:image/png;base64,AAAA" });

    await expect(downloadElementAsPdf(ID, FILENAME)).resolves.toBe(true);

    expect(addImage).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(FILENAME);
    expect(captureException).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expectRestored(element);
  });
});
