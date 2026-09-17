// Compile application TypeScript in memory for Node tests and maintenance scripts. The normal
// typecheck command remains responsible for type safety; tests use the same code
// as Next without writing build artifacts or depending on its server runtime.
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoot = pathToFileURL(path.join(root, "src") + path.sep).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier.startsWith("@/")) specifier = pathToFileURL(path.join(root, "src", specifier.slice(2))).href;
    if ((specifier.startsWith(".") || specifier.startsWith("file:")) && context.parentURL) {
      for (const ext of [".ts", ".tsx"]) {
        const candidate = new URL(specifier + ext, context.parentURL);
        if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && /\.tsx?$/.test(url)) {
      const filename = fileURLToPath(url);
      return {
        format: "module",
        shortCircuit: true,
        source: ts.transpileModule(fs.readFileSync(filename, "utf8"), {
          fileName: filename,
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
        }).outputText,
      };
    }
    return nextLoad(url, context);
  },
});
