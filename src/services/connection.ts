export type ConnectionInfo = { configured: boolean; httpsUrl: string | null; certificateUrl: string | null; fingerprint: string | null };
/** Keep only application page destinations, never a caller-supplied redirect origin. */
export function connectionTarget(httpsUrl: string, next = '/') {
  const base = new URL(httpsUrl);
  if(base.protocol!=='https:' || base.username || base.password)throw new Error('HTTPS 地址无效。');
  const target = new URL(next, base);
  if(target.origin!==base.origin || !['/','/index.html','/admin','/admin/','/admin/index.html'].includes(target.pathname))return new URL('/',base);
  return target;
}
/** Success proves this browser can currently reach HTTPS, not that a system CA was installed. */
export async function probeHttps(target: URL): Promise<boolean> {
  try {
    const response=await fetch(new URL('/api/connection/probe',target),{mode:'cors',credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(3000)});
    if(!response.ok)return false;
    const result=await response.json();return result.service==='voidplayer-connection' && result.https===true;
  }catch{return false;}
}
