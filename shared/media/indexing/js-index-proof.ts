/** Runtime authority minted by complete enumeration or an authenticated cache
 * read, never by parsing a document's self-reported completeness fields. */
const verified=new WeakSet<object>();
export function sealJsIndex<T extends object>(index:T):T {
  const freeze=(value:object)=>{if(Object.isFrozen(value))return;for(const child of Object.values(value))if(child&&typeof child==='object')freeze(child);Object.freeze(value);};
  freeze(index);verified.add(index);return index;
}
export const isSealedJsIndex=(index:object)=>verified.has(index);
