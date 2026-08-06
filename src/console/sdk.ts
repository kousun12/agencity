import type { ArtifactReference,WorkingValue } from "../domain/index.ts";import type { JsonValue } from "../domain/json.ts";
export interface ConsoleSession {readonly id:string;readonly branchId:string;}
export interface StateSdk {readonly restored:Readonly<Record<string,WorkingValue>>;get(name:string):Promise<WorkingValue|null>;set(name:string,value:JsonValue):Promise<WorkingValue>;}
export interface ArtifactsSdk {put(content:string,mediaType?:string):Promise<ArtifactReference>;get(artifactId:string):Promise<string>;}
export interface ToolsSdk {request(executor:string,operation:string,input:JsonValue,options?:{idempotencyKey?:string;idempotent?:boolean}):Promise<{outcome:"succeeded"|"failed"|"cancelled"|"unknown";output?:JsonValue;error?:string}>;shell(command:string,options?:{cwd?:string;timeoutMs?:number;idempotencyKey?:string}):Promise<JsonValue>;readFile(path:string):Promise<JsonValue>;writeFile(path:string,content:string,expectedSha256?:string):Promise<JsonValue>;}
export interface MemorySdk { search(query:string,options?:JsonValue):Promise<JsonValue>; create(input:JsonValue|string):Promise<JsonValue>; list(options?:JsonValue):Promise<JsonValue>; }
export interface HarnessSdk { propose(input:JsonValue):Promise<JsonValue>; list(options?:JsonValue):Promise<JsonValue>; history(entryId:string):Promise<JsonValue>; }
export interface SkillsSdk { invoke(entryId:string,input:JsonValue,options?:JsonValue):Promise<JsonValue>; test(entryId:string,versionId?:string):Promise<JsonValue>; }
export interface SpecsSdk { spawn(entryId:string,input?:JsonValue):Promise<JsonValue>; }
export interface ConsoleSdk {readonly state:StateSdk;readonly artifacts:ArtifactsSdk;readonly tools:ToolsSdk;readonly memory:MemorySdk;readonly harness:HarnessSdk;readonly skills:SkillsSdk;readonly specs:SpecsSdk;}
export type SqlTag=(strings:TemplateStringsArray,...values:Array<string|number|boolean|null>)=>Promise<JsonValue[]>;
