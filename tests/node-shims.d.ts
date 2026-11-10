// Minimal ambient types for the Node built-ins this repo's tests use.
//
// Why this exists: the project has no `@types/node` in its dependency tree, and
// `tsconfig.json` type-checks `tests/` under `strict` while `npm run build` runs
// `tsc -b`. Without this file a test that reads files (`node:fs`) fails type-check
// even though vitest runs it fine. Declaring only the functions actually used
// keeps the surface honest instead of pulling in a full (installed-less) type
// package.
//
// Replace this file with a real `@types/node` devDependency when one is added:
//   npm install -D @types/node  &&  delete tests/node-shims.d.ts

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function existsSync(path: string): boolean;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
