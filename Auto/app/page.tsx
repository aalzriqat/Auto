import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { ArrowRight, BarChart3, Car, Globe, FileText, CheckCircle2, Star } from "lucide-react";

export default function MarketingPage() {
  return (
    <div className="flex flex-col min-h-screen bg-white text-slate-800 font-sans selection:bg-[#0ea5e9]/20">
      
      {/* Navbar */}
      <header className="sticky top-0 z-50 w-full border-b border-slate-100 bg-white/80 backdrop-blur-md">
        <div className="container mx-auto px-4 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Image src="/logo.png" alt="AutoFlow Logo" width={200} height={80} className="w-36 h-auto object-contain" priority />
          </Link>
          
          <nav className="hidden md:flex gap-8 text-sm font-medium text-slate-600">
            <Link href="#features" className="hover:text-[#0ea5e9] transition-colors">Features</Link>
            <Link href="#pricing" className="hover:text-[#0ea5e9] transition-colors">Pricing</Link>
            <Link href="#faq" className="hover:text-[#0ea5e9] transition-colors">FAQ</Link>
          </nav>

          <div className="flex items-center gap-4">
            <Link href="/sign-in" className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors">
              Log in
            </Link>
            <Link href="/sign-up">
              <Button className="rounded-full shadow-sm bg-[#0ea5e9] hover:bg-[#0284c7] text-white">
                Get Started
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero Section */}
        <section className="relative pt-24 pb-32 overflow-hidden bg-gradient-to-b from-slate-50 to-white">
          {/* Background decorative elements */}
          <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-[#0ea5e9]/5 rounded-full blur-3xl -z-10 translate-x-1/3 -translate-y-1/4" />
          <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-[#06b6d4]/5 rounded-full blur-3xl -z-10 -translate-x-1/3 translate-y-1/4" />
          <div className="absolute top-1/2 left-1/2 w-[800px] h-[800px] bg-[#f97316]/5 rounded-full blur-3xl -z-10 -translate-x-1/2 -translate-y-1/2" />
          
          <div className="container mx-auto px-4 text-center max-w-5xl">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-slate-100 text-slate-700 text-sm font-medium mb-8 border border-slate-200">
              <span className="flex h-2 w-2 rounded-full bg-[#f97316] animate-pulse" />
              Revolutionizing Dealership Management
            </div>
            
            <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight text-slate-900 mb-8 leading-[1.1]">
              The Operating System for <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#0ea5e9] via-[#06b6d4] to-[#0284c7]">Modern Dealerships</span>
            </h1>
            
            <p className="text-xl text-slate-600 mb-10 max-w-2xl mx-auto leading-relaxed">
              Ditch the spreadsheets. Manage your vehicle inventory, track sales pipelines, and generate professional PDF quotes instantly.
            </p>
            
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link href="/sign-up">
                <Button size="lg" className="rounded-full h-14 px-8 text-base shadow-lg shadow-[#0ea5e9]/20 hover:shadow-xl hover:-translate-y-0.5 transition-all bg-[#0ea5e9] hover:bg-[#0284c7]">
                  Start 14-Day Free Trial
                  <ArrowRight className="ml-2 w-5 h-5" />
                </Button>
              </Link>
              <Button size="lg" variant="outline" className="rounded-full h-14 px-8 text-base bg-white border-slate-200 hover:bg-slate-50 text-slate-700">
                Book a Demo
              </Button>
            </div>
            
            <p className="mt-6 text-sm text-slate-500">No credit card required • Setup in 2 minutes</p>
          </div>

          {/* Abstract Mockup Area */}
          <div className="mt-20 container mx-auto px-4">
            <div className="relative mx-auto max-w-5xl rounded-2xl border border-slate-200/50 bg-white shadow-2xl overflow-hidden aspect-video">
              <div className="absolute inset-0 bg-slate-50/50 flex flex-col">
                <div className="h-12 border-b border-slate-200/50 flex items-center px-4 gap-2 bg-white">
                  <div className="w-3 h-3 rounded-full bg-red-400" />
                  <div className="w-3 h-3 rounded-full bg-amber-400" />
                  <div className="w-3 h-3 rounded-full bg-emerald-400" />
                </div>
                <div className="flex-1 relative w-full h-full bg-slate-100">
                  <Image 
                    src="/dashboard-mockup.png" 
                    alt="AutoFlow Dashboard" 
                    fill
                    className="object-cover object-top"
                    priority
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section id="features" className="py-24 bg-white border-y border-slate-100">
          <div className="container mx-auto px-4 max-w-6xl">
            <div className="text-center mb-16">
              <h2 className="text-3xl font-bold tracking-tight text-slate-900 mb-4">Everything you need to close more deals</h2>
              <p className="text-slate-600 max-w-2xl mx-auto">AutoFlow replaces 5 different tools with one seamless, lightning-fast platform designed specifically for auto dealerships.</p>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
              {[
                {
                  icon: Car,
                  color: "text-[#0ea5e9]",
                  bg: "bg-[#0ea5e9]/10",
                  title: "Inventory Management",
                  desc: "Track vehicles, VINs, purchase prices, and statuses in real-time. Never lose track of a car."
                },
                {
                  icon: BarChart3,
                  color: "text-[#f97316]",
                  bg: "bg-[#f97316]/10",
                  title: "Sales Pipeline",
                  desc: "Visual data tables to track every lead from 'New' to 'Won'. Identify bottlenecks instantly."
                },
                {
                  icon: FileText,
                  color: "text-[#06b6d4]",
                  bg: "bg-[#06b6d4]/10",
                  title: "Instant Quotes",
                  desc: "Generate professional PDF quotes and finance calculations with one single click."
                },
                {
                  icon: Globe,
                  color: "text-slate-700",
                  bg: "bg-slate-100",
                  title: "Bilingual Ready",
                  desc: "Full English and Arabic (RTL) support built directly into the core engine."
                }
              ].map((feature, i) => (
                <div key={i} className="p-8 rounded-3xl bg-white border border-slate-100 shadow-sm hover:shadow-xl transition-all hover:-translate-y-1">
                  <div className={`w-14 h-14 rounded-2xl ${feature.bg} flex items-center justify-center mb-6`}>
                    <feature.icon className={`w-7 h-7 ${feature.color}`} />
                  </div>
                  <h3 className="text-xl font-bold text-slate-900 mb-3">{feature.title}</h3>
                  <p className="text-slate-600 leading-relaxed text-sm">{feature.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Testimonials */}
        <section className="py-24 bg-slate-50">
          <div className="container mx-auto px-4 max-w-4xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-slate-900 mb-12">Trusted by top dealerships</h2>
            <div className="bg-white p-8 md:p-12 rounded-3xl shadow-sm border border-slate-100 relative">
              <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white px-4">
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Star key={i} className="w-6 h-6 text-[#f97316] fill-[#f97316]" />
                  ))}
                </div>
              </div>
              <p className="text-2xl font-medium text-slate-800 leading-relaxed mb-8 italic">
                "AutoFlow completely transformed our sales floor. We generate quotes in seconds instead of minutes, and our lead conversion rate has never been higher."
              </p>
              <div>
                <p className="font-bold text-slate-900">Michael Chen</p>
                <p className="text-sm text-slate-500">Sales Director, Downtown Motors</p>
              </div>
            </div>
          </div>
        </section>

        {/* Pricing Section */}
        <section id="pricing" className="py-24 bg-white">
          <div className="container mx-auto px-4 max-w-4xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-slate-900 mb-4">Simple, transparent pricing</h2>
            <p className="text-slate-600 mb-16">No per-user fees. One flat rate for your entire dealership.</p>

            <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden max-w-md mx-auto relative group hover:shadow-2xl transition-all">
              <div className="absolute top-0 inset-x-0 h-2 bg-gradient-to-r from-[#0ea5e9] to-[#06b6d4]" />
              <div className="p-8">
                <h3 className="text-2xl font-bold text-slate-900 mb-2">Dealership Plan</h3>
                <p className="text-slate-500 mb-6">Everything you need to run your showroom.</p>
                <div className="flex items-baseline justify-center gap-1 mb-8">
                  <span className="text-5xl font-extrabold text-slate-900">$149</span>
                  <span className="text-slate-500 font-medium">/month</span>
                </div>
                
                <ul className="space-y-4 text-left mb-8">
                  {[
                    "Unlimited User Seats",
                    "Unlimited Vehicles & Leads",
                    "Automated PDF Quotes",
                    "Arabic & English Support",
                    "Role-based Access Control",
                    "Daily Encrypted Backups"
                  ].map((feature, i) => (
                    <li key={i} className="flex items-center gap-3 text-slate-700 font-medium">
                      <CheckCircle2 className="w-5 h-5 text-[#0ea5e9] flex-shrink-0" />
                      {feature}
                    </li>
                  ))}
                </ul>

                <Link href="/sign-up" className="block w-full">
                  <Button size="lg" className="w-full rounded-xl h-14 text-base bg-[#0ea5e9] hover:bg-[#0284c7] text-white">
                    Start 14-Day Free Trial
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-slate-50 border-t border-slate-200 py-12">
        <div className="container mx-auto px-4 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2">
            <Image src="/logo.png" alt="AutoFlow Logo" width={140} height={50} className="w-28 h-auto object-contain grayscale opacity-60" />
          </div>
          <p className="text-slate-500 text-sm">
            © {new Date().getFullYear()} AutoFlow Inc. All rights reserved.
          </p>
          <div className="flex gap-4 text-sm text-slate-500">
            <Link href="#" className="hover:text-[#0ea5e9] transition-colors">Privacy Policy</Link>
            <Link href="#" className="hover:text-[#0ea5e9] transition-colors">Terms of Service</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
