/** Prefer an accelerated decoder when the browser accepts it. Capability
 * acceptance is a request preference, not evidence of the GPU used at runtime. */
export async function preferredVideoConfig(config: VideoDecoderConfig,
  supports = (value: VideoDecoderConfig) => VideoDecoder.isConfigSupported(value)) {
  const hardware = { ...config, hardwareAcceleration: 'prefer-hardware' as const };
  if ((await supports(hardware)).supported) return hardware;
  const automatic = { ...config, hardwareAcceleration: 'no-preference' as const };
  return (await supports(automatic)).supported ? automatic : null;
}
