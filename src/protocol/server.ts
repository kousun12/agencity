import { AgentRuntimeError } from "../domain/index.ts";import type { Supervisor } from "../runtime/index.ts";
export class ProtocolServer {#server:ReturnType<typeof Bun.serve>|null=null;constructor(readonly supervisor:Supervisor){}
 listen(port=0,hostname="127.0.0.1"):ReturnType<typeof Bun.serve>{if(this.#server)return this.#server;this.#server=Bun.serve({port,hostname,fetch:(request)=>this.#fetch(request)});return this.#server;}
 stop():void{this.#server?.stop();this.#server=null;}
 async #fetch(request:Request):Promise<Response>{try{const url=new URL(request.url),parts=url.pathname.split("/").filter(Boolean);if(request.method==="GET"&&url.pathname==="/health")return Response.json({ok:true,mode:"trusted-local"});if(request.method==="POST"&&url.pathname==="/sessions"){const body=await request.json() as any;return Response.json(await this.supervisor.createSession({workspaceId:String(body.workspaceId??"default"),...(body.model?{model:body.model}:{}),...(body.budget?{budget:body.budget}:{})}));}if(parts[0]==="sessions"&&parts[1]){const sessionId=parts[1],branchId=url.searchParams.get("branch")??parts[3];if(request.method==="GET"&&parts[2]==="snapshot"&&branchId)return Response.json(await this.supervisor.projections.getSnapshot(sessionId,branchId));if(request.method==="GET"&&parts[2]==="history"&&branchId)return Response.json(await this.supervisor.projections.history(sessionId,branchId));if(request.method==="GET"&&parts[2]==="stream"&&branchId)return this.#stream(sessionId,branchId,url.searchParams.get("after")??"0",request.signal);if(request.method==="POST"&&parts[2]==="messages"&&branchId){const body=await request.json() as {content?:unknown};return Response.json(await this.supervisor.appendMessage(sessionId,branchId,"user",String(body.content??"")));}if(request.method==="POST"&&parts[2]==="turns"&&branchId)return Response.json(await this.supervisor.modelLoop.turn(sessionId,branchId));if(request.method==="POST"&&parts[2]==="cells"&&branchId){const body=await request.json() as {code?:unknown};return Response.json(await this.supervisor.executeCell(sessionId,branchId,String(body.code??"")));}if(request.method==="POST"&&parts[2]==="branches"&&branchId){const body=await request.json() as {cursor?:unknown;name?:unknown};return Response.json({branchId:await this.supervisor.fork(sessionId,branchId,String(body.cursor),typeof body.name==="string"?body.name:undefined)});}}return Response.json({error:{code:"NOT_FOUND",message:"Route not found"}},{status:404});}catch(error){const status=httpStatus(error);return Response.json({error:{code:error instanceof AgentRuntimeError?error.code:"INTERNAL",message:error instanceof Error?error.message:String(error)}},{status});}}
 #stream(sessionId:string,branchId:string,after:string,signal:AbortSignal):Response{const encoder=new TextEncoder();let unsubscribe=()=>{};const stream=new ReadableStream<Uint8Array>({start:controller=>{unsubscribe=this.supervisor.projections.subscribe(sessionId,branchId,after,event=>controller.enqueue(encoder.encode(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`)));signal.addEventListener("abort",()=>{unsubscribe();try{controller.close();}catch{}},{once:true});},cancel:()=>unsubscribe()});return new Response(stream,{headers:{"content-type":"text/event-stream","cache-control":"no-cache","connection":"keep-alive"}});}
}

function httpStatus(error: unknown): number {
 if (!(error instanceof AgentRuntimeError)) return 500;
 switch (error.code) {
  case "NOT_FOUND": return 404;
  case "CONFLICT":
  case "INVALID_TRANSITION": return 409;
  case "DEPENDENCY_FAILURE": return 424;
  case "CAPABILITY_UNAVAILABLE": return 501;
  case "VALIDATION_ERROR":
  default: return 400;
 }
}
