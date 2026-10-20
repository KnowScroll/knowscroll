import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
// Compile the actual pinned schemas, preserving source bytes. Node's TS loader cannot run .ts
// dependencies inside a deployed node_modules tree. Only relative extensions change in the output.
const source = new URL('../packages/backend/src/modules/content/adapters/cutroom/wire-v1/', import.meta.url);
const target = new URL('../packages/backend/dist/modules/content/adapters/cutroom/wire-runtime/', import.meta.url);
await mkdir(target, { recursive: true });
for (const file of await readdir(source)) {
  if (!file.endsWith('.ts')) continue;
  const compiled = ts.transpileModule(await readFile(new URL(file, source), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022, rewriteRelativeImportExtensions: true },
    fileName: file,
  });
  await writeFile(new URL(file.replace(/\.ts$/, '.js'), target), compiled.outputText);
}
