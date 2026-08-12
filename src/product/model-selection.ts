import {
  isCanonicalProductModelId,
  type ModelDescriptor,
} from "../domain/index.ts";

export const MAX_PROVIDER_QUERY_CODE_POINTS = 128;
export const MAX_MODEL_QUERY_CODE_POINTS = 512;
export const MAX_MODEL_SELECTION_CANDIDATES = 10_000;
export const MAX_SEARCHABLE_DISPLAY_CODE_POINTS = 512;
export const MAX_SEARCHABLE_DISPLAY_BYTES = 2_048;
export const MAX_VISIBLE_MODEL_OPTIONS = 8;
export const FALLBACK_TERMINAL_COLUMNS = 80;

const SEARCH_BOUNDARY = /[\s/._-]+/u;
const UNSAFE_TERMINAL_CHARACTER =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;

export interface ProviderSelectionCandidate {
  readonly name: string;
  readonly displayName: string;
}

export interface ProviderSelectionOption extends ProviderSelectionCandidate {
  readonly kind: "provider";
  readonly identity: string;
}

export interface CatalogModelSelectionOption {
  readonly kind: "catalog";
  readonly identity: string;
  readonly model: string;
  readonly displayName: string;
  readonly descriptor: ModelDescriptor;
}

export interface ManualModelSelectionOption {
  readonly kind: "manual";
  readonly identity: string;
  readonly model: string;
  readonly displayName: "Use exact model ID";
}

export type ModelSelectionOption =
  | CatalogModelSelectionOption
  | ManualModelSelectionOption;

export interface SelectionWindow<T> {
  readonly start: number;
  readonly end: number;
  readonly options: readonly T[];
}

interface SearchField {
  readonly rawLower: string;
  readonly normalized: string;
  readonly compact: string;
  readonly tokens: readonly string[];
  readonly compactLength: number;
}

interface MatchScore {
  readonly tier: number;
  readonly unmatched: number;
  readonly first: number;
  readonly field: "display" | "identity";
}

interface Ranked<T> {
  readonly option: T;
  readonly score: MatchScore;
  readonly displaySort: string;
  readonly identitySort: string;
}

export function boundProviderSelectionQuery(value: string): string {
  return codePointPrefix(value, MAX_PROVIDER_QUERY_CODE_POINTS);
}

export function boundModelSelectionQuery(value: string): string {
  return codePointPrefix(value, MAX_MODEL_QUERY_CODE_POINTS);
}

export function providerAcceptsCanonicalModel(
  provider: string,
  model: string,
): boolean {
  if (!isCanonicalProductModelId(model)) return false;
  return provider === "vercel" || model.startsWith(`${provider}/`);
}

export function filterCatalogModelsForProvider(
  descriptors: readonly ModelDescriptor[],
  provider: string,
): readonly ModelDescriptor[] {
  return Object.freeze(
    descriptors.filter((descriptor) =>
      providerAcceptsCanonicalModel(provider, descriptor.model)
    ),
  );
}

export function rankProviderOptions(
  candidates: readonly ProviderSelectionCandidate[],
  query: string,
): readonly ProviderSelectionOption[] {
  const boundedQuery = boundProviderSelectionQuery(query);
  const projected = candidates.map((candidate) => ({
    kind: "provider" as const,
    identity: `provider:${candidate.name}`,
    name: candidate.name,
    displayName: candidate.displayName,
  }));
  if (!normalizeSearchField(boundedQuery).compact) {
    return Object.freeze(projected);
  }
  return Object.freeze(rankCandidates(
    projected,
    boundedQuery,
    (candidate) => searchableDisplayField(candidate.displayName),
    (candidate) => normalizeSearchField(candidate.name),
    (candidate) => candidate.name,
  ));
}

export function rankModelOptions(
  descriptors: readonly ModelDescriptor[],
  provider: string,
  query: string,
): readonly ModelSelectionOption[] {
  if (descriptors.length > MAX_MODEL_SELECTION_CANDIDATES) {
    throw new RangeError(
      `Model selection accepts at most ${MAX_MODEL_SELECTION_CANDIDATES} candidates`,
    );
  }
  const boundedQuery = boundModelSelectionQuery(query);
  const seen = new Set<string>();
  const candidates: CatalogModelSelectionOption[] = [];
  for (const descriptor of descriptors) {
    if (
      seen.has(descriptor.model) ||
      !providerAcceptsCanonicalModel(provider, descriptor.model)
    ) {
      continue;
    }
    seen.add(descriptor.model);
    candidates.push({
      kind: "catalog",
      identity: `catalog:${descriptor.model}`,
      model: descriptor.model,
      displayName: descriptor.displayName,
      descriptor,
    });
  }

  const queryField = normalizeSearchField(boundedQuery);
  const ranked = queryField.compact
    ? rankCandidates(
        candidates,
        boundedQuery,
        (candidate) => searchableDisplayField(candidate.displayName),
        (candidate) => normalizeSearchField(candidate.model),
        (candidate) => candidate.model,
      )
    : candidates.map((candidate) => ({
        candidate,
        displaySort: searchableDisplayField(candidate.displayName).normalized,
      })).sort((left, right) =>
        compareCodePoints(left.displaySort, right.displaySort) ||
        compareCodePoints(left.candidate.model, right.candidate.model)
      ).map((item) => item.candidate);

  const exactCatalog = candidates.some((candidate) =>
    candidate.model.toLowerCase() === boundedQuery.toLowerCase()
  );
  const manual = !exactCatalog &&
      providerAcceptsManualModel(provider, boundedQuery)
    ? [{
        kind: "manual" as const,
        identity: `manual:${boundedQuery}`,
        model: boundedQuery,
        displayName: "Use exact model ID" as const,
      }]
    : [];
  return Object.freeze([...manual, ...ranked]);
}

function providerAcceptsManualModel(
  provider: string,
  model: string,
): boolean {
  if (provider === "vercel" || provider === "openai" || provider === "anthropic") {
    return providerAcceptsCanonicalModel(provider, model);
  }
  return model.length > 0 &&
    !/[\s\u0000-\u001f\u007f-\u009f]/u.test(model);
}

export function defaultSelectedIdentity<T extends { readonly identity: string }>(
  options: readonly T[],
): string | null {
  return options[0]?.identity ?? null;
}

export function reconcileSelectedIdentity<
  T extends { readonly identity: string },
>(
  options: readonly T[],
  selectedIdentity: string | null | undefined,
  reason: "query-edit" | "data-refresh",
): string | null {
  if (
    reason === "data-refresh" &&
    selectedIdentity !== null &&
    selectedIdentity !== undefined &&
    options.some((option) => option.identity === selectedIdentity)
  ) {
    return selectedIdentity;
  }
  return defaultSelectedIdentity(options);
}

export function navigateSelectedIdentity<
  T extends { readonly identity: string },
>(
  options: readonly T[],
  selectedIdentity: string | null | undefined,
  delta: number,
): string | null {
  if (!options.length) return null;
  const selected = options.findIndex((option) =>
    option.identity === selectedIdentity
  );
  const origin = selected < 0 ? 0 : selected;
  const offset = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const index = ((origin + offset) % options.length + options.length) %
    options.length;
  return options[index]!.identity;
}

export function visibleSelectionWindow<
  T extends { readonly identity: string },
>(
  options: readonly T[],
  selectedIdentity: string | null | undefined,
  maximum = MAX_VISIBLE_MODEL_OPTIONS,
): SelectionWindow<T> {
  const size = Number.isSafeInteger(maximum) && maximum > 0
    ? maximum
    : MAX_VISIBLE_MODEL_OPTIONS;
  if (!options.length) {
    return Object.freeze({ start: 0, end: 0, options: Object.freeze([]) });
  }
  const found = options.findIndex((option) =>
    option.identity === selectedIdentity
  );
  const selected = found < 0 ? 0 : found;
  const start = Math.min(
    Math.max(0, selected - size + 1),
    Math.max(0, options.length - size),
  );
  const end = Math.min(options.length, start + size);
  return Object.freeze({
    start,
    end,
    options: Object.freeze(options.slice(start, end)),
  });
}

export function sanitizeTerminalLine(value: unknown): string {
  const input = typeof value === "string" ? value : String(value ?? "");
  let output = "";
  for (const character of input) {
    if (character === "\n" || character === "\r" || character === "\t") {
      output += " ";
    } else if (UNSAFE_TERMINAL_CHARACTER.test(character)) {
      output += character === "\u001b" ? "␛" : "�";
    } else {
      output += character;
    }
  }
  return output;
}

export function terminalColumns(value: unknown): number {
  return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= 10_000
    ? value
    : FALLBACK_TERMINAL_COLUMNS;
}

export function terminalDisplayWidth(value: string): number {
  return Bun.stringWidth(value);
}

export function fitTerminalLine(
  value: unknown,
  columns?: number,
): string {
  const safe = sanitizeTerminalLine(value);
  const width = terminalColumns(columns);
  if (terminalDisplayWidth(safe) <= width) return safe;
  const ellipsis = "…";
  if (width <= terminalDisplayWidth(ellipsis)) return ellipsis;
  const available = width - terminalDisplayWidth(ellipsis);
  let output = "";
  let used = 0;
  for (const segment of graphemes(safe)) {
    const segmentWidth = terminalDisplayWidth(segment);
    if (used + segmentWidth > available) break;
    output += segment;
    used += segmentWidth;
  }
  return `${output}${ellipsis}`;
}

function rankCandidates<T>(
  candidates: readonly T[],
  query: string,
  displayField: (candidate: T) => SearchField,
  identityField: (candidate: T) => SearchField,
  identitySort: (candidate: T) => string,
): T[] {
  const queryField = normalizeSearchField(query);
  const ranked: Ranked<T>[] = [];
  for (const candidate of candidates) {
    const display = displayField(candidate);
    const identity = identityField(candidate);
    const displayScore = scoreField(queryField, display, "display", false);
    const identityScore = scoreField(queryField, identity, "identity", true);
    const score = bestScore(displayScore, identityScore);
    if (!score) continue;
    ranked.push({
      option: candidate,
      score,
      displaySort: display.normalized,
      identitySort: identitySort(candidate),
    });
  }
  ranked.sort((left, right) =>
    left.score.tier - right.score.tier ||
    left.score.unmatched - right.score.unmatched ||
    left.score.first - right.score.first ||
    fieldOrder(left.score) - fieldOrder(right.score) ||
    compareCodePoints(left.displaySort, right.displaySort) ||
    compareCodePoints(left.identitySort, right.identitySort)
  );
  return ranked.map((item) => item.option);
}

function scoreField(
  query: SearchField,
  candidate: SearchField,
  field: MatchScore["field"],
  stableIdentity: boolean,
): MatchScore | null {
  if (!query.compact || !candidate.compact) return null;
  const unmatched = Math.max(0, candidate.compactLength - query.compactLength);
  if (stableIdentity && query.rawLower === candidate.rawLower) {
    return { tier: 1, unmatched, first: 0, field };
  }
  if (!stableIdentity && query.normalized === candidate.normalized) {
    return { tier: 2, unmatched, first: 0, field };
  }
  if (candidate.normalized.startsWith(query.normalized)) {
    return { tier: 3, unmatched, first: 0, field };
  }
  const tokenFirst = tokenPrefixFirst(query.tokens, candidate.tokens);
  if (tokenFirst !== null) {
    return { tier: 4, unmatched, first: tokenFirst, field };
  }
  const substring = candidate.compact.indexOf(query.compact);
  if (substring >= 0) {
    return {
      tier: 5,
      unmatched,
      first: codePointLength(candidate.compact.slice(0, substring)),
      field,
    };
  }
  const subsequence = subsequenceFirst(query.compact, candidate.compact);
  return subsequence === null
    ? null
    : { tier: 6, unmatched, first: subsequence, field };
}

function bestScore(
  left: MatchScore | null,
  right: MatchScore | null,
): MatchScore | null {
  if (!left) return right;
  if (!right) return left;
  return compareScore(left, right) <= 0 ? left : right;
}

function compareScore(left: MatchScore, right: MatchScore): number {
  return left.tier - right.tier ||
    left.unmatched - right.unmatched ||
    left.first - right.first ||
    fieldOrder(left) - fieldOrder(right);
}

function fieldOrder(score: MatchScore): number {
  if (score.tier === 1) return score.field === "identity" ? 0 : 1;
  return score.field === "display" ? 0 : 1;
}

function tokenPrefixFirst(
  query: readonly string[],
  candidate: readonly string[],
): number | null {
  if (!query.length) return null;
  let candidateIndex = 0;
  let first = -1;
  let compactOffset = 0;
  for (const queryToken of query) {
    let found = false;
    while (candidateIndex < candidate.length) {
      const candidateToken = candidate[candidateIndex]!;
      if (candidateToken.startsWith(queryToken)) {
        if (first < 0) first = compactOffset;
        compactOffset += codePointLength(candidateToken);
        candidateIndex += 1;
        found = true;
        break;
      }
      compactOffset += codePointLength(candidateToken);
      candidateIndex += 1;
    }
    if (!found) return null;
  }
  return first;
}

function subsequenceFirst(query: string, candidate: string): number | null {
  const queryPoints = Array.from(query);
  const candidatePoints = Array.from(candidate);
  let queryIndex = 0;
  let first = -1;
  for (let index = 0; index < candidatePoints.length; index += 1) {
    if (candidatePoints[index] !== queryPoints[queryIndex]) continue;
    if (first < 0) first = index;
    queryIndex += 1;
    if (queryIndex === queryPoints.length) return first;
  }
  return null;
}

function searchableDisplayField(value: string): SearchField {
  const safe = sanitizeTerminalLine(value).toLowerCase();
  const codePointBounded = codePointPrefix(
    safe,
    MAX_SEARCHABLE_DISPLAY_CODE_POINTS,
  );
  return normalizeSearchField(
    utf8Prefix(codePointBounded, MAX_SEARCHABLE_DISPLAY_BYTES),
  );
}

function normalizeSearchField(value: string): SearchField {
  const safe = sanitizeTerminalLine(value).trim().toLowerCase();
  const tokens = safe.split(SEARCH_BOUNDARY).filter(Boolean);
  const normalized = tokens.join(" ");
  const compact = tokens.join("");
  return {
    rawLower: safe,
    normalized,
    compact,
    tokens: Object.freeze(tokens),
    compactLength: codePointLength(compact),
  };
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] === rightPoints[index]) continue;
    return leftPoints[index]! < rightPoints[index]! ? -1 : 1;
  }
  return leftPoints.length < rightPoints.length ? -1 : 1;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function codePointPrefix(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function utf8Prefix(value: string, maximum: number): string {
  const encoder = new TextEncoder();
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maximum) break;
    output += character;
    bytes += size;
  }
  return output;
}

function graphemes(value: string): Iterable<string> {
  if (typeof Intl.Segmenter === "function") {
    const segments = new Intl.Segmenter("en", {
      granularity: "grapheme",
    }).segment(value);
    return {
      *[Symbol.iterator]() {
        for (const segment of segments) yield segment.segment;
      },
    };
  }
  return value;
}
