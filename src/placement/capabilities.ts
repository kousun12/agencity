import { CapabilityUnavailableError } from "../domain/index.ts";

export type ComponentPlacement = "local" | "remote";

export interface PlacementDescriptor<TCapabilities extends object> {
  readonly name: string;
  readonly placement: ComponentPlacement;
  readonly transport: "in-process" | "http";
  readonly capabilities: TCapabilities;
}

/** Fail closed when a caller requests semantics the selected adapter did not advertise. */
export function requireCapability(
  adapter: string,
  capability: string,
  available: boolean,
): void {
  if (!available) throw new CapabilityUnavailableError(capability, adapter);
}
