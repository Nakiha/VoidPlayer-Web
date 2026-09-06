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

/** Inline editing: Enter/blur commits once, Escape restores, playback updates never overwrite a draft. */
export function installTimeInput(input:HTMLInputElement, options:{read():number;format(value:number):string;parse(value:string):number;commit(value:number):Promise<unknown>;begin?():void}) {
  let initial='', cancelled=false, committing=false;
  const restore=()=>{input.value=options.format(options.read());input.removeAttribute('aria-invalid');input.removeAttribute('aria-description');};
  input.onfocus=()=>{cancelled=false;options.begin?.();restore();initial=input.value;input.select();};
  input.oninput=()=>input.removeAttribute('aria-invalid');
  async function commit() {
    if(cancelled||committing||input.value===initial) return;
    let value:number;
    try {value=options.parse(input.value);} catch(error) {input.setAttribute('aria-invalid','true');input.setAttribute('aria-description',String(error));return;}
    committing=true;
    try {await options.commit(value);restore();initial=input.value;} finally {committing=false;}
  }
  input.onkeydown=e=>{
    if(e.isComposing)return;
    if(e.key==='Enter'){e.preventDefault();void commit().then(()=>{if(!input.hasAttribute('aria-invalid'))input.blur();});}
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancelled=true;restore();input.blur();}
  };
  input.onblur=()=>{void commit();}; restore();
}
