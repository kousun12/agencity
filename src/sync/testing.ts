import { ConflictError } from "../domain/index.ts";
import type { BidirectionalSyncProgress, ReplicatedEnvelope, SyncTransport, WorkspaceAnnouncement } from "./types.ts";

/** Deterministic, process-local exchange used by the multi-replica conformance suite. */
export class DeterministicSyncHub {
  readonly #envelopes=new Map<string,ReplicatedEnvelope>();
  readonly #announcements=new Map<string,WorkspaceAnnouncement>();
  #version=0;
  connect(id:string):InProcessSyncTransport{return new InProcessSyncTransport(this,id);}
  exchange(localEnvelopes:Map<string,ReplicatedEnvelope>,localAnnouncements:Map<string,WorkspaceAnnouncement>):number{
    for(const [id,envelope] of [...localEnvelopes].sort(([a],[b])=>a.localeCompare(b))){const old=this.#envelopes.get(id);if(old&&old.digest!==envelope.digest)throw new ConflictError("Hub envelope collision",{envelopeId:id});if(!old){this.#envelopes.set(id,envelope);this.#version++;}}
    for(const [id,row] of [...localAnnouncements].sort(([a],[b])=>a.localeCompare(b))){const old=this.#announcements.get(id);if(!old||old.updatedAt<=row.updatedAt){this.#announcements.set(id,row);this.#version++;}}
    for(const [id,envelope] of this.#envelopes)localEnvelopes.set(id,envelope);
    for(const [id,row] of this.#announcements)localAnnouncements.set(id,row);
    return this.#version;
  }
  inject(envelope:ReplicatedEnvelope):void{this.#envelopes.set(envelope.envelopeId,envelope);this.#version++;}
}

export class InProcessSyncTransport implements SyncTransport {
  readonly capabilities={adapter:"in-process",nativeMethod:"in-process",networkExchange:"bidirectional-only",offlineEnvelopeWrites:true,directionalPush:false,directionalPull:false,checkpoint:false,statistics:false,distributedCoordination:false} as const;
  readonly #incarnation=crypto.randomUUID();
  readonly #envelopes=new Map<string,ReplicatedEnvelope>();readonly #announcements=new Map<string,WorkspaceAnnouncement>();
  #online=true;#closed=false;#version=0;
  constructor(readonly hub:DeterministicSyncHub,readonly id:string){}
  setOnline(online:boolean):void{this.#online=online;}
  async initialize():Promise<void>{if(this.#closed)throw new Error("Transport is closed");}
  async replicaIncarnation():Promise<string>{await this.initialize();return this.#incarnation;}
  async putEnvelopes(rows:readonly ReplicatedEnvelope[]):Promise<number>{await this.initialize();let count=0;for(const row of rows){const old=this.#envelopes.get(row.envelopeId);if(old&&old.digest!==row.digest)throw new ConflictError("Local envelope collision",{envelopeId:row.envelopeId});if(!old){this.#envelopes.set(row.envelopeId,row);count++;}}return count;}
  async listEnvelopes(workspaceId?:string,afterByOrigin?:Readonly<Record<string,number>>):Promise<ReplicatedEnvelope[]>{await this.initialize();return[...this.#envelopes.values()].filter(x=>(workspaceId===undefined||x.workspaceId===workspaceId)&&(!afterByOrigin||x.originSequence>(afterByOrigin[x.originDeviceId]??0)||(afterByOrigin[x.originDeviceId]??0)>0&&x.originSequence===(afterByOrigin[x.originDeviceId]??0))).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.originSequence-b.originSequence||a.originDeviceId.localeCompare(b.originDeviceId)||a.envelopeId.localeCompare(b.envelopeId));}
  async putWorkspaceAnnouncement(row:WorkspaceAnnouncement):Promise<void>{await this.initialize();this.#announcements.set(row.announcementId,row);}
  async discoverWorkspaces():Promise<WorkspaceAnnouncement[]>{await this.initialize();return[...this.#announcements.values()].sort((a,b)=>a.workspaceId.localeCompare(b.workspaceId)||b.updatedAt.localeCompare(a.updatedAt)||a.deviceId.localeCompare(b.deviceId));}
  async sync():Promise<BidirectionalSyncProgress>{await this.initialize();if(!this.#online)throw new Error("Deterministic sync hub is offline");this.#version=this.hub.exchange(this.#envelopes,this.#announcements);return{exchangeVersion:this.#version,envelopeCount:this.#envelopes.size};}
  async reconnect():Promise<void>{await this.initialize();if(!this.#online)throw new Error("Deterministic sync hub is offline");}
  async close():Promise<void>{this.#closed=true;}
}
