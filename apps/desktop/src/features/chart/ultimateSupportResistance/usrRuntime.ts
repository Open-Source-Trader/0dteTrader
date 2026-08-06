import type { UsrSettings } from './usrSettings';
import type {
  UsrAnalysisCandle,
  UsrConfluence,
  UsrFvg,
  UsrPool,
  UsrSignal,
  UsrZone,
} from './usrTypes';

export interface UsrRuntime {
  readonly settings: UsrSettings;
  readonly analysis: UsrAnalysisCandle[];
  readonly timeframeTag: string;
  readonly processedCandidates: Set<string>;
  readonly candidateOrder: string[];
  supportZones: UsrZone[];
  resistanceZones: UsrZone[];
  supportPools: UsrPool[];
  resistancePools: UsrPool[];
  bullishFvgs: UsrFvg[];
  bearishFvgs: UsrFvg[];
  supportConfluences: UsrConfluence[];
  resistanceConfluences: UsrConfluence[];
  mixedConfluences: UsrConfluence[];
  signals: UsrSignal[];
  identity: number;
  analysisBarId: number;
  highVolumeSequenceLength: number;
  zonesChanged: boolean;
  lastConfluenceBuild: number;
  lastPoolBuild: number;
  previousBullSignal: UsrSignal | null;
  previousBearSignal: UsrSignal | null;
}

export function createUsrRuntime(
  settings: UsrSettings,
  analysis: UsrAnalysisCandle[],
  timeframeTag: string,
): UsrRuntime {
  return {
    settings,
    analysis,
    timeframeTag,
    processedCandidates: new Set(),
    candidateOrder: [],
    supportZones: [],
    resistanceZones: [],
    supportPools: [],
    resistancePools: [],
    bullishFvgs: [],
    bearishFvgs: [],
    supportConfluences: [],
    resistanceConfluences: [],
    mixedConfluences: [],
    signals: [],
    identity: 0,
    analysisBarId: -1,
    highVolumeSequenceLength: 0,
    zonesChanged: false,
    lastConfluenceBuild: -1,
    lastPoolBuild: -1,
    previousBullSignal: null,
    previousBearSignal: null,
  };
}
