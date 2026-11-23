import { useLanguage } from "@/components/providers/LanguageProvider";
import { formatMoneyDisplay } from "@/lib/moneyDisplay";

export function VehiclePriceLabel({
  label,
  amount,
  variant,
}: {
  label: string;
  amount: number;
  variant?: "selling";
}) {
  const { locale } = useLanguage();
  return (
    <>
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <p
        className={
          variant === "selling"
            ? "text-sm font-bold text-green-500"
            : "text-sm font-medium"
        }
      >
        <bdi>{formatMoneyDisplay(amount, "JOD", locale)}</bdi>
      </p>
    </>
  );
}
