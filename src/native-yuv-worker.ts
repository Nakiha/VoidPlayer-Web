// Raw-plane copy only: never request a browser RGB conversion.
const scope=self as unknown as {onmessage:(event:MessageEvent)=>void;postMessage:(value:unknown,transfer?:Transferable[])=>void};
scope.onmessage=async({data:{id,frame,buffer}}:{data:{id:number;frame:VideoFrame;buffer?:ArrayBuffer}})=>{
  try{
    const rect={x:0,y:0,width:frame.codedWidth,height:frame.codedHeight};
    const size=frame.allocationSize({rect});
    if(buffer?.byteLength!==size)buffer=new ArrayBuffer(size);
    const layout=await frame.copyTo(new Uint8Array(buffer),{rect});
    scope.postMessage({id,buffer,layout},[buffer]);
  }catch(error){scope.postMessage({id,error:String(error)});}
  finally{frame.close();}
};
