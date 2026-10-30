export type ColorMode = 'reference' | 'browser';
export type ReferenceDecode = {decoder:'hardware'|'software';depth:1|2|4|8};

/** Captured once for a source open; later preference changes cannot alter it. */
export type DecodeConfiguration = Readonly<{colorMode:ColorMode|null;referenceDecode:Readonly<ReferenceDecode>}>;
