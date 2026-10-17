/** Shared playback shader helpers, matching hdr-color.ts. Inputs are nonlinear
 * BT.2020 RGB, transfer=1 (PQ) or 2 (HLG), and policy=(sourcePeakNits,
 * exposureWhiteNits, hlgDisplayPeakNits, hlgSystemGamma). Output is SDR sRGB.
 * WGSL additionally supplies extended Display-P3 output for HDR canvases. */
export const hdrPreviewGlsl = `
float hdrPq(float signal) {
  float n=pow(clamp(signal,0.0,1.0),32.0/2523.0);
  return 10000.0*pow(max(n-3424.0/4096.0,0.0)/(2413.0/128.0-2392.0/128.0*n),16384.0/2610.0);
}
float hdrHlg(float signal) {
  float e=clamp(signal,0.0,1.0),a=0.17883277,b=1.0-4.0*a,c=0.5-a*log(4.0*a);
  return e<=0.5?e*e/3.0:(exp((e-c)/a)+b)/12.0;
}
vec3 hdrDisplayNits(vec3 rgb,float transfer,vec4 policy) {
  if(transfer<1.5)return vec3(hdrPq(rgb.r),hdrPq(rgb.g),hdrPq(rgb.b));
  vec3 scene=vec3(hdrHlg(rgb.r),hdrHlg(rgb.g),hdrHlg(rgb.b));
  float luminance=dot(scene,vec3(0.2627,0.6780,0.0593));
  if(luminance<=0.0)return vec3(0.0);
  return scene*(policy.z*pow(luminance,policy.w-1.0));
}
float hdrChromaBound(float value,float gray) {
  if(value>gray)return min(1.0,(1.0-gray)/(value-gray));
  if(value<gray)return min(1.0,gray/(gray-value));
  return 1.0;
}
vec3 hdrPreview(vec3 rgb,float transfer,vec4 policy) {
  vec3 c=hdrDisplayNits(rgb,transfer,policy);
  float luminance=dot(c,vec3(0.2627,0.6780,0.0593));
  if(luminance<=0.0)return vec3(0.0);
  float x=luminance/policy.y,peak=policy.x/policy.y;
  float mapped=clamp(x*(1.0+x/(peak*peak))/(1.0+x),0.0,1.0);
  vec3 linear=vec3(dot(c,vec3(1.660491,-0.587641,-0.072850)),dot(c,vec3(-0.124550,1.132900,-0.008349)),dot(c,vec3(-0.018151,-0.100579,1.118730)))*(mapped/luminance);
  float chroma=min(hdrChromaBound(linear.r,mapped),min(hdrChromaBound(linear.g,mapped),hdrChromaBound(linear.b,mapped)));
  vec3 v=clamp(vec3(mapped)+(linear-vec3(mapped))*chroma,0.0,1.0);
  return mix(12.92*v,1.055*pow(v,vec3(1.0/2.4))-0.055,step(vec3(0.0031308),v));
}
`;

export const hdrPreviewWgsl = `
fn hdrPq(signal:f32)->f32 {
  let n=pow(clamp(signal,0.0,1.0),32.0/2523.0);
  return 10000.0*pow(max(n-3424.0/4096.0,0.0)/(2413.0/128.0-2392.0/128.0*n),16384.0/2610.0);
}
fn hdrHlg(signal:f32)->f32 {
  let e=clamp(signal,0.0,1.0);let a=0.17883277;let b=1.0-4.0*a;let c=0.5-a*log(4.0*a);
  if(e<=0.5){return e*e/3.0;}
  return (exp((e-c)/a)+b)/12.0;
}
fn hdrDisplayNits(rgb:vec3f,transfer:f32,policy:vec4f)->vec3f {
  if(transfer<1.5){return vec3f(hdrPq(rgb.r),hdrPq(rgb.g),hdrPq(rgb.b));}
  let scene=vec3f(hdrHlg(rgb.r),hdrHlg(rgb.g),hdrHlg(rgb.b));
  let luminance=dot(scene,vec3f(0.2627,0.6780,0.0593));
  if(luminance<=0.0){return vec3f(0);}
  return scene*(policy.z*pow(luminance,policy.w-1.0));
}
fn hdrChromaBound(value:f32,gray:f32)->f32 {
  if(value>gray){return min(1.0,(1.0-gray)/(value-gray));}
  if(value<gray){return min(1.0,gray/(gray-value));}
  return 1.0;
}
fn hdrPreview(rgb:vec3f,transfer:f32,policy:vec4f)->vec3f {
  let c=hdrDisplayNits(rgb,transfer,policy);let luminance=dot(c,vec3f(0.2627,0.6780,0.0593));
  if(luminance<=0.0){return vec3f(0);}
  let x=luminance/policy.y;let peak=policy.x/policy.y;
  let mapped=clamp(x*(1.0+x/(peak*peak))/(1.0+x),0.0,1.0);
  let linear=vec3f(dot(c,vec3f(1.660491,-0.587641,-0.072850)),dot(c,vec3f(-0.124550,1.132900,-0.008349)),dot(c,vec3f(-0.018151,-0.100579,1.118730)))*(mapped/luminance);
  let chroma=min(hdrChromaBound(linear.r,mapped),min(hdrChromaBound(linear.g,mapped),hdrChromaBound(linear.b,mapped)));
  let v=clamp(vec3f(mapped)+(linear-vec3f(mapped))*chroma,vec3f(0),vec3f(1));
  return select(12.92*v,1.055*pow(v,vec3f(1.0/2.4))-0.055,v>vec3f(0.0031308));
}
fn hdrEncodeExtended(v:vec3f)->vec3f {
  let c=max(v,vec3f(0));
  return select(12.92*c,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>vec3f(0.0031308));
}
// Extended Display-P3 code values; no SDR shoulder or [0,1] highlight clamp.
// Negative linear P3 channels are clipped at the chosen output gamut boundary.
fn hdrOutputP3(rgb:vec3f,transfer:f32,policy:vec4f,whiteNits:f32)->vec3f {
  let c=hdrDisplayNits(rgb,transfer,policy)/whiteNits;
  return hdrEncodeExtended(vec3f(dot(c,vec3f(1.343578252,-0.282179671,-0.061398582)),dot(c,vec3f(-0.065297452,1.075787916,-0.010490464)),dot(c,vec3f(0.002821787,-0.019598495,1.016776708))));
}
// SDR reference code values keep their viewing convention and common white.
fn sdrOutputP3(rgb:vec3f)->vec3f {
  let c=select(rgb/12.92,pow((max(rgb,vec3f(0))+0.055)/1.055,vec3f(2.4)),rgb>vec3f(0.04045));
  return hdrEncodeExtended(vec3f(dot(c,vec3f(0.822461969,0.177538031,0)),dot(c,vec3f(0.033194199,0.966805801,0)),dot(c,vec3f(0.017082631,0.072397440,0.910519929))));
}
`;
