import {
  TEXT_MODEL_RESPONSE_CONTRACT,
  modelDispatchWithResponseAdmission,
  resolveBuiltInModelResponseContract,
  type BuiltInStructuredContractId,
  type ModelConfigurationInput,
  type ModelDispatch,
  type ResolvedModelExecutionDescriptor,
} from "../domain/index.ts";
import type { ModelExecutor } from "../executors/index.ts";

export interface ModelEffectAdmission {
  readonly modelDispatch: ModelDispatch;
  readonly execution: ResolvedModelExecutionDescriptor;
}

/**
 * Supervisor-owned response-contract admission for every canonical model
 * dispatch.
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
    const modelDispatch = modelDispatchWithResponseAdmission(
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
    const modelDispatch = modelDispatchWithResponseAdmission(
      this.modelExecutor.resolveDispatch(configuration),
      {
        responseContract,
        responseCapability,
      },
    );
    return Object.freeze({ modelDispatch, execution });
  }
}
