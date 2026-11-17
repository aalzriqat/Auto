import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LanguageProvider, useLanguage } from "./LanguageProvider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";

// jsdom lacks these browser APIs; the Radix implementations remain real.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
});

function LocaleControls() {
  const { setLocale } = useLanguage();
  return <>{(["ar", "en"] as const).map(locale => (
    <button key={locale} onClick={() => setLocale(locale)}>{locale}</button>
  ))}</>;
}
function SelectExample() {
  return <Select><SelectTrigger aria-label="Vehicle"><SelectValue placeholder="Choose" /></SelectTrigger>
    <SelectContent aria-label="Vehicles"><SelectItem value="one">One</SelectItem></SelectContent>
  </Select>;
}
function MenuExample() {
  return <DropdownMenu modal={false}><DropdownMenuTrigger>Actions</DropdownMenuTrigger>
    <DropdownMenuContent><DropdownMenuItem>Details</DropdownMenuItem></DropdownMenuContent>
  </DropdownMenu>;
}
function AccordionExample() {
  return <Accordion type="single" orientation="horizontal" defaultValue="one">
    {["one", "two", "three"].map(value => <AccordionItem key={value} value={value}>
      <AccordionTrigger>{value}</AccordionTrigger><AccordionContent>{value} details</AccordionContent>
    </AccordionItem>)}
  </Accordion>;
}
function TabsExample() {
  return <Tabs defaultValue="one" role="group" aria-label="Records">
    <TabsList aria-label="Record tabs"><TabsTrigger value="one">First record</TabsTrigger></TabsList>
    <TabsContent value="one">Record details</TabsContent>
  </Tabs>;
}
function ScrollExample() {
  return <ScrollArea role="region" aria-label="History">Previous records</ScrollArea>;
}

type Direction = "rtl" | "ltr";
function literalDirection(element: HTMLElement, direction: Direction) {
  expect.soft(element.getAttribute("dir")).toBe(direction);
}
function inheritedDirection(element: HTMLElement, direction: Direction) {
  // These primitives emit no trigger dir: verify their literal HTML boundary,
  // then separately verify the direction-aware API or keyboard behavior.
  expect(element.getAttribute("dir")).toBeNull();
  expect(element.closest("[dir]")?.getAttribute("dir")).toBe(direction);
}
const cases = [
  { name: "Select", Example: SelectExample,
    anchor: () => screen.getByRole("combobox", { name: "Vehicle", hidden: true }),
    check: async (direction: Direction) => {
    const trigger = screen.getByRole("combobox", { name: "Vehicle", hidden: true });
    literalDirection(trigger, direction);
    if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.keyDown(trigger, { key: "Enter" });
    literalDirection(await screen.findByRole("listbox", { name: "Vehicles" }), direction);
  } },
  { name: "DropdownMenu", Example: MenuExample,
    anchor: () => screen.getByRole("button", { name: "Actions" }),
    check: async (direction: Direction) => {
    const trigger = screen.getByRole("button", { name: "Actions" });
    inheritedDirection(trigger, direction);
    if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.keyDown(trigger, { key: "Enter" });
    literalDirection(await screen.findByRole("menu", { name: "Actions" }), direction);
  } },
  { name: "Accordion", Example: AccordionExample,
    anchor: () => screen.getByRole("button", { name: "one" }),
    check: async (direction: Direction) => {
    const trigger = screen.getByRole("button", { name: "one" });
    inheritedDirection(trigger, direction);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", {
      name: direction === "rtl" ? "two" : "three",
    })));
  } },
  { name: "Tabs", Example: TabsExample,
    anchor: () => screen.getByRole("group", { name: "Records" }),
    check: async (direction: Direction) => {
    literalDirection(screen.getByRole("group", { name: "Records" }), direction);
    inheritedDirection(screen.getByRole("tab", { name: "First record" }), direction);
    literalDirection(screen.getByRole("tabpanel", { name: "First record" }), direction);
  } },
  { name: "ScrollArea", Example: ScrollExample,
    anchor: () => screen.getByRole("region", { name: "History" }),
    check: async (direction: Direction) => {
    literalDirection(screen.getByRole("region", { name: "History" }), direction);
  } },
];

describe.each(cases)("SCRUM-958 $name follows the real locale", ({ Example, anchor, check }) => {
  test.each([
    { locale: "ar", direction: "rtl" },
    { locale: "en", direction: "ltr" },
  ] as const)("$locale renders $direction", async ({ locale, direction }) => {
    localStorage.setItem("autoflow-locale", locale);
    render(<LanguageProvider><Example /></LanguageProvider>);
    await check(direction);
    expect(document.documentElement.dir).toBe(direction);
    expect(document.documentElement.lang).toBe(locale);
  });
  test("switches Arabic to English and back without remounting", async () => {
    render(<LanguageProvider><LocaleControls /><Example /></LanguageProvider>);
    const english = screen.getByRole("button", { name: "en" });
    const arabic = screen.getByRole("button", { name: "ar" });
    const exampleAnchor = anchor();
    // Keep a popup open across the state update; its portal must update too.
    await check("rtl");
    fireEvent.click(english);
    await check("ltr");
    expect(anchor()).toBe(exampleAnchor);
    expect(document.body.contains(exampleAnchor)).toBe(true);
    // Select's modal popup hides the controls from the accessibility tree.
    expect(screen.getByRole("button", { name: "en", hidden: true })).toBe(english);
    expect(document.body.contains(english)).toBe(true);
    expect(screen.getByRole("button", { name: "ar", hidden: true })).toBe(arabic);
    expect(document.body.contains(arabic)).toBe(true);
    fireEvent.click(arabic);
    await check("rtl");
    expect(anchor()).toBe(exampleAnchor);
    expect(document.body.contains(exampleAnchor)).toBe(true);
    expect(screen.getByRole("button", { name: "en", hidden: true })).toBe(english);
    expect(document.body.contains(english)).toBe(true);
    expect(screen.getByRole("button", { name: "ar", hidden: true })).toBe(arabic);
    expect(document.body.contains(arabic)).toBe(true);
  });
});
