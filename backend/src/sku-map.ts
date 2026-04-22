export type SkuDefinition = {
  sku: string;
  instrument: string;
  description: string;
  aliases?: string[];
};

export const skuDefinitions: SkuDefinition[] = [
  {
    sku: "HTM-890",
    instrument: "890 HTM",
    description: "HTM-890 2-in-1 Contact cum Non Contact Digital Tachometer",
    aliases: ["htm 890 tachometer", "contact non contact digital tachometer"]
  },
  {
    sku: "REFLECTIVE-TAPES",
    instrument: "Reflective tapes",
    description: "Reflective tapes"
  },
  {
    sku: "RUBBER-TIPS",
    instrument: "Rubber tips",
    description: "Rubber tips"
  },
  {
    sku: "HTM-560",
    instrument: "560 HTM",
    description: "HTM-560 Non-Contact Digital Tachometer"
  },
  {
    sku: "HTM-590",
    instrument: "590 HTM",
    description: "HTM-590 Contact Type Digital Tachometer"
  },
  {
    sku: "TS-201",
    instrument: "TS 201",
    description: "TS-201 Temperature and Humidity 2-in-1 Sensor with IoT"
  },
  {
    sku: "TS-200",
    instrument: "TS 200",
    description: "TS-200 Temperature sensor with IoT"
  },
  {
    sku: "TM-804-SENSOR",
    instrument: "TM 804 Sensor alone",
    description: "TM-804 Photo-Reflective Sensor"
  },
  {
    sku: "TM-802-SENSOR",
    instrument: "TM 802 Sensor alone",
    description: "TM-802 Magnetic Pickup Sensor"
  },
  {
    sku: "TM-804-PLUS",
    instrument: "TM 804+ Sensor",
    description: "TM 804 Digital Panel Mount Tachometer with Photo-Reflective Sensor"
  },
  {
    sku: "TM-803-PLUS",
    instrument: "TM 803+ Sensor",
    description: "TM 803 Digital Panel Mount Tachometer with Proximity Switch Sensor"
  },
  {
    sku: "TM-802-PLUS",
    instrument: "TM 802+ Sensor",
    description: "TM 802 Digital Panel Mount Tachometer with Magnetic Pick-up Sensor"
  },
  {
    sku: "TM-801-PLUS",
    instrument: "TM 801+ Sensor",
    description: "TM 801 Digital Panel Mount Tachometer with Digital Tachogenerator Sensor"
  },
  {
    sku: "TM-803",
    instrument: "TM 803 Sensor alone",
    description: "TM 803 Sensor"
  },
  {
    sku: "TM-801",
    instrument: "TM 801 Sensor alone",
    description: "TM 801 Sensor"
  },
  {
    sku: "REFLECTIVE-TAPE-ROLL",
    instrument: "High Intensity Reflective Tape",
    description:
      "High Intensity Reflective Tape - 3 Feet per Roll, Minimum Quantity of 3 Rolls, Designed for Precision in RPM Measurement and Superior Reflectivity",
    aliases: ["reflective tape per roll", "high intensity reflective tape"]
  },
  {
    sku: "RUBBER-TIPS-PREMIUM",
    instrument: "Premium Rubber Tips for Tachometers",
    description:
      "Premium Rubber Tips for Tachometers - Set of 4 Durable Plastic Nose Tips for Precise Measurement and Protection",
    aliases: ["premium rubber tips", "durable plastic nose tips"]
  },
  {
    sku: "TM-803-PROX",
    instrument: "TM 803 Proximity Pickup Sensor alone",
    description: "TM 803 Proximity Pickup Sensor alone"
  },
  {
    sku: "TM-801-TA",
    instrument: "TM 801 Tachogenerator Sensor alone",
    description: "TM 801 Tachogenerator Sensor alone"
  },
  {
    sku: "TM-DISPLAY",
    instrument: "TM",
    description: "Digital Panel Mount Tachometer (Display)",
    aliases: ["tm display", "panel mount digital tachometer display"]
  },
  {
    sku: "TM-CARDS",
    instrument: "TM cards",
    description: "Panel Mount Cards"
  }
];

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const skuMatchers = skuDefinitions.map((entry) => ({
  entry,
  keywords: Array.from(
    new Set(
      [entry.instrument, entry.description, ...(entry.aliases ?? [])]
        .map((value) => normalize(value))
        .filter(Boolean)
    )
  )
}));

export function matchSku(line: string): SkuDefinition | null {
  const normalizedLine = normalize(line);
  for (const matcher of skuMatchers) {
    if (matcher.keywords.some((key) => normalizedLine.includes(key))) {
      return matcher.entry;
    }
  }
  return null;
}

export function findSkuByName(name: string): SkuDefinition | null {
  const normalizedName = normalize(name);
  if (!normalizedName) return null;
  for (const matcher of skuMatchers) {
    if (matcher.keywords.some((key) => normalizedName.includes(key))) {
      return matcher.entry;
    }
  }
  return null;
}
