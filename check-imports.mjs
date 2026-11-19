// check-imports.mjs
// Run from your backend folder:  node check-imports.mjs
// Lists every relative import (./ or ../) that points to a file that doesn't exist.
import fs from "fs";
import path from "path";

const skip = new Set(["node_modules", ".git"]);
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.m?js$/.test(entry.name)) files.push(full);
  }
})(".");

const importRe = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
let broken = 0;
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(importRe)) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (!fs.existsSync(target)) {
      broken++;
      console.log(`MISSING in ${file}\n    imports ${match[1]}`);
    }
  }
}
console.log(broken ? `\n${broken} broken import(s) found.` : "All relative imports resolve.");