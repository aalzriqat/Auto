import { Fragment, type CSSProperties, type ReactNode } from "react";
import { JOURNAL_HEAD, pick, type AcctFeature, type Bi, type JournalLine, type VehicleStatus } from "./content";

/**
 * Word-split headline for the motion-blur reveal. Splitting on WORDS (never
 * characters) keeps Arabic ligatures intact. The parent keys this by locale so
 * a language switch remounts it and replays the reveal.
 */
export function BlurIn({
  as: Tag = "h2",
  text,
  className = "",
  style,
}: {
  as?: "h1" | "h2";
  text: string;
  className?: string;
  style?: CSSProperties;
}) {
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <Tag className={`blur-in ${className}`.trim()} style={style}>
      {words.map((w, i) => (
        // the space is a text node BETWEEN the inline-block spans: inside one
        // it is trailing whitespace and gets collapsed, gluing the words together
        <Fragment key={`${i}-${w}`}>
          <span style={{ "--d": `${i * 55}ms` } as CSSProperties}>{w}</span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </Tag>
  );
}

export function SectionHead({
  locale,
  eyebrow,
  title,
  lede,
  children,
  style,
}: {
  locale: string;
  eyebrow?: Bi;
  title: Bi;
  lede?: Bi;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="section-head" style={style}>
      {eyebrow ? <span className="eyebrow">{pick(locale, eyebrow)}</span> : null}
      <BlurIn key={locale} text={pick(locale, title)} />
      {lede ? <p className="lede">{pick(locale, lede)}</p> : null}
      {children}
    </div>
  );
}

export function Pill({ status, children }: { status: VehicleStatus; children: ReactNode }) {
  return <span className={`pill pill-${status}`}>{children}</span>;
}

export function Journal({ locale, lines }: { locale: string; lines: readonly JournalLine[] }) {
  return (
    <table className="journal">
      <thead>
        <tr>
          <th>{pick(locale, JOURNAL_HEAD.account)}</th>
          <th className="num">{pick(locale, JOURNAL_HEAD.debit)}</th>
          <th className="num">{pick(locale, JOURNAL_HEAD.credit)}</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.account.en}>
            <td>{pick(locale, l.account)}</td>
            <td className="num">{l.debit ?? "—"}</td>
            <td className="num">{l.credit ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  );
}

export function AcctIcon({ icon }: { icon: AcctFeature["icon"] }) {
  switch (icon) {
    case "ledger":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5.5h16v13H4z" />
          <path d="M4 10h16M9 10v8.5" />
        </svg>
      );
    case "bank":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 9.5L12 4l9 5.5M5 9.5v9M19 9.5v9M3 19h18" />
        </svg>
      );
    case "vat":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M19 5L5 19" />
          <circle cx="7.5" cy="7.5" r="2.5" />
          <circle cx="16.5" cy="16.5" r="2.5" />
        </svg>
      );
    case "calendar":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
          <path d="M3.5 10h17M8 3.5v3M16 3.5v3M8 14h3" />
        </svg>
      );
  }
}
