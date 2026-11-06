/** WebGPU requires four-byte writes. Only copy the trailing 1..3 bytes into
 * padding; the full frame and any leading view offset remain untouched. */
export function uploadPixelBuffer<T>(queue: {
  writeBuffer(buffer:T, offset:number, data:ArrayBufferLike|Uint8Array, dataOffset?:number, size?:number):void;
}, buffer:T, pixels:Uint8Array|Uint8ClampedArray):void {
  const aligned = pixels.byteLength - pixels.byteLength % 4;
  if (aligned) queue.writeBuffer(buffer, 0, pixels.buffer, pixels.byteOffset, aligned);
  if (aligned !== pixels.byteLength) {
    const tail = new Uint8Array(4);
    tail.set(pixels.subarray(aligned));
    queue.writeBuffer(buffer, aligned, tail);
  }
}
