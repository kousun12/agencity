import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeterministicSyncHub, Supervisor, type InProcessSyncTransport } from "../../src/index.ts";

export interface Replica { readonly name:string; readonly directory:string; readonly supervisor:Supervisor; readonly transport:InProcessSyncTransport; }
export async function makeRoot():Promise<string>{return mkdtemp(join(tmpdir(),"agencity-slice4-"));}
export async function openReplica(root:string,name:string,hub:DeterministicSyncHub,options:{startup?:boolean;intervalMs?:number}={}):Promise<Replica>{const directory=join(root,name);await mkdir(directory,{recursive:true});const transport=hub.connect(name);const supervisor=await Supervisor.open({databaseUrl:`file:${directory}/workspace.db`,profileDatabaseUrl:`file:${directory}/profile.db`,artifactDirectory:join(directory,"artifacts"),workspaceRoot:directory,recover:false,sync:{workspaceId:"workspace",workspaceName:"Shared workspace",transport,startup:options.startup??false,intervalMs:options.intervalMs??0}});return{name,directory,supervisor,transport};}
export async function closeAll(root:string,...replicas:Array<Replica|undefined>):Promise<void>{for(const replica of replicas)if(replica)await replica.supervisor.close().catch(()=>{});await rm(root,{recursive:true,force:true});}
export async function seedBoth(a:Replica,b:Replica):Promise<{sessionId:string;branchId:string}>{const session=await a.supervisor.createSession({workspaceId:"workspace",budget:{tokenLimit:1000}});await a.supervisor.sync.sync();await b.supervisor.sync.sync();return session;}
