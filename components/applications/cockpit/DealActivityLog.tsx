import { Clock, History } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DealCockpitData } from "./DealStagePresentation";

export function DealActivityLog({
  entries,
  formatMoment,
  statusLabel,
  t,
}: Readonly<{
  entries: DealCockpitData["timeline"];
  /** Returns null for an unrenderable timestamp so the status can still show. */
  formatMoment: (moment: number | undefined) => string | null;
  statusLabel: (status: string) => string;
  t: (key: string) => string;
}>) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <History
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          {t("StatusLogHeading")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {entries.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("StatusLogEmpty")}</p>
        )}
        {entries.map((entry, index) => {
          const dateLabel = formatMoment(entry.changedAt);
          return (
            <div
              key={`${entry.changedAt ?? "no-date"}-${index}`}
              className="flex gap-3 text-sm"
            >
              <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p>{statusLabel(entry.toStatus)}</p>
                <p className="text-xs text-muted-foreground">
                  <bdi>{entry.actorName}</bdi>
                  {/* The transition is stated whether or not its moment is
                  known. `changedAt` is optional precisely so a status is
                  never withheld for want of a timestamp — and `format`
                  throws `RangeError` on an unrenderable input, which
                  during render loses the whole screen, not one row. */}
                  {dateLabel !== null && (
                    <>
                      {" · "}
                      <bdi>{dateLabel}</bdi>
                    </>
                  )}
                </p>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
