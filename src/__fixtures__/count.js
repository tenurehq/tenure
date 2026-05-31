import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FIELDS_TO_STRIP = ["why_it_matters", "updated_at"];

try {
  const inputPath = resolve("src/__fixtures__/beliefs.seed.json");
  const outputPath = resolve("src/__fixtures__/beliefs.seed.public.json");

  const raw = JSON.parse(readFileSync(inputPath, "utf8"));

  if (!Array.isArray(raw)) {
    console.error("❌ Error: Top-level structure is not an array.");
    process.exit(1);
  }

  const stripped = raw.map((belief) => {
    const out = { ...belief };
    for (const field of FIELDS_TO_STRIP) {
      delete out[field];
    }
    return out;
  });

  writeFileSync(outputPath, JSON.stringify(stripped, null, 2));

  console.log(`✅ Wrote ${stripped.length} beliefs to ${outputPath}`);
  console.log(`🗑️  Stripped fields: ${FIELDS_TO_STRIP.join(", ")}`);
} catch (error) {
  console.error("❌ Failed:", error.message);
}
