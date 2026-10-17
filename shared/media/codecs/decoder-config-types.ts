/** Encoded decoder configuration data; no browser decoder or frame resource. */
export interface EncodedVideoConfiguration {
    codec: string;
    description?: Uint8Array<ArrayBuffer> | ArrayBuffer;
    displayAspectWidth?: number;
    displayAspectHeight?: number;
    codedWidth?: number;
    codedHeight?: number;
    optimizeForLatency?: boolean;
}
