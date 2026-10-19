/// <reference types="expo/types" />

/** Metro resolves a font import to an asset module ID. */
declare module '*.ttf' {
  const asset: number;
  export default asset;
}
