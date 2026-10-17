/** Parse seconds, mm:ss, hh:mm:ss, or explicit ms/s units without accepting partial input. */
export function parseTimeInput(text:string, unit:'s'|'ms'='s', signed=false) {
  const value=text.trim().replace(/\s+(?=ms$|s$)/i,'');
  const match=/^([+-]?)(\d+(?:\.\d+)?|\d+:\d{2}(?::\d{2})?(?:\.\d+)?)(ms|s)?$/i.exec(value);
  if(!match || (!signed && match[1]==='-')) throw new Error('请输入秒数或时间码，例如 3.3、00:03.300。');
  const parts=match[2].split(':');
  if(parts.length>1 && (match[3] || parts.slice(1).some(p=>Number(p)>=60))) throw new Error('时间码的分、秒需小于 60。');
  const seconds=parts.length>1 ? parts.reduce((sum,p)=>sum*60+Number(p),0) : Number(parts[0])*((match[3]?.toLowerCase()??unit)==='ms'?.001:1);
  const us=Math.round(seconds*1e6)*(match[1]==='-'?-1:1);
  if(!Number.isSafeInteger(us)) throw new Error('时间超出可用范围。');
  return us;
}

