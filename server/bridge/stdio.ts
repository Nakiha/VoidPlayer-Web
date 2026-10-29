import {PAGE_BRIDGE_LIMITS as L,PAGE_MCP_VERSIONS,MCP_PAGE_TOOLS} from '../../shared/service/page-bridge.ts';
import {validateToolInput} from '../../shared/service/tool-input.ts';
export interface StdioPageChannel {
  client:{name:string;version:string}|null;clientRevision:number;ready:boolean;
  status():unknown;receipt(id:unknown):unknown;
  call(name:unknown,args:unknown,onCorrelation:(v:string)=>void):Promise<unknown>;
  revoke(reason:string):void;cancel(correlation:string):void;close():void;
  sync?():Promise<void>;
}

const [modern,legacy]=PAGE_MCP_VERSIONS,versions=PAGE_MCP_VERSIONS;
const serverInfo={name:'voidplayer-page-bridge',version:'1.0.0'};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);


/** Newline UTF-8 JSON-RPC only. No SDK/service installation and no network MCP.
 * Supports the current per-request era and the explicit legacy handshake. */
export function runPageStdio(channel:StdioPageChannel,close:()=>Promise<void>){
  let initialized=false,legacyStarted=false,closed=false,buffer=Buffer.alloc(0);
  const requests=new Map<string,{cancelled:boolean;correlation?:string}>();
  const legacyIds=new Set<string>();
  const stop=()=>{if(closed)return;closed=true;channel.close();process.stdin.destroy();void close().catch(()=>{process.exitCode=1;}).finally(()=>process.stdout.end());};
  const send=(message:object)=>{if(closed)return;const line=JSON.stringify(message)+'\n';if(Buffer.byteLength(line)>L.stdioBytes||process.stdout.writableLength+Buffer.byteLength(line)>4*L.stdioBytes){process.stderr.write('stdio output budget exceeded; closing temporary bridge\n');stop();return;}process.stdout.write(line);};
  const error=(id:unknown,code:number,message:string,data?:unknown)=>send({jsonrpc:'2.0',...(id!==undefined?{id}:{}),error:{code,message,...(data===undefined?{}:{data})}});
  const result=(id:unknown,value:object,isModern:boolean)=>send({jsonrpc:'2.0',id,result:{...value,...(isModern?{resultType:'complete',_meta:{'io.modelcontextprotocol/serverInfo':serverInfo}}:{})}});
  const declaration=(value:unknown)=>{if(!object(value)||typeof value.name!=='string'||!value.name.length||value.name.length>100||typeof value.version!=='string'||value.version.length>80)throw Error('Invalid clientInfo');return {name:value.name,version:value.version};};
  const acceptClaim=(claim:{name:string;version:string})=>{if(JSON.stringify(channel.client)!==JSON.stringify(claim)){channel.revoke('client-declaration-changed');channel.clientRevision++;}channel.client=claim;channel.ready=true;};
  const receive=async(value:unknown)=>{
    if(!object(value)||value.jsonrpc!=='2.0'||typeof value.method!=='string'||value.params!==undefined&&!object(value.params)){error(undefined,-32600,'Invalid Request');return;}
    const params=(value.params??{}) as Record<string,unknown>;
    if(!Object.hasOwn(value,'id')){
      if(value.method==='notifications/initialized'&&legacyStarted){initialized=true;channel.ready=true;}
      if(value.method==='notifications/cancelled'){
        const key=JSON.stringify(params.requestId),r=requests.get(key);if(r){r.cancelled=true;if(r.correlation)channel.cancel(r.correlation);}
      }
      return;
    }
    const id=value.id;if(!(typeof id==='string'&&id.length<=100||typeof id==='number'&&Number.isSafeInteger(id))){error(undefined,-32600,'Invalid request ID');return;}
    const key=JSON.stringify(id);if(requests.has(key)){error(undefined,-32600,'Duplicate pending request ID');return;}
    const requestMeta=params._meta;
    if(value.method==='initialize'||legacyStarted&&!(object(requestMeta)&&Object.hasOwn(requestMeta,'io.modelcontextprotocol/protocolVersion'))){
      if(legacyIds.has(key)){error(id,-32600,'Legacy request IDs must not be reused');return;}
      if(legacyIds.size>=L.legacyRequestIds){error(id,-32602,'Legacy request-ID budget reached; explicitly restart and reauthorize, never replay unknown writes');stop();return;}
      legacyIds.add(key);
    }
    if(requests.size>=16){error(id,-32602,'Request budget exceeded');return;}
    const state:{cancelled:boolean;correlation?:string}={cancelled:false};requests.set(key,state);
    let isModern=false;
    try{
      if(value.method==='initialize'){
        if(legacyStarted||typeof params.protocolVersion!=='string'||!object(params.capabilities))throw Error('Invalid initialize');
        const claim=declaration(params.clientInfo);legacyStarted=true;channel.revoke('legacy-initialization');channel.client=claim;channel.clientRevision++;channel.ready=false;
        await channel.sync?.();
        result(id,{protocolVersion:legacy,capabilities:{tools:{}},serverInfo,instructions:'Open the localhost page printed on stderr. Only a trusted user click in that exact page can grant temporary scopes. Query get_bridge_status and pass its explicit epoch; retain write operationId. Never replay unknown writes.'},false);return;
      }
      const meta=params._meta;
      if(value.method==='ping'&&!(object(meta)&&Object.hasOwn(meta,'io.modelcontextprotocol/protocolVersion'))){result(id,{},false);return;}
      if(object(meta)&&Object.hasOwn(meta,'io.modelcontextprotocol/protocolVersion')){
        if(meta['io.modelcontextprotocol/protocolVersion']!==modern){error(id,-32022,'Unsupported protocol version',{supported:versions,requested:meta['io.modelcontextprotocol/protocolVersion']});return;}
        if(!object(meta['io.modelcontextprotocol/clientCapabilities']))throw Error('Missing required clientCapabilities');
        isModern=true;
        acceptClaim(meta['io.modelcontextprotocol/clientInfo']===undefined?{name:'Unspecified MCP client',version:''}:declaration(meta['io.modelcontextprotocol/clientInfo']));
      }else if(!initialized){error(id,-32602,'Use initialize/initialized for 2025-11-25, or required per-request metadata for 2026-07-28');return;}
      await channel.sync?.();
      if(value.method==='server/discover'&&isModern){result(id,{supportedVersions:versions,capabilities:{tools:{}},instructions:'Only the explicitly connected owned page is available; grant handles are ordinary epoch arguments, never authentication.',ttlMs:0,cacheScope:'public'},true);return;}
      if(value.method==='ping'&&!isModern){result(id,{},false);return;}
      if(value.method==='tools/list'){
        if(params.cursor!==undefined){error(id,-32602,'This bounded tool list has no cursor');return;}
        result(id,{tools:MCP_PAGE_TOOLS,...(isModern?{ttlMs:0,cacheScope:'public'}:{})},isModern);return;
      }
      if(value.method!=='tools/call'){error(id,-32601,'Method not found');return;}
      const tool=MCP_PAGE_TOOLS.find(t=>t.name===params.name);if(!tool){error(id,-32602,'Unknown tool');return;}
      const input=params.arguments===undefined?{}:params.arguments;
      validateToolInput(tool.inputSchema,input);
      const args=input as Record<string,unknown>;
      const output=tool.name==='get_bridge_status'?await channel.status():tool.name==='get_bridge_receipt'?await channel.receipt(args.operationId):await channel.call(tool.name,args,v=>state.correlation=v);
      if(!state.cancelled)result(id,{content:[{type:'text',text:JSON.stringify(output)}],isError:object(output)&&output.isError===true},isModern);
    }catch{if(!state.cancelled)error(id,-32602,'Invalid request or tool arguments');}
    finally{requests.delete(key);}
  };
  process.stdin.on('data',(chunk:Buffer)=>{
    if(closed)return;buffer=Buffer.concat([buffer,chunk]);
    for(let at;(at=buffer.indexOf(10))>=0;){const line=buffer.subarray(0,at);buffer=buffer.subarray(at+1);if(line.length>L.requestBytes){error(undefined,-32600,'Message budget exceeded');stop();return;}try{const decoded=new TextDecoder('utf-8',{fatal:true}).decode(line);void receive(JSON.parse(decoded));}catch{error(undefined,-32700,'Parse error');}}
    if(buffer.length>L.requestBytes){error(undefined,-32600,'Message budget exceeded');stop();}
  });
  process.stdin.on('end',stop);process.stdin.on('error',stop);process.stdout.on('error',stop);
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  return stop;
}
