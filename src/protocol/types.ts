import type { AgentEvent,AgentState,BudgetLimits,JsonValue,ModelConfiguration } from "../domain/index.ts";
export type ProtocolRequest = {type:"createSession";workspaceId:string;model?:ModelConfiguration;budget?:BudgetLimits}|{type:"message";sessionId:string;branchId:string;content:string}|{type:"turn";sessionId:string;branchId:string}|{type:"cell";sessionId:string;branchId:string;code:string}|{type:"fork";sessionId:string;branchId:string;cursor:string;name?:string};
export type ProtocolResponse = {ok:true;value:JsonValue}|{ok:false;error:{code:string;message:string}};
export interface SnapshotEnvelope {cursor:string;state:AgentState;}
export interface EventEnvelope {cursor:string;event:AgentEvent;}
