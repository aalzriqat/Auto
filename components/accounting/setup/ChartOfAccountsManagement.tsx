"use client";

import { useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { usePermissions } from "@/hooks/use-permissions";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MoneySurfaceErrorBoundary } from "../MoneySurfaceErrorBoundary";
import { ChartOfAccountsDialog } from "./ChartOfAccountsDialog";

export function ChartOfAccountsManagement({
  orgId,
}: Readonly<{ orgId: Id<"organizations"> }>) {
  const { t } = useLanguage();
  const { hasPermission, isLoading } = usePermissions();
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{t("CoaTitle")}</CardTitle>
        <CardDescription>{t("CoaDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <AccountsLoading />
        ) : !hasPermission(PERMISSIONS.VIEW_FINANCE) ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("CoaReadDenied")}
          </p>
        ) : (
          <MoneySurfaceErrorBoundary
            key={orgId}
            fallback={
              <p role="alert" className="text-sm text-destructive">
                {t("CoaLoadError")}
              </p>
            }
          >
            <AccountsList
              orgId={orgId}
              canManage={hasPermission(PERMISSIONS.MANAGE_FINANCE)}
            />
          </MoneySurfaceErrorBoundary>
        )}
      </CardContent>
    </Card>
  );
}

function AccountsLoading() {
  const { t } = useLanguage();
  return (
    <div role="status" aria-label={t("Loading")} className="space-y-3">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function AccountsList({
  orgId,
  canManage,
}: Readonly<{ orgId: Id<"organizations">; canManage: boolean }>) {
  const { t, locale } = useLanguage();
  const accounts = useQuery(api.chartOfAccounts.list, { orgId });
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const [editor, setEditor] = useState<{
    accountId: Id<"chartOfAccounts"> | null;
    invoker: HTMLButtonElement;
  } | null>(null);
  if (accounts === undefined) return <AccountsLoading />;
  const selected = editor?.accountId
    ? accounts.find((row) => row._id === editor.accountId)
    : undefined;
  return (
    <div className="min-w-0 space-y-4">
      {canManage ? (
        <Button
          ref={createButtonRef}
          onClick={(event) =>
            setEditor({ accountId: null, invoker: event.currentTarget })
          }
        >
          {t("CoaCreate")}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">{t("CoaReadOnly")}</p>
      )}
      {accounts.length === 0 ? (
        <p role="status" className="py-6 text-sm text-muted-foreground">
          {t("CoaEmpty")}
        </p>
      ) : (
        <Table aria-label={t("CoaTitle")}>
          <TableHeader>
            <TableRow>
              {[
                "CoaCode",
                "CoaName",
                "CoaType",
                "CoaNormalBalance",
                "CoaState",
              ].map((key) => (
                <TableHead key={key} scope="col" className="text-start">
                  {t(key)}
                </TableHead>
              ))}
              {canManage && (
                <TableHead scope="col" className="text-end">
                  {t("CoaActions")}
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...accounts]
              .sort((a, b) =>
                a.code.localeCompare(b.code, "en", { numeric: true }),
              )
              .map((account) => (
                <TableRow key={account._id}>
                  <TableCell>
                    <bdi dir="ltr" className="font-mono">
                      {account.code}
                    </bdi>
                  </TableCell>
                  <TableCell className="min-w-40 whitespace-normal break-words">
                    <span dir="auto">
                      {(locale === "ar"
                        ? account.nameAr || account.name
                        : account.name) || "—"}
                    </span>
                    {locale === "ar" ? (
                      <p dir="auto" className="text-xs text-muted-foreground">
                        {account.name}
                      </p>
                    ) : (
                      account.nameAr && (
                        <p dir="auto" className="text-xs text-muted-foreground">
                          {account.nameAr}
                        </p>
                      )
                    )}
                    {account.systemKey && (
                      <Badge variant="outline">{t("CoaSystem")}</Badge>
                    )}
                  </TableCell>
                  <TableCell>{t(`CoaType_${account.type}`)}</TableCell>
                  <TableCell>
                    {t(`CoaBalance_${account.normalBalance}`)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={account.active ? "secondary" : "outline"}>
                      {t(account.active ? "CoaActive" : "CoaInactive")}
                    </Badge>
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-end">
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`${t("CoaEdit")} ${account.code}`}
                        onClick={(event) =>
                          setEditor({
                            accountId: account._id,
                            invoker: event.currentTarget,
                          })
                        }
                      >
                        {t("CoaEdit")}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
          </TableBody>
        </Table>
      )}
      {canManage &&
        editor !== null &&
        (editor.accountId === null || selected) && (
          <ChartOfAccountsDialog
            key={editor.accountId ?? "create"}
            orgId={orgId}
            account={selected}
            onClose={() => setEditor(null)}
            onCloseAutoFocus={(event) => {
              const target = editor.invoker.isConnected
                ? editor.invoker
                : createButtonRef.current;
              if (target) {
                event.preventDefault();
                target.focus();
              }
            }}
          />
        )}
    </div>
  );
}
