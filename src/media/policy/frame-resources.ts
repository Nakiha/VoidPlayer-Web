/** The composition root supplies the consumer's current resource demand.
 * Decoders consult it while pulling a frame, inside existing backpressure. */
let nativeDemand = () => false;
export const needsNativeFrameResource = () => nativeDemand();
export function configureFrameResourceDemand(demand: () => boolean) {
  nativeDemand = demand;
}
