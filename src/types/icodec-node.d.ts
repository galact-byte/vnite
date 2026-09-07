// The `icodec/node` entry is exposed through package.json "exports", which the
// project's classic `moduleResolution: node` cannot follow. Map it to the real
// type declarations so `import('icodec/node')` stays fully typed. Node honors
// the exports map at runtime, so only the compile-time alias is needed here.
declare module 'icodec/node' {
  export * from 'icodec/lib/index.js'
}
