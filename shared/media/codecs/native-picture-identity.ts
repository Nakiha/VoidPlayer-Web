/** WebCodecs output attribution for an admitted one-picture input. The key is
 * the exact chunk clock in this decoder epoch, never a nearest-PTS index lookup.
 * This is local decoder evidence, not a quality cache/source authentication. */
export interface NativePictureIdentity {
  protocol: 'webcodecs-associated-chunk-v1'; epoch: number;
  au: number; configuration: number; pts: number; dts: number;
  offset: number; size: number;
  configurationHex: string;
}
export const NATIVE_CONFIGURATION_MAX_BYTES=4096;
/** Exact configuration bytes serialized ONCE, not a hash or an authentication
 * claim. No compressed-payload or pixel hashing/copying per frame. */
export function nativeConfigurationHex(bytes:Uint8Array) {
  if(!bytes.length||bytes.length>NATIVE_CONFIGURATION_MAX_BYTES)return '';
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
export class NativePictureInputs {
  private epoch = 0;
  private pending = new Map<number, NativePictureIdentity>();
  private disabled = false;
  private configurationHex?:string;
  private readonly capacity:number;
  constructor(capacity = 512) { this.capacity=capacity; }
  reset() { this.epoch++; this.pending.clear(); this.disabled = false; this.configurationHex=undefined; }
  reject() { this.disabled = true; this.pending.clear(); }
  accepted(clock: number, packet: Omit<NativePictureIdentity, 'protocol'|'epoch'> | undefined) {
    if (this.disabled) return;
    if (!packet || !Number.isSafeInteger(clock) || this.pending.has(clock) || this.pending.size >= this.capacity) {
      this.reject(); return;
    }
    if ([packet.au,packet.configuration,packet.pts,packet.dts,packet.offset,packet.size].some(n => !Number.isSafeInteger(n)) || packet.au < 0 || packet.configuration < 0 || packet.offset < 0 || packet.size < 1) {
      this.reject(); return;
    }
    if(this.configurationHex===undefined){
      if(typeof packet.configurationHex!=='string'||packet.configurationHex.length>NATIVE_CONFIGURATION_MAX_BYTES*2||!/^(?:[a-f0-9]{2})+$/.test(packet.configurationHex)){this.reject();return;}
      this.configurationHex=packet.configurationHex;
    }else if(this.configurationHex!==packet.configurationHex){this.reject();return;}
    this.pending.set(clock, { protocol: 'webcodecs-associated-chunk-v1', epoch: this.epoch, ...packet });
  }
  output(clock: number): NativePictureIdentity | undefined {
    if (this.disabled) return;
    const input = this.pending.get(clock);
    if (!input) { this.reject(); return; }
    this.pending.delete(clock);
    return { ...input };
  }
}
