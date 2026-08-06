import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TursoSyncTransport } from "../../src/index.ts";

const enabled=process.env.AGENCITY_TURSO_SMOKE==="1"&&!!process.env.TURSO_DATABASE_URL&&!!process.env.TURSO_AUTH_TOKEN;
test.skipIf(!enabled)("credential-gated official Turso directional push/pull/checkpoint/stats smoke",async()=>{const dir=await mkdtemp(join(tmpdir(),"agencity-turso-smoke-"));const transport=new TursoSyncTransport({replicaUrl:`file:${dir}/replica.db`,syncUrl:process.env.TURSO_DATABASE_URL!,authToken:process.env.TURSO_AUTH_TOKEN!});try{await transport.initialize();await transport.replicaIncarnation();const before=await transport.stats();expect(before.cdcOperations).toBeGreaterThan(0);await transport.push();expect(typeof await transport.pull()).toBe("boolean");await transport.checkpoint();const after=await transport.stats();expect(after.cdcOperations).toBe(0);expect(transport.capabilities.networkExchange).toBe("directional");expect(transport.capabilities.nativeMethod).toBe("push-pull-checkpoint-stats");}finally{await transport.close();await rm(dir,{recursive:true,force:true});}});
