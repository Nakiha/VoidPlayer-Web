/** Historical native evidence retains its original executor identity. New
 * analysis-WASM evidence pins both glue and binary and never invents a native
 * supervisor hash or process resource accounting. */
export type NativeScoringComponent = {
  manifestSha256: string;
  binarySha256: string;
  supervisorSha256: string;
  sourceRevision: string;
};
export type AnalysisScoringComponent = {
  executor: "analysis-wasm";
  abi: 1;
  manifestSha256: string;
  binarySha256: string;
  glueSha256: string;
  provenanceSha256: string;
  sourceRevision: string;
  coreRevision: string;
};
export type ScoringComponent =
  | NativeScoringComponent
  | AnalysisScoringComponent;
export type AnalysisScoringResources = {
  executor: "analysis-wasm";
  wallMs: number;
  heapBytes: number;
};
export function validateScoringComponent(
  value: unknown,
): asserts value is ScoringComponent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Missing scoring component");
  const c = value as Record<string, unknown>;
  const wasm = c.executor === "analysis-wasm";
  const fields = wasm
    ? [
        "executor",
        "abi",
        "manifestSha256",
        "binarySha256",
        "glueSha256",
        "provenanceSha256",
        "sourceRevision",
        "coreRevision",
      ]
    : ["manifestSha256", "binarySha256", "supervisorSha256", "sourceRevision"];
  // modelSha256 is additionally required by the VMAF caller, absent for CAMBI.
  if (
    Object.keys(c).some((k) => !fields.includes(k) && k !== "modelSha256") ||
    fields.some((k) => !(k in c)) ||
    fields
      .filter((k) => k.endsWith("Sha256"))
      .some((k) => !/^[a-f0-9]{64}$/.test(String(c[k]))) ||
    !/^[a-f0-9]{40}$/.test(String(c.sourceRevision)) ||
    (wasm && (c.abi !== 1 || !/^[a-f0-9]{40}$/.test(String(c.coreRevision))))
  )
    throw new Error("Invalid scoring component identity");
}
