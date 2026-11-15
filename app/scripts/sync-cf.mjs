// 同步云函数：src/utils 下的 ESM 模块合成 cloudfunctions/api/db-core.cjs.js（CommonJS）。
// 每个模块包进 IIFE 再解构导出名——notice/db-core/slots 各有同名私有工具（pad 等），
// 平铺拼接会撞名。用法：node scripts/sync-cf.mjs（build:mp-weixin 已串联）。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url))); // app/
const src = (p) => readFileSync(join(root, p), "utf8");

function exportNames(code) {
  const names = [];
  for (const m of code.matchAll(/^export (?:async )?(?:function|const|let) (\w+)/gm)) names.push(m[1]);
  for (const m of code.matchAll(/^export \{([^}]+)\}/gm))
    for (const n of m[1].split(",")) if (n.trim()) names.push(n.trim());
  return names;
}

// ESM → IIFE 段：剥 export 前缀、删相对 import，包成 (( ) => ({...导出名}))()
function segment(name, code) {
  const body = code
    .split("\n")
    .filter((ln) => !/^import .* from "\.\/.*";?\s*$/.test(ln))
    .map((ln) => ln.replace(/^export (async )?/, "$1").replace(/^export \{[^}]*\};?\s*$/, ""))
    .join("\n");
  const names = exportNames(code);
  return `const __${name} = (function () {\n${body}\nreturn { ${names.join(", ")} };\n})();\nconst { ${names.join(", ")} } = __${name};\n`;
}

const cjs = [
  "// 自动生成：npm run sync-cf（源：slots.js + notice.js + db-core.js），勿手改",
  '"use strict";',
  segment("slots", src("src/utils/slots.js")),
  segment("notice", src("src/utils/notice.js")),
  segment("suggest", src("src/utils/suggest.js")),
  segment("ttfile", src("src/utils/timetableFile.js")),
  segment("core", src("src/utils/db-core.js")),
  "module.exports = { bindStorage, localRequest, exportAll, importAll, importTimetable, SLOT_TIMES };",
].join("\n");
writeFileSync(join(root, "cloudfunctions/api/db-core.cjs.js"), cjs);
console.log("✓ db-core.cjs.js 生成");

// 拷贝 cloudfunctions 到 dist（build 与 dev 都有就都放），并给 project.config.json 加 cloudfunctionRoot
for (const dist of ["dist/build/mp-weixin", "dist/dev/mp-weixin"]) {
  const distDir = join(root, dist);
  if (!existsSync(distDir)) continue;
  copyDir(join(root, "cloudfunctions"), join(distDir, "cloudfunctions"));
  const cfgPath = join(distDir, "project.config.json");
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    if (!cfg.cloudfunctionRoot) {
      cfg.cloudfunctionRoot = "cloudfunctions/";
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      console.log(`✓ ${dist}/project.config.json + cloudfunctionRoot`);
    }
  }
  console.log(`✓ ${dist}/cloudfunctions 同步`);
}

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const f = join(from, name);
    if (statSync(f).isDirectory()) copyDir(f, join(to, name));
    else copyFileSync(f, join(to, name));
  }
}
