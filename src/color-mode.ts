export type ColorMode = 'reference' | 'browser';
export type ReferenceDecode = {decoder:'hardware'|'software';depth:1|2|4|8};
let referenceDecode:ReferenceDecode={decoder:'software',depth:2};
export const getReferenceDecode=():ReferenceDecode=>({...referenceDecode});
export function setReferenceDecode(value:ReferenceDecode){
  if(!['hardware','software'].includes(value.decoder)||![1,2,4,8].includes(value.depth))throw new Error('无效的解码路径或缓冲深度。');
  referenceDecode={...value};
}
// Null preserves the low-level diagnostic API's explicit pipeline selection.
let current: ColorMode | null = null;
export const getColorMode = () => current;
export function setColorMode(value: ColorMode | null) {
  if(value!==null&&value!=='reference'&&value!=='browser')throw new Error('未知色彩模式。');
  current=value;
}
