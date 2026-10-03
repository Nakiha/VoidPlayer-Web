import { t, msg } from '../i18n.ts';
import { colorLabel as sourceColorLabel } from '../media-metadata.ts';

// Keep language dependencies out of the metadata used by demuxers and workers.
export const colorLabel = (value: string | null | undefined) => value ? sourceColorLabel(value) : t(msg("metadata.unspecified", "未标记"));
export const rangeLabel = (value: boolean | null | undefined) => value == null ? t(msg("metadata.unspecified", "未标记")) : value ? t(msg("metadata.fullRange", "全范围 (PC)")) : t(msg("metadata.limitedRange", "有限范围 (TV)"));
