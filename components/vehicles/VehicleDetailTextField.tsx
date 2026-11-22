export function VehicleDetailTextField({
  label,
  text,
}: {
  label: string;
  text: string;
}) {
  return (
    <div className="space-y-1">
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <p className="text-sm">{text}</p>
    </div>
  );
}
