import type {
  ChartDisplayPreferences,
  IndicatorDescriptor,
  IndicatorGeometryDescriptor,
  IndicatorId,
  IndicatorParameterDescriptor,
  IndicatorRegistry,
  IndicatorSetting,
  IndicatorSettingsState,
} from '@0dtetrader/shared-types';
import registryJson from '../../../../../packages/shared-types/indicator-registry.json';

export interface IndicatorSettingsResult {
  ok: boolean;
  error?: string;
  value: IndicatorSettingsState;
}

const GEOMETRY_KINDS = new Set([
  'line',
  'multi_line',
  'band',
  'cloud',
  'histogram',
  'segmented_line',
  'price_profile',
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite.`);
  }
  return value;
}

function decodeParameter(value: unknown, key: string): IndicatorParameterDescriptor {
  const raw = record(value, `parameter ${key}`);
  if (raw.id !== key || typeof raw.label !== 'string') {
    throw new Error(`parameter ${key} has an invalid identity.`);
  }
  if (raw.kind !== 'integer' && raw.kind !== 'number' && raw.kind !== 'timestamp') {
    throw new Error(`parameter ${key} has an invalid kind.`);
  }
  const minimum = finiteNumber(raw.minimum, `parameter ${key} minimum`);
  const maximum = finiteNumber(raw.maximum, `parameter ${key} maximum`);
  const defaultValue = finiteNumber(raw.default, `parameter ${key} default`);
  if (minimum > maximum || defaultValue < minimum || defaultValue > maximum) {
    throw new Error(`parameter ${key} has invalid bounds.`);
  }
  if ((raw.kind === 'integer' || raw.kind === 'timestamp') && !Number.isInteger(defaultValue)) {
    throw new Error(`parameter ${key} default must be an integer.`);
  }
  if (raw.kind === 'timestamp' && raw.zeroMeansSessionAnchor !== true) {
    throw new Error(`parameter ${key} must define its session anchor.`);
  }
  return raw as unknown as IndicatorParameterDescriptor;
}

function decodeGeometry(value: unknown, indicatorId: string): IndicatorGeometryDescriptor {
  const raw = record(value, `${indicatorId} geometry`);
  if (typeof raw.kind !== 'string' || !GEOMETRY_KINDS.has(raw.kind)) {
    throw new Error(`${indicatorId} geometry has an invalid kind.`);
  }
  if (!Array.isArray(raw.series) || raw.series.length === 0) {
    throw new Error(`${indicatorId} geometry must define series.`);
  }
  const seen = new Set<string>();
  for (const value of raw.series) {
    const series = record(value, `${indicatorId} geometry series`);
    if (
      typeof series.id !== 'string' ||
      !series.id ||
      typeof series.label !== 'string' ||
      typeof series.styleToken !== 'string' ||
      seen.has(series.id)
    ) {
      throw new Error(`${indicatorId} geometry has an invalid series.`);
    }
    seen.add(series.id);
  }
  const expectedLengths: Partial<Record<string, number>> = {
    line: 1,
    band: 3,
    histogram: 1,
    segmented_line: 2,
    price_profile: 2,
  };
  const expected = expectedLengths[raw.kind];
  if (expected !== undefined && raw.series.length !== expected) {
    throw new Error(`${indicatorId} geometry has the wrong number of series.`);
  }
  return raw as unknown as IndicatorGeometryDescriptor;
}

export function decodeIndicatorRegistry(value: unknown): IndicatorRegistry {
  const raw = record(value, 'indicator registry');
  if (
    raw.version !== 1 ||
    raw.maxSubPanes !== 2 ||
    typeof raw.paneLimitMessage !== 'string' ||
    !raw.paneLimitMessage ||
    !Array.isArray(raw.indicators)
  ) {
    throw new Error('indicator registry header is invalid.');
  }
  const seenIds = new Set<string>();
  const indicators = raw.indicators.map((value): IndicatorDescriptor => {
    const descriptor = record(value, 'indicator descriptor');
    if (
      typeof descriptor.id !== 'string' ||
      !descriptor.id ||
      seenIds.has(descriptor.id) ||
      typeof descriptor.displayName !== 'string' ||
      (descriptor.pane !== 'overlay' && descriptor.pane !== 'subpane') ||
      typeof descriptor.requiresL2 !== 'boolean'
    ) {
      throw new Error('indicator descriptor identity is invalid.');
    }
    seenIds.add(descriptor.id);
    const parametersRaw = record(descriptor.parameters, `${descriptor.id} parameters`);
    const parameters = Object.fromEntries(
      Object.entries(parametersRaw).map(([key, parameter]) => [
        key,
        decodeParameter(parameter, key),
      ]),
    );
    const defaults = record(descriptor.defaultSettings, `${descriptor.id} defaults`);
    const defaultParameters = record(defaults.parameters, `${descriptor.id} default parameters`);
    if (typeof defaults.enabled !== 'boolean')
      throw new Error(`${descriptor.id} default is invalid.`);
    if (
      Object.keys(defaultParameters).length !== Object.keys(parameters).length ||
      Object.keys(parameters).some((key) => defaultParameters[key] !== parameters[key].default)
    ) {
      throw new Error(`${descriptor.id} defaults do not match its parameters.`);
    }
    const constraints = descriptor.constraints;
    if (constraints !== undefined) {
      if (!Array.isArray(constraints)) throw new Error(`${descriptor.id} constraints are invalid.`);
      for (const constraintValue of constraints) {
        const constraint = record(constraintValue, `${descriptor.id} constraint`);
        if (
          constraint.kind !== 'less_than' ||
          typeof constraint.left !== 'string' ||
          typeof constraint.right !== 'string' ||
          typeof constraint.message !== 'string' ||
          !parameters[constraint.left] ||
          !parameters[constraint.right]
        ) {
          throw new Error(`${descriptor.id} constraint is invalid.`);
        }
      }
    }
    const styleTokens = record(descriptor.styleTokens, `${descriptor.id} style tokens`);
    if (Object.values(styleTokens).some((token) => typeof token !== 'string' || !token)) {
      throw new Error(`${descriptor.id} style tokens are invalid.`);
    }
    const geometry = decodeGeometry(descriptor.geometry, descriptor.id);
    const declaredStyles = new Set(Object.values(styleTokens));
    if (geometry.series.some(({ styleToken }) => !declaredStyles.has(styleToken))) {
      throw new Error(`${descriptor.id} geometry references an undeclared style token.`);
    }
    return {
      ...descriptor,
      parameters,
      geometry,
    } as unknown as IndicatorDescriptor;
  });
  return { version: 1, maxSubPanes: 2, paneLimitMessage: raw.paneLimitMessage, indicators };
}

export const INDICATOR_REGISTRY = decodeIndicatorRegistry(registryJson);
const DESCRIPTORS = new Map(
  INDICATOR_REGISTRY.indicators.map((descriptor) => [descriptor.id, descriptor]),
);

export const DEFAULT_INDICATOR_SETTINGS_STATE: IndicatorSettingsState = {
  registryVersion: 1,
  indicators: Object.fromEntries(
    INDICATOR_REGISTRY.indicators.map((descriptor) => [
      descriptor.id,
      structuredClone(descriptor.defaultSettings),
    ]),
  ) as Record<IndicatorId, IndicatorSetting>,
};

export const DEFAULT_CHART_DISPLAY: ChartDisplayPreferences = {
  volumeEnabled: true,
  volumeWeightedCandleWidth: false,
};

function validateCandidate(candidate: unknown): IndicatorSettingsState {
  const raw = record(candidate, 'indicator settings');
  if (raw.registryVersion !== INDICATOR_REGISTRY.version) {
    throw new Error('Indicator settings registry version is invalid.');
  }
  const indicators = record(raw.indicators, 'indicator settings entries');
  const knownIds = new Set(INDICATOR_REGISTRY.indicators.map(({ id }) => id));
  if (
    Object.keys(indicators).length !== knownIds.size ||
    Object.keys(indicators).some((id) => !knownIds.has(id as IndicatorId))
  ) {
    throw new Error('Indicator settings contain an unknown or missing id.');
  }
  for (const descriptor of INDICATOR_REGISTRY.indicators) {
    const setting = record(indicators[descriptor.id], `${descriptor.id} setting`);
    if (typeof setting.enabled !== 'boolean')
      throw new Error(`${descriptor.id} enabled is invalid.`);
    const parameters = record(setting.parameters, `${descriptor.id} parameter values`);
    const parameterIds = Object.keys(descriptor.parameters);
    if (
      Object.keys(parameters).length !== parameterIds.length ||
      Object.keys(parameters).some((id) => !descriptor.parameters[id])
    ) {
      throw new Error(`${descriptor.id} contains an unknown or missing parameter.`);
    }
    for (const parameter of Object.values(descriptor.parameters)) {
      const value = finiteNumber(parameters[parameter.id], `${descriptor.id}.${parameter.id}`);
      if (value < parameter.minimum || value > parameter.maximum) {
        throw new Error(`${descriptor.id}.${parameter.id} is out of range.`);
      }
      if (
        (parameter.kind === 'integer' || parameter.kind === 'timestamp') &&
        !Number.isInteger(value)
      ) {
        throw new Error(`${descriptor.id}.${parameter.id} must be an integer.`);
      }
    }
    for (const constraint of descriptor.constraints ?? []) {
      const left = finiteNumber(parameters[constraint.left], `${descriptor.id}.${constraint.left}`);
      const right = finiteNumber(
        parameters[constraint.right],
        `${descriptor.id}.${constraint.right}`,
      );
      if (left >= right) throw new Error(constraint.message);
    }
  }
  if (
    enabledSubPaneIds(candidate as IndicatorSettingsState).length > INDICATOR_REGISTRY.maxSubPanes
  ) {
    throw new Error(INDICATOR_REGISTRY.paneLimitMessage);
  }
  return candidate as IndicatorSettingsState;
}

export function validateIndicatorSettingsState(
  candidate: unknown,
  lastValid: IndicatorSettingsState,
): IndicatorSettingsResult {
  try {
    return { ok: true, value: validateCandidate(candidate) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Indicator settings are invalid.',
      value: lastValid,
    };
  }
}

export function applyIndicatorSetting(
  current: IndicatorSettingsState,
  id: IndicatorId,
  patch: Partial<IndicatorSetting>,
): IndicatorSettingsResult {
  if (!DESCRIPTORS.has(id)) return { ok: false, error: `Unknown indicator: ${id}`, value: current };
  const existing = current.indicators[id];
  const candidate: IndicatorSettingsState = {
    registryVersion: 1,
    indicators: {
      ...current.indicators,
      [id]: {
        enabled: patch.enabled ?? existing.enabled,
        parameters: { ...existing.parameters, ...(patch.parameters ?? {}) },
      },
    },
  };
  return validateIndicatorSettingsState(candidate, current);
}

export function enabledSubPaneIds(settings: IndicatorSettingsState): IndicatorId[] {
  return INDICATOR_REGISTRY.indicators
    .filter(
      (descriptor) => descriptor.pane === 'subpane' && settings.indicators[descriptor.id]?.enabled,
    )
    .map(({ id }) => id);
}

export function indicatorAvailability(
  id: IndicatorId,
): { available: true } | { available: false; reason: string } {
  return indicatorDescriptor(id).requiresL2
    ? { available: false, reason: 'No L2 data' }
    : { available: true };
}

export function indicatorDescriptor(id: IndicatorId): IndicatorDescriptor {
  const descriptor = DESCRIPTORS.get(id);
  if (!descriptor) throw new Error(`Unknown indicator: ${id}`);
  return descriptor;
}
