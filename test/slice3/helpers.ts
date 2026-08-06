import { Supervisor } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";
export async function openSlice3(prefix="agencity-slice3-"):Promise<{supervisor:Supervisor;temp:TempRuntime}> { const temp=await makeTempRuntime(prefix); const supervisor=await Supervisor.open({databaseUrl:temp.databaseUrl,artifactDirectory:temp.artifactDirectory,workspaceRoot:temp.workspaceRoot,recover:false}); return {supervisor,temp}; }
export async function closeSlice3(value:{supervisor:Supervisor;temp:TempRuntime}):Promise<void>{await value.supervisor.close();await removeTempRuntime(value.temp);}
export async function evidence(supervisor:Supervisor,sessionId:string,branchId:string,text="objective evidence"){return supervisor.appendMessage(sessionId,branchId,"user",text);}

export async function objectiveEvidence(supervisor:Supervisor,sessionId:string,branchId:string,key:string){const effectId=await supervisor.outbox.request({sessionId,branchId,executor:"shell",operation:"run",input:{command:"true"},idempotencyKey:`slice3-objective:${key}`,idempotent:true});await supervisor.outbox.run(effectId);const events=await supervisor.storage.loadEvents(sessionId,{branchId});return [...events].reverse().find((event)=>event.type==="EffectOutcomeRecorded"&&(event.payload as any).effectId===effectId)!;}
