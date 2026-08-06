import { USR } from './usrConstants';
import type { UsrRuntime } from './usrRuntime';
import type { UsrConfluence, UsrPool, UsrZone } from './usrTypes';
import {
  activeAnalysisAtr,
  hasForce,
  isAbove,
  isBelow,
  recencyAdjustedPriority,
  zoneStrength,
} from './usrZones';

function currentChartBar(runtime: UsrRuntime): number {
  return runtime.analysis[runtime.analysisBarId].eventChartIndex;
}

function zoneAnalyticalPriority(runtime: UsrRuntime, zone: UsrZone): number {
  return recencyAdjustedPriority(
    zoneStrength(zone, runtime.analysisBarId),
    zone.activationBar > 0 ? zone.activationBar : zone.startBar,
    currentChartBar(runtime),
  );
}

function confluencePriority(runtime: UsrRuntime, confluence: UsrConfluence): number {
  return recencyAdjustedPriority(
    confluence.strength,
    confluence.startBar,
    currentChartBar(runtime),
  );
}

function rankedZones(runtime: UsrRuntime, zones: UsrZone[]): UsrZone[] {
  // Pine scans retained zones newest-to-oldest and only invokes the analytical
  // priority selector when the bounded candidate cap is actually exceeded.
  // Preserve that order below the cap because it is also the deterministic
  // tie-break used by the interval sweep.
  const candidates = [...zones]
    .reverse()
    .filter(
      (zone) =>
        zone.isActive &&
        zoneStrength(zone, runtime.analysisBarId) > USR.confluenceStrengthThreshold,
    );
  if (candidates.length <= USR.maximumConfluenceCandidates) return candidates;
  return candidates
    .sort((a, b) => zoneAnalyticalPriority(runtime, b) - zoneAnalyticalPriority(runtime, a))
    .slice(0, USR.maximumConfluenceCandidates);
}

function range(runtime: UsrRuntime, zone: UsrZone): [number, number] {
  if (!zone.isLine && zone.top !== zone.bottom) return [zone.top, zone.bottom];
  const atr = activeAnalysisAtr(runtime, runtime.analysis[runtime.analysisBarId]);
  return [zone.top + atr * 0.05, zone.bottom - atr * 0.05];
}

function buildSide(runtime: UsrRuntime, zones: UsrZone[]): UsrConfluence[] {
  const candidates = rankedZones(runtime, zones)
    .map((zone) => ({ zone, bounds: range(runtime, zone) }))
    .sort((a, b) => a.bounds[1] - b.bounds[1]);
  const result: UsrConfluence[] = [];
  let comparisons = 0;
  for (
    let first = 0;
    first < candidates.length - 1 && comparisons < USR.confluencePairCap;
    first += 1
  ) {
    const a = candidates[first];
    for (
      let second = first + 1;
      second < candidates.length && comparisons < USR.confluencePairCap;
      second += 1
    ) {
      const b = candidates[second];
      if (b.bounds[1] > a.bounds[0]) break;
      comparisons += 1;
      let top = Math.min(a.bounds[0], b.bounds[0]);
      let bottom = Math.max(a.bounds[1], b.bounds[1]);
      if (top < bottom) continue;
      const members = [a.zone, b.zone];
      for (
        let third = second + 1;
        third < candidates.length && comparisons < USR.confluencePairCap;
        third += 1
      ) {
        const c = candidates[third];
        if (c.bounds[1] > top) break;
        comparisons += 1;
        const commonTop = Math.min(top, c.bounds[0]);
        const commonBottom = Math.max(bottom, c.bounds[1]);
        if (commonTop >= commonBottom) {
          top = commonTop;
          bottom = commonBottom;
          members.push(c.zone);
          break;
        }
      }
      result.push({
        top,
        bottom,
        startBar: Math.max(
          ...members.map((zone) => (zone.activationBar > 0 ? zone.activationBar : zone.startBar)),
        ),
        isMixed: false,
        memberIds: members.map((zone) => zone.id),
        strength:
          members.reduce((sum, zone) => sum + zoneStrength(zone, runtime.analysisBarId), 0) /
          members.length,
      });
    }
  }
  if (result.length <= USR.maximumConfluences) return result;
  return result
    .sort((a, b) => confluencePriority(runtime, b) - confluencePriority(runtime, a))
    .slice(0, USR.maximumConfluences);
}

function buildMixed(
  runtime: UsrRuntime,
  support: UsrConfluence[],
  resistance: UsrConfluence[],
): UsrConfluence[] {
  const mixed: UsrConfluence[] = [];
  let comparisons = 0;
  for (const left of support) {
    for (const right of resistance) {
      comparisons += 1;
      if (comparisons > USR.confluencePairCap) break;
      const top = Math.min(left.top, right.top);
      const bottom = Math.max(left.bottom, right.bottom);
      if (top >= bottom) {
        mixed.push({
          top,
          bottom,
          startBar: Math.max(left.startBar, right.startBar),
          isMixed: true,
          // Pine deliberately keeps mixed membership analytical-only. Side
          // confluences are the sole source of per-zone signal boosts.
          memberIds: [],
          strength: (left.strength + right.strength) / 2,
        });
      }
    }
    if (comparisons > USR.confluencePairCap) break;
  }
  if (mixed.length <= USR.maximumConfluences) return mixed;
  return mixed
    .sort((a, b) => confluencePriority(runtime, b) - confluencePriority(runtime, a))
    .slice(0, USR.maximumConfluences);
}

export function rebuildUsrConfluences(runtime: UsrRuntime): void {
  runtime.supportConfluences = buildSide(runtime, runtime.supportZones);
  runtime.resistanceConfluences = buildSide(runtime, runtime.resistanceZones);
  runtime.mixedConfluences = buildMixed(
    runtime,
    runtime.supportConfluences,
    runtime.resistanceConfluences,
  );
  runtime.lastConfluenceBuild = runtime.analysisBarId;
}

export function confluenceCount(runtime: UsrRuntime, zone: UsrZone): number {
  const groups = zone.isSupport ? runtime.supportConfluences : runtime.resistanceConfluences;
  return groups.reduce(
    (maximum, group) =>
      group.memberIds.includes(zone.id) ? Math.max(maximum, group.memberIds.length) : maximum,
    1,
  );
}

function poolId(support: boolean, members: UsrZone[]): string {
  return `${support ? 'PS' : 'PR'}|${members.map((zone) => zone.id).join('|')}`;
}

function retainStrongestPools(pools: UsrPool[], maximum: number): UsrPool[] {
  const retained = [...pools];
  while (retained.length > maximum) {
    let weakestIndex = 0;
    for (let index = 1; index < retained.length; index += 1) {
      const candidate = retained[index];
      const weakest = retained[weakestIndex];
      if (
        candidate.strength < weakest.strength ||
        (candidate.strength === weakest.strength && candidate.startBar < weakest.startBar)
      ) {
        weakestIndex = index;
      }
    }
    retained.splice(weakestIndex, 1);
  }
  return retained;
}

function rebuildSidePools(runtime: UsrRuntime, support: boolean, oldPools: UsrPool[]): UsrPool[] {
  const settings = runtime.settings;
  const atr = activeAnalysisAtr(runtime, runtime.analysis[runtime.analysisBarId]);
  const tolerance = Math.max(settings.minimumTick * 2, atr * settings.poolAtrFactor * 0.15);
  const sourceZones = support ? runtime.supportZones : runtime.resistanceZones;
  for (const zone of sourceZones) {
    zone.inPool = false;
    zone.poolId = '';
  }
  let zones = [...sourceZones]
    .reverse()
    .filter((zone) => zone.isActive && zone.isLine && !zone.isFlipped);
  if (zones.length > USR.maximumClusterLevels) {
    zones = zones
      .sort((a, b) => zoneAnalyticalPriority(runtime, b) - zoneAnalyticalPriority(runtime, a))
      .slice(0, USR.maximumClusterLevels);
  }
  // Modern JavaScript sorting is stable, so equal-price levels retain Pine's
  // newest-to-oldest candidate order and therefore stable pool identities.
  zones.sort((a, b) => a.top - b.top);

  const pools = [...oldPools];
  const rebuiltIds = new Set<string>();
  for (let position = 0; position < zones.length;) {
    const floor = zones[position].top;
    const members: UsrZone[] = [zones[position]];
    position += 1;
    while (
      position < zones.length &&
      members.length < 10 &&
      zones[position].top - floor <= tolerance
    ) {
      members.push(zones[position]);
      position += 1;
    }
    if (members.length < settings.poolClusterThreshold) continue;
    const id = poolId(support, members);
    const existing = pools.find((pool) => pool.id === id);
    const strength = Math.min(
      1,
      members.reduce((sum, zone) => sum + zoneStrength(zone, runtime.analysisBarId), 0) /
        members.length +
        Math.min(members.length - 1, 4) * 0.05,
    );
    const pool: UsrPool = existing ?? {
      id,
      top: 0,
      bottom: 0,
      strength,
      startBar: runtime.analysis[runtime.analysisBarId].eventChartIndex,
      isSupport: support,
      state: 'anticipated',
      memberIds: [],
      analysisBirth: runtime.analysisBarId,
      bounceSignalCount: 0,
      sweepSignalCount: 0,
      lastBounceSignalAnalysisBar: 0,
      lastSweepSignalAnalysisBar: 0,
    };
    if (!existing) pools.push(pool);
    pool.top = Math.max(...members.map((zone) => zone.top));
    pool.bottom = Math.min(...members.map((zone) => zone.bottom));
    pool.strength = strength;
    pool.memberIds = members.map((zone) => zone.id);
    rebuiltIds.add(id);
  }
  const maximum = support ? settings.maxSupportPools : settings.maxResistancePools;
  const retained = retainStrongestPools(
    pools.filter((pool) => rebuiltIds.has(pool.id)),
    maximum,
  );
  for (const pool of retained) {
    for (const zone of sourceZones) {
      if (pool.memberIds.includes(zone.id)) {
        zone.inPool = true;
        zone.poolId = pool.id;
      }
    }
  }
  return retained;
}

export function rebuildUsrPools(runtime: UsrRuntime): void {
  runtime.supportPools = rebuildSidePools(runtime, true, runtime.supportPools);
  runtime.resistancePools = rebuildSidePools(runtime, false, runtime.resistancePools);
  runtime.lastPoolBuild = runtime.analysisBarId;
}

export function updateUsrPools(runtime: UsrRuntime): void {
  const candle = runtime.analysis[runtime.analysisBarId];
  const epsilon = runtime.settings.minimumTick * runtime.settings.breakBufferTicks;
  for (const key of ['supportPools', 'resistancePools'] as const) {
    runtime[key] = runtime[key].filter((pool) => {
      if (runtime.analysisBarId <= pool.analysisBirth) return true;
      if (
        hasForce(runtime, candle) &&
        (pool.isSupport
          ? isBelow(runtime, candle.close, pool.bottom)
          : isAbove(runtime, candle.close, pool.top))
      ) {
        for (const zone of pool.isSupport ? runtime.supportZones : runtime.resistanceZones) {
          if (zone.poolId === pool.id) {
            zone.inPool = false;
            zone.poolId = '';
          }
        }
        return false;
      }
      const interacting = candle.high >= pool.bottom && candle.low <= pool.top;
      const swept = pool.isSupport
        ? isBelow(runtime, candle.low, pool.bottom) && candle.close >= pool.top - epsilon
        : isAbove(runtime, candle.high, pool.top) && candle.close <= pool.bottom + epsilon;
      if (swept) pool.state = 'swept';
      else if (interacting && pool.state === 'anticipated') pool.state = 'validated';
      return true;
    });
  }
}

export function processUsrDerivedEvent(runtime: UsrRuntime): void {
  if (
    runtime.zonesChanged ||
    runtime.lastConfluenceBuild < 0 ||
    runtime.analysisBarId - runtime.lastConfluenceBuild >= 5
  ) {
    rebuildUsrConfluences(runtime);
  }
  if (runtime.settings.showLiquidityPools) {
    if (
      runtime.zonesChanged ||
      runtime.lastPoolBuild < 0 ||
      runtime.analysisBarId - runtime.lastPoolBuild >= 10
    ) {
      rebuildUsrPools(runtime);
    }
    updateUsrPools(runtime);
  } else {
    runtime.supportPools = [];
    runtime.resistancePools = [];
  }
}
