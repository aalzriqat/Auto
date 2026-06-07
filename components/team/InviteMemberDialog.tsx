"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLanguage } from "@/components/providers/LanguageProvider";

const createAccountSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  username: z.string().min(3, "Username must be at least 3 characters").regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  roleId: z.string().min(1, "Role is required"),
});

type CreateAccountFormValues = z.infer<typeof createAccountSchema>;

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InviteMemberDialog({ open, onOpenChange }: InviteMemberDialogProps) {
  const { activeOrgId } = useOrg();
  const { isRtl: isRTL } = useLanguage();

  const roles = useQuery(api.roles.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const createAccount = useAction(api.memberships.createAccount);

  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<CreateAccountFormValues>({
    resolver: zodResolver(createAccountSchema as any),
    defaultValues: {
      name: "",
      username: "",
      email: "",
      password: "",
      roleId: "",
    },
  });

  const onSubmit = async (values: CreateAccountFormValues) => {
    if (!activeOrgId) return;
    setIsSubmitting(true);
    try {
      await createAccount({
        orgId: activeOrgId,
        name: values.name,
        username: values.username,
        email: values.email,
        password: values.password,
        roleId: values.roleId as Id<"roles">,
      });

      toast.success(isRTL ? "تم إنشاء الحساب بنجاح!" : "Account created successfully!");
      form.reset();
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || (isRTL ? "فشل إنشاء الحساب" : "Failed to create account"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir={isRTL ? "rtl" : "ltr"}>
        <DialogHeader>
          <DialogTitle>{isRTL ? "إضافة عضو جديد" : "Add Team Member"}</DialogTitle>
          <DialogDescription>
            {isRTL
              ? "قم بإنشاء حساب جديد لعضو الفريق بإدخال الاسم، البريد الإلكتروني، وكلمة المرور."
              : "Create a new account for a team member by providing their name, email, and a password."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{isRTL ? "الاسم الكامل" : "Full Name"}</FormLabel>
                  <FormControl>
                    <Input placeholder={isRTL ? "الاسم الكامل" : "John Doe"} {...field} />
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
                  <FormLabel>{isRTL ? "اسم المستخدم" : "Username"}</FormLabel>
                  <FormControl>
                    <Input placeholder="johndoe" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{isRTL ? "البريد الإلكتروني" : "Email Address"}</FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="employee@dealership.com" {...field} />
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
                  <FormLabel>{isRTL ? "كلمة المرور" : "Password"}</FormLabel>
                  <FormControl>
                    <Input type="password" placeholder="********" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="roleId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{isRTL ? "تحديد الصلاحية" : "Assign Role"}</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={isRTL ? "اختر صلاحية" : "Select a role"} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {roles?.map((r) => (
                        <SelectItem key={r._id} value={r._id}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className={`flex justify-end gap-2 pt-4 ${isRTL ? 'flex-row-reverse' : ''}`}>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {isRTL ? "إلغاء" : "Cancel"}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? (isRTL ? "جاري الإنشاء..." : "Creating...")
                  : (isRTL ? "إنشاء حساب" : "Create Account")}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
