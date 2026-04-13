import fs from "fs";
import path from "path";
import { PDFParse } from "pdf-parse";

async function dump(filePath) {
  const data = fs.readFileSync(filePath);
  const parser = new PDFParse({ data });
  const result = await parser.getText();
  const text = typeof result === "string" ? result : result?.text ?? "";
  console.log(`--- ${path.basename(filePath)} ---`);
  console.log(text);
}

async function main() {
  try {
    const target = process.argv[2];
    if (!target) {
      throw new Error("Provide a file path as the first argument");
    }
    const resolved = path.resolve(target);
    await dump(resolved);
  } catch (err) {
    console.error("Failed to dump PDF:", err);
    process.exit(1);
  }
}

main();
