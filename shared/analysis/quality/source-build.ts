import {PAIR_LIMITS} from './frame-pair.ts';
/** Separate explicit cache operation; never a side effect of source discovery,
 * presented-frame binding, inspection or scoring. */
export const QUALITY_SOURCE_BUILD_LIMITS=Object.freeze({maxSourceBytes:64*1024*1024,maxReadBytes:128*1024*1024,
  maxPackets:PAIR_LIMITS.maxIndexPackets,maxIndexBytes:PAIR_LIMITS.maxIndexBytes,maxElapsedMs:30000,maxHeapMb:256});
