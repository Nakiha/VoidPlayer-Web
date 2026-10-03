declare const catalog: Partial<Record<import("./types.ts").Sources extends infer S ? keyof S : never, (values?: Record<string, string | number>) => string>>;
export default catalog;
