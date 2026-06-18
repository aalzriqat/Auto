"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "convex/react";
import { Mail, Loader2, CheckCircle2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import { contactFormSchema, type ContactFormValues } from "@/components/marketing/contact.schema";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";

const copy = {
  en: {
    title: "Contact Us",
    subtitle: "Have a question about AutoFlow, pricing, or onboarding your dealership? Send us a message and a member of our team will get back to you within 1 business day.",
    name: "Your Name",
    namePlaceholder: "John Doe",
    email: "Email Address",
    emailPlaceholder: "you@dealership.com",
    subject: "Subject",
    subjectPlaceholder: "How can we help?",
    message: "Message",
    messagePlaceholder: "Tell us a bit more...",
    send: "Send Message",
    sending: "Sending...",
    successTitle: "Message sent",
    successBody: "Thanks for reaching out — we've emailed you a confirmation and will reply within 1 business day.",
    sendAnother: "Send another message",
    altContact: "You can also reach us directly at",
  },
  ar: {
    title: "تواصل معنا",
    subtitle: "هل لديك سؤال حول أوتوفلو، أو الأسعار، أو إعداد معرضك؟ أرسل لنا رسالة وسيتواصل معك أحد أعضاء فريقنا خلال يوم عمل واحد.",
    name: "اسمك",
    namePlaceholder: "محمد أحمد",
    email: "البريد الإلكتروني",
    emailPlaceholder: "you@dealership.com",
    subject: "الموضوع",
    subjectPlaceholder: "كيف يمكننا مساعدتك؟",
    message: "الرسالة",
    messagePlaceholder: "أخبرنا بمزيد من التفاصيل...",
    send: "إرسال الرسالة",
    sending: "جارٍ الإرسال...",
    successTitle: "تم إرسال الرسالة",
    successBody: "شكراً لتواصلك معنا — لقد أرسلنا لك رسالة تأكيد وسنرد عليك خلال يوم عمل واحد.",
    sendAnother: "إرسال رسالة أخرى",
    altContact: "يمكنك أيضاً التواصل معنا مباشرة عبر",
  },
};

export default function ContactPage() {
  const { locale, isRtl } = useLanguage();
  const t = copy[locale] || copy.en;
  const submitContactMessage = useMutation(api.support.submitContactMessage);
  const [submitted, setSubmitted] = useState(false);

  const form = useForm<ContactFormValues>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: { name: "", email: "", subject: "", message: "" },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: ContactFormValues) {
    try {
      await submitContactMessage(values);
      setSubmitted(true);
      form.reset();
    } catch (error: any) {
      toast.error(error?.data?.message ?? error?.message ?? "Failed to send message. Please try again.");
    }
  }

  return (
    <MarketingShell>
      <section className="container mx-auto px-6 py-20 max-w-xl">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white mb-3">{t.title}</h1>
        <p className="text-sm text-white/65 leading-relaxed mb-10">{t.subtitle}</p>

        {submitted ? (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-8 text-center flex flex-col items-center gap-4">
            <CheckCircle2 className="w-10 h-10 text-emerald-400" />
            <div>
              <h2 className="text-lg font-bold text-white mb-1">{t.successTitle}</h2>
              <p className="text-sm text-white/60">{t.successBody}</p>
            </div>
            <Button variant="outline" onClick={() => setSubmitted(false)}>
              {t.sendAnother}
            </Button>
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} dir={isRtl ? "rtl" : "ltr"} className="space-y-5">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-white/75">{t.name}</FormLabel>
                    <FormControl>
                      <Input placeholder={t.namePlaceholder} {...field} />
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
                    <FormLabel className="text-white/75">{t.email}</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder={t.emailPlaceholder} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="subject"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-white/75">{t.subject}</FormLabel>
                    <FormControl>
                      <Input placeholder={t.subjectPlaceholder} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="message"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-white/75">{t.message}</FormLabel>
                    <FormControl>
                      <Textarea rows={6} placeholder={t.messagePlaceholder} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button type="submit" disabled={isSubmitting} className="w-full">
                {isSubmitting ? (
                  <>
                    <Loader2 className="me-2 h-4 w-4 animate-spin" />
                    {t.sending}
                  </>
                ) : (
                  t.send
                )}
              </Button>
            </form>
          </Form>
        )}

        <div className="mt-10 pt-8 border-t border-white/5 flex items-center gap-2 text-sm text-white/50">
          <Mail className="w-4 h-4 shrink-0" />
          <span>
            {t.altContact}{" "}
            <a href="mailto:support@autoflowdealer.com" className="text-blue-400 hover:text-blue-300 transition-colors">
              support@autoflowdealer.com
            </a>
          </span>
        </div>
      </section>
    </MarketingShell>
  );
}
