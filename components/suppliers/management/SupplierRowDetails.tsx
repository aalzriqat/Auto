"use client";

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { usePermissions } from "@/hooks/use-permissions";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useTranslate } from "./shared";

type Context = FunctionReturnType<typeof api.supplierStatement.outstanding>["payable"]["rows"][number]["context"];
const SOURCE_PERMISSION: Record<NonNullable<Context["source"]>["kind"], string> = {
  VEHICLE: "view:vehicles",
  SALE: "view:sales",
  APPLICATION: "view:sales",
  OPENING: "manage:finance",
  EXPENSE: "view:expenses",
};

function SourceLabel({ source }: Readonly<{ source: Context["source"] }>) {
  const translate = useTranslate();
  const { hasPermission, isLoading } = usePermissions();
  const href = source?.href;
  const canLink = source && !isLoading && hasPermission(SOURCE_PERMISSION[source.kind]);
  return <div className="break-words">
    {source && <span>{translate(`SuppliersRowSource${source.kind}`)}: </span>}
    {source && href && canLink ? <Link href={href} prefetch={false} className="font-medium text-primary underline underline-offset-4"><bdi>{source.label}</bdi></Link> : <bdi>{source?.label || translate("SuppliersRowSourceUnavailable")}</bdi>}
  </div>;
}

/** Server chooses the source and href. The client mirrors permissions while membership changes load. */
export function SupplierRowDetails({ context }: Readonly<{ context: Context | undefined }>) {
  const translate = useTranslate();
  const { locale } = useLanguage();
  const date = context?.occurredAt;
  const instant = date === null || date === undefined ? null : new Date(date);
  const localeCode = locale === "ar" ? "ar-JO" : "en-GB";
  const timestamp = date === null || date === undefined ? null : new Intl.DateTimeFormat(localeCode, {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Amman",
  }).format(date);
  return (
    <div className="mt-1 min-w-0 space-y-1 text-xs font-normal text-muted-foreground">
      <SourceLabel source={context?.source ?? null} />
      {context?.vehicleSource && <SourceLabel source={context.vehicleSource} />}
      {context && <>
        <p>{translate(context.role === "AP" ? "SuppliersRowAP" : "SuppliersRowAR")}</p>
        <p className="break-words">{translate(context.role === "AP" ? "SuppliersRowPayee" : "SuppliersRowPayer")}: <bdi>{context.counterparty || translate("SuppliersRowUnknownParty")}</bdi></p>
        <p>{translate("SuppliersRowCreated")}: {timestamp && instant ? <time dateTime={instant.toISOString()}><bdi>{timestamp}</bdi></time> : translate("SuppliersRowUnknownTime")}</p>
      </>}
    </div>
  );
}
