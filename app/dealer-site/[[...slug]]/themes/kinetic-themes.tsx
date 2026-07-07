
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ThemeProps } from "./theme-props";

export function KineticLuxuryTheme(props: ThemeProps) {
  return (
    <div className="theme-kinetic bg-background text-on-background selection:bg-luxury-gold selection:text-white" dir={props.dir}>
      

<nav className="bg-surface/90 dark:bg-primary/90 backdrop-blur-xl docked full-width top-0 sticky z-50 bg-surface-container-low dark:bg-surface-dim shadow-sm">
<div className="flex justify-between items-center px-gutter py-4 w-full max-w-screen-2xl mx-auto">
<div className="flex items-center gap-8">
<a className="font-display-luxury text-display-luxury text-luxury-gold dark:text-jod-gold tracking-tighter" href="#">{props.site.profile.dealershipName}</a>
<div className="hidden md:flex gap-6 items-center">
<a className="font-label-caps text-label-caps text-secondary dark:text-secondary-fixed-dim border-b-2 border-secondary font-bold pb-1" href="#">Inventory</a>
<a className="font-label-caps text-label-caps text-on-surface-variant dark:text-outline-variant hover:text-primary dark:hover:text-primary-fixed-dim transition-colors" href="#">New Arrivals</a>
<a className="font-label-caps text-label-caps text-on-surface-variant dark:text-outline-variant hover:text-primary dark:hover:text-primary-fixed-dim transition-colors" href="#">Special Offers</a>
<a className="font-label-caps text-label-caps text-on-surface-variant dark:text-outline-variant hover:text-primary dark:hover:text-primary-fixed-dim transition-colors" href="#">Finance</a>
<a className="font-label-caps text-label-caps text-on-surface-variant dark:text-outline-variant hover:text-primary dark:hover:text-primary-fixed-dim transition-colors" href="#">About Us</a>
</div>
</div>
<div className="flex items-center gap-4">
<button className="hidden lg:flex items-center gap-2 px-4 py-2 rounded-full border border-whatsapp-green text-whatsapp-green font-label-caps text-label-caps hover:bg-whatsapp-green hover:text-white transition-all">
<span className="material-symbols-outlined text-[18px]">whatshot</span>
                    WhatsApp Support
                </button>
<div className="flex items-center gap-2">
<span className="material-symbols-outlined p-2 text-on-surface-variant cursor-pointer hover:bg-surface-container-highest/50 rounded-full transition-colors">language</span>
<span className="font-arabic-ui text-arabic-ui text-primary cursor-pointer">العربية</span>
</div>
<span className="material-symbols-outlined p-2 text-on-surface-variant cursor-pointer hover:bg-surface-container-highest/50 rounded-full transition-colors" data-icon="search">search</span>
<span className="material-symbols-outlined p-2 text-on-surface-variant cursor-pointer hover:bg-surface-container-highest/50 rounded-full transition-colors" data-icon="directions_car">directions_car</span>
</div>
</div>
</nav>
<main>

<section className="relative h-screen w-full overflow-hidden">
<div className="absolute inset-0 bg-primary/40 z-10"></div>

<div className="absolute inset-0 w-full h-full">
<div className="w-full h-full bg-cover bg-center transition-transform duration-1000 scale-105" data-alt="A cinematic, high-angle wide shot of a sleek black luxury SUV driving along a winding coastal road at sunset. The lighting is golden and warm, reflecting off the polished metallic surfaces of the car. The atmosphere is prestigious and serene, with the deep blues of the ocean contrasting against the vibrant orange sky. High-end automotive photography style with shallow depth of field." style={{ backgroundImage: 'url("https://lh3.googleusercontent.com/aida-public/AB6AXuBaeBg7I5oQC5iPs3oeViaCgbyOttAAxVOWW68dpG5fFKN-sFW366E2rcwrWFK7YcTWO9AMVyUJOVT14rTMfdCAZz34IK_Ytq1P0ML1zmeRdNMtZvopTYsOAC2Vb0H5WKoVPoJztGx1641T_w87supNsYVrd0Wv_DTFyVZjR6mG69fwPXo8ssqhDtuNYC_5uppZ71xuodPp1VJgy5sUDaPAfAG0McCSOgTW2Q6a41Le-xlqyp5wdoO18Y-3cB8Ba3nb2-dXD5yjuOoP")' }}></div>
</div>
<div className="relative z-20 h-full flex flex-col justify-center items-center text-center px-margin-mobile md:px-margin-desktop">
<div className="max-w-4xl space-y-6">
<h1 className="font-display-luxury text-white text-[48px] md:text-[80px] leading-tight animate-fade-in">Luxury Redefined</h1>
<p className="font-body-md text-white/90 text-lg md:text-xl max-w-2xl mx-auto opacity-80">
                        Experience the pinnacle of automotive excellence in Amman. Discover an curated collection of the world's most prestigious marques.
                    </p>
<div className="flex flex-col md:flex-row gap-4 justify-center pt-8">
<a className="px-8 py-4 bg-luxury-gold text-white font-label-caps text-label-caps rounded-sm hover:bg-jod-gold transition-all transform hover:-translate-y-1 shadow-lg flex items-center justify-center gap-2" href="#">
                            Browse Exclusive Collection
                            <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
</a>
<a className="px-8 py-4 bg-white/10 backdrop-blur-md border border-white/30 text-white font-label-caps text-label-caps rounded-sm hover:bg-white hover:text-primary transition-all flex items-center justify-center gap-2" href="#">
                            Private Showroom Visit
                            <span className="material-symbols-outlined text-[16px]">event</span>
</a>
</div>
</div>
</div>

<div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 animate-bounce">
<span className="material-symbols-outlined text-white/50 text-4xl">expand_more</span>
</div>
</section>

<section className="bg-primary py-12 border-y border-luxury-gold/20">
<div className="max-w-screen-2xl mx-auto px-gutter grid grid-cols-2 md:grid-cols-4 gap-8">
<div className="text-center">
<div className="font-display-luxury text-luxury-gold text-4xl mb-1">15+</div>
<div className="font-label-caps text-on-primary-container text-xs tracking-widest uppercase">Years of Heritage</div>
</div>
<div className="text-center">
<div className="font-display-luxury text-luxury-gold text-4xl mb-1">500+</div>
<div className="font-label-caps text-on-primary-container text-xs tracking-widest uppercase">Elite Deliveries</div>
</div>
<div className="text-center">
<div className="font-display-luxury text-luxury-gold text-4xl mb-1">24h</div>
<div className="font-label-caps text-on-primary-container text-xs tracking-widest uppercase">Global Sourcing</div>
</div>
<div className="text-center">
<div className="font-display-luxury text-luxury-gold text-4xl mb-1">100%</div>
<div className="font-label-caps text-on-primary-container text-xs tracking-widest uppercase">Private Service</div>
</div>
</div>
</section>

<section className="py-section-gap bg-surface-container-lowest">
<div className="max-w-screen-2xl mx-auto px-gutter">
<div className="flex flex-col md:flex-row justify-between items-end mb-12 gap-6">
<div>
<span className="font-label-caps text-luxury-gold text-sm tracking-widest uppercase">Featured Inventory</span>
<h2 className="font-display-luxury text-primary text-headline-lg mt-2">Curated Masterpieces</h2>
</div>
<a className="font-label-caps text-primary border-b border-primary pb-1 hover:text-luxury-gold hover:border-luxury-gold transition-colors" href="#">View All Vehicles</a>
</div>
<div className="grid grid-cols-1 md:grid-cols-3 gap-8">

<div className="group cursor-pointer car-card-hover">
<div className="relative aspect-[16/10] overflow-hidden rounded-sm bg-surface-container">
<img className="car-image w-full h-full object-cover transition-transform duration-500" data-alt="Close-up detailed professional photography of a white 2024 Range Rover Autobiography. The car is parked on a minimalist white architectural floor, with dramatic clean shadows. The lighting is bright and airy, highlighting the premium metallic finish and sophisticated grill design. Minimalist luxury car advertisement style." src="https://lh3.googleusercontent.com/aida-public/AB6AXuBpZmtyUOhQvw4PbwybcyGuCUrBimGu-2-CDQ1LbH_v5RtHaGRe-BH_Prj32mg0X4KsrOBWEZqwybKgv0CqPPRVEruPhL1xbV-vNLntrb_bCjJCSoDadQq8OiMNziZulWx52EHK0dB-Mdtc2MZ8go0XyoRT5DFP065hHDMiIYkCh8_P2G9Gsz-guJMFvEZk1GDVWqGkC9Iegi1FUD1EGyXlBmOcIJf4R3AHiSKZVVRzONR0TvU3dhodM5yxvxR5LdE4m7DUlJzv_XDI"/>
<div className="absolute top-4 left-4">
<span className="bg-primary text-white font-label-caps text-[10px] px-3 py-1 tracking-tighter rounded-full uppercase">Just Arrived</span>
</div>
</div>
<div className="mt-6 space-y-2">
<div className="flex justify-between items-start">
<h3 className="font-headline-lg text-xl text-primary">Range Rover Autobiography</h3>
<span className="font-headline-lg text-luxury-gold text-xl">145,000 JOD</span>
</div>
<p className="font-body-md text-on-surface-variant text-sm">2024 • 0 km • P530 V8 Engine</p>
<div className="flex gap-4 pt-2">
<button className="flex-1 py-3 border border-outline text-primary font-label-caps text-xs hover:bg-primary hover:text-white transition-all uppercase">Inquire Now</button>
<button className="w-12 h-12 flex items-center justify-center border border-outline hover:text-secondary-container transition-colors">
<span className="material-symbols-outlined">favorite</span>
</button>
</div>
</div>
</div>

<div className="group cursor-pointer car-card-hover">
<div className="relative aspect-[16/10] overflow-hidden rounded-sm bg-surface-container">
<img className="car-image w-full h-full object-cover transition-transform duration-500" data-alt="A front three-quarter view of a midnight blue Mercedes-Benz S-Class parked in front of a modern glass skyscraper in Amman at twilight. The city lights are blurred in the background, creating a bokeh effect. The car's LED headlights are glowing softly. Luxury corporate aesthetic, clean lines, and deep contrast." src="https://lh3.googleusercontent.com/aida-public/AB6AXuA15j2cL5Rj8FncZCcFpC7iNqZ06AEztkvXMQJeVWuByf3M7UFK4t1r4J3Ri8PGUoQtUV4aN4IRFBK6BVtZCT_qDF_BZEowzv2CH4Hhn90hmUOZLU1nG4TqlR9hUf0YxF_OYD8yUzzIZzYRkIytBDaVyyDwrYT6LmlulJQFGZTqzvsFXVoAsl-0d7MzNE6-_5TGtuVMkZn1H816AaNZdqyLtjjX9cHsibaSUXsxWnKF3GdST6xBNSr-61jehAjr7vwLBZdcGh-FZ5fh"/>
<div className="absolute top-4 left-4">
<span className="bg-luxury-gold text-white font-label-caps text-[10px] px-3 py-1 tracking-tighter rounded-full uppercase">Reserved</span>
</div>
</div>
<div className="mt-6 space-y-2">
<div className="flex justify-between items-start">
<h3 className="font-headline-lg text-xl text-primary">Mercedes-Benz S-Class</h3>
<span className="font-headline-lg text-luxury-gold text-xl">118,000 JOD</span>
</div>
<p className="font-body-md text-on-surface-variant text-sm">2023 • 4,500 km • Exclusive Package</p>
<div className="flex gap-4 pt-2">
<button className="flex-1 py-3 border border-outline text-primary font-label-caps text-xs hover:bg-primary hover:text-white transition-all uppercase">Inquire Now</button>
<button className="w-12 h-12 flex items-center justify-center border border-outline hover:text-secondary-container transition-colors">
<span className="material-symbols-outlined">favorite</span>
</button>
</div>
</div>
</div>

<div className="group cursor-pointer car-card-hover">
<div className="relative aspect-[16/10] overflow-hidden rounded-sm bg-surface-container">
<img className="car-image w-full h-full object-cover transition-transform duration-500" data-alt="A high-performance luxury SUV, Porsche Cayenne GTS in Chalk Grey, captured in a dynamic panning shot. The car is sharp while the desert landscape background is softly blurred. High-contrast lighting with deep shadows, emphasizing the muscular wheel arches and sporty silhouette. Premium automotive editorial style." src="https://lh3.googleusercontent.com/aida-public/AB6AXuCPRsVI5gBJSdZ1XQeRa9EFlskKNcXknxKHofa7PDDGskhfWXstM7tQA1csJwRsG0WcPDGBA1VhCCb_27ngMEvQk939ia1adR_w8AXFUYqqhT42h5lcwcYYHjDaBmustoA6vkIU-W1yYvV8oFvyRqtM-38KEB4kOszwFkh9KCBc6q-Yxl9DlqYP5EtKf16EnE58sbY7FjOtE_GJ-CGmjzNzAPneLBn6rYHa3arBHUL4ucaGPCpB24bH5zc1ghLX27k6SNvdBjgE7k1t"/>
</div>
<div className="mt-6 space-y-2">
<div className="flex justify-between items-start">
<h3 className="font-headline-lg text-xl text-primary">Porsche Cayenne GTS</h3>
<span className="font-headline-lg text-luxury-gold text-xl">95,000 JOD</span>
</div>
<p className="font-body-md text-on-surface-variant text-sm">2022 • 12,000 km • Sport Chrono</p>
<div className="flex gap-4 pt-2">
<button className="flex-1 py-3 border border-outline text-primary font-label-caps text-xs hover:bg-primary hover:text-white transition-all uppercase">Inquire Now</button>
<button className="w-12 h-12 flex items-center justify-center border border-outline hover:text-secondary-container transition-colors">
<span className="material-symbols-outlined">favorite</span>
</button>
</div>
</div>
</div>
</div>
</div>
</section>

<section className="relative py-section-gap bg-primary overflow-hidden">

<div className="absolute inset-0 opacity-10">

</div>
<div className="relative z-10 max-w-screen-2xl mx-auto px-gutter">
<div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
<div className="relative">
<div className="aspect-square rounded-sm overflow-hidden border border-luxury-gold/30 p-4">
<div className="w-full h-full bg-cover bg-center" data-alt="A macro shot of a craftsman's hands working on the fine leather stitching of a luxury car steering wheel. The focus is sharp on the golden thread and the texture of the black premium leather. Soft, warm lighting creates an intimate and high-end feel of craftsmanship and heritage. Cinematic close-up." style={{ backgroundImage: 'url("https://lh3.googleusercontent.com/aida-public/AB6AXuBd5Baj3AZCFWd5QddePY8xBqIF9sBxXj-86Nx-EK0yIhaIbJpyMJBnVLtO6tXk05g3Ns8YeFNFCEaqqU3HmUM9BTnEWDZOx-qCRLZFA5gVp9Uc_MssnlG9JuGTrmHGMA5zxCcAuZ_GYTPylTSuiWo27F9CzF06bQh5NzEnv712eM3tiXMccmBKoFqZGgBcIbJh-UaiK-CHaB8AizKxE43xV2yfm4n1qOwyVcIiJIVj54fFiL20bero-5ScZYEfV90fo_HoIQGPE7O-")' }}></div>
</div>

<div className="absolute -bottom-8 -right-8 bg-luxury-gold p-8 rounded-sm shadow-2xl hidden md:block">
<div className="font-display-luxury text-white text-3xl">Est. 2009</div>
<div className="font-label-caps text-white/80 text-[10px] tracking-widest uppercase">Trusted in Amman</div>
</div>
</div>
<div className="space-y-8">
<span className="font-label-caps text-luxury-gold text-sm tracking-widest uppercase">The AutoFlow Standard</span>
<h2 className="font-display-luxury text-white text-[40px] md:text-[56px] leading-tight">Beyond Acquisition</h2>
<div className="space-y-6">
<div className="flex gap-6">
<span className="material-symbols-outlined text-luxury-gold text-3xl">verified_user</span>
<div>
<h4 className="font-headline-lg text-white text-xl mb-2">White-Glove Service</h4>
<p className="font-body-md text-on-primary-container">Every vehicle undergoes a 200-point inspection by certified technicians to ensure absolute perfection.</p>
</div>
</div>
<div className="flex gap-6">
<span className="material-symbols-outlined text-luxury-gold text-3xl">public</span>
<div>
<h4 className="font-headline-lg text-white text-xl mb-2">International Sourcing</h4>
<p className="font-body-md text-on-primary-container">If your dream car isn't in our showroom, our global network will locate it and manage the entire import process.</p>
</div>
</div>
<div className="flex gap-6">
<span className="material-symbols-outlined text-luxury-gold text-3xl">history_edu</span>
<div>
<h4 className="font-headline-lg text-white text-xl mb-2">Legacy of Trust</h4>
<p className="font-body-md text-on-primary-container">A decade-long heritage of serving the most discerning clients in the Hashemite Kingdom of Jordan.</p>
</div>
</div>
</div>
</div>
</div>
</div>
</section>

<section className="py-24 bg-surface-container">
<div className="max-w-4xl mx-auto px-margin-mobile text-center space-y-8">
<h2 className="font-display-luxury text-primary text-4xl">Interested in a Private Consultation?</h2>
<p className="font-body-md text-on-surface-variant text-lg">Our luxury specialists are available to discuss your requirements discreetly and professionally.</p>
<div className="flex flex-col md:flex-row gap-6 justify-center">
<a className="flex items-center justify-center gap-3 px-10 py-5 bg-whatsapp-green text-white rounded-full font-label-caps text-sm hover:opacity-90 transition-all shadow-lg" href="#">
<span className="material-symbols-outlined">whatshot</span>
                        Connect via WhatsApp
                    </a>
<button className="px-10 py-5 bg-primary text-white rounded-full font-label-caps text-sm hover:bg-luxury-gold transition-all shadow-lg">
                        Request a Call Back
                    </button>
</div>
</div>
</section>
</main>

<footer className="bg-primary dark:bg-on-primary-fixed w-full py-section-gap">
<div className="w-full grid grid-cols-1 md:grid-cols-4 gap-gutter px-margin-desktop max-w-screen-2xl mx-auto">

<div className="space-y-6">
<div className="font-display-luxury text-display-luxury text-luxury-gold">{props.site.profile.dealershipName}</div>
<p className="font-body-md text-on-primary-container text-sm leading-relaxed">
                    The destination for premium automotive experiences in Amman, Jordan. Excellence in every detail, from showroom to garage.
                </p>
<div className="flex gap-4">
<span className="material-symbols-outlined text-white cursor-pointer hover:text-luxury-gold">face_nod</span>
<span className="material-symbols-outlined text-white cursor-pointer hover:text-luxury-gold">camera</span>
<span className="material-symbols-outlined text-white cursor-pointer hover:text-luxury-gold">alternate_email</span>
</div>
</div>

<div className="space-y-6">
<h4 className="font-label-caps text-white uppercase tracking-widest text-sm">Explore</h4>
<ul className="space-y-3 font-body-md text-on-primary-container">
<li><a className="hover:text-white transition-colors" href="#">Our Inventory</a></li>
<li><a className="hover:text-white transition-colors" href="#">Luxury Concierge</a></li>
<li><a className="hover:text-white transition-colors" href="#">Finance Options</a></li>
<li><a className="hover:text-white transition-colors" href="#">Showroom Location</a></li>
</ul>
</div>

<div className="space-y-6">
<h4 className="font-label-caps text-white uppercase tracking-widest text-sm">Company</h4>
<ul className="space-y-3 font-body-md text-on-primary-container">
<li><a className="hover:text-white transition-colors" href="#">Privacy Policy</a></li>
<li><a className="hover:text-white transition-colors" href="#">Terms of Service</a></li>
<li><a className="hover:text-white transition-colors" href="#">Shipping Info</a></li>
<li><a className="hover:text-white transition-colors" href="#">VAT Registration</a></li>
</ul>
</div>

<div className="space-y-6">
<h4 className="font-label-caps text-white uppercase tracking-widest text-sm">Amman Showroom</h4>
<div className="font-body-md text-on-primary-container text-sm space-y-4">
<p className="flex items-start gap-3">
<span className="material-symbols-outlined text-luxury-gold text-lg">location_on</span>
                        King Abdullah II St, Amman, Jordan
                    </p>
<p className="flex items-start gap-3">
<span className="material-symbols-outlined text-luxury-gold text-lg">phone</span>
                        +962 6 500 0000
                    </p>
<p className="flex items-start gap-3">
<span className="material-symbols-outlined text-luxury-gold text-lg">mail</span>
                        concierge@autoflow.jo
                    </p>
</div>
</div>
</div>

<div className="mt-20 border-t border-white/10 pt-8 text-center px-gutter">
<p className="font-body-md text-on-primary-container text-xs opacity-60">
                © 2024 AutoFlow Dealership System. All Rights Reserved. Amman, Jordan.
            </p>
</div>
</footer>

<a className="fixed bottom-8 right-8 z-50 w-16 h-16 bg-whatsapp-green rounded-full flex items-center justify-center text-white shadow-2xl hover:scale-110 active:scale-95 transition-transform md:hidden" href="#">
<span className="material-symbols-outlined text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>whatshot</span>
</a>


    </div>
  );
}

export function KineticModernEvTheme(props: ThemeProps) {
  return (
    <div className="theme-kinetic bg-surface text-on-surface" dir={props.dir}>
      

<nav className="bg-surface/90 backdrop-blur-xl docked full-width top-0 sticky z-50 shadow-sm">
<div className="flex justify-between items-center px-gutter py-4 w-full max-w-screen-2xl mx-auto">
<div className="flex items-center gap-8">
<span className="font-display-luxury text-display-luxury text-luxury-gold text-2xl">{props.site.profile.dealershipName}</span>
<div className="hidden md:flex gap-6 items-center">
<a className="text-secondary border-b-2 border-secondary font-bold pb-1 font-label-caps text-label-caps" href="#">Inventory</a>
<a className="text-on-surface-variant hover:text-primary transition-colors font-label-caps text-label-caps" href="#">New Arrivals</a>
<a className="text-on-surface-variant hover:text-primary transition-colors font-label-caps text-label-caps" href="#">Special Offers</a>
<a className="text-on-surface-variant hover:text-primary transition-colors font-label-caps text-label-caps" href="#">Finance</a>
</div>
</div>
<div className="flex items-center gap-4">
<button className="hidden lg:flex items-center gap-2 bg-whatsapp-green text-white px-4 py-2 rounded-full font-bold transition-transform scale-95 active:scale-90 duration-200">
<span className="material-symbols-outlined">chat</span>
<span>WhatsApp Support</span>
</button>
<div className="flex gap-2">
<button className="p-2 hover:bg-surface-container-highest/50 rounded-full transition-colors">
<span className="material-symbols-outlined">language</span>
</button>
<button className="p-2 hover:bg-surface-container-highest/50 rounded-full transition-colors">
<span className="material-symbols-outlined">search</span>
</button>
<button className="md:hidden p-2 hover:bg-surface-container-highest/50 rounded-full transition-colors">
<span className="material-symbols-outlined">menu</span>
</button>
</div>
</div>
</div>
</nav>

<main>

<section className="relative h-[921px] overflow-hidden flex items-center bg-primary">

<div className="relative z-10 w-full max-w-screen-2xl mx-auto px-gutter grid lg:grid-cols-2 items-center gap-12">
<div className="space-y-8 animate-fade-in">
<div className="inline-flex items-center gap-3 bg-electric-blue/10 border border-electric-blue/20 rounded-full px-4 py-1">
<span className="w-2 h-2 rounded-full bg-electric-blue animate-pulse"></span>
<span className="text-electric-blue font-label-caps text-label-caps">NEOM EDITION NOW AVAILABLE</span>
</div>
<h1 className="font-headline-lg text-6xl text-white leading-tight">
                        The Future <br/><span className="text-electric-blue">is Electric</span>
</h1>
<p className="text-on-primary-container text-xl max-w-lg leading-relaxed">
                        Experience the peak of automotive innovation. Precision engineered for the highways of Amman and the silence of the desert.
                    </p>
<div className="flex flex-wrap gap-4 pt-4">
<button className="bg-electric-blue text-white px-8 py-4 rounded-xl font-bold flex items-center gap-2 hover:translate-y-[-2px] transition-transform">
                            Explore EV Inventory
                            <span className="material-symbols-outlined">arrow_forward</span>
</button>
<button className="bg-white/5 border border-white/10 backdrop-blur-md text-white px-8 py-4 rounded-xl font-bold hover:bg-white/10 transition-colors">
                            Charging &amp; Range Guide
                        </button>
</div>
</div>
<div className="relative hidden lg:block">
<img className="w-full h-auto object-contain transform translate-x-12 scale-110 drop-shadow-[0_0_50px_rgba(99,102,241,0.2)]" data-alt="A futuristic high-performance electric vehicle silhouette with glowing cyan LED light strips, parked against a minimalist architectural background in Amman, Jordan at dusk. The aesthetic is clean, high-tech, and luxurious, featuring soft ambient blue lighting and sharp reflections on the car's metallic surface." src="https://lh3.googleusercontent.com/aida-public/AB6AXuBNnORI3oOFyAbC4TeenRWQ32ToBBbBkXxszpVsb_-HQWx5zPkQeOTaW2H6oe8bkDt13turpwT5g0jMwX9D2ZyV9WoK6QWLRJ5bG-sDisD5G4uFYoxsv2eJpdFEUY6XMqy1bzO4BqTcqsNpcwJsLPJhyd79s2SUmZdf84A7w9xwloDmoDvjaOBJXoy9YBBb1ZfrcAwSNkPe6nCicSJsCr661HfCuDbF_5m8f1oCC8zz4lqLPCQFQ0qdfXkbmqO9zoIgrk7_zrlJvmp0"/>
</div>
</div>
</section>

<section className="py-section-gap px-gutter max-w-screen-2xl mx-auto">
<div className="flex flex-col md:flex-row justify-between items-end mb-12 gap-6">
<div className="space-y-2">
<h2 className="font-headline-lg text-headline-lg">Premium Fleet</h2>
<p className="text-on-surface-variant font-arabic-ui">استكشف مستقبل التنقل الكهربائي في الأردن</p>
</div>
<div className="flex gap-2">
<button className="p-3 border border-outline-variant rounded-full hover:bg-surface-container transition-colors">
<span className="material-symbols-outlined">chevron_left</span>
</button>
<button className="p-3 border border-outline-variant rounded-full hover:bg-surface-container transition-colors">
<span className="material-symbols-outlined">chevron_right</span>
</button>
</div>
</div>
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">

<div className="group bg-surface-container-lowest border border-outline-variant rounded-3xl overflow-hidden hover:shadow-xl transition-all duration-300">
<div className="relative aspect-[16/10] overflow-hidden">
<img className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" data-alt="A side view of a minimalist white luxury EV SUV parked in a brightly lit modern showroom. The car has large aerodynamic rims and flush door handles. The lighting is soft and even, highlighting the sleek curves and premium metallic finish. Professional automotive photography style." src="https://lh3.googleusercontent.com/aida-public/AB6AXuDpp8E7Vvy48sEwAFggDgUFg4Ku-zeVf840pbPjEkHrbr0LZrB7SzSf2i82QgTmzS_5WL0lRemN26mEzmBQznWjKbfxiedaypufd-B_klY6-mW34QMD7pzk1mG-w6Y5P88kc6uYDu34WkjX1c-MnvGutdtAEMN-_63ufU5c-zI53ml9TUHVmzV21ZehYf5qp7pU3iAZpFek_4uquJXVbtqoC20VoUDlHp0wN3_kJ5ZJp92KCPWYLuNmA73Gb-fCVz0P4yfQqq5nVOgf"/>
<div className="absolute top-4 left-4 bg-white/90 backdrop-blur-sm px-3 py-1 rounded-full text-xs font-bold text-primary">NEW</div>
</div>
<div className="p-6 space-y-6">
<div className="flex justify-between items-start">
<div>
<h3 className="font-headline-lg text-xl">Model X-Zenith</h3>
<p className="text-on-surface-variant text-sm">Long Range Dual Motor</p>
</div>
<span className="text-electric-blue font-bold text-xl">74,500 JOD</span>
</div>
<div className="grid grid-cols-3 gap-4 border-t border-b border-outline-variant/30 py-4">
<div className="text-center">
<span className="material-symbols-outlined text-electric-blue block mb-1">bolt</span>
<span className="font-bold text-sm">620km</span>
<span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">Range</span>
</div>
<div className="text-center">
<span className="material-symbols-outlined text-electric-blue block mb-1">battery_charging_full</span>
<span className="font-bold text-sm">82kWh</span>
<span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">Battery</span>
</div>
<div className="text-center">
<span className="material-symbols-outlined text-electric-blue block mb-1">speed</span>
<span className="font-bold text-sm">3.8s</span>
<span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">0-100km/h</span>
</div>
</div>
<button className="w-full py-3 rounded-xl border border-primary font-bold hover:bg-primary hover:text-white transition-all">View Details</button>
</div>
</div>

<div className="group bg-surface-container-lowest border border-outline-variant rounded-3xl overflow-hidden hover:shadow-xl transition-all duration-300">
<div className="relative aspect-[16/10] overflow-hidden">
<img className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" data-alt="A front three-quarter view of a deep blue electric sedan with slim matrix LED headlights. The car is positioned on a glass floor reflecting the ceiling's blue neon light accents. Modern EV aesthetic with high information density in the background design." src="https://lh3.googleusercontent.com/aida-public/AB6AXuDCGdNYs7uRpH9xMXHQ_ne2aSS0_sm1n8nuuooJTdyDtBFw9YdbPTgeztXeT3mdWpkZDANpFgTMyC-Ajn-EAdAy7z03PTNCtgqUS-1_iiXn1-9FeSpg1BL-qDVbWgPiWxg4KLgHWLvsQsuT1hzZ3hX7w6ZqrsmtBnWtjjDPO3Wxy3AwTW4aC7oOszPQIwBAHv6g_1U8-WustYsCBvcO5pbxIrQnvmQ0MOC40w9KkgWBlPn_3yprtgL329t7oN_9gFDvyCSlrsxhZ5xB"/>
</div>
<div className="p-6 space-y-6">
<div className="flex justify-between items-start">
<div>
<h3 className="font-headline-lg text-xl">Nexus GT</h3>
<p className="text-on-surface-variant text-sm">Performance Sport</p>
</div>
<span className="text-electric-blue font-bold text-xl">58,000 JOD</span>
</div>
<div className="grid grid-cols-3 gap-4 border-t border-b border-outline-variant/30 py-4">
<div className="text-center">
<span className="material-symbols-outlined text-electric-blue block mb-1">bolt</span>
<span className="font-bold text-sm">540km</span>
<span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">Range</span>
</div>
<div className="text-center">
<span className="material-symbols-outlined text-electric-blue block mb-1">battery_charging_full</span>
<span className="font-bold text-sm">75kWh</span>
<span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">Battery</span>
</div>
<div className="text-center">
<span className="material-symbols-outlined text-electric-blue block mb-1">speed</span>
<span className="font-bold text-sm">4.2s</span>
<span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">0-100km/h</span>
</div>
</div>
<button className="w-full py-3 rounded-xl border border-primary font-bold hover:bg-primary hover:text-white transition-all">View Details</button>
</div>
</div>

<div className="group bg-surface-container-lowest border border-outline-variant rounded-3xl overflow-hidden hover:shadow-xl transition-all duration-300">
<div className="relative aspect-[16/10] overflow-hidden">
<img className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" data-alt="A compact metallic silver electric city car parked in an urban landscape with clean geometric architecture. Soft morning light creates gentle shadows. The car features a panoramic glass roof and futuristic wheels. High-end lifestyle photography." src="https://lh3.googleusercontent.com/aida-public/AB6AXuDiqL8zy2hWZDFNo6r5PLJrGQDWWJzsFKFWbNZ27Kxfo8-buMniJMF4ujDt8hRCywSIDx5tK44QbuLivJ9U4CxWNfSPxBeir9uTZMsmLxwu5XCPB4sq-hIRVeqjU8JlzmJ3odQvzDc-FvEwN0BKaYiRH4KMxBo0vOCzMnTLQz-ap1XmbnqI0rtI2nY0ilG4fH-qDthHSERoE4b3mJCNn5cYWQzkTw95xusdA2E9b_akW11ChfaOEybX2Oyu3itj0W0Y0Xtbt11JIr22"/>
</div>
<div className="p-6 space-y-6">
<div className="flex justify-between items-start">
<div>
<h3 className="font-headline-lg text-xl">CityFlow E1</h3>
<p className="text-on-surface-variant text-sm">Urban Specialist</p>
</div>
<span className="text-electric-blue font-bold text-xl">32,900 JOD</span>
</div>
<div className="grid grid-cols-3 gap-4 border-t border-b border-outline-variant/30 py-4">
<div className="text-center">
<span className="material-symbols-outlined text-electric-blue block mb-1">bolt</span>
<span className="font-bold text-sm">310km</span>
<span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">Range</span>
</div>
<div className="text-center">
<span className="material-symbols-outlined text-electric-blue block mb-1">battery_charging_full</span>
<span className="font-bold text-sm">44kWh</span>
<span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">Battery</span>
</div>
<div className="text-center">
<span className="material-symbols-outlined text-electric-blue block mb-1">speed</span>
<span className="font-bold text-sm">7.5s</span>
<span className="text-[10px] text-on-surface-variant block uppercase tracking-wider">0-100km/h</span>
</div>
</div>
<button className="w-full py-3 rounded-xl border border-primary font-bold hover:bg-primary hover:text-white transition-all">View Details</button>
</div>
</div>
</div>
</section>

<section className="bg-surface-container-low py-section-gap">
<div className="max-w-screen-2xl mx-auto px-gutter grid lg:grid-cols-2 gap-16 items-center">
<div className="order-2 lg:order-1">
<div className="relative">
<div className="absolute -top-10 -left-10 w-40 h-40 bg-electric-blue/10 rounded-full blur-3xl"></div>
<img className="relative rounded-[2rem] shadow-2xl z-10" data-alt="A modern wall-mounted electric vehicle charging station in a clean, minimalist garage. The charger has a sleek black design with a glowing green status light. A high-end EV is partially visible connected to the cable. The environment is organized and reflects a luxury tech-forward lifestyle." src="https://lh3.googleusercontent.com/aida-public/AB6AXuB9tkPxwJAFg1dg7T2fR9-ReZcO-EMVzIDUAjRq_nhV0pOaJykZJZR3AEAjn29KuTd4ZqvFZm9Av74w0MG2m26rKkueSl9eddpPn9InjFd010rLHkxBjL8ruhFFRBsGjHT73U8M2miU6D1pWhR4jGTCl6CsLQDoR8fRQUiaSsZq9jaTB-OqkblBG9lXg59L6eJerJJ7E-oehcR3ma5lBHOYbU3VFFXoIeaukamq1NY-WV6--Eq2S-ErndEmuAWY2R6uJQKXlbh9xNI6"/>
<div className="absolute -bottom-8 -right-8 bg-white p-6 rounded-2xl shadow-xl z-20 flex gap-4 items-center">
<div className="bg-whatsapp-green/20 p-3 rounded-full">
<span className="material-symbols-outlined text-whatsapp-green">ev_station</span>
</div>
<div>
<p className="font-bold text-primary">150+ Points</p>
<p className="text-xs text-on-surface-variant">Jordan Public Network</p>
</div>
</div>
</div>
</div>
<div className="order-1 lg:order-2 space-y-8">
<h2 className="font-headline-lg text-headline-lg">Powering Your <br/>Journey Home &amp; Beyond</h2>
<p className="text-on-surface-variant text-lg leading-relaxed">
                        Say goodbye to gas stations. Our holistic charging ecosystem provides smart wall-boxes for your home and exclusive access to the fastest charging network across Jordan's main highways.
                    </p>
<div className="space-y-4">
<div className="flex gap-4 items-start">
<div className="bg-primary text-white p-2 rounded-lg mt-1">
<span className="material-symbols-outlined">home</span>
</div>
<div>
<h4 className="font-bold">AutoFlow Home Charger</h4>
<p className="text-sm text-on-surface-variant">Full charge overnight with our 11kW smart home station.</p>
</div>
</div>
<div className="flex gap-4 items-start">
<div className="bg-primary text-white p-2 rounded-lg mt-1">
<span className="material-symbols-outlined">map</span>
</div>
<div>
<h4 className="font-bold">Nationwide Network</h4>
<p className="text-sm text-on-surface-variant">Access to fast chargers from Amman to Aqaba via our app.</p>
</div>
</div>
</div>
<button className="bg-primary text-white px-8 py-4 rounded-xl font-bold hover:bg-primary/90 transition-colors">
                        Explore Infrastructure
                    </button>
</div>
</div>
</section>

<section className="py-section-gap px-gutter bg-white relative overflow-hidden">
<div className="max-w-4xl mx-auto text-center space-y-6 mb-16 relative z-10">
<h2 className="font-headline-lg text-headline-lg">The Efficiency Advantage</h2>
<p className="text-on-surface-variant font-arabic-ui">احسب مقدار التوفير عند الانتقال إلى السيارة الكهربائية</p>
</div>
<div className="max-w-5xl mx-auto glass p-8 md:p-12 rounded-[3rem] border border-outline-variant/30 shadow-sm relative z-10">
<div className="grid md:grid-cols-2 gap-12">
<div className="space-y-8">
<div>
<label className="block font-bold mb-4 flex justify-between">
                                Monthly Distance <span><span id="distVal">2,000</span> km</span>
</label>
<input className="w-full h-2 bg-surface-container-high rounded-lg appearance-none cursor-pointer accent-electric-blue" id="distRange" max="10000" min="500" step="100" type="range" value="2000"/>
</div>
<div>
<label className="block font-bold mb-4 flex justify-between">
                                Gas Price (JOD/L) <span><span id="gasVal">1.25</span> JOD</span>
</label>
<input className="w-full h-2 bg-surface-container-high rounded-lg appearance-none cursor-pointer accent-electric-blue" id="gasRange" max="2.0" min="0.8" step="0.05" type="range" value="1.25"/>
</div>
<div className="p-6 bg-surface-container-low rounded-2xl">
<p className="text-xs text-on-surface-variant uppercase font-bold tracking-widest mb-2">Estimated Electricity Cost</p>
<div className="flex items-center gap-2">
<span className="text-electric-blue font-bold text-2xl">0.12 JOD</span>
<span className="text-sm text-on-surface-variant">/ kWh Average</span>
</div>
</div>
</div>
<div className="bg-primary rounded-[2rem] p-8 text-white flex flex-col justify-center items-center text-center space-y-4">
<p className="text-on-primary-container font-label-caps tracking-widest">ESTIMATED YEARLY SAVINGS</p>
<div className="text-6xl font-bold text-electric-blue" id="savingsTotal">1,840</div>
<span className="text-2xl font-bold">JOD / Year</span>
<p className="text-sm text-on-primary-container opacity-80 mt-4 leading-relaxed">
                            Based on local utility rates and average combustion engine efficiency. Switching to EV pays for itself in just 4 years.
                        </p>
<button className="mt-6 w-full py-4 bg-white text-primary rounded-xl font-bold hover:bg-electric-blue hover:text-white transition-all">Start Your Switch</button>
</div>
</div>
</div>

<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full opacity-5 pointer-events-none">

</div>
</section>

<section className="py-section-gap px-gutter max-w-screen-2xl mx-auto">
<div className="text-center mb-16">
<h2 className="font-headline-lg text-headline-lg">Intelligence in Every Kilowatt</h2>
<p className="text-on-surface-variant mt-2 font-arabic-ui">تكنولوجيا القيادة الذكية والاتصال المتقدم</p>
</div>
<div className="grid grid-cols-2 lg:grid-cols-4 gap-8">
<div className="p-8 rounded-3xl border border-outline-variant hover:border-electric-blue hover:bg-electric-blue/[0.02] transition-all text-center space-y-4">
<div className="w-16 h-16 bg-surface-container rounded-2xl flex items-center justify-center mx-auto text-electric-blue">
<span className="material-symbols-outlined text-4xl">sensors</span>
</div>
<h3 className="font-bold text-xl">L2+ Autopilot</h3>
<p className="text-sm text-on-surface-variant">Advanced sensor fusion for semi-autonomous cruising.</p>
</div>
<div className="p-8 rounded-3xl border border-outline-variant hover:border-electric-blue hover:bg-electric-blue/[0.02] transition-all text-center space-y-4">
<div className="w-16 h-16 bg-surface-container rounded-2xl flex items-center justify-center mx-auto text-electric-blue">
<span className="material-symbols-outlined text-4xl">update</span>
</div>
<h3 className="font-bold text-xl">OTA Updates</h3>
<p className="text-sm text-on-surface-variant">Your car gets better every week with wireless software upgrades.</p>
</div>
<div className="p-8 rounded-3xl border border-outline-variant hover:border-electric-blue hover:bg-electric-blue/[0.02] transition-all text-center space-y-4">
<div className="w-16 h-16 bg-surface-container rounded-2xl flex items-center justify-center mx-auto text-electric-blue">
<span className="material-symbols-outlined text-4xl">smartphone</span>
</div>
<h3 className="font-bold text-xl">App Command</h3>
<p className="text-sm text-on-surface-variant">Control climate, location, and security from your smartphone.</p>
</div>
<div className="p-8 rounded-3xl border border-outline-variant hover:border-electric-blue hover:bg-electric-blue/[0.02] transition-all text-center space-y-4">
<div className="w-16 h-16 bg-surface-container rounded-2xl flex items-center justify-center mx-auto text-electric-blue">
<span className="material-symbols-outlined text-4xl">shield</span>
</div>
<h3 className="font-bold text-xl">Safety Core</h3>
<p className="text-sm text-on-surface-variant">5-Star safety rating with reinforced battery protection cell.</p>
</div>
</div>
</section>
</main>

<footer className="bg-primary py-section-gap">
<div className="w-full max-w-screen-2xl mx-auto px-margin-desktop grid grid-cols-1 md:grid-cols-4 gap-gutter">
<div className="space-y-6">
<span className="font-display-luxury text-display-luxury text-luxury-gold text-4xl block">{props.site.profile.dealershipName}</span>
<p className="text-on-primary-container text-sm leading-relaxed">
                    The leading platform for electric mobility in the Hashemite Kingdom of Jordan. Redefining how we move, one charge at a time.
                </p>
<div className="flex gap-4">
<a className="w-10 h-10 rounded-full border border-white/10 flex items-center justify-center text-white hover:bg-electric-blue hover:border-electric-blue transition-all" href="#">
<span className="material-symbols-outlined text-xl">public</span>
</a>
<a className="w-10 h-10 rounded-full border border-white/10 flex items-center justify-center text-white hover:bg-electric-blue hover:border-electric-blue transition-all" href="#">
<span className="material-symbols-outlined text-xl">mail</span>
</a>
</div>
</div>
<div className="space-y-4">
<h4 className="text-white font-bold text-lg">Inventory</h4>
<nav className="flex flex-col gap-2">
<a className="text-on-primary-container hover:text-white transition-colors" href="#">Electric Sedans</a>
<a className="text-on-primary-container hover:text-white transition-colors" href="#">Electric SUVs</a>
<a className="text-on-primary-container hover:text-white transition-colors" href="#">Pre-Owned EV</a>
<a className="text-on-primary-container hover:text-white transition-colors" href="#">Commercial EV</a>
</nav>
</div>
<div className="space-y-4">
<h4 className="text-white font-bold text-lg">Owners</h4>
<nav className="flex flex-col gap-2">
<a className="text-on-primary-container hover:text-white transition-colors" href="#">Service Center</a>
<a className="text-on-primary-container hover:text-white transition-colors" href="#">Charging Maps</a>
<a className="text-on-primary-container hover:text-white transition-colors" href="#">Software Updates</a>
<a className="text-on-primary-container hover:text-white transition-colors" href="#">Finance Calculator</a>
</nav>
</div>
<div className="space-y-4">
<h4 className="text-white font-bold text-lg">Contact Us</h4>
<p className="text-on-primary-container text-sm">
                    7th Circle, Mecca Street<br/>
                    Amman, Jordan
                </p>
<p className="text-white font-bold">+962 6 000 0000</p>
<button className="bg-luxury-gold text-primary w-full py-3 rounded-lg font-bold hover:bg-jod-gold transition-colors">
                    Book Test Drive
                </button>
</div>
</div>
<div className="max-w-screen-2xl mx-auto px-margin-desktop mt-20 pt-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-4 text-[10px] uppercase tracking-[0.2em] text-on-primary-container">
<span>© 2024 AutoFlow Dealership System. All Rights Reserved. Amman, Jordan.</span>
<div className="flex gap-8">
<a className="hover:text-white" href="#">Privacy Policy</a>
<a className="hover:text-white" href="#">Terms of Service</a>
<a className="hover:text-white" href="#">Shipping Info</a>
</div>
</div>
</footer>


    </div>
  );
}

export function KineticSalesTheme(props: ThemeProps) {
  return (
    <div className="theme-kinetic bg-background text-on-background" dir={props.dir}>
      

<nav className="bg-surface/90 backdrop-blur-xl docked full-width top-0 sticky z-50 shadow-sm">
<div className="flex justify-between items-center px-gutter py-4 w-full max-w-screen-2xl mx-auto">
<div className="flex items-center gap-8">
<span className="font-display-luxury text-display-luxury text-luxury-gold">{props.site.profile.dealershipName}</span>
<div className="hidden lg:flex items-center gap-6">
<a className="text-secondary border-b-2 border-secondary font-bold pb-1 font-label-caps text-label-caps" href="#">Inventory</a>
<a className="text-on-surface-variant hover:text-primary transition-colors font-label-caps text-label-caps" href="#">New Arrivals</a>
<a className="text-on-surface-variant hover:text-primary transition-colors font-label-caps text-label-caps" href="#">Special Offers</a>
<a className="text-on-surface-variant hover:text-primary transition-colors font-label-caps text-label-caps" href="#">Finance</a>
<a className="text-on-surface-variant hover:text-primary transition-colors font-label-caps text-label-caps" href="#">About Us</a>
</div>
</div>
<div className="flex items-center gap-4">
<button className="hidden md:flex items-center gap-2 px-4 py-2 bg-whatsapp-green text-white rounded-lg font-bold hover:scale-95 transition-transform active:scale-90">
<span className="material-symbols-outlined">whatshot</span>
<span className="font-arabic-ui text-arabic-ui">WhatsApp Support</span>
</button>
<div className="flex items-center gap-3">
<span className="material-symbols-outlined text-primary cursor-pointer p-2 hover:bg-surface-container-highest/50 rounded-full transition-colors">language</span>
<span className="font-arabic-ui text-arabic-ui text-primary cursor-pointer font-bold">العربية</span>
<span className="material-symbols-outlined text-primary cursor-pointer p-2 hover:bg-surface-container-highest/50 rounded-full transition-colors">search</span>
<span className="material-symbols-outlined text-primary cursor-pointer p-2 hover:bg-surface-container-highest/50 rounded-full transition-colors">directions_car</span>
</div>
</div>
</div>
</nav>
<main>

<section className="relative min-h-[870px] flex items-center overflow-hidden sales-gradient text-white">

<div className="absolute inset-0 z-0 bg-gradient-to-r from-primary via-primary/80 to-transparent"></div>
<div className="relative z-10 w-full max-w-screen-2xl mx-auto px-margin-desktop py-section-gap grid lg:grid-cols-2 gap-12 items-center">
<div className="space-y-8">
<div className="inline-flex items-center gap-2 px-4 py-1 bg-secondary rounded-full">
<span className="animate-ping h-2 w-2 rounded-full bg-white opacity-75"></span>
<span className="font-label-caps text-label-caps uppercase tracking-widest text-white">200+ Cars Available in Amman</span>
</div>
<h1 className="font-headline-lg text-[64px] leading-tight font-extrabold uppercase italic tracking-tighter">
                        Find Your Next <br/>
<span className="text-secondary">Car Today</span>
</h1>
<p className="text-xl text-primary-fixed max-w-lg font-body-md">
                        The largest selection of premium used and new vehicles in Jordan. Quality inspected. Finance approved. Ready for delivery.
                    </p>

<div className="bg-white p-2 rounded-xl shadow-2xl flex flex-col md:flex-row items-center gap-2">
<div className="flex-1 w-full relative">
<span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-outline">search</span>
<input className="w-full pl-12 pr-4 py-4 text-primary border-none focus:ring-0 rounded-lg" placeholder="Search Make or Model (e.g. Toyota Camry)" type="text"/>
</div>
<button className="w-full md:w-auto px-8 py-4 bg-secondary text-white font-bold rounded-lg hover:bg-on-secondary-fixed transition-colors flex items-center justify-center gap-2">
<span className="font-label-caps text-label-caps">FIND CARS</span>
<span className="material-symbols-outlined">arrow_forward</span>
</button>
</div>
<div className="flex flex-wrap gap-4">
<button className="px-8 py-4 border-2 border-white text-white font-bold rounded-lg hover:bg-white hover:text-primary transition-all">
                            View All 200+ Cars
                        </button>
<button className="px-8 py-4 bg-white/10 backdrop-blur-md text-white font-bold rounded-lg hover:bg-white/20 transition-all flex items-center gap-2">
<span className="material-symbols-outlined">calculate</span>
                            Calculate Monthly Payment
                        </button>
</div>
</div>
<div className="hidden lg:block relative group">
<div className="absolute -inset-4 bg-secondary/20 blur-3xl rounded-full group-hover:bg-secondary/40 transition-colors duration-700"></div>
<img className="relative z-10 w-full h-auto object-cover rounded-2xl shadow-2xl transform group-hover:scale-[1.02] transition-transform duration-500" data-alt="A side-profile high-performance luxury sports sedan in a striking crimson red color, parked in a minimalist high-tech showroom with polished concrete floors and dramatic spotlighting. The lighting is aggressive and high-contrast, emphasizing the sharp aerodynamic lines of the car. The overall aesthetic is bold, modern, and high-performance, fitting the premium sales-focused automotive theme of AutoFlow Jordan." src="https://lh3.googleusercontent.com/aida-public/AB6AXuCISsNZv4p3s3nQX53EvqatD2UUtA1HnS1SuZamDkx6j07K8q3-_DmI8GsqbuwHJI70v7hECzMMo3fSJOhNX1uweay5guuGrNaEO2Qw1JV31BVKAL3nTnwKYlTDNSjJ3hK7VsxKiIBQYGy-GyMO1ViBNU75QYAVJdJJ9FqqvkfTmZekueid1yGHMjra7f_M2AFez-flbuL-CGhUIB9AxuUoXOeNfSUhtGkDkAZ_EkbrVq54BY9d1V9Q2jyBhRyKhLd_IkYbpLYZ-aw9"/>
<div className="absolute bottom-6 right-6 z-20 glass-card p-6 rounded-xl border border-white/20">
<p className="text-primary font-bold text-lg mb-1">Weekly Special</p>
<p className="text-secondary text-3xl font-extrabold">Save 2,500 JOD</p>
</div>
</div>
</div>
</section>

<section className="py-section-gap px-margin-desktop max-w-screen-2xl mx-auto">
<div className="flex justify-between items-end mb-12">
<div>
<h2 className="font-headline-lg text-headline-lg text-primary uppercase italic">Hot Offers <span className="text-secondary font-black">/ العروض الساخنة</span></h2>
<div className="h-1 w-24 bg-secondary mt-2"></div>
</div>
<a className="text-secondary font-bold flex items-center gap-1 hover:underline" href="#">
                    View All Deals <span className="material-symbols-outlined">chevron_right</span>
</a>
</div>
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-gutter">

<div className="group bg-surface-container-lowest rounded-xl overflow-hidden shadow-sm hover:shadow-xl transition-shadow border border-outline-variant relative">
<div className="absolute top-4 left-4 z-10">
<span className="bg-secondary text-white px-3 py-1 font-bold text-xs rounded uppercase urgent-pulse">Price Drop</span>
</div>
<div className="h-64 overflow-hidden relative">
<img className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" data-alt="A sleek 2023 metallic grey Toyota Camry parked against a clean urban backdrop in Amman. The photo is bright and clear, with a low camera angle that makes the vehicle look prestigious and powerful. High-quality commercial automotive photography style with crisp details and a premium showroom feel." src="https://lh3.googleusercontent.com/aida-public/AB6AXuApQ4LS6vMlBYD8tcCBhpjYFU3cLZYoUMAxULnQB3qk2g3vXaVuaQqrIVnH6SMa0jCi29DXkCnXdoYtc6c96aeh6_UiTXYMmGgzYvs7g03aF5QhyHRmqdxvlRWE9CjpZ4_37yMA52ADbyd2lpwicx_fEygnUHZV1e0X2xxqPqOdcse5MbAhL8__ahMZRkc7qI0ILFFXiQEhCErD_YDYyTKBNTvjM9BCTb1f58-2m9T7QdGyyHFP6cGrlF8gE2qJ7GuUt_j2x75HeZee"/>
</div>
<div className="p-6">
<div className="flex justify-between items-start mb-2">
<h3 className="text-xl font-bold text-primary">Toyota Camry 2023 GLE</h3>
<span className="text-outline text-sm">34,000 KM</span>
</div>
<div className="flex items-center gap-4 text-sm text-on-surface-variant mb-6">
<span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">local_gas_station</span> Hybrid</span>
<span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">settings_suggest</span> Automatic</span>
</div>
<div className="flex items-end justify-between">
<div>
<p className="text-outline line-through text-sm">29,500 JOD</p>
<p className="text-2xl font-black text-secondary">27,500 JOD</p>
</div>
<button className="bg-primary text-white p-3 rounded-lg hover:bg-secondary transition-colors">
<span className="material-symbols-outlined">whatshot</span>
</button>
</div>
</div>
</div>

<div className="group bg-surface-container-lowest rounded-xl overflow-hidden shadow-sm hover:shadow-xl transition-shadow border border-outline-variant relative">
<div className="absolute top-4 left-4 z-10">
<span className="bg-secondary text-white px-3 py-1 font-bold text-xs rounded uppercase">Save 2,000 JOD</span>
</div>
<div className="h-64 overflow-hidden relative">
<img className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" data-alt="A pearl white 2022 Hyundai Tucson SUV showcased in a bright, modern dealership environment. The lighting is soft and even, highlighting the car's contemporary design and high-tech features. Professional automotive marketing photography with a clean, trustworthy aesthetic." src="https://lh3.googleusercontent.com/aida-public/AB6AXuD8AJTAe1Qt2OCHzXL4_ZwxM4HBeMrI_k0d5QsQkQ1_7J-cOF2iTC7dvFuOWmBGrROaEqYZDsSUCX5kYZQS-cEduZF6k_fybx3tPFlN7tm69Ac1zBkfOJNHianaUVLssqh9SgmHKEDQK1fEOVSVpcAAbP7Fv1rkqATgqgEnPhtxi9dc6d6xAIWcjuJLDf2TO3Kh5Xfezi1daL5oZxYk8j6iTj1fQ4iTWc6mS48LRNSsLT44SwjEu4I-ZY13YsduZ_dsJsZNzp6fbjt1"/>
</div>
<div className="p-6">
<div className="flex justify-between items-start mb-2">
<h3 className="text-xl font-bold text-primary">Hyundai Tucson 2022</h3>
<span className="text-outline text-sm">12,500 KM</span>
</div>
<div className="flex items-center gap-4 text-sm text-on-surface-variant mb-6">
<span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">local_gas_station</span> Petrol</span>
<span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">settings_suggest</span> Automatic</span>
</div>
<div className="flex items-end justify-between">
<div>
<p className="text-outline line-through text-sm">24,000 JOD</p>
<p className="text-2xl font-black text-secondary">22,000 JOD</p>
</div>
<button className="bg-primary text-white p-3 rounded-lg hover:bg-secondary transition-colors">
<span className="material-symbols-outlined">whatshot</span>
</button>
</div>
</div>
</div>

<div className="group bg-surface-container-lowest rounded-xl overflow-hidden shadow-sm hover:shadow-xl transition-shadow border border-outline-variant relative">
<div className="absolute top-4 left-4 z-10">
<span className="bg-secondary text-white px-3 py-1 font-bold text-xs rounded uppercase urgent-pulse">Limited Stock</span>
</div>
<div className="h-64 overflow-hidden relative">
<img className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" data-alt="A deep black 2024 Kia Sorento SUV with aggressive styling, positioned on a modern asphalt road with a city skyline in the far distance. Dramatic sunset lighting creates long shadows and highlights the premium paint finish. Bold, high-impact commercial automotive imagery." src="https://lh3.googleusercontent.com/aida-public/AB6AXuAOT5QCVfPR2ym4Mnaq2n4sQ01vGTKX_KC1Ywue1s3EXANfpN1_aODF1W0yBHV_Q2EUW76c2oH-NwSfnBDicDLovhrKNpaaUKWICdeOvPAZK_YuXkDRwRkUR2vJ4qPaKTnXtB1OpgG_Nvbc98Q0X2Gxd__rKTapo23QBzkxJv28EDFhT00T_qh8bMuum-ffrxnewxNA7NY49QMhPGrMTzjZqb2krGMf4E5SScJt5MweoteYzCjERuxBMIAFR4uS_BpgKG8OTNsSMhQ-"/>
</div>
<div className="p-6">
<div className="flex justify-between items-start mb-2">
<h3 className="text-xl font-bold text-primary">Kia Sorento 2024</h3>
<span className="text-outline text-sm">New</span>
</div>
<div className="flex items-center gap-4 text-sm text-on-surface-variant mb-6">
<span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">local_gas_station</span> Hybrid</span>
<span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">settings_suggest</span> Automatic</span>
</div>
<div className="flex items-end justify-between">
<div>
<p className="text-2xl font-black text-secondary">38,900 JOD</p>
</div>
<button className="bg-primary text-white p-3 rounded-lg hover:bg-secondary transition-colors">
<span className="material-symbols-outlined">whatshot</span>
</button>
</div>
</div>
</div>
</div>
</section>

<section className="bg-primary-container text-white py-section-gap relative overflow-hidden">
<div className="absolute top-0 right-0 w-1/3 h-full bg-secondary/10 skew-x-12 translate-x-24"></div>
<div className="max-w-screen-2xl mx-auto px-margin-desktop grid lg:grid-cols-2 gap-16 items-center relative z-10">
<div>
<h2 className="font-headline-lg text-headline-lg mb-6 uppercase">Estimate your installments <br/> <span className="text-secondary">in 10 seconds</span></h2>
<p className="text-on-primary-container text-lg mb-10 max-w-md">
                        Get an instant monthly payment estimate. No commitment required. Our finance partners offer the most competitive rates in Jordan.
                    </p>
<div className="grid grid-cols-2 gap-6">
<div className="bg-white/5 border border-white/10 p-4 rounded-xl">
<span className="material-symbols-outlined text-secondary text-3xl mb-2">speed</span>
<p className="font-bold">Fast Approval</p>
<p className="text-xs text-on-primary-container">Response within 24 hours</p>
</div>
<div className="bg-white/5 border border-white/10 p-4 rounded-xl">
<span className="material-symbols-outlined text-secondary text-3xl mb-2">percent</span>
<p className="font-bold">Low Interest</p>
<p className="text-xs text-on-primary-container">Starting from 3.5% annually</p>
</div>
</div>
</div>
<div className="bg-white rounded-2xl p-8 text-primary shadow-2xl">
<div className="space-y-6">
<div>
<label className="block text-sm font-bold uppercase tracking-wider text-outline mb-2">Car Price (JOD)</label>
<input className="w-full accent-secondary" max="100000" min="5000" type="range" value="25000"/>
<div className="flex justify-between mt-2 font-black text-xl">
<span>25,000 JOD</span>
</div>
</div>
<div>
<label className="block text-sm font-bold uppercase tracking-wider text-outline mb-2">Down Payment (%)</label>
<div className="flex gap-2">
<button className="flex-1 py-2 border-2 border-secondary bg-secondary text-white rounded-lg font-bold">20%</button>
<button className="flex-1 py-2 border-2 border-outline-variant hover:border-secondary rounded-lg font-bold">30%</button>
<button className="flex-1 py-2 border-2 border-outline-variant hover:border-secondary rounded-lg font-bold">50%</button>
</div>
</div>
<div className="bg-surface-container-low p-6 rounded-xl border-l-4 border-secondary">
<p className="text-sm font-bold text-outline uppercase mb-1">Estimated Monthly Payment</p>
<div className="flex items-baseline gap-2">
<span className="text-4xl font-black text-primary">342 JOD</span>
<span className="text-on-surface-variant text-sm">/ month*</span>
</div>
</div>
<button className="w-full py-4 bg-secondary text-white font-bold rounded-lg uppercase italic tracking-widest hover:scale-95 transition-transform flex items-center justify-center gap-2">
                            Apply for Finance Now
                            <span className="material-symbols-outlined">arrow_forward_ios</span>
</button>
<p className="text-[10px] text-outline text-center">*Terms and conditions apply. Rates may vary based on credit profile and bank approval.</p>
</div>
</div>
</div>
</section>

<section className="py-section-gap px-margin-desktop bg-surface">
<div className="max-w-screen-2xl mx-auto">
<div className="text-center mb-16">
<div className="inline-block px-6 py-2 bg-secondary text-white font-black text-2xl uppercase italic rounded-lg mb-4">
                        20+ Cars Sold This Week
                    </div>
<h2 className="font-headline-lg text-headline-lg text-primary">Recent Customer Deliveries</h2>
</div>
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-gutter">
<div className="space-y-4">
<img className="w-full h-48 object-cover rounded-xl grayscale hover:grayscale-0 transition-all duration-500" data-alt="A happy Jordanian family posing with their new white SUV in front of a modern dealership. The setting is bright and sunny, conveying success and satisfaction. Warm, inviting documentary style photography." src="https://lh3.googleusercontent.com/aida-public/AB6AXuAS_bQFZY1WLiZmymIE6DKbuATqqdr0RKaXX5RELvVHH2wfgTEDdCSz57snPWFNO_kmgbSFFfR99EnKNOlQ6uTpcfgwTUilEASasX33-Bv6WYHlPWQFJDRznG3NYWd6GXzoNjbllAbEL9BhLOMu1eGDnvbhcMykn0LCJZZwn0V4wrT7--Ul6Aivc5r1LyF14BW67Oue2k2FJoyTrRD4j6NJE9JgccrRw0jojHxoj98dZG0RJ5rrNFK6uIEzERCsbC1abbL-Y5TeWc3B"/>
<div>
<p className="font-bold text-primary">Sold: Kia Sportage 2023</p>
<p className="text-on-surface-variant text-sm font-arabic-ui">تم التسليم لزبوننا في عمان</p>
</div>
</div>
<div className="space-y-4">
<img className="w-full h-48 object-cover rounded-xl grayscale hover:grayscale-0 transition-all duration-500" data-alt="A professional young man in business attire taking the keys to a metallic blue luxury sedan. The interaction is professional and joyful, set in a clean, modern showroom. High-contrast, sharp photography." src="https://lh3.googleusercontent.com/aida-public/AB6AXuDywAsLCxFqbCxCE3iwXGGTJrUXrrTIKsEECXnT2vGZhF5ARS_wdE232C23WJYrUivr9sRL74s5g7IdFXgmJz7A-4d9crhIkb4a-4GRk_78Pc8EYPMqfFCXmsyF7ocT3oA1AAJvxzpFpADokH-2ntg75e8AptEEtr7TuR__yrFPhqsOy7kCC_2kU0mazkz_5KaktB78zSzzYqXpv5YYA89w-uUKT1kYrXA1wKWSijj_WQFfEn--LHIeYd3PyZi3rGzLLy6XxsOTgANA"/>
<div>
<p className="font-bold text-primary">Sold: Mercedes C200</p>
<p className="text-on-surface-variant text-sm font-arabic-ui">مبروك لزبوننا الجديد من إربد</p>
</div>
</div>
<div className="space-y-4">
<img className="w-full h-48 object-cover rounded-xl grayscale hover:grayscale-0 transition-all duration-500" data-alt="Close up of a customer's hand shaking hands with a car salesperson, with a shiny red car out of focus in the background. Professional and celebratory mood, focusing on trust and transaction completion." src="https://lh3.googleusercontent.com/aida-public/AB6AXuA03zRRn25DvuZ1LwzV8r-phf8EGnY2wfgWBeMJqAQhg6BPU1LBECZEFjo14I25QQw0YKIHIYCThpFyXeWfI3kwitfzGRykTiSg6O4niBPiC6bAjBW6D9gIHqsN93R6u91vYP9oFBgE7tHO8YYH5i3whRCNPhwdvqfeJR_Pe-DA6yaZ6lGX8w-uiMiK9OwiKMny_cbCzjKhcj-CWh1rDjhOD9oEkYPfsMEcQhCWn-DLpKY4X-3ekw-2sDwUEooVyuXCgjzTDYtPK3md"/>
<div>
<p className="font-bold text-primary">Sold: Toyota RAV4</p>
<p className="text-on-surface-variant text-sm font-arabic-ui">تم البيع خلال 24 ساعة فقط</p>
</div>
</div>
<div className="space-y-4">
<img className="w-full h-48 object-cover rounded-xl grayscale hover:grayscale-0 transition-all duration-500" data-alt="A brand new black electric vehicle with a large red ribbon on its hood, ready for delivery inside a premium dealership. The lighting is pristine, showing off the car's mirror-like finish." src="https://lh3.googleusercontent.com/aida-public/AB6AXuB5CKtne3R-FzZRGCmiRoRpamLYL0pVc-LKDyLYNfxUjiBng6zMb8MW_SnzJesKPUXchiRrpcniHo2wVG7f0Ie-QBioXJphJ8COFO3RhMVTxO9Q-Na65ImfQXGPzzn_7HcP9F48Ocug_KkgN1U7o_mS32UDwo_PlUznzD3Swr-UbY20Eeq0M-izVn5rDMM_lu_i9io40PQSU87-j-pLv3q1bCc6gSgTXABKFniMI5mzj1KkKR5mltbd_BZgzXOreH8HLjZdvXmqALwJ"/>
<div>
<p className="font-bold text-primary">Sold: VW ID.4</p>
<p className="text-on-surface-variant text-sm font-arabic-ui">انضمت سيارة كهربائية جديدة لشوارعنا</p>
</div>
</div>
</div>
</div>
</section>

<section className="bg-secondary py-16 px-margin-desktop text-white text-center">
<h2 className="text-4xl md:text-5xl font-black uppercase italic mb-8">Ready to drive your dream car?</h2>
<div className="flex flex-col md:flex-row gap-4 justify-center items-center">
<button className="w-full md:w-auto px-12 py-5 bg-primary text-white font-bold text-xl rounded-xl hover:bg-on-primary-fixed transition-all flex items-center justify-center gap-4">
<span className="material-symbols-outlined text-3xl">directions_car</span>
                    VIEW ALL INVENTORY
                </button>
<button className="w-full md:w-auto px-12 py-5 bg-whatsapp-green text-white font-bold text-xl rounded-xl hover:scale-105 transition-all flex items-center justify-center gap-4">
<span className="material-symbols-outlined text-3xl">whatshot</span>
                    CHAT WITH SALES
                </button>
</div>
</section>
</main>

<footer className="bg-primary py-section-gap">
<div className="w-full max-w-screen-2xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-gutter px-margin-desktop text-on-primary">
<div className="space-y-6">
<span className="font-display-luxury text-display-luxury text-luxury-gold">{props.site.profile.dealershipName}</span>
<p className="text-on-primary-container text-sm">
                    Jordan's leading automotive dealership system. Bringing transparency and efficiency to every transaction.
                </p>
<div className="flex gap-4">
<span className="material-symbols-outlined p-2 bg-white/5 rounded-full hover:text-luxury-gold transition-colors cursor-pointer">face_nod</span>
<span className="material-symbols-outlined p-2 bg-white/5 rounded-full hover:text-luxury-gold transition-colors cursor-pointer">camera</span>
<span className="material-symbols-outlined p-2 bg-white/5 rounded-full hover:text-luxury-gold transition-colors cursor-pointer">share</span>
</div>
</div>
<div>
<h4 className="font-bold text-white mb-6 uppercase tracking-widest">Quick Links</h4>
<ul className="space-y-4 text-on-primary-container">
<li><a className="hover:text-luxury-gold transition-colors" href="#">Privacy Policy</a></li>
<li><a className="hover:text-luxury-gold transition-colors" href="#">Terms of Service</a></li>
<li><a className="hover:text-luxury-gold transition-colors" href="#">Shipping Info</a></li>
<li><a className="hover:text-luxury-gold transition-colors" href="#">VAT Registration</a></li>
<li><a className="hover:text-luxury-gold transition-colors" href="#">Location</a></li>
</ul>
</div>
<div>
<h4 className="font-bold text-white mb-6 uppercase tracking-widest">Showroom</h4>
<div className="space-y-4 text-on-primary-container">
<p className="flex items-center gap-2">
<span className="material-symbols-outlined text-secondary">location_on</span>
                        Mecca Street, Amman, Jordan
                    </p>
<p className="flex items-center gap-2">
<span className="material-symbols-outlined text-secondary">schedule</span>
                        Sat - Thu: 09:00 - 20:00
                    </p>
<p className="flex items-center gap-2">
<span className="material-symbols-outlined text-secondary">phone</span>
                        +962 6 000 0000
                    </p>
</div>
</div>
<div>
<h4 className="font-bold text-white mb-6 uppercase tracking-widest">Join Our Newsletter</h4>
<p className="text-on-primary-container text-sm mb-4">Get first access to price drops and new arrivals.</p>
<div className="flex">
<input className="bg-white/5 border border-white/10 rounded-l-lg px-4 py-2 w-full focus:ring-1 focus:ring-secondary text-white" placeholder="Your Email" type="email"/>
<button className="bg-secondary text-white px-4 py-2 rounded-r-lg font-bold">JOIN</button>
</div>
</div>
</div>
<div className="max-w-screen-2xl mx-auto px-margin-desktop mt-16 pt-8 border-t border-white/5 text-center text-on-primary-container text-xs">
            © 2024 AutoFlow Dealership System. All Rights Reserved. Amman, Jordan.
        </div>
</footer>

<div className="md:hidden fixed bottom-0 left-0 w-full bg-surface shadow-[0_-4px_20px_rgba(0,0,0,0.1)] z-50">
<div className="flex justify-around items-center py-4">
<button className="flex flex-col items-center gap-1 text-secondary">
<span className="material-symbols-outlined">home</span>
<span className="text-[10px] font-bold">Home</span>
</button>
<button className="flex flex-col items-center gap-1 text-on-surface-variant">
<span className="material-symbols-outlined">directions_car</span>
<span className="text-[10px] font-bold">Inventory</span>
</button>
<button className="flex flex-col items-center gap-1 text-on-surface-variant">
<span className="material-symbols-outlined">calculate</span>
<span className="text-[10px] font-bold">Finance</span>
</button>
<button className="flex flex-col items-center gap-1 text-on-surface-variant">
<span className="material-symbols-outlined">whatshot</span>
<span className="text-[10px] font-bold">Contact</span>
</button>
</div>
</div>

<div className="fixed bottom-24 right-6 z-40 md:bottom-8">
<button className="bg-whatsapp-green text-white p-4 rounded-full shadow-2xl hover:scale-110 transition-transform active:scale-90 group relative">
<span className="material-symbols-outlined text-4xl">whatshot</span>
<div className="absolute right-full mr-4 top-1/2 -translate-y-1/2 bg-white text-primary px-4 py-2 rounded-lg text-sm font-bold shadow-xl whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                Need help? Chat now!
            </div>
</button>
</div>


    </div>
  );
}
