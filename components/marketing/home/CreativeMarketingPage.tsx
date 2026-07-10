"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, useRef } from "react";
import { useLanguage } from "@/components/providers/LanguageProvider";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Globe,
  Layers,
  Menu,
  ShieldCheck,
  TrendingDown,
  Users,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { motion, AnimatePresence, useScroll, useTransform, useMotionValue, useSpring } from "framer-motion";
import { SiteVisitorTracker } from "@/components/analytics/SiteVisitorTracker";
import {
  copy,
  faqs,
  financeFeatures,
  growFeatures,
  opsFeatures,
  pipelineStages,
  platformModules,
  reportCards,
  roleColorMap,
  rolesData,
} from "./content";
import { useFinanceCalculator, usePipelineSimulation, useRoiEstimator } from "./hooks";
import { FeatureCardGrid } from "./ui";

function localize(locale: string, english: string, arabic: string) {
  return locale === "ar" ? arabic : english;
}

function localizeList<T>(locale: string, english: T, arabic: T) {
  return locale === "ar" ? arabic : english;
}

function ltrOnly(isRtl: boolean, className: string) {
  return isRtl ? "" : className;
}

function pipelineCardClasses(isActive: boolean, isDone: boolean) {
  if (isActive) {
    return "bg-blue-500/10 border-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.2)]";
  }

  if (isDone) {
    return "bg-white/[0.03] border-blue-500/40 text-white/80";
  }

  return "bg-white/[0.01] border-white/5 text-white/55";
}

function pipelineIconClasses(isActive: boolean, isDone: boolean) {
  if (isActive) {
    return "bg-blue-500 text-white animate-pulse";
  }

  if (isDone) {
    return "bg-blue-500/20 text-blue-400";
  }

  return "bg-white/5 text-white/50";
}

function pipelineStatusClasses(isActive: boolean, isDone: boolean) {
  if (isActive) {
    return "bg-blue-500/20 text-blue-300";
  }

  if (isDone) {
    return "bg-white/5 text-white/60";
  }

  return "bg-white/5 text-white/40";
}

export default function CreativeMarketingPage() {
  const { locale, setLocale, isRtl } = useLanguage();
  const t = copy[locale] || copy.en;
  const currencyLabel = localize(locale, "JOD", "د.أ");
  const monthlyPeriodLabel = localize(locale, "mo", "شهرياً");

  const toggleLanguage = () => {
    setLocale(locale === "en" ? "ar" : "en");
  };

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const trackMouseGlow = (e: React.MouseEvent) => {
    setMousePos({ x: e.clientX, y: e.clientY });
  };

  const pageContainerRef = useRef<HTMLDivElement>(null);
  const mockupSectionRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: mockupSectionRef,
    offset: ["start end", "end start"]
  });

  const mockupScale = useTransform(scrollYProgress, [0, 0.4], [0.85, 1.05]);
  const mockupRotateX = useTransform(scrollYProgress, [0, 0.4], [15, 0]);
  const mockupTranslateY = useTransform(scrollYProgress, [0, 0.4], [60, 0]);

  const cardX = useMotionValue(0);
  const cardY = useMotionValue(0);
  const tiltRotateX = useTransform(cardY, [-200, 200], [10, -10]);
  const tiltRotateY = useTransform(cardX, [-300, 300], [-10, 10]);
  const springConfig = { damping: 25, stiffness: 180 };
  const springRotateX = useSpring(tiltRotateX, springConfig);
  const springRotateY = useSpring(tiltRotateY, springConfig);

  const tiltMockupTowardPointer = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const clientX = e.clientX - rect.left - width / 2;
    const clientY = e.clientY - rect.top - height / 2;
    cardX.set(clientX);
    cardY.set(clientY);
  };

  const resetMockupTilt = () => {
    cardX.set(0);
    cardY.set(0);
  };

  const {
    carPrice,
    downPayment,
    apr,
    term,
    principal,
    monthlyInstallment,
    totalPaid,
    totalInterest,
    principalPercent,
    strokeDasharray,
    strokeDashoffset,
    setCarPrice,
    setDownPayment,
    setApr,
    setTerm,
  } = useFinanceCalculator();

  const { pipelineStage, advancePipelineStage, simulatePipelineAutoRun } = usePipelineSimulation();
  const currentPipelineStage = pipelineStages[pipelineStage];

  const {
    monthlySales,
    setMonthlySales,
    hoursSavedPerWk,
    annualSavingsDollars,
  } = useRoiEstimator();

  const [activeFaq, setActiveFaq] = useState<number | null>(null);

  return (
    <div
      ref={pageContainerRef}
      onMouseMove={trackMouseGlow}
      className={`dark relative min-h-screen bg-[#030014] text-white selection:bg-blue-500/30 overflow-hidden font-sans`}
      style={{ direction: isRtl ? "rtl" : "ltr" }}
    >
      <SiteVisitorTracker path="/" />

      {/* 20-Year Exp Interactive Background Canvas */}
      {/* 1. Global mouse follower glow */}
      <div
        className="fixed inset-0 pointer-events-none z-0 transition-opacity duration-500"
        style={{
          background: `radial-gradient(700px circle at ${mousePos.x}px ${mousePos.y}px, rgba(59, 130, 246, 0.08), transparent 45%)`
        }}
      />
      {/* 2. Abstract Glowing Vector Grid */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#1f29370f_1px,transparent_1px),linear-gradient(to_bottom,#1f29370f_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] pointer-events-none z-0" />

      {/* 3. Deep Cinematic Nebula Orbs */}
      <div className="absolute top-[-10%] right-[-5%] w-[45vw] h-[45vw] rounded-full bg-blue-600/10 blur-[130px] animate-pulse pointer-events-none z-0" style={{ animationDuration: "12s" }} />
      <div className="absolute bottom-[20%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-blue-500/5 blur-[150px] pointer-events-none z-0" />
      <div className="absolute top-[40%] left-[30%] w-[35vw] h-[35vw] rounded-full bg-orange-600/5 blur-[140px] pointer-events-none z-0" />

      {/* Bespoke Header */}
      <header className="fixed top-0 inset-x-0 z-50 w-full bg-[#030014]/40 backdrop-blur-2xl border-b border-white/5 transition-all duration-300">
        <div className="container mx-auto px-6 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 relative z-10">
            <Image
              src="/logo.png"
              alt="AutoFlow Logo"
              width={160}
              height={50}
              className="w-28 h-auto object-contain opacity-95 transition-transform duration-500 hover:scale-105"
              priority
            />
          </Link>

          <nav className={`hidden lg:flex items-center gap-8 text-sm font-semibold text-white/75 uppercase ${ltrOnly(isRtl, "tracking-wider")}`}>
            <a href="#features" className="hover:text-white transition-colors duration-300 relative group py-2">
              {t.navFeatures}
              <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-blue-500 group-hover:w-full transition-all duration-300" />
            </a>
            <a href="#calculator" className="hover:text-white transition-colors duration-300 relative group py-2">
              {t.navCalculator}
              <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-blue-500 group-hover:w-full transition-all duration-300" />
            </a>
            <a href="#workflow" className="hover:text-white transition-colors duration-300 relative group py-2">
              {t.navWorkflow}
              <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-blue-500 group-hover:w-full transition-all duration-300" />
            </a>
            <a href="#analytics" className="hover:text-white transition-colors duration-300 relative group py-2">
              {t.navReports}
              <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-blue-500 group-hover:w-full transition-all duration-300" />
            </a>
            <Link href="/contact" className="hover:text-white transition-colors duration-300 relative group py-2">
              {t.navContact}
              <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-blue-500 group-hover:w-full transition-all duration-300" />
            </Link>
          </nav>

          <div className="flex items-center gap-4 z-10">
            {/* Language Switcher */}
            <button
              onClick={toggleLanguage}
              className="px-3 py-1.5 rounded-lg border border-white/10 hover:border-white/20 bg-white/5 hover:bg-white/10 text-xs font-bold uppercase transition-all duration-300 flex items-center gap-1.5 cursor-pointer text-white/80"
            >
              <Globe className="w-3.5 h-3.5" />
              <span>{locale === "en" ? "العربية" : "EN"}</span>
            </button>

            <Link href="/sign-in" className="text-sm font-bold text-white/75 hover:text-white transition-colors duration-300 py-2">
              {t.navLogin}
            </Link>

            <Link href="/sign-up" className="relative group">
              <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-500 to-orange-600 rounded-full blur opacity-40 group-hover:opacity-100 transition duration-700" />
              <button className="relative px-6 py-2.5 bg-black hover:bg-[#07051a] rounded-full flex items-center gap-2 border border-white/10 group-hover:border-blue-500/30 transition-colors duration-300 cursor-pointer">
                <span className="text-white text-xs font-bold">{t.navStart}</span>
                {isRtl ? <ArrowLeft className="w-3.5 h-3.5 text-white/70" /> : <ArrowRight className="w-3.5 h-3.5 text-white/70" />}
              </button>
            </Link>

            {/* Mobile Menu Icon */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden p-1.5 text-white/80 hover:text-white"
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Menu overlay */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.2 }}
            className="fixed top-20 inset-x-0 z-40 bg-[#030014]/95 border-b border-white/5 p-6 backdrop-blur-3xl lg:hidden flex flex-col gap-4 text-center"
          >
            <a
              href="#features"
              onClick={() => setMobileMenuOpen(false)}
              className="py-2.5 text-sm font-semibold hover:text-blue-400 transition-colors"
            >
              {t.navFeatures}
            </a>
            <a
              href="#calculator"
              onClick={() => setMobileMenuOpen(false)}
              className="py-2.5 text-sm font-semibold hover:text-blue-400 transition-colors"
            >
              {t.navCalculator}
            </a>
            <a
              href="#workflow"
              onClick={() => setMobileMenuOpen(false)}
              className="py-2.5 text-sm font-semibold hover:text-blue-400 transition-colors"
            >
              {t.navWorkflow}
            </a>
            <a
              href="#analytics"
              onClick={() => setMobileMenuOpen(false)}
              className="py-2.5 text-sm font-semibold hover:text-blue-400 transition-colors"
            >
              {t.navReports}
            </a>
            <Link
              href="/contact"
              onClick={() => setMobileMenuOpen(false)}
              className="py-2.5 text-sm font-semibold hover:text-blue-400 transition-colors"
            >
              {t.navContact}
            </Link>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="relative z-10 pt-20">

        {/* Cinematic Premium Hero */}
        <section className="relative min-h-[90vh] flex items-center justify-center pt-16 pb-12">
          <div className="container mx-auto px-6 max-w-6xl flex flex-col items-center text-center">

            {/* Split Title Animations */}
            <h1 className="text-[2.25rem] sm:text-[4rem] lg:text-[5.5rem] font-black leading-[1.05] tracking-tight mb-8">
              <motion.span
                initial={{ opacity: 0, y: 35 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
                className="block text-white"
              >
                {t.heroTitle1}
              </motion.span>
              <motion.span
                initial={{ opacity: 0, y: 35 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="block text-transparent bg-clip-text bg-gradient-to-r from-blue-200 via-blue-400 to-cyan-400"
              >
                {t.heroTitle2}
              </motion.span>
            </h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1.2, delay: 0.5 }}
              className="text-base sm:text-lg lg:text-xl text-white/65 max-w-2xl mx-auto leading-relaxed font-medium mb-12"
            >
              {t.heroSubhead}
            </motion.p>

            {/* Button Interactions */}
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1, delay: 0.7 }}
              className="flex flex-col sm:flex-row items-center gap-5 justify-center w-full"
            >
              <Link href="/sign-up" className="relative group w-full sm:w-auto">
                <div className="absolute -inset-1 bg-gradient-to-r from-blue-500 to-blue-600 rounded-full blur opacity-60 group-hover:opacity-100 transition duration-700" />
                <button className="relative w-full sm:w-auto px-10 py-4.5 bg-white text-black font-bold rounded-full flex items-center justify-center gap-3 hover:bg-white/95 transition-colors cursor-pointer text-sm">
                  <span>{t.heroCTA}</span>
                  {isRtl ? <ArrowLeft className="w-4 h-4" /> : <ArrowRight className="w-4 h-4" />}
                </button>
              </Link>

              <a href="#features" className="w-full sm:w-auto">
                <button className={`w-full sm:w-auto px-8 py-4.5 bg-white/5 border border-white/10 hover:border-white/20 rounded-full text-sm font-semibold text-white/80 hover:text-white backdrop-blur-md transition-all duration-300 cursor-pointer ${ltrOnly(isRtl, "tracking-wide")}`}>
                  {t.heroDemo}
                </button>
              </a>
            </motion.div>
          </div>
        </section>

        {/* Scroll-Linked 3D Mockup Showcase */}
        <section ref={mockupSectionRef} className="relative w-full px-6 pb-24 z-20">
          <div className="max-w-6xl mx-auto flex justify-center">

            {/* Animated Parent Wrapper (Links to scroll zoom & perspective rotate) */}
            <motion.div
              style={{
                scale: mockupScale,
                rotateX: mockupRotateX,
                y: mockupTranslateY,
                transformPerspective: 1200,
              }}
              className="w-full"
            >

              {/* Inner Mouse Parallax Tilt Container */}
              <motion.div
                onMouseMove={tiltMockupTowardPointer}
                onMouseLeave={resetMockupTilt}
                style={{
                  rotateX: springRotateX,
                  rotateY: springRotateY,
                }}
                className="relative w-full rounded-2xl md:rounded-3xl border border-white/10 bg-[#090622]/85 shadow-[0_0_120px_rgba(59,130,246,0.15)] overflow-hidden aspect-[16/10] backdrop-blur-3xl transition-shadow duration-700 hover:shadow-[0_0_150px_rgba(59,130,246,0.25)] group"
              >

                {/* Visual Glass Overlay reflection */}
                <div className="absolute inset-0 bg-gradient-to-tr from-white/0 via-white/5 to-white/0 opacity-0 group-hover:opacity-100 transition-opacity duration-1000 pointer-events-none" />

                {/* Browser Top Bar */}
                <div className="h-12 border-b border-white/5 flex items-center justify-between px-6 gap-3 select-none" style={{ direction: "ltr" }}>
                  <div className="flex gap-2">
                    <div className="w-3 h-3 rounded-full bg-red-500/60" />
                    <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
                    <div className="w-3 h-3 rounded-full bg-green-500/60" />
                  </div>
                  <div className="bg-white/5 px-6 py-1 rounded text-[10px] text-white/50 font-semibold tracking-wider w-40 text-center truncate">
                    autoflow.io/dashboard
                  </div>
                  <div className="w-16" />
                </div>

                {/* Live mock screen display */}
                <div className="relative w-full h-[calc(100%-3rem)] bg-[#030014] select-none overflow-hidden">
                  <Image
                    src="/dashboard.png"
                    alt="AutoFlow Enterprise Dashboard Interface Preview"
                    fill
                    priority
                    className="object-cover object-top opacity-85 group-hover:opacity-95 transition-opacity duration-700"
                  />

                  {/* Internal ambient glowing points */}
                  <div className="absolute top-1/4 left-1/3 w-32 h-32 bg-blue-500/10 rounded-full blur-3xl" />
                  <div className="absolute bottom-1/4 right-1/4 w-40 h-40 bg-orange-500/10 rounded-full blur-3xl" />
                </div>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* Platform Module Index — every department, one glance */}
        <section id="platform" className="py-20 relative border-t border-white/5 bg-[#030014]">
          <div className="container mx-auto px-6 max-w-6xl">
            <div className="text-center mb-14">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.platformTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-2xl mx-auto font-medium leading-relaxed">
                {t.platformSub}
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
              {platformModules.map((mod, idx) => {
                const Icon = mod.icon;
                return (
                  <motion.div
                    key={mod.titleEn}
                    initial={{ opacity: 0, y: 16 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: idx * 0.03 }}
                    className="group flex flex-col items-center justify-center gap-2.5 text-center p-4 rounded-2xl bg-white/[0.02] border border-white/5 hover:border-blue-500/30 hover:bg-white/[0.05] transition-all duration-300"
                  >
                    <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/10 flex items-center justify-center group-hover:bg-blue-500/20 transition-colors duration-300">
                      <Icon className="w-4.5 h-4.5 text-blue-400" />
                    </div>
                    <span className="text-[10px] sm:text-[11px] font-bold text-white/70 group-hover:text-white leading-tight transition-colors duration-300">
                      {localize(locale, mod.titleEn, mod.titleAr)}
                    </span>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Bento Grid Features Showcase */}
        <section id="features" className="py-24 relative border-t border-white/5 bg-white/[0.01]">
          <div className="container mx-auto px-6 max-w-6xl">
            <div className="text-center mb-20">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-4">
                {t.bentoTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-2xl mx-auto font-medium leading-relaxed">
                {t.bentoSub}
              </p>
            </div>

            {/* Asymmetrical Bento Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 auto-rows-[280px] md:auto-rows-[260px]">

              {/* Feature 1: Live Inventory (Double Column) */}
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8 }}
                className="md:col-span-2 md:row-span-2 rounded-2xl bg-gradient-to-br from-white/5 to-[#05031b] border border-white/5 p-8 relative overflow-hidden group hover:border-blue-500/30 transition-all duration-500 flex flex-col justify-between"
              >
                {/* Floating graphic overlay */}
                <div className="absolute top-0 right-0 w-80 h-80 bg-blue-500/[0.02] rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none" />

                {/* Interactive Showroom Stock Mini-Widget */}
                <div className="relative z-10 w-full h-full flex flex-col justify-between gap-6">
                  <div className="flex items-center justify-between">
                    <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                      <Layers className="w-5 h-5 text-blue-400" />
                    </div>
                    <span className="text-[10px] font-bold text-blue-400/80 uppercase tracking-widest bg-blue-500/5 px-3 py-1 rounded-full border border-blue-500/10">Interactive Sandbox</span>
                  </div>

                  {/* Mock Inventory List */}
                  <div className="space-y-2.5 my-4">
                    {[
                      { name: "Toyota Land Cruiser GXR", vin: "JTMHV05J504123456", status: "Available", statusAr: "متوفرة", color: "text-emerald-400 bg-emerald-400/5 border-emerald-400/20", price: `47,500 ${currencyLabel}` },
                      { name: "Hyundai Tucson 2024", vin: "KM8J3CAL2RU123456", status: "Reserved", statusAr: "محجوزة", color: "text-amber-400 bg-amber-400/5 border-amber-400/20", price: `28,900 ${currencyLabel}` },
                      { name: "Porsche 911 Carrera S", vin: "WP0AB2A99NS123456", status: "Sold", statusAr: "مباعة", color: "text-blue-400 bg-blue-400/5 border-blue-400/20", price: `165,000 ${currencyLabel}` }
                    ].map((car) => (
                      <div
                        key={car.vin}
                        className="flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] hover:border-white/10 transition-all duration-300"
                      >
                        <div className="flex flex-col text-left" style={{ direction: "ltr" }}>
                          <span className="text-xs font-bold text-white/90">{car.name}</span>
                          <span className="text-[9px] text-white/50 font-semibold mt-0.5">VIN: {car.vin}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-extrabold text-white/80">{car.price}</span>
                          <span className={`text-[10px] font-extrabold px-2.5 py-0.5 rounded border ${car.color}`}>
                            {localize(locale, car.status, car.statusAr)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div>
                    <h3 className="text-lg sm:text-xl font-bold text-white mb-2">{t.bentoCard1Title}</h3>
                    <p className="text-xs sm:text-sm text-white/65 leading-relaxed max-w-xl">{t.bentoCard1Desc}</p>
                  </div>
                </div>
              </motion.div>

              {/* Feature 2: Sync Engine (Single Column) */}
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8, delay: 0.15 }}
                className="rounded-2xl bg-[#090622]/85 border border-white/5 p-6 relative overflow-hidden group hover:border-white/20 transition-all duration-500 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <Zap className="w-5 h-5 text-blue-400" />
                  </div>
                  {/* Ping Animation indicator */}
                  <div className="flex items-center gap-1.5 bg-emerald-500/5 px-2.5 py-1 rounded border border-emerald-500/10">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
                    <span className="text-[9px] text-emerald-400 font-extrabold tracking-wider uppercase">Active Live Sync</span>
                  </div>
                </div>

                {/* Ping speedometer mock */}
                <div className="bg-black/40 rounded-xl p-3 border border-white/5 text-center my-2 select-none" style={{ direction: "ltr" }}>
                  <div className="text-xs text-white/60 font-bold mb-1">Websocket Latency</div>
                  <div className="text-2xl font-black text-blue-400 tracking-tight">
                    12<span className="text-xs text-white/60 font-semibold ml-0.5">ms</span>
                  </div>
                  <div className="text-[9px] text-white/40 font-bold mt-1">Convex Reactive Subscriptions</div>
                </div>

                <div>
                  <h3 className="text-base font-bold text-white mb-1">{t.bentoCard2Title}</h3>
                  <p className="text-xs text-white/60 leading-relaxed">{t.bentoCard2Desc}</p>
                </div>
              </motion.div>

              {/* Feature 3: Margin Safeguards (Single Column) */}
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8, delay: 0.25 }}
                className="rounded-2xl bg-[#090622]/85 border border-white/5 p-6 relative overflow-hidden group hover:border-white/20 transition-all duration-500 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <ShieldCheck className="w-5 h-5 text-blue-400" />
                  </div>
                  <span className="text-[9px] font-bold text-red-400 uppercase tracking-widest bg-red-500/5 px-2 py-0.5 rounded border border-red-500/10">Security Trigger</span>
                </div>

                {/* Overrides Banner Mock */}
                <div className="bg-red-500/5 rounded-xl p-3 border border-red-500/10 my-2 text-left" style={{ direction: "ltr" }}>
                  <div className="flex items-center gap-1 text-[10px] text-red-400 font-extrabold mb-1">
                    <TrendingDown className="w-3.5 h-3.5" />
                    <span>Margin Fallback Alert</span>
                  </div>
                  <div className="text-[10px] text-white/60 leading-tight">Sale #1092 requires profit approval.</div>
                </div>

                <div>
                  <h3 className="text-base font-bold text-white mb-1">{t.bentoCard3Title}</h3>
                  <p className="text-xs text-white/60 leading-relaxed">{t.bentoCard3Desc}</p>
                </div>
              </motion.div>

              {/* Feature 4: Client Profile Hub (Single Column) */}
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8, delay: 0.3 }}
                className="rounded-2xl bg-[#090622]/85 border border-white/5 p-6 relative overflow-hidden group hover:border-white/20 transition-all duration-500 flex flex-col justify-between md:col-span-1"
              >
                <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                  <Users className="w-5 h-5 text-blue-400" />
                </div>

                {/* Customer tags list mock */}
                <div className="flex flex-wrap gap-1.5 my-2">
                  {["Score: 785", "Capital One Approved", "Active Lease", "3 Visits"].map((tag) => (
                    <span key={tag} className="text-[9px] font-bold px-2 py-0.5 rounded bg-white/5 border border-white/5 text-white/70">
                      {tag}
                    </span>
                  ))}
                </div>

                <div>
                  <h3 className="text-base font-bold text-white mb-1">{t.bentoCard4Title}</h3>
                  <p className="text-xs text-white/60 leading-relaxed">{t.bentoCard4Desc}</p>
                </div>
              </motion.div>

            </div>
          </div>
        </section>

        {/* Role-Based Access Showcase */}
        <section id="roles" className="py-24 relative border-t border-white/5 bg-[#030014]">
          <div className="container mx-auto px-6 max-w-6xl">
            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.rolesTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-2xl mx-auto font-medium leading-relaxed">
                {t.rolesSub}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-5">
              {rolesData.map((role, idx) => {
                const Icon = role.icon;
                const colors = roleColorMap[role.color];
                return (
                  <motion.div
                    key={role.nameEn}
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: idx * 0.08 }}
                    className={`relative rounded-2xl border ${colors.ring} bg-white/[0.02] p-6 flex flex-col gap-4 hover:bg-white/[0.04] transition-all duration-500 group`}
                  >
                    <div
                      className="absolute -top-10 -right-10 w-32 h-32 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none"
                      style={{ backgroundColor: colors.glow }}
                    />
                    <div className={`w-11 h-11 rounded-xl ${colors.bg} flex items-center justify-center relative z-10`}>
                      <Icon className={`w-5 h-5 ${colors.text}`} />
                    </div>
                    <div className="relative z-10">
                      <h3 className="text-base font-extrabold text-white">{localize(locale, role.nameEn, role.nameAr)}</h3>
                      <span className={`text-[10px] font-bold uppercase ${colors.text} ${ltrOnly(isRtl, "tracking-wide")}`}>
                        {localize(locale, role.taglineEn, role.taglineAr)}
                      </span>
                    </div>
                    <ul className="space-y-2 relative z-10">
                      {localizeList(locale, role.bulletsEn, role.bulletsAr).map((bullet) => (
                        <li key={bullet} className="flex items-start gap-2 text-[11px] text-white/55 leading-snug font-medium">
                          <Check className={`w-3 h-3 mt-0.5 shrink-0 ${colors.text}`} />
                          <span>{bullet}</span>
                        </li>
                      ))}
                    </ul>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Finance Department: GL, bank reconciliation, VAT, installments */}
        <section id="finance" className="py-24 relative border-t border-white/5 bg-white/[0.01]">
          <div className="container mx-auto px-6 max-w-6xl">
            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.financeTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-2xl mx-auto font-medium leading-relaxed">
                {t.financeSub}
              </p>
            </div>

            <FeatureCardGrid
              features={financeFeatures}
              locale={locale}
              gridClassName="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5"
              cardClassName="rounded-2xl bg-gradient-to-br from-white/5 to-[#05031b] border border-white/5 p-6 hover:border-blue-500/30 transition-all duration-500 flex flex-col gap-4"
              iconWrapClassName="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center"
              titleClassName="text-sm font-bold text-white mb-1.5"
              descClassName="text-xs text-white/62 leading-relaxed"
              delayStep={0.08}
            />
          </div>
        </section>

        {/* Dynamic Auto Loan Financing Estimator Section */}
        <section id="calculator" className="py-24 relative border-t border-white/5 bg-[#030014]">
          <div className="container mx-auto px-6 max-w-6xl">

            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.calcTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-xl mx-auto font-medium">
                {t.calcSub}
              </p>
            </div>

            {/* Split layout: inputs vs outputs */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">

              {/* Sliders Input Panel */}
              <div className="lg:col-span-7 bg-white/[0.02] border border-white/5 rounded-3xl p-8 backdrop-blur-md flex flex-col justify-between gap-8">

                {/* 1. Vehicle Value Slider */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-bold text-white/75">{t.calcVal}</span>
                    <span className="font-black text-blue-400 text-lg" style={{ direction: "ltr" }}>
                      {carPrice.toLocaleString()} {currencyLabel}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="15000"
                    max="250000"
                    step="5000"
                    value={carPrice}
                    onChange={(e) => setCarPrice(Number(e.target.value))}
                    className="w-full accent-blue-500 h-1.5 bg-white/5 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-white/40 font-bold" style={{ direction: "ltr" }}>
                    <span>15,000 JOD</span>
                    <span>250,000 JOD</span>
                  </div>
                </div>

                {/* 2. Down Payment Slider */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-bold text-white/75">{t.calcDown}</span>
                    <span className="font-black text-blue-400 text-lg" style={{ direction: "ltr" }}>
                      {downPayment.toLocaleString()} {currencyLabel}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max={carPrice}
                    step="2000"
                    value={downPayment}
                    onChange={(e) => setDownPayment(Number(e.target.value))}
                    className="w-full accent-blue-500 h-1.5 bg-white/5 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-white/40 font-bold" style={{ direction: "ltr" }}>
                    <span>0 JOD</span>
                    <span>Max ({carPrice ? `${carPrice.toLocaleString()} JOD` : ""})</span>
                  </div>
                </div>

                {/* 3. Interest Rate Slider */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-bold text-white/75">{t.calcRate}</span>
                    <span className="font-black text-blue-400 text-lg" style={{ direction: "ltr" }}>
                      {apr.toFixed(1)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1.9"
                    max="17.9"
                    step="0.1"
                    value={apr}
                    onChange={(e) => setApr(Number(e.target.value))}
                    className="w-full accent-blue-500 h-1.5 bg-white/5 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-white/40 font-bold" style={{ direction: "ltr" }}>
                    <span>1.9%</span>
                    <span>17.9%</span>
                  </div>
                </div>

                {/* 4. Financing Term Select buttons */}
                <div className="space-y-3">
                  <span className="text-sm font-bold text-white/75 block">{t.calcTerm}</span>
                  <div className="grid grid-cols-4 gap-3">
                    {[24, 36, 48, 60, 72].map((m) => (
                      <button
                        key={m}
                        onClick={() => setTerm(m)}
                        className={`py-3 rounded-xl border text-xs font-bold transition-all duration-300 cursor-pointer ${term === m
                            ? "bg-blue-500 border-blue-500 text-white shadow-[0_0_15px_rgba(59,130,246,0.4)]"
                            : "bg-white/5 border-white/5 text-white/75 hover:bg-white/10 hover:border-white/10"
                          }`}
                      >
                        {m} {t.calcMonths}
                      </button>
                    ))}
                  </div>
                </div>

              </div>

              {/* Dynamic Calculations Visualizer Panel */}
              <div className="lg:col-span-5 bg-gradient-to-b from-[#090622] to-black border border-white/5 rounded-3xl p-8 flex flex-col justify-between gap-8 relative overflow-hidden group">
                {/* Glowing ring backdrop */}
                <div className="absolute -top-1/4 -right-1/4 w-60 h-60 bg-blue-500/[0.04] rounded-full blur-3xl" />

                <div className="text-center relative z-10">
                  <span className={`text-[10px] font-extrabold text-white/50 uppercase ${ltrOnly(isRtl, "tracking-widest")}`}>{t.calcMonthly}</span>
                  <div className="text-4xl sm:text-5xl font-black text-white mt-1 mb-2" style={{ direction: "ltr" }}>
                    {Math.round(monthlyInstallment).toLocaleString()} <span className="text-xl font-bold">{currencyLabel}</span>
                    <span className={`text-sm font-light text-white/60 ${ltrOnly(isRtl, "tracking-wider")}`}> / {monthlyPeriodLabel}</span>
                  </div>
                </div>

                {/* Graphic Circle Diagram */}
                <div className="flex justify-center items-center my-4 relative z-10">
                  <svg className="w-36 h-36 transform -rotate-90 select-none">
                    {/* Secondary/Interest Ring */}
                    <circle
                      cx="72"
                      cy="72"
                      r="48"
                      className="stroke-orange-500/20"
                      strokeWidth="10"
                      fill="transparent"
                    />
                    {/* Principal Ring */}
                    <circle
                      cx="72"
                      cy="72"
                      r="48"
                      className="stroke-blue-500 transition-all duration-500"
                      strokeWidth="10"
                      fill="transparent"
                      strokeDasharray={strokeDasharray}
                      strokeDashoffset={strokeDashoffset}
                      strokeLinecap="round"
                    />
                  </svg>

                  {/* Digital percentage display inside circle */}
                  <div className="absolute flex flex-col items-center select-none" style={{ direction: "ltr" }}>
                    <span className="text-lg font-black text-white">{Math.round(principalPercent)}%</span>
                    <span className={`text-[8px] text-white/50 font-bold uppercase ${ltrOnly(isRtl, "tracking-wider")}`}>{t.calcPrinc}</span>
                  </div>
                </div>

                {/* Numeric details list */}
                <div className="space-y-3.5 relative z-10 border-t border-white/5 pt-6">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-white/60 font-bold">{t.calcPrinc}</span>
                    <span className="text-white font-extrabold" style={{ direction: "ltr" }}>
                      {principal.toLocaleString()} {currencyLabel}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-white/60 font-bold">{t.calcInterest}</span>
                    <span className="text-orange-400 font-extrabold" style={{ direction: "ltr" }}>
                      {Math.round(totalInterest).toLocaleString()} {currencyLabel}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs border-t border-white/5 pt-3">
                    <span className="text-white/60 font-bold">{t.calcTotalPaid}</span>
                    <span className="text-white font-black text-sm" style={{ direction: "ltr" }}>
                      {Math.round(totalPaid).toLocaleString()} {currencyLabel}
                    </span>
                  </div>
                </div>

              </div>

            </div>

          </div>
        </section>

        {/* Live Deal Flow / Pipeline automation simulation section */}
        <section id="workflow" className="py-24 relative border-t border-white/5 bg-white/[0.01]">
          <div className="container mx-auto px-6 max-w-6xl">

            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.pipeTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-xl mx-auto font-medium">
                {t.pipeSub}
              </p>
            </div>

            {/* Workflow Widget Layout */}
            <div className="bg-gradient-to-br from-white/5 to-[#05031b] border border-white/5 rounded-3xl p-8 backdrop-blur-md">

              {/* Line Connector Progress Visual */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 items-center relative mb-12">
                {pipelineStages.map((stage, idx) => {
                  const isActive = pipelineStage === idx;
                  const isDone = pipelineStage >= idx;

                  return (
                    <div
                      key={stage.labelEn}
                      className={`relative p-5 rounded-2xl border transition-all duration-500 text-center select-none ${pipelineCardClasses(isActive, isDone)}`}
                    >
                      <div className="absolute top-3 right-3 text-[10px] font-black opacity-35">0{idx + 1}</div>

                      <div className="flex justify-center mb-3">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors duration-500 ${pipelineIconClasses(isActive, isDone)}`}>
                          <Workflow className="w-4 h-4" />
                        </div>
                      </div>

                      <div className="text-xs sm:text-sm font-black mb-1">
                        {localize(locale, stage.labelEn, stage.labelAr)}
                      </div>
                      <div className={`text-[9px] font-bold px-2 py-0.5 rounded inline-block ${pipelineStatusClasses(isActive, isDone)}`}>
                        {localize(locale, stage.statusEn, stage.statusAr)}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Detail breakdown box */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-center border-t border-white/5 pt-8">

                <div className="md:col-span-8 space-y-4">
                  <div className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 px-3.5 py-1 rounded-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                    <span className="text-[10px] font-black uppercase text-blue-300 tracking-wider">
                      Stage {pipelineStage + 1} Details
                    </span>
                  </div>

                  <h4 className="text-xl sm:text-2xl font-black text-white">
                    {localize(locale, currentPipelineStage.labelEn, currentPipelineStage.labelAr)}
                  </h4>
                  <p className="text-xs sm:text-sm text-white/65 leading-relaxed max-w-xl">
                    {localize(locale, currentPipelineStage.descEn, currentPipelineStage.descAr)}
                  </p>
                </div>

                <div className="md:col-span-4 flex flex-col md:flex-row gap-3 md:justify-end">
                  <button
                    onClick={advancePipelineStage}
                    className="px-6 py-3 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer"
                  >
                    {t.pipeBtn}
                  </button>
                  <button
                    onClick={simulatePipelineAutoRun}
                    className="px-6 py-3 bg-white/5 border border-white/10 hover:border-white/20 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer"
                  >
                    {t.pipeBtnAuto}
                  </button>
                </div>

              </div>

            </div>

          </div>
        </section>

        {/* Reports & Analytics Gallery */}
        <section id="analytics" className="py-24 relative border-t border-white/5 bg-white/[0.01]">
          <div className="container mx-auto px-6 max-w-6xl">
            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.analyticsTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-2xl mx-auto font-medium leading-relaxed">
                {t.analyticsSub}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {reportCards.map((report, idx) => {
                const Icon = report.icon;
                const barHeights = [40, 70, 55, 85, 60, 95];
                return (
                  <motion.div
                    key={report.titleEn}
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: idx * 0.07 }}
                    className="rounded-2xl bg-gradient-to-br from-white/5 to-[#05031b] border border-white/5 p-6 hover:border-blue-500/30 transition-all duration-500 group flex flex-col gap-5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                        <Icon className="w-5 h-5 text-blue-400" />
                      </div>
                      <div className="flex items-end gap-1 h-8" style={{ direction: "ltr" }}>
                        {barHeights.map((h) => (
                          <div
                            key={h}
                            className="w-1.5 rounded-full bg-blue-500/20 group-hover:bg-blue-500/50 transition-all duration-500"
                            style={{ height: `${h}%` }}
                          />
                        ))}
                      </div>
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white mb-1.5">{localize(locale, report.titleEn, report.titleAr)}</h3>
                      <p className="text-xs text-white/62 leading-relaxed">{localize(locale, report.descEn, report.descAr)}</p>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Operations: branches, approvals, bulk tools, custom fields */}
        <section id="operations" className="py-24 relative border-t border-white/5 bg-[#030014]">
          <div className="container mx-auto px-6 max-w-6xl">
            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.opsTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-2xl mx-auto font-medium leading-relaxed">
                {t.opsSub}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {opsFeatures.map((feature, idx) => {
                const Icon = feature.icon;
                return (
                  <motion.div
                    key={feature.titleEn}
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: idx * 0.08 }}
                    className="rounded-2xl bg-[#090622]/85 border border-white/5 p-6 hover:border-white/20 transition-all duration-500 flex flex-col gap-4"
                  >
                    <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                      <Icon className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white mb-1.5">{localize(locale, feature.titleEn, feature.titleAr)}</h3>
                      <p className="text-xs text-white/62 leading-relaxed">{localize(locale, feature.descEn, feature.descAr)}</p>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Grow Beyond The Showroom: website builder, social inbox, team chat */}
        <section id="grow" className="py-24 relative border-t border-white/5 bg-white/[0.01]">
          <div className="container mx-auto px-6 max-w-6xl">
            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.growTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-2xl mx-auto font-medium leading-relaxed">
                {t.growSub}
              </p>
            </div>

            <FeatureCardGrid
              features={growFeatures}
              locale={locale}
              gridClassName="grid grid-cols-1 md:grid-cols-3 gap-6"
              cardClassName="rounded-2xl bg-gradient-to-br from-white/5 to-[#05031b] border border-white/5 p-7 hover:border-blue-500/30 transition-all duration-500 flex flex-col gap-4"
              iconWrapClassName="w-11 h-11 rounded-xl bg-blue-500/10 border border-blue-500/10 flex items-center justify-center"
              titleClassName="text-base font-bold text-white mb-2"
              descClassName="text-xs sm:text-sm text-white/62 leading-relaxed"
              delayStep={0.1}
            />
          </div>
        </section>

        {/* Dynamic ROI Calculator widget section */}
        <section className="py-24 relative border-t border-white/5 bg-[#030014]">
          <div className="container mx-auto px-6 max-w-4xl">

            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.roiTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-xl mx-auto font-medium">
                {t.roiSub}
              </p>
            </div>

            <div className="bg-gradient-to-r from-[#090622] to-black border border-white/5 rounded-3xl p-8 relative overflow-hidden group">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-center">

                {/* Inputs */}
                <div className="md:col-span-6 space-y-4">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-bold text-white/85">{t.roiSales}</span>
                    <span className="font-black text-blue-400 text-xl">{monthlySales}</span>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="300"
                    step="5"
                    value={monthlySales}
                    onChange={(e) => setMonthlySales(Number(e.target.value))}
                    className="w-full accent-blue-500 h-1.5 bg-white/5 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-white/40 font-bold" style={{ direction: "ltr" }}>
                    <span>5 cars</span>
                    <span>300 cars</span>
                  </div>
                </div>

                {/* Outputs Display */}
                <div className="md:col-span-6 grid grid-cols-2 gap-4 text-center">

                  <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-5">
                    <div className="text-2xl sm:text-3xl font-black text-white mb-1">
                      {hoursSavedPerWk}
                    </div>
                    <div className={`text-[10px] text-blue-400 font-extrabold uppercase mb-1 ${ltrOnly(isRtl, "tracking-wide")}`}>
                      {t.roiHours}
                    </div>
                    <div className="text-[9px] text-white/55 font-bold leading-tight">
                      {t.roiHoursSub}
                    </div>
                  </div>

                  <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-5">
                    <div className="text-2xl sm:text-3xl font-black text-white mb-1" style={{ direction: "ltr" }}>
                      {annualSavingsDollars.toLocaleString()} {currencyLabel}
                    </div>
                    <div className={`text-[10px] text-blue-400 font-extrabold uppercase mb-1 ${ltrOnly(isRtl, "tracking-wide")}`}>
                      {t.roiSavings}
                    </div>
                    <div className="text-[9px] text-white/55 font-bold leading-tight">
                      {t.roiSavingsSub}
                    </div>
                  </div>

                </div>

              </div>
            </div>

          </div>
        </section>

        {/* Brand FAQ Section */}
        <section className="py-24 relative border-t border-white/5 bg-[#030014]">
          <div className="container mx-auto px-6 max-w-3xl">

            <div className="text-center mb-16">
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white mb-3">
                {t.faqTitle}
              </h2>
              <p className="text-sm sm:text-base text-white/60 max-w-xl mx-auto font-medium">
                {t.faqSub}
              </p>
            </div>

            <div className="space-y-4">
              {faqs.map((faq, idx) => {
                const isOpen = activeFaq === idx;
                return (
                  <div
                    key={faq.question.en}
                    className="border border-white/5 bg-white/[0.01] rounded-2xl overflow-hidden transition-all duration-300 hover:border-white/10"
                  >
                    <button
                      onClick={() => setActiveFaq(isOpen ? null : idx)}
                      className="w-full px-6 py-5 flex items-center justify-between gap-4 font-bold text-sm sm:text-base text-white/90 text-right cursor-pointer"
                      style={{ direction: isRtl ? "rtl" : "ltr" }}
                    >
                      <span>{faq.question[locale]}</span>
                      <ChevronRight className={`w-4 h-4 text-white/60 shrink-0 transition-transform duration-300 ${isOpen ? "rotate-90" : ""}`} />
                    </button>

                    <AnimatePresence initial={false}>
                      {isOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.25 }}
                        >
                          <div className="px-6 pb-6 text-xs sm:text-sm text-white/65 leading-relaxed text-right border-t border-white/5 pt-4" style={{ direction: isRtl ? "rtl" : "ltr" }}>
                            {faq.answer[locale]}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>

          </div>
        </section>

      </main>

      {/* Ultra-Premium Minimalist Footer */}
      <footer className="border-t border-white/5 py-12 relative z-10 bg-[#02000f]">
        <div className="container mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-8">

          <div className="flex items-center gap-3">
            <Image
              src="/logo.png"
              alt="AutoFlow Logo"
              width={100}
              height={30}
              className="w-20 h-auto object-contain opacity-70 hover:opacity-100 transition-opacity duration-300"
            />
          </div>

          <p className={`text-white/60 text-sm font-semibold ${ltrOnly(isRtl, "tracking-wider")}`}>
            © {new Date().getFullYear()} {t.footerRights}
          </p>

          <div className={`flex gap-6 text-sm font-semibold text-white/70 uppercase ${ltrOnly(isRtl, "tracking-wider")}`}>
            <Link href="/privacy" className="hover:text-white transition-colors duration-300">{t.footerPrivacy}</Link>
            <Link href="/terms" className="hover:text-white transition-colors duration-300">{t.footerTerms}</Link>
            <Link href="/contact" className="hover:text-white transition-colors duration-300">{t.footerContact}</Link>
          </div>

        </div>
      </footer>
    </div>
  );
}
