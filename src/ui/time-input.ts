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
