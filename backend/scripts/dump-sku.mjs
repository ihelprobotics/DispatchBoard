import fs from "fs";
import path from "path";
import { PDFParse } from "pdf-parse";

const skuPdf = path.resolve("../fwdbase", "Sales Sheet.xlsx - Google Sheets.pdf");

async function main() {
  try {
    const data = fs.readFileSync(skuPdf);
    const parser = new PDFParse({ data });
    const textResult = await parser.getText();
    const text = typeof textResult === "string" ? textResult : textResult?.text ?? "";
    console.log("=== RAW SKU PDF TEXT ===");
    console.log(text);
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    console.log("Lines:");
    lines.forEach((line, idx) => console.log(`${idx + 1}: ${line}`));
  } catch (err) {
    console.error("Failed to parse SKU PDF:", err);
    process.exit(1);
  }
}

main();
