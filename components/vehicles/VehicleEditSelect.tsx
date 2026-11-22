import { useLanguage } from "@/components/providers/LanguageProvider";
import { FormControl } from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const options = {
  fuel: {
    placeholder: "VehicleSelectFuelType",
    items: [
      ["Gasoline", "VehicleFuelGasoline"],
      ["Diesel", "VehicleFuelDiesel"],
      ["Hybrid", "VehicleFuelHybrid"],
      ["Electric", "VehicleFuelElectric"],
    ],
  },
  transmission: {
    placeholder: "VehicleSelectTransmission",
    items: [
      ["Automatic", "VehicleTransmissionAutomatic"],
      ["Manual", "VehicleTransmissionManual"],
    ],
  },
} as const;

export function VehicleEditSelect({
  kind,
  initialValue,
  onValueChange,
}: {
  kind: keyof typeof options;
  initialValue: string | undefined;
  onValueChange: (value: string) => void;
}) {
  const { t } = useLanguage();
  const { placeholder, items } = options[kind];
  return (
    <Select onValueChange={onValueChange} defaultValue={initialValue}>
      <FormControl>
        <SelectTrigger>
          <SelectValue placeholder={t(placeholder)} />
        </SelectTrigger>
      </FormControl>
      <SelectContent>
        {items.map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {t(label)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
