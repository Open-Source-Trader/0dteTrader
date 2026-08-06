import { atrSeries } from './usrMath';
import { processUsrDerivedEvent } from './usrDerived';
import { processUsrFvgEvent } from './usrFvg';
import { renderUsr } from './usrRender';
import { createUsrRuntime } from './usrRuntime';
import type { UsrSettings } from './usrSettings';
import { validateUsrSettings } from './usrSettings';
import { processUsrSignals } from './usrSignals';
import { prepareUsrHistory } from './usrTimeframe';
import type { UsrCandle, UsrComputation, UsrComputeContext } from './usrTypes';
import { processUsrZoneEvent } from './usrZones';

export function computeUsr(
  candles: readonly UsrCandle[],
  candidateSettings: UsrSettings,
  context: UsrComputeContext,
): UsrComputation | null {
  const settings = validateUsrSettings(candidateSettings);
  if (!settings.enabled || candles.length === 0) return null;
  const prepared = prepareUsrHistory(candles, settings, context);
  const runtime = createUsrRuntime(settings, prepared.analysisCandles, prepared.timeframeTag);
  const analysisByEvent = new Map<number, number[]>();
  prepared.analysisCandles.forEach((candle, index) => {
    const events = analysisByEvent.get(candle.eventChartIndex) ?? [];
    events.push(index);
    analysisByEvent.set(candle.eventChartIndex, events);
  });
  const chartAtr = atrSeries(prepared.chartCandles);
  for (let chartIndex = 0; chartIndex < prepared.chartCandles.length; chartIndex += 1) {
    for (const analysisIndex of analysisByEvent.get(chartIndex) ?? []) {
      processUsrZoneEvent(runtime, analysisIndex);
      processUsrDerivedEvent(runtime);
      processUsrFvgEvent(runtime);
    }
    const fallbackAtr = Math.max(
      Math.abs(prepared.chartCandles[chartIndex].close) * 0.02,
      settings.minimumTick,
    );
    processUsrSignals(
      runtime,
      prepared.chartCandles,
      chartIndex,
      chartAtr[chartIndex] ?? fallbackAtr,
    );
  }
  // Pine updates last-bar visuals and its rendering-only proximity window on
  // the live bar, while all analytical transitions remain close-confirmed.
  const lastBar = Math.max(0, prepared.presentationCandles.length - 1);
  const reference = prepared.presentationCandles[lastBar]?.close ?? 0;
  return {
    renderModel: renderUsr(runtime, lastBar, reference),
    supportZones: runtime.supportZones,
    resistanceZones: runtime.resistanceZones,
    supportPools: runtime.supportPools,
    resistancePools: runtime.resistancePools,
    bullishFvgs: runtime.bullishFvgs,
    bearishFvgs: runtime.bearishFvgs,
    supportConfluences: runtime.supportConfluences,
    resistanceConfluences: runtime.resistanceConfluences,
    mixedConfluences: runtime.mixedConfluences,
    signals: runtime.signals,
    diagnostics: {
      analysisTimeframeSeconds: prepared.analysisSeconds,
      analysisTimeframeTag: prepared.timeframeTag,
      usedChartTimeframe: prepared.usedChartTimeframe,
      confirmedChartBars: prepared.chartCandles.length,
      analysisBars: prepared.analysisCandles.length,
      warnings: prepared.warnings,
    },
  };
}

export * from './usrSettings';
export * from './usrTypes';
