/** UTF-16 code-unit order, the order `Array#sort` uses by default; locale-aware sorts are deliberately different. */
export const compareCodeUnits = (a: string, b: string) =>
  a < b ? -1 : a > b ? 1 : 0;
