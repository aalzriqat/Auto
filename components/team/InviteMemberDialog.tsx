"use client";

import { useState, useEffect, useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { toast } from "@/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Info, UserCheck, Loader2, User } from "lucide-react";

const baseSchema = z.object({
  email: z.string().email("Invalid email address"),
  name: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  roleId: z.string().min(1, "Role is required"),
});

type CreateAccountFormValues = z.infer<typeof baseSchema>;

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InviteMemberDialog({ open, onOpenChange }: InviteMemberDialogProps) {
  const { activeOrgId } = useOrg();
  const { isRtl: isRTL, t } = useLanguage();

  const roles = useQuery(api.roles.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const createAccount = useAction(api.memberships.createAccount);
  const checkEmailExists = useAction(api.memberships.checkEmailExists);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [emailCheckState, setEmailCheckState] = useState<"idle" | "checking" | "exists" | "new">("idle");
  const [existingUserName, setExistingUserName] = useState<string>("");

  const form = useForm<CreateAccountFormValues>({
    resolver: zodResolver(baseSchema as any),
    defaultValues: {
      email: "",
      name: "",
      username: "",
      password: "",
      roleId: "",
    },
  });

  const watchedEmail = form.watch("email");
  const isExistingUser = emailCheckState === "exists";
  const isChecking = emailCheckState === "checking";

  // Debounced email check — runs 700ms after user stops typing
  const debouncedCheckEmail = useCallback(
    (() => {
      let timer: ReturnType<typeof setTimeout>;
      return (email: string) => {
        clearTimeout(timer);
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          setEmailCheckState("idle");
          setExistingUserName("");
          return;
        }
        setEmailCheckState("checking");
        timer = setTimeout(async () => {
          try {
            const result = await checkEmailExists({ email });
            if (result.exists) {
              setEmailCheckState("exists");
              setExistingUserName(result.name || "");
            } else {
              setEmailCheckState("new");
              setExistingUserName("");
            }
          } catch {
            setEmailCheckState("new");
            setExistingUserName("");
          }
        }, 700);
      };
    })(),
    [checkEmailExists]
  );

  useEffect(() => {
    debouncedCheckEmail(watchedEmail);
  }, [watchedEmail]);

  // Reset everything when dialog closes
  useEffect(() => {
    if (!open) {
      form.reset();
      setEmailCheckState("idle");
      setExistingUserName("");
    }
  }, [open]);

  const onSubmit = async (values: CreateAccountFormValues) => {
    if (!activeOrgId) return;

    // For brand-new accounts, enforce username + password + name
    if (!isExistingUser) {
      if (!values.name || values.name.trim().length < 2) {
        form.setError("name", { message: "Full name must be at least 2 characters" });
        return;
      }
      if (!values.username || values.username.length < 3) {
        form.setError("username", { message: "Username must be at least 3 characters" });
        return;
      }
      if (!values.password || values.password.length < 8) {
        form.setError("password", { message: "Password must be at least 8 characters" });
        return;
      }
    }

    setIsSubmitting(true);
    try {
      await createAccount({
        orgId: activeOrgId,
        // For existing users: pass their real name from Clerk, or a placeholder
        name: isExistingUser ? (existingUserName || values.email) : (values.name || ""),
        email: values.email,
        username: isExistingUser ? undefined : values.username,
        password: isExistingUser ? undefined : values.password,
        roleId: values.roleId as Id<"roles">,
      });

      toast.success(t("AccountCreatedSuccess" as any));
      form.reset();
      setEmailCheckState("idle");
      setExistingUserName("");
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || t("AccountCreatedFail" as any));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir={isRTL ? "rtl" : "ltr"}>
        <DialogHeader>
          <DialogTitle>{t("AddTeamMember" as any)}</DialogTitle>
          <DialogDescription>
            {t("AddTeamMemberDesc" as any)}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">

            {/* Email — always shown first */}
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("EmailAddress" as any)}</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input type="email" placeholder="employee@dealership.com" {...field} />
                      {isChecking && (
                        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                      )}
                      {isExistingUser && (
                        <UserCheck className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-green-500" />
                      )}
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Existing user: show their name as a read-only badge, hide the input */}
            {isExistingUser && (
              <>
                {existingUserName && (
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 dark:bg-zinc-900 dark:border-zinc-700 px-3 py-2.5">
                    <User className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="flex flex-col">
                      <span className="text-xs text-muted-foreground">
                        {isRTL ? "الاسم المسجل" : "Registered name"}
                      </span>
                      <span className="text-sm font-medium">{existingUserName}</span>
                    </div>
                  </div>
                )}
                <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 p-3 text-sm text-blue-800 dark:text-blue-300">
                  <Info className="h-4 w-4 mt-0.5 shrink-0" />
                  <p>
                    {isRTL
                      ? "هذا المستخدم لديه حساب بالفعل. سيتم إضافته مباشرة إلى المعرض دون الحاجة لإنشاء حساب جديد."
                      : "This user already has an account. They will be added directly to the organization — no new account needed."}
                  </p>
                </div>
              </>
            )}

            {/* New user only: name, username, password */}
            {!isExistingUser && emailCheckState !== "idle" && (
              <>
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("FullName" as any)}</FormLabel>
                      <FormControl>
                        <Input placeholder="John Doe" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("Username" as any)}</FormLabel>
                      <FormControl>
                        <Input placeholder="johndoe" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("Password" as any)}</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="********" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {/* Role — shown once we know if they exist or not */}
            {emailCheckState !== "idle" && (
              <FormField
                control={form.control}
                name="roleId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("AssignRole" as any)}</FormLabel>
                    <FormControl>
                      <SearchableSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder={t("SelectARole" as any)}
                        options={roles?.map((r) => ({
                          value: r._id,
                          label: t(r.name as any) || r.name,
                        })) ?? []}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <div className={`flex justify-end gap-2 pt-2 ${isRTL ? "flex-row-reverse" : ""}`}>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("Cancel" as any)}
              </Button>
              <Button type="submit" disabled={isSubmitting || isChecking || emailCheckState === "idle"}>
                {isSubmitting ? (
                  <><Loader2 className="me-2 h-4 w-4 animate-spin" />{t("Creating" as any)}</>
                ) : isExistingUser ? (
                  isRTL ? "إضافة إلى المعرض" : "Add to Organization"
                ) : (
                  t("CreateAccount" as any)
                )}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
