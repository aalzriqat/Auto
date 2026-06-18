import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function firstName(name?: string | null) {
  if (!name) return name ?? undefined;
  return name.trim().split(/\s+/)[0];
}
