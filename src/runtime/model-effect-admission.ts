import {
  TEXT_MODEL_RESPONSE_CONTRACT,
  responseAwareDispatchFromV1,
  resolveBuiltInModelResponseContract,
  type BuiltInStructuredContractId,
  type ModelConfigurationInput,
  type ModelDispatchV2,
  type ResolvedModelExecutionDescriptor,
} from "../domain/index.ts";
import type { ModelExecutor } from "../executors/index.ts";

export interface ModelEffectAdmission {
  readonly modelDispatch: ModelDispatchV2;
  readonly execution: ResolvedModelExecutionDescriptor;
}

/**
 * Supervisor-owned response-contract admission. Phase 2 constructs and
 * validates the complete version-2 dispatch here; the workspace-schema-3
 * writer cutover in Phase 4 will commit this value atomically with calls and
 * effects.
 */
export class ModelEffectAdmissionService {
  constructor(readonly modelExecutor: ModelExecutor) {}

  requestText(
    configuration: ModelConfigurationInput,
  ): ModelEffectAdmission {
    const execution = this.modelExecutor.resolveExecutionDescriptor(
      configuration,
    );
    const responseCapability = Object.freeze({ kind: "text" as const });
    const modelDispatch = responseAwareDispatchFromV1(
      this.modelExecutor.resolveDispatch(configuration),
      {
        responseContract: TEXT_MODEL_RESPONSE_CONTRACT,
        responseCapability,
      },
    );
    return Object.freeze({ modelDispatch, execution });
  }

  requestBuiltInStructured(
    contractId: BuiltInStructuredContractId,
    configuration: ModelConfigurationInput,
  ): ModelEffectAdmission {
    const execution = this.modelExecutor.resolveExecutionDescriptor(
      configuration,
    );
    this.modelExecutor.assertRequiredToolSetAdmission(execution);
    const capability = execution.requiredAgentToolSet;
    const responseContract = resolveBuiltInModelResponseContract(
      contractId,
      capability.status === "provider-strict"
        ? "provider-strict"
        : "runtime-validated",
    );
    const responseCapability = Object.freeze({
      kind: "required-tool-set" as const,
      capability,
    });
    const modelDispatch = responseAwareDispatchFromV1(
      this.modelExecutor.resolveDispatch(configuration),
      {
        responseContract,
        responseCapability,
      },
    );
    return Object.freeze({ modelDispatch, execution });
  }
}
