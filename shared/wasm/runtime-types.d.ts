/** Host-neutral subset of the standard WebAssembly API consumed by core.ts.
 * Kept module-scoped: importing this contract never installs DOM/global types. */
export interface Module {
}
export type Imports = Record<string, Record<string, unknown>>;
export class Memory {
    readonly buffer: ArrayBufferLike;
}
export class Instance {
    constructor(module: Module, imports: Imports);
    readonly exports: Record<string, unknown>;
}
export function compile(bytes: Uint8Array<ArrayBuffer>): Promise<Module>;
