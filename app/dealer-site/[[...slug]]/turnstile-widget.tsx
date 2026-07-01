"use client";

type TurnstileWidgetProps = {
  siteKey?: string;
  theme?: "auto" | "light" | "dark";
};

export function TurnstileWidget({ siteKey, theme = "auto" }: TurnstileWidgetProps) {
  if (!siteKey) return null;

  return (
    <div
      className="cf-turnstile"
      data-sitekey={siteKey}
      data-action="turnstile-spin-v1"
      data-theme={theme}
    />
  );
}
