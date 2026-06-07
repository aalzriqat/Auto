"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCcw, Home } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error("Unhandled Application Error:", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-3xl shadow-xl border border-slate-100 overflow-hidden text-center p-8 relative">
        <div className="absolute top-0 inset-x-0 h-2 bg-gradient-to-r from-red-500 to-[#f97316]" />
        
        <div className="mb-8 flex justify-center">
          <Image src="/logo.png" alt="AutoFlow Logo" width={160} height={60} className="h-10 w-auto object-contain" />
        </div>

        <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-6">
          <AlertCircle className="w-8 h-8 text-red-500" />
        </div>

        <h2 className="text-2xl font-bold tracking-tight text-slate-900 mb-2">
          Oops! Something went wrong.
        </h2>
        
        <p className="text-slate-500 text-sm mb-8 leading-relaxed">
          We encountered an unexpected error while trying to process your request. Don't worry, our team has been notified.
        </p>

        <div className="flex flex-col gap-3">
          <Button 
            onClick={() => reset()} 
            className="w-full h-12 rounded-xl bg-slate-900 hover:bg-slate-800 text-white flex items-center justify-center gap-2"
          >
            <RefreshCcw className="w-4 h-4" />
            Try again
          </Button>
          
          <Link href="/dashboard" className="w-full">
            <Button 
              variant="outline" 
              className="w-full h-12 rounded-xl border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center justify-center gap-2"
            >
              <Home className="w-4 h-4" />
              Back to Dashboard
            </Button>
          </Link>
        </div>

        {/* Optional details in development */}
        {process.env.NODE_ENV === "development" && (
          <div className="mt-8 text-left bg-slate-100 rounded-lg p-4 overflow-auto max-h-32 border border-slate-200">
            <p className="text-xs font-mono text-slate-700 break-all">
              {error.message}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
