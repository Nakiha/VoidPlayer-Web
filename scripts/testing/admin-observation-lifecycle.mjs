// Test-owned document teardown: stop periodic observers, then drain the exact
// readers used by the page. No response cloning, extra IO or error filtering.
export function installAdminObservationLifecycle(host=window){
 if(!host.location.pathname.startsWith('/admin'))return;
 const intervals=new Set(),pending=new Map();let sequence=0;
 const interval=host.setInterval.bind(host),clear=host.clearInterval.bind(host),fetch=host.fetch.bind(host);
 host.setInterval=(...args)=>{const id=interval(...args);intervals.add(id);return id;};
 host.clearInterval=id=>{intervals.delete(id);return clear(id);};
 host.fetch=async(input,options)=>{
  const url=new URL(input instanceof Request?input.url:input,host.location.href),method=String(options?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
  if(method!=='GET'||url.origin!==host.location.origin||!url.pathname.startsWith('/api/'))return fetch(input,options);
  const id=++sequence;pending.set(id,{path:url.pathname});const done=()=>pending.delete(id);
  try{
   const response=await fetch(input,options);pending.get(id).status=response.status;
   if(!response.body){done();return response;}
   const getReader=response.body.getReader.bind(response.body);
   response.body.getReader=(...args)=>{const reader=getReader(...args),read=reader.read.bind(reader),cancel=reader.cancel.bind(reader);
    reader.read=async(...args)=>{try{const value=await read(...args);if(value.done)done();return value;}catch(error){done();throw error;}};
    reader.cancel=async(...args)=>{try{return await cancel(...args);}finally{done();}};return reader;};
   for(const method of ['json','text','arrayBuffer','blob','formData']){const consume=response[method].bind(response);response[method]=async(...args)=>{try{return await consume(...args);}finally{done();}};}
   return response;
  }catch(error){done();throw error;}
 };
 host.__vpAdminObservation={
  stop(){for(const id of intervals)clear(id);intervals.clear();},
  pending(){return [...pending.values()].map(row=>({...row}));}
 };
}

export async function drainAdminObservations(page){
 await page.evaluate(()=>window.__vpAdminObservation.stop());
 try{await page.waitForFunction(()=>window.__vpAdminObservation.pending().length===0,null,{timeout:15000,polling:25});}
 catch(error){const pending=await page.evaluate(()=>window.__vpAdminObservation.pending()).catch(()=>null);throw new Error('Admin observation readers did not finish: '+JSON.stringify(pending),{cause:error});}
}
