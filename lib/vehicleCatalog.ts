// lib/vehicleCatalog.ts
//
// Canonical vehicle make/model catalog for the marketplace. Buyer requests
// and dealer inventory both arrive as free text ("تويوتا", "Toyota ", "toyota")
// — matching them requires one canonical spelling per make, with Arabic and
// Latin aliases folding into it. Shared by the request wizard's selectors,
// browse autosuggest, and the Convex matching code (same import pattern as
// lib/financing.ts).

export type CanonicalMake = {
  /** Canonical English display name, e.g. "Toyota". */
  name: string;
  /** Alternate spellings — lowercased Latin and Arabic — that fold into this make. */
  aliases: string[];
  /** Popular models in this market, canonical casing, for autosuggest. */
  popularModels: string[];
};

export const VEHICLE_MAKES: CanonicalMake[] = [
  {
    name: "Toyota",
    aliases: ["تويوتا"],
    popularModels: ["Corolla", "Camry", "Yaris", "RAV4", "Land Cruiser", "Prado", "Hilux", "C-HR", "Avalon", "Corolla Cross"],
  },
  {
    name: "Hyundai",
    aliases: ["هيونداي", "هيونداى", "هيوندا", "هيونداي"],
    popularModels: ["Elantra", "Sonata", "Tucson", "Accent", "Santa Fe", "Kona", "Ioniq", "Ioniq 5", "Venue", "Avante"],
  },
  {
    name: "Kia",
    aliases: ["كيا"],
    popularModels: ["Sportage", "Cerato", "Picanto", "Rio", "Optima", "K5", "Sorento", "Soul", "Niro", "Seltos"],
  },
  {
    name: "Nissan",
    aliases: ["نيسان"],
    popularModels: ["Sunny", "Sentra", "Altima", "Qashqai", "X-Trail", "Patrol", "Kicks", "Leaf", "Micra"],
  },
  {
    name: "Honda",
    aliases: ["هوندا"],
    popularModels: ["Civic", "Accord", "CR-V", "HR-V", "City"],
  },
  {
    name: "Mitsubishi",
    aliases: ["ميتسوبيشي", "متسوبيشي", "ميتسوبيشى"],
    popularModels: ["Lancer", "Pajero", "Outlander", "ASX", "Attrage", "Eclipse Cross"],
  },
  {
    name: "Mazda",
    aliases: ["مازدا"],
    popularModels: ["Mazda 3", "Mazda 6", "CX-5", "CX-30", "CX-9"],
  },
  {
    name: "Suzuki",
    aliases: ["سوزوكي", "سوزوكى"],
    popularModels: ["Swift", "Baleno", "Vitara", "Jimny", "Ciaz", "Fronx"],
  },
  {
    name: "Isuzu",
    aliases: ["ايسوزو", "إيسوزو"],
    popularModels: ["D-Max", "MU-X"],
  },
  {
    name: "Lexus",
    aliases: ["لكزس", "ليكزس", "لكسز"],
    popularModels: ["ES", "IS", "RX", "NX", "LX", "UX"],
  },
  {
    name: "Mercedes-Benz",
    aliases: ["مرسيدس", "مرسيدس بنز", "مارسيدس", "mercedes", "benz", "mercedes benz"],
    popularModels: ["C-Class", "E-Class", "S-Class", "A-Class", "CLA", "GLA", "GLC", "GLE", "EQE", "EQS"],
  },
  {
    name: "BMW",
    aliases: ["بي ام دبليو", "بي إم دبليو", "بمو", "بي ام"],
    popularModels: ["3 Series", "5 Series", "7 Series", "X1", "X3", "X5", "i4", "iX", "X6"],
  },
  {
    name: "Audi",
    aliases: ["اودي", "أودي", "اودى"],
    popularModels: ["A3", "A4", "A6", "Q3", "Q5", "Q7", "e-tron"],
  },
  {
    name: "Volkswagen",
    aliases: ["فولكس فاجن", "فولكسفاغن", "فولكس واجن", "فولكس", "vw"],
    popularModels: ["Golf", "Passat", "Jetta", "Tiguan", "Touareg", "T-Roc", "ID.4", "ID.6"],
  },
  {
    name: "Skoda",
    aliases: ["سكودا", "شكودا", "škoda"],
    popularModels: ["Octavia", "Superb", "Kodiaq", "Karoq", "Fabia"],
  },
  {
    name: "SEAT",
    aliases: ["سيات"],
    popularModels: ["Leon", "Ibiza", "Ateca", "Arona"],
  },
  {
    name: "Opel",
    aliases: ["اوبل", "أوبل"],
    popularModels: ["Astra", "Corsa", "Insignia", "Grandland", "Mokka"],
  },
  {
    name: "Peugeot",
    aliases: ["بيجو", "بيجوت"],
    popularModels: ["208", "301", "308", "508", "2008", "3008", "5008"],
  },
  {
    name: "Renault",
    aliases: ["رينو", "رينوه"],
    popularModels: ["Megane", "Clio", "Duster", "Captur", "Koleos", "Logan"],
  },
  {
    name: "Citroën",
    aliases: ["ستروين", "سيتروين", "citroen"],
    popularModels: ["C3", "C4", "C5 Aircross", "C-Elysée"],
  },
  {
    name: "Ford",
    aliases: ["فورد"],
    popularModels: ["Focus", "Fusion", "Escape", "Explorer", "F-150", "Mustang", "EcoSport"],
  },
  {
    name: "Chevrolet",
    aliases: ["شفروليه", "شيفروليه", "شفرولية", "chevy"],
    popularModels: ["Cruze", "Malibu", "Captiva", "Equinox", "Tahoe", "Spark", "Bolt"],
  },
  {
    name: "Dodge",
    aliases: ["دودج"],
    popularModels: ["Charger", "Challenger", "Durango"],
  },
  {
    name: "Jeep",
    aliases: ["جيب"],
    popularModels: ["Grand Cherokee", "Cherokee", "Wrangler", "Compass", "Renegade"],
  },
  {
    name: "GMC",
    aliases: ["جي ام سي", "جمس"],
    popularModels: ["Yukon", "Acadia", "Terrain", "Sierra"],
  },
  {
    name: "Land Rover",
    aliases: ["لاند روفر", "لاندروفر", "رنج روفر", "رينج روفر", "landrover", "range rover"],
    popularModels: ["Range Rover", "Range Rover Sport", "Range Rover Evoque", "Discovery", "Defender", "Velar"],
  },
  {
    name: "Jaguar",
    aliases: ["جكوار", "جاكوار", "جاغوار"],
    popularModels: ["XE", "XF", "F-Pace", "E-Pace", "I-Pace"],
  },
  {
    name: "Volvo",
    aliases: ["فولفو"],
    popularModels: ["S60", "S90", "XC40", "XC60", "XC90"],
  },
  {
    name: "Porsche",
    aliases: ["بورشه", "بورش", "بورشة"],
    popularModels: ["Cayenne", "Macan", "Panamera", "911", "Taycan"],
  },
  {
    name: "Tesla",
    aliases: ["تسلا", "تيسلا"],
    popularModels: ["Model 3", "Model Y", "Model S", "Model X"],
  },
  {
    name: "BYD",
    aliases: ["بي واي دي", "بايد", "بي وای دي"],
    popularModels: ["Atto 3", "Seal", "Dolphin", "Han", "Song Plus", "Qin"],
  },
  {
    name: "MG",
    aliases: ["ام جي", "إم جي", "أم جي"],
    popularModels: ["MG 5", "MG 6", "ZS", "HS", "RX5", "MG 4"],
  },
  {
    name: "Chery",
    aliases: ["شيري", "تشيري"],
    popularModels: ["Tiggo 7", "Tiggo 8", "Arrizo 5", "Arrizo 6", "Tiggo 4"],
  },
  {
    name: "Jetour",
    aliases: ["جيتور"],
    popularModels: ["X70", "X90", "Dashing", "T2"],
  },
  {
    name: "Geely",
    aliases: ["جيلي", "جيلى"],
    popularModels: ["Coolray", "Emgrand", "Tugella", "Monjaro", "Geometry C"],
  },
  {
    name: "Haval",
    aliases: ["هافال"],
    popularModels: ["Jolion", "H6", "Dargo"],
  },
  {
    name: "Changan",
    aliases: ["شانجان", "تشانجان", "شانغان"],
    popularModels: ["CS35 Plus", "CS75 Plus", "Eado", "Alsvin", "UNI-T", "UNI-K"],
  },
  {
    name: "JAC",
    aliases: ["جاك"],
    popularModels: ["J7", "S3", "S4", "T8"],
  },
  {
    name: "Subaru",
    aliases: ["سوبارو"],
    popularModels: ["Impreza", "Forester", "Outback", "XV"],
  },
  {
    name: "Infiniti",
    aliases: ["انفينيتي", "إنفينيتي", "انفنيتي"],
    popularModels: ["Q50", "QX50", "QX60", "QX80"],
  },
  {
    name: "Genesis",
    aliases: ["جينيسيس", "جنسس"],
    popularModels: ["G70", "G80", "GV70", "GV80"],
  },
  {
    name: "Fiat",
    aliases: ["فيات"],
    popularModels: ["500", "Tipo", "Panda"],
  },
  {
    name: "MINI",
    aliases: ["ميني", "ميني كوبر", "mini cooper"],
    popularModels: ["Cooper", "Countryman", "Clubman"],
  },
];

// Arabic (and common variant) spellings of popular model names, folded to the
// canonical English model. Keys are pre-normalized (see normalizeToken).
const MODEL_ALIASES: Record<string, string> = {
  // Toyota
  "كورولا": "Corolla",
  "كامري": "Camry",
  "يارس": "Yaris",
  "راف فور": "RAV4",
  "راف 4": "RAV4",
  "لاند كروزر": "Land Cruiser",
  "لاندكروزر": "Land Cruiser",
  "برادو": "Prado",
  "هايلوكس": "Hilux",
  // Hyundai
  "النترا": "Elantra",
  "الانترا": "Elantra",
  "افانتي": "Avante",
  "سوناتا": "Sonata",
  "توسان": "Tucson",
  "توكسون": "Tucson",
  "اكسنت": "Accent",
  "سنتافي": "Santa Fe",
  "سانتافي": "Santa Fe",
  "كونا": "Kona",
  "ايونيك": "Ioniq",
  "ايونيك 5": "Ioniq 5",
  // Kia
  "سبورتاج": "Sportage",
  "سيراتو": "Cerato",
  "بيكانتو": "Picanto",
  "ريو": "Rio",
  "اوبتيما": "Optima",
  "سورينتو": "Sorento",
  "سول": "Soul",
  "نيرو": "Niro",
  "سيلتوس": "Seltos",
  // Nissan
  "صني": "Sunny",
  "سنترا": "Sentra",
  "التيما": "Altima",
  "قشقاي": "Qashqai",
  "كاشكاي": "Qashqai",
  "اكس تريل": "X-Trail",
  "باترول": "Patrol",
  "ليف": "Leaf",
  // Honda
  "سيفيك": "Civic",
  "اكورد": "Accord",
  "سي ار في": "CR-V",
  // Mitsubishi
  "لانسر": "Lancer",
  "باجيرو": "Pajero",
  "اوتلاندر": "Outlander",
  // Mercedes
  "سي كلاس": "C-Class",
  "اي كلاس": "E-Class",
  "اس كلاس": "S-Class",
  // VW
  "جولف": "Golf",
  "باسات": "Passat",
  "جيتا": "Jetta",
  "تيغوان": "Tiguan",
  "تيجوان": "Tiguan",
  // Skoda
  "اوكتافيا": "Octavia",
  "سوبيرب": "Superb",
  // Renault / Dacia family
  "ميجان": "Megane",
  "كليو": "Clio",
  "داستر": "Duster",
  // Chevrolet
  "كروز": "Cruze",
  "ماليبو": "Malibu",
  "كابتيفا": "Captiva",
  // Land Rover
  "رنج روفر": "Range Rover",
  "ديفندر": "Defender",
  "ديسكفري": "Discovery",
};

/**
 * Folds a free-text token for lookup: trims, lowercases, strips Arabic
 * diacritics and the definite article, and unifies hamza/taa-marbuta forms so
 * "أودي" and "اودى" land on the same key.
 */
function normalizeToken(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/^ال/, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ");
}

const makeByAlias: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const make of VEHICLE_MAKES) {
    map.set(normalizeToken(make.name), make.name);
    for (const alias of make.aliases) {
      map.set(normalizeToken(alias), make.name);
    }
  }
  return map;
})();

const modelByAlias: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const make of VEHICLE_MAKES) {
    for (const model of make.popularModels) {
      map.set(normalizeToken(model), model);
    }
  }
  for (const [alias, model] of Object.entries(MODEL_ALIASES)) {
    map.set(normalizeToken(alias), model);
  }
  return map;
})();

/** Canonical English make name for any known spelling, or null if unrecognized. */
export function normalizeMake(input: string | null | undefined): string | null {
  if (!input) return null;
  const token = normalizeToken(input);
  if (!token) return null;
  return makeByAlias.get(token) ?? null;
}

/** Canonical model name for any known spelling; unknown models fold to a trimmed, space-collapsed form so equal free text still matches itself. */
export function normalizeModel(input: string | null | undefined): string | null {
  if (!input) return null;
  const token = normalizeToken(input);
  if (!token) return null;
  return modelByAlias.get(token) ?? token;
}

/** True when two free-text makes refer to the same manufacturer. Unknown makes fall back to normalized-token equality so two dealers typing the same unknown brand still match. */
export function makesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const canonicalA = normalizeMake(a);
  const canonicalB = normalizeMake(b);
  if (canonicalA && canonicalB) return canonicalA === canonicalB;
  return normalizeToken(a) === normalizeToken(b);
}

/** True when two free-text models refer to the same model line. */
export function modelsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const normalizedA = normalizeModel(a);
  const normalizedB = normalizeModel(b);
  if (normalizedA == null || normalizedB == null) return false;
  return normalizedA === normalizedB;
}
