// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Ingredient and attribute synonyms. Two names are the same substance only
// when a table says so or when they normalize to the same string. Never by
// string similarity: "sodium chloride" and "sodium chlorite" differ by one
// letter and one is bleach. Names follow the INCI convention (Personal Care
// Products Council, International Cosmetic Ingredient Dictionary, 2024) for
// cosmetics and IUPAC names where the table lists a chemical name.

export interface SubstanceGroup {
  /** The preferred name, lowercase. */
  canonical: string;
  /** Other names for the same substance, lowercase. */
  names: string[];
  /** The INCI name when the substance has one, in INCI capitals. */
  inci?: string;
}

/** Built-in table. Add a group, never merge two groups on a guess. */
export const SUBSTANCE_TABLE: SubstanceGroup[] = [
  { canonical: "isopropyl alcohol", names: ["2-propanol", "isopropanol", "propan-2-ol", "rubbing alcohol"], inci: "ISOPROPYL ALCOHOL" },
  { canonical: "sodium chloride", names: ["salt", "table salt", "sea salt", "nacl"], inci: "SODIUM CHLORIDE" },
  { canonical: "tocopherol", names: ["vitamin e", "alpha-tocopherol", "dl-alpha-tocopherol", "d-alpha-tocopherol"], inci: "TOCOPHEROL" },
  { canonical: "ascorbic acid", names: ["vitamin c", "l-ascorbic acid"], inci: "ASCORBIC ACID" },
  { canonical: "retinol", names: ["vitamin a alcohol", "all-trans-retinol"], inci: "RETINOL" },
  { canonical: "water", names: ["aqua", "eau", "purified water", "deionized water", "distilled water"], inci: "AQUA" },
  { canonical: "sodium bicarbonate", names: ["baking soda", "sodium hydrogen carbonate", "bicarbonate of soda"], inci: "SODIUM BICARBONATE" },
  { canonical: "acetic acid", names: ["ethanoic acid"], inci: "ACETIC ACID" },
  { canonical: "ethanol", names: ["ethyl alcohol", "alcohol", "grain alcohol"], inci: "ALCOHOL" },
  { canonical: "glycerin", names: ["glycerol", "glycerine", "propane-1,2,3-triol"], inci: "GLYCERIN" },
  { canonical: "sodium hydroxide", names: ["lye", "caustic soda", "naoh"], inci: "SODIUM HYDROXIDE" },
  { canonical: "hydrogen peroxide", names: ["dihydrogen dioxide", "h2o2"], inci: "HYDROGEN PEROXIDE" },
  { canonical: "titanium dioxide", names: ["ci 77891", "titanium(iv) oxide", "titania"], inci: "TITANIUM DIOXIDE" },
  { canonical: "zinc oxide", names: ["ci 77947"], inci: "ZINC OXIDE" },
  { canonical: "citric acid", names: ["2-hydroxypropane-1,2,3-tricarboxylic acid"], inci: "CITRIC ACID" },
  { canonical: "sucrose", names: ["table sugar", "cane sugar", "beet sugar", "saccharose"], inci: "SUCROSE" },
  { canonical: "caffeine", names: ["1,3,7-trimethylxanthine", "guaranine", "theine"], inci: "CAFFEINE" },
  { canonical: "niacinamide", names: ["nicotinamide", "vitamin b3", "nicotinic acid amide"], inci: "NIACINAMIDE" },
  { canonical: "panthenol", names: ["provitamin b5", "d-panthenol", "dexpanthenol", "pro-vitamin b5"], inci: "PANTHENOL" },
  { canonical: "sodium lauryl sulfate", names: ["sodium dodecyl sulfate", "sls", "sodium lauryl sulphate", "sds"], inci: "SODIUM LAURYL SULFATE" },
  { canonical: "sodium laureth sulfate", names: ["sles", "sodium lauryl ether sulfate", "sodium laureth sulphate"], inci: "SODIUM LAURETH SULFATE" },
  { canonical: "dimethicone", names: ["polydimethylsiloxane", "pdms"], inci: "DIMETHICONE" },
  { canonical: "petrolatum", names: ["petroleum jelly", "white petrolatum", "soft paraffin"], inci: "PETROLATUM" },
  { canonical: "mineral oil", names: ["paraffinum liquidum", "liquid paraffin", "white mineral oil"], inci: "PARAFFINUM LIQUIDUM" },
  { canonical: "shea butter", names: ["butyrospermum parkii butter", "butyrospermum parkii (shea) butter", "karite butter"], inci: "BUTYROSPERMUM PARKII (SHEA) BUTTER" },
  { canonical: "coconut oil", names: ["cocos nucifera oil", "cocos nucifera (coconut) oil"], inci: "COCOS NUCIFERA (COCONUT) OIL" },
  { canonical: "jojoba oil", names: ["simmondsia chinensis seed oil", "simmondsia chinensis (jojoba) seed oil"], inci: "SIMMONDSIA CHINENSIS (JOJOBA) SEED OIL" },
  { canonical: "aloe vera leaf juice", names: ["aloe barbadensis leaf juice", "aloe vera juice", "aloe juice"], inci: "ALOE BARBADENSIS LEAF JUICE" },
  { canonical: "magnesium sulfate", names: ["epsom salt", "magnesium sulphate", "epsom salts"], inci: "MAGNESIUM SULFATE" },
  { canonical: "calcium carbonate", names: ["ci 77220", "chalk", "precipitated chalk"], inci: "CALCIUM CARBONATE" },
  { canonical: "menthol", names: ["l-menthol", "levomenthol"], inci: "MENTHOL" },
  { canonical: "salicylic acid", names: ["2-hydroxybenzoic acid", "bha"], inci: "SALICYLIC ACID" },
  { canonical: "benzoyl peroxide", names: ["dibenzoyl peroxide", "bpo"], inci: "BENZOYL PEROXIDE" },
  { canonical: "urea", names: ["carbamide"], inci: "UREA" },
  { canonical: "hyaluronic acid", names: ["hyaluronan"], inci: "HYALURONIC ACID" },
  { canonical: "sodium hyaluronate", names: ["hyaluronic acid sodium salt"], inci: "SODIUM HYALURONATE" },
  { canonical: "phenoxyethanol", names: ["2-phenoxyethanol", "ethylene glycol monophenyl ether"], inci: "PHENOXYETHANOL" },
  { canonical: "acetaminophen", names: ["paracetamol", "n-acetyl-p-aminophenol", "apap"] },
  { canonical: "ibuprofen", names: ["2-(4-isobutylphenyl)propanoic acid"] },
  { canonical: "fragrance", names: ["parfum", "perfume", "aroma"], inci: "PARFUM" },
  { canonical: "lactic acid", names: ["2-hydroxypropanoic acid"], inci: "LACTIC ACID" },
  { canonical: "cholecalciferol", names: ["vitamin d3"], inci: "CHOLECALCIFEROL" },
  { canonical: "cyanocobalamin", names: ["vitamin b12"], inci: "CYANOCOBALAMIN" },
  { canonical: "ferrous sulfate", names: ["iron(ii) sulfate", "ferrous sulphate", "iron sulfate"] },
  { canonical: "acetone", names: ["propanone", "2-propanone", "dimethyl ketone"], inci: "ACETONE" },
  { canonical: "methanol", names: ["methyl alcohol", "wood alcohol"], inci: "METHYL ALCOHOL" },
  { canonical: "xylitol", names: ["birch sugar"], inci: "XYLITOL" },
  { canonical: "potassium chloride", names: ["kcl", "salt substitute"], inci: "POTASSIUM CHLORIDE" },
];

/**
 * Attribute names and values that are spelling variants of one another.
 * These are spellings, not similar words: "colour" is "color"; "gray" is "grey".
 */
export const SPELLING_TABLE: string[][] = [
  ["color", "colour"],
  ["flavor", "flavour"],
  ["odor", "odour"],
  ["gray", "grey"],
  ["aluminum", "aluminium"],
  ["sulfate", "sulphate"],
  ["sulfur", "sulphur"],
  ["fiber", "fibre"],
  ["liter", "litre"],
  ["milliliter", "millilitre"],
  ["centimeter", "centimetre"],
  ["millimeter", "millimetre"],
  ["meter", "metre"],
];

// ---------------------------------------------------------------- normalization

const GREEK: Record<string, string> = { "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ω": "omega" };

/** Lowercase, NFKC, one space between words, ASCII hyphen, Greek letters spelled out, no stray punctuation at the ends. */
export function normalizeName(name: string): string {
  let s = name.normalize("NFKC").toLowerCase();
  s = s.replace(/[αβγδω]/g, (c) => GREEK[c] ?? c);
  s = s.replace(/[‐-―−]/g, "-");
  s = s.replace(/\s*-\s*/g, "-");
  s = s.replace(/\s*\/\s*/g, "/");
  s = s.replace(/\s*,\s*/g, ",");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[.,;:]+|[.,;:]+$/g, "");
  return s;
}

/** The INCI form: the normalized name in capitals, as the INCI dictionary prints it. */
export function normalizeInci(name: string): string {
  return normalizeName(name).toUpperCase();
}

/** Spelling variants collapse to the first spelling in their row, word by word. */
function normalizeSpelling(name: string): string {
  return normalizeName(name)
    .split(" ")
    .map((w) => {
      for (const row of SPELLING_TABLE) if (row.includes(w)) return row[0]!;
      return w;
    })
    .join(" ");
}

// ---------------------------------------------------------------- lookup

const INDEX: Map<string, SubstanceGroup> = new Map();
for (const g of SUBSTANCE_TABLE) {
  INDEX.set(normalizeSpelling(g.canonical), g);
  for (const n of g.names) INDEX.set(normalizeSpelling(n), g);
  if (g.inci) INDEX.set(normalizeSpelling(g.inci), g);
}

export function lookupSubstance(name: string): SubstanceGroup | null {
  return INDEX.get(normalizeSpelling(name)) ?? null;
}

/** Every name the table knows for this substance, the canonical name first. Unknown names return themselves. */
export function synonymsOf(name: string): string[] {
  const g = lookupSubstance(name);
  if (!g) return [normalizeName(name)];
  const out = [g.canonical].concat(g.names);
  if (g.inci) out.push(g.inci.toLowerCase());
  return Array.from(new Set(out));
}

export type SubstanceMatch =
  | { same: true; via: "exact" | "spelling" | "table"; canonical: string }
  | { same: false; reason: "different_substances" | "unknown_name" };

/**
 * Are these two names the same substance? Yes only through an exact match of
 * the normalized names, a spelling variant from the spelling table, or the
 * substance table. There is no distance measure here on purpose.
 */
export function sameSubstance(a: string, b: string): SubstanceMatch {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return { same: true, via: "exact", canonical: na };
  const sa = normalizeSpelling(a);
  const sb = normalizeSpelling(b);
  if (sa === sb) return { same: true, via: "spelling", canonical: sa };
  const ga = INDEX.get(sa);
  const gb = INDEX.get(sb);
  if (ga && gb) return ga === gb ? { same: true, via: "table", canonical: ga.canonical } : { same: false, reason: "different_substances" };
  if (!ga && !gb) return { same: false, reason: "unknown_name" };
  return { same: false, reason: "different_substances" };
}

/** Attribute names ("Colour" and "color") are the same only by normalization and the spelling table. */
export function sameAttributeName(a: string, b: string): boolean {
  return normalizeSpelling(a) === normalizeSpelling(b);
}

/** Attribute values: same rule as names, with units kept as given. */
export function sameAttributeValue(a: string, b: string): boolean {
  return normalizeSpelling(a) === normalizeSpelling(b);
}

/** Does an ingredient list, with declared synonyms and INCI names, contain this substance? */
export function listContains(ingredients: { name: string; synonyms: string[]; inci?: string }[], substance: string): { found: true; matched: string; via: SubstanceMatch } | { found: false } {
  for (const g of ingredients) {
    const names = [g.name].concat(g.synonyms, g.inci ? [g.inci] : []);
    for (const n of names) {
      const m = sameSubstance(n, substance);
      if (m.same) return { found: true, matched: n, via: m };
    }
  }
  return { found: false };
}
