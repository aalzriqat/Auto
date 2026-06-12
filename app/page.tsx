"use client";

import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, Sparkles, Fingerprint, Activity, Zap } from "lucide-react";
import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";

export default function MarketingPage() {
  const containerRef = useRef(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end end"]
  });

  const heroY = useTransform(scrollYProgress, [0, 0.2], [0, 150]);
  const heroOpacity = useTransform(scrollYProgress, [0, 0.15], [1, 0]);

  return (
    <div ref={containerRef} className="dark flex flex-col min-h-screen bg-[#050505] text-white font-sans selection:bg-primary/30 overflow-hidden" dir="rtl">
      
      {/* Abstract Background Orbs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute top-[-10%] right-[-5%] w-[50vw] h-[50vw] rounded-full bg-primary/10 blur-[120px]" />
        <div className="absolute bottom-[-20%] left-[-10%] w-[60vw] h-[60vw] rounded-full bg-blue-900/10 blur-[150px]" />
      </div>

      {/* Bespoke Navbar */}
      <header className="fixed top-0 inset-x-0 z-50 w-full bg-[#050505]/40 backdrop-blur-2xl border-b border-white/5">
        <div className="container mx-auto px-6 h-24 flex flex-row-reverse items-center justify-between">
          <Link href="/" className="flex items-center gap-2 relative z-10">
            <Image src="/logo.png" alt="AutoFlow Logo" width={180} height={60} className="w-32 h-auto object-contain brightness-0 invert opacity-90" priority />
          </Link>
          
          <nav className="hidden md:flex gap-12 text-sm font-medium tracking-widest text-white/50 uppercase">
            <Link href="#features" className="hover:text-white transition-colors duration-500">الميزات</Link>
            <Link href="#experience" className="hover:text-white transition-colors duration-500">التجربة</Link>
            <Link href="#pricing" className="hover:text-white transition-colors duration-500">النخبة</Link>
          </nav>

          <div className="flex items-center gap-6 z-10">
            <Link href="/sign-in" className="text-sm font-medium text-white/60 hover:text-white transition-colors duration-500">
              دخول
            </Link>
            <Link href="/sign-up" className="relative group">
              <div className="absolute -inset-0.5 bg-gradient-to-r from-primary to-blue-600 rounded-full blur opacity-30 group-hover:opacity-100 transition duration-1000 group-hover:duration-200" />
              <button className="relative px-8 py-3 bg-black rounded-full leading-none flex items-center border border-white/10 group-hover:border-white/20 transition-colors">
                <span className="text-white text-sm font-medium">ابدأ الآن</span>
              </button>
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 relative z-10">
        {/* Massive Cinematic Hero */}
        <section className="relative min-h-[100vh] flex items-center justify-center pt-24 pb-32">
          <motion.div 
            style={{ y: heroY, opacity: heroOpacity }}
            className="container mx-auto px-6 flex flex-col items-center text-center mt-20"
          >
            <motion.div 
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
              className="inline-flex items-center gap-3 px-6 py-2 rounded-full bg-white/5 border border-white/10 backdrop-blur-md mb-12"
            >
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-sm font-light tracking-wide text-white/80">مستقبل إدارة السيارات الفارهة</span>
            </motion.div>
            
            <motion.h1 
              initial={{ opacity: 0, y: 50 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1.2, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="text-[4rem] sm:text-[6rem] lg:text-[8rem] font-black leading-[1.1] tracking-tighter mb-8"
            >
              تحفة <span className="text-transparent bg-clip-text bg-gradient-to-l from-white via-white/80 to-primary/40">رقمية</span>
              <br />
              لمعارض النخبة
            </motion.h1>
            
            <motion.p 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 1.5, delay: 0.6 }}
              className="text-xl sm:text-2xl text-white/40 font-light max-w-3xl mx-auto leading-relaxed mb-16"
            >
              تجاوز حدود الأنظمة التقليدية. اكتشف أوتوفلو؛ منصة مصممة بدقة متناهية لتعكس فخامة معرضك وترتقي بتجربة عملائك.
            </motion.p>
            
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1, delay: 0.8, ease: "easeOut" }}
              className="flex items-center justify-center gap-6"
            >
              <Link href="/sign-up" className="relative group">
                <div className="absolute -inset-1 bg-gradient-to-r from-primary to-indigo-600 rounded-full blur-md opacity-60 group-hover:opacity-100 transition duration-700 group-hover:duration-300" />
                <button className="relative px-12 py-5 bg-[#0a0a0a] border border-white/10 rounded-full flex items-center gap-3">
                  <span className="text-white text-lg font-medium tracking-wide">احجز النسخة الحصرية</span>
                  <ArrowLeft className="w-5 h-5 text-white/50 group-hover:text-white group-hover:-translate-x-2 transition-all duration-500" />
                </button>
              </Link>
            </motion.div>
          </motion.div>
        </section>

        {/* Floating Mockup Reveal */}
        <section className="relative w-full px-6 pb-40">
          <motion.div 
            initial={{ opacity: 0, y: 150 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-10%" }}
            transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
            className="relative mx-auto max-w-[90vw] lg:max-w-7xl rounded-[2.5rem] border border-white/10 bg-[#0a0a0a]/80 shadow-[0_0_100px_rgba(var(--primary),0.1)] overflow-hidden aspect-video backdrop-blur-3xl"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent pointer-events-none" />
            <div className="h-16 border-b border-white/5 flex items-center px-8 gap-3" dir="ltr">
              <div className="w-4 h-4 rounded-full bg-white/20" />
              <div className="w-4 h-4 rounded-full bg-white/10" />
              <div className="w-4 h-4 rounded-full bg-white/5" />
            </div>
            <div className="relative w-full h-[calc(100%-4rem)] bg-[#030303]">
              <Image 
                src="/dashboard.png" 
                alt="AutoFlow Elite Dashboard" 
                fill
                className="object-cover object-top opacity-80 mix-blend-screen"
              />
            </div>
          </motion.div>
        </section>

        {/* Asymmetrical Bento Grid */}
        <section id="features" className="py-32 relative">
          <div className="container mx-auto px-6 max-w-7xl">
            <div className="mb-24">
              <h2 className="text-4xl md:text-6xl font-black text-white mb-6">هندسة <span className="text-primary">التفوق</span></h2>
              <p className="text-xl text-white/40 font-light max-w-2xl">تم بناء كل تفصيل ليعمل بتناغم تام. نظام واحد يجمع بين القوة المطلقة والجمال الاستثنائي.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 auto-rows-[300px]">
              {/* Massive Card */}
              <motion.div 
                initial={{ opacity: 0, y: 50 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 1, ease: "easeOut" }}
                className="md:col-span-2 md:row-span-2 rounded-[2rem] bg-gradient-to-br from-white/5 to-[#050505] border border-white/5 p-12 relative overflow-hidden group hover:border-primary/30 transition-colors duration-700"
              >
                <div className="absolute top-0 right-0 w-full h-full bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
                <div className="relative z-10 h-full flex flex-col justify-between">
                  <div className="w-16 h-16 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mb-8">
                    <Fingerprint className="w-8 h-8 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-4xl font-bold text-white mb-4">هوية بصرية استثنائية</h3>
                    <p className="text-lg text-white/50 leading-relaxed max-w-md">انعكاس تام لعلامتك التجارية. واجهات مستخدم تتكيف مع هوية معرضك لتمنح عملاءك شعوراً بالفخامة في كل تفاعل.</p>
                  </div>
                </div>
              </motion.div>

              {/* Smaller Cards */}
              <motion.div 
                initial={{ opacity: 0, y: 50 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 1, delay: 0.2, ease: "easeOut" }}
                className="rounded-[2rem] bg-[#0a0a0a] border border-white/5 p-10 relative overflow-hidden group hover:border-white/20 transition-colors duration-700"
              >
                <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-6">
                  <Zap className="w-6 h-6 text-white" />
                </div>
                <h3 className="text-2xl font-bold text-white mb-3">سرعة خاطفة</h3>
                <p className="text-white/40 leading-relaxed">أداء فائق لا يعرف الانتظار. مبني على أحدث التقنيات لضمان استجابة فورية.</p>
              </motion.div>

              <motion.div 
                initial={{ opacity: 0, y: 50 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 1, delay: 0.4, ease: "easeOut" }}
                className="rounded-[2rem] bg-gradient-to-t from-primary/10 to-[#0a0a0a] border border-white/5 p-10 relative overflow-hidden group"
              >
                <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center mb-6">
                  <Activity className="w-6 h-6 text-primary" />
                </div>
                <h3 className="text-2xl font-bold text-white mb-3">تحليلات النخبة</h3>
                <p className="text-white/40 leading-relaxed">رؤى عميقة لبيانات مبيعاتك تساعدك على اتخاذ قرارات استراتيجية بدقة متناهية.</p>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Minimalist Pricing */}
        <section id="pricing" className="py-40 relative border-t border-white/5">
          <div className="container mx-auto px-6 max-w-4xl text-center">
            <h2 className="text-5xl font-black text-white mb-8">الاستثمار في <span className="text-primary/80">التميز</span></h2>
            <p className="text-xl text-white/40 mb-20 max-w-2xl mx-auto font-light">لا توجد تعقيدات. باقة واحدة تشمل كل شيء، مصممة للمعارض التي لا ترضى بأقل من الكمال.</p>
            
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
              className="relative p-[1px] rounded-[3rem] bg-gradient-to-b from-white/20 to-transparent max-w-lg mx-auto group hover:from-primary/50 transition-all duration-1000"
            >
              <div className="absolute inset-0 bg-primary/20 blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-1000" />
              <div className="relative bg-[#050505] rounded-[3rem] p-16 overflow-hidden">
                <div className="absolute top-0 right-0 w-[200px] h-[200px] bg-primary/10 blur-[80px]" />
                
                <h3 className="text-2xl font-bold text-white mb-4">نسخة النخبة</h3>
                <div className="flex items-baseline justify-center gap-2 mb-12">
                  <span className="text-6xl font-black text-white">149$</span>
                  <span className="text-white/30 tracking-widest text-sm">/ شهرياً</span>
                </div>
                
                <ul className="space-y-6 text-right mb-16">
                  {[
                    "وصول غير محدود لجميع الميزات",
                    "دعم فني مخصص على مدار الساعة",
                    "أمان وتشفير من الدرجة العسكرية",
                    "تخصيص الواجهة بهوية معرضك"
                  ].map((feature, i) => (
                    <li key={i} className="flex items-center gap-4 text-white/70">
                      <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                      <span className="text-lg font-light">{feature}</span>
                    </li>
                  ))}
                </ul>

                <Link href="/sign-up" className="block w-full relative">
                  <div className="absolute inset-0 bg-primary rounded-full blur opacity-50 transition-opacity duration-500 hover:opacity-100" />
                  <button className="relative w-full py-5 bg-white text-black rounded-full text-lg font-bold hover:bg-white/90 transition-colors">
                    ارتقِ بأعمالك الآن
                  </button>
                </Link>
              </div>
            </motion.div>
          </div>
        </section>
      </main>

      {/* Ultra-Minimal Footer */}
      <footer className="border-t border-white/5 py-12 relative z-10 bg-[#030303]">
        <div className="container mx-auto px-6 flex flex-col md:flex-row-reverse justify-between items-center gap-8">
          <Image src="/logo.png" alt="AutoFlow Logo" width={120} height={40} className="w-24 h-auto object-contain brightness-0 invert opacity-30 hover:opacity-100 transition-opacity duration-500" />
          <p className="text-white/20 text-sm font-light tracking-widest">
            © {new Date().getFullYear()} AUTOFLOW. جميع الحقوق محفوظة.
          </p>
          <div className="flex gap-8 text-sm font-light tracking-widest text-white/30 uppercase">
            <Link href="#" className="hover:text-white transition-colors duration-500">الخصوصية</Link>
            <Link href="#" className="hover:text-white transition-colors duration-500">الشروط</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
