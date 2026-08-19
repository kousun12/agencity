import {
  TEXT_MODEL_RESPONSE_CONTRACT,
  ValidationError,
  resolveDeclaredSchema,
  modelDispatchWithResponseAdmission,
  resolveBuiltInModelResponseContract,
  resolveDeclaredDataModelResponseContract,
  resolveTypedAgentModelResponseContract,
  type BuiltInStructuredContractId,
  type ModelConfigurationInput,
  type ModelDispatch,
  type RecursiveResponseAdmission,
  type ResolvedModelExecutionDescriptor,
} from "../domain/index.ts";
import type { ModelExecutor } from "../executors/index.ts";
import {
  containsBrokeredSecret,
} from "../security/index.ts";

export interface ModelEffectAdmission {
  readonly modelDispatch: ModelDispatch;
  readonly execution: ResolvedModelExecutionDescriptor;
}

export interface RetainedModelEffectAdmission {
  readonly modelDispatch: ModelDispatch;
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

  requestDeclaredData(
    schema: unknown,
    configuration: ModelConfigurationInput,
  ): ModelEffectAdmission {
    const checkedSchema = resolveDeclaredSchema(schema);
    if (containsBrokeredSecret(checkedSchema.schema)) {
      throw new ValidationError(
        "Declared JSON Schema contains a registered credential value",
      );
    }
    const execution = this.modelExecutor.resolveExecutionDescriptor(
      configuration,
    );
    this.modelExecutor.assertRequiredToolSetAdmission(execution);
    const capability = execution.requiredAgentToolSet;
    const responseContract = resolveDeclaredDataModelResponseContract(
      checkedSchema.schema,
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

  requestTypedAgent(
    schema: unknown,
    configuration: ModelConfigurationInput,
  ): ModelEffectAdmission {
    const checkedSchema = resolveDeclaredSchema(schema);
    if (containsBrokeredSecret(checkedSchema.schema)) {
      throw new ValidationError(
        "Declared JSON Schema contains a registered credential value",
      );
    }
    const execution = this.modelExecutor.resolveExecutionDescriptor(
      configuration,
    );
    this.modelExecutor.assertRequiredToolSetAdmission(execution);
    const capability = execution.requiredAgentToolSet;
    const responseContract = resolveTypedAgentModelResponseContract(
      checkedSchema.schema,
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
      { responseContract, responseCapability },
    );
    return Object.freeze({ modelDispatch, execution });
  }

  /**
   * Reconstructs only the model/reasoning/endpoint side of a dispatch. The
   * response contract and capability are copied from durable admission and are
   * never resolved against current registry or catalog capability state.
   */
  requestRetained(
    responseAdmission: RecursiveResponseAdmission,
    configuration: ModelConfigurationInput,
  ): RetainedModelEffectAdmission {
    const modelDispatch = modelDispatchWithResponseAdmission(
      this.modelExecutor.resolveDispatch(configuration),
      responseAdmission,
    );
    return Object.freeze({ modelDispatch });
  }
}
