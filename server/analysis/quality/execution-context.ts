import type {QualityAdmission} from '../../quality-admission.ts';
/** Decoder/scorer workers need immutable locations and admission, not an application locator. */
export type QualityExecutionContext={readonly indexDatabase:string;readonly qualityAdmission:QualityAdmission};
