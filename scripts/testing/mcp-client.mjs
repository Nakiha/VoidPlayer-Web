// Independent test/example client: only stdio/HTTP public boundaries, no bridge imports.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';

export async function startMcpClient({staticDir,modern=false}={}){
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../mcp-page-bridge.ts',import.meta.url)),...(staticDir?['--static-dir',staticDir]:[])],{cwd:root,stdio:['pipe','pipe','pipe']});
  const pending=new Map(),messages=[],errors=[];let seq=0,stderr='',resolveReady,rejectReady;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const exited=new Promise(resolve=>child.once('close',(code,signal)=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Bridge exited'));}pending.clear();resolve({code,signal});rejectReady(Error('Bridge exited before ready'));}));
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{
    try{const m=JSON.parse(line);if(m.jsonrpc!=='2.0')throw Error('Non-protocol stdout');messages.push(m);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);p.resolve(m);}}catch(e){errors.push(String(e));}
  });
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-16000);const base=stderr.match(/VoidPlayer temporary page: (http:\/\/127\.0\.0\.1:\d+)\//)?.[1];if(base)resolveReady(base);});
  child.once('error',rejectReady);
  child.stdin.on('error',error=>{if(error.code!=='EPIPE'&&error.code!=='ERR_STREAM_DESTROYED')errors.push(String(error));});
  const notify=(method,params={})=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n');
  function request(method,params={},meta=true){
    const id=++seq;
    if(modern&&meta)params={...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'VoidPlayer independent stdio client',version:'1.0.0'},...params._meta}};
    const promise=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Client deadline '+method));},22000);pending.set(id,{resolve,reject,timer});});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return {id,promise};
  }
  const rpc=(method,params,meta)=>request(method,params,meta).promise;
  const call=async(name,args={})=>{const m=await rpc('tools/call',{name,arguments:args});return m.error?{rpcError:m.error}:JSON.parse(m.result.content[0].text);};
  const base=await Promise.race([ready,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Launcher readiness timeout: '+stderr)),15000);timer.unref();})]);
  const cancel=id=>{notify('notifications/cancelled',{requestId:id});const p=pending.get(id);if(p){clearTimeout(p.timer);pending.delete(id);p.resolve({cancelled:true});}};
  return {child,base,errors,messages,notify,request,rpc,call,cancel,exited,get stderr(){return stderr;},async initialize(){if(modern)return rpc('server/discover');const r=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'VoidPlayer independent stdio client',version:'1.0.0'}},false);notify('notifications/initialized');return r;},async close(){child.stdin.end();let force;const stop=setTimeout(()=>{child.kill('SIGTERM');force=setTimeout(()=>child.kill('SIGKILL'),1000);},5000);try{return await exited;}finally{clearTimeout(stop);clearTimeout(force);lines.close();}}};
}
