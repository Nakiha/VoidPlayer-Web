export type PresentationInfo = { requestedTarget: 'sdr' | 'hdr'; actualTarget: 'sdr' | 'hdr'; captureTarget: 'sdr'; executor: string; contract: string;
    displayHdr: boolean; outputColorSpace: 'srgb' | 'display-p3'; outputFormat: 'unorm8' | 'float16'; toneMapping: 'standard' | 'extended'; fallbackReason?: string };
