export function nativeComponent():Promise<{directory:string;manifestSha256:string}>;
export function nativeFixture(options?:{depth?:number;distorted?:boolean;staticDir?:string;start?:any;component?:boolean;frames?:number;tagged?:boolean;codec?:'h264'|'hevc';containers?:readonly ['flv'|'mp4','flv'|'mp4'];prepare?:boolean}):Promise<any>;
export function officialOracle(f:any,depth:number,model?:string):Promise<any>;
export function sha(b:Uint8Array):string;
export function until<T>(read:()=>Promise<T>|T,predicate:(r:T)=>unknown,label?:string):Promise<T>;
