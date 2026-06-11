import { z } from "zod";

const backendEnvSchema = z.object({
  // Require these for the application to function
  CLERK_JWT_ISSUER_DOMAIN: z.string().url(),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  
  // Optional but recommended
  RESEND_API_KEY: z.string().startsWith("re_").optional(),
  CLERK_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
});

export function getValidatedEnv() {
  const result = backendEnvSchema.safeParse(process.env);
  
  if (!result.success) {
    const errorMsg = "Backend Environment Variables Missing/Invalid: " + 
      result.error.errors.map(e => `${e.path.join('.')}`).join(', ');
    console.error(errorMsg);
    throw new Error(errorMsg); // This will crash the action/mutation predictably
  }
  
  return result.data;
}
