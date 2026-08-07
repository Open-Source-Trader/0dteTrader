import type {
  IndicatorDescriptor,
  IndicatorGeometry,
  IndicatorPriceProfileRow,
} from '@0dtetrader/shared-types';
import type { OverlaySeries } from './CandleChart';
import type { PaneSeries } from './IndicatorPane';
import { indicatorStyleColor } from './chartColors';

export interface IndicatorFill {
  upperSeriesId: string;
  lowerSeriesId: string;
  color: string;
  opacity: number;
}

export interface IndicatorProfileDecorationRow extends IndicatorPriceProfileRow {
  color: string;
  opacity: number;
}

export interface IndicatorRenderModel {
  overlays: OverlaySeries[];
  paneSeries: PaneSeries[];
  fills: IndicatorFill[];
  profileRows: IndicatorProfileDecorationRow[];
}

export function buildIndicatorRenderModel(
  descriptor: IndicatorDescriptor,
  geometry: IndicatorGeometry,
): IndicatorRenderModel {
  if (descriptor.geometry.kind !== geometry.kind) {
    throw new Error(`${descriptor.id} geometry kind does not match its descriptor.`);
  }
  const model: IndicatorRenderModel = { overlays: [], paneSeries: [], fills: [], profileRows: [] };
  if (geometry.kind === 'price_profile') {
    const rowSeries = descriptor.geometry.series.find(({ id }) => id === 'row');
    const valueAreaSeries = descriptor.geometry.series.find(({ id }) => id === 'valueArea');
    if (!rowSeries || !valueAreaSeries) {
      throw new Error(`${descriptor.id} profile descriptor is incomplete.`);
    }
    model.profileRows = geometry.rows.map((row) => ({
      ...row,
      color: indicatorStyleColor(
        row.inValueArea ? valueAreaSeries.styleToken : rowSeries.styleToken,
      ),
      opacity: row.inValueArea ? 0.42 : 0.22,
    }));
    return model;
  }
  const seriesById = new Map(descriptor.geometry.series.map((series) => [series.id, series]));
  for (const [seriesId, values] of Object.entries(geometry.series)) {
    const series = seriesById.get(seriesId);
    if (!series) throw new Error(`${descriptor.id} geometry contains an unknown series.`);
    const id = `${descriptor.id}:${seriesId}`;
    const histogram = descriptor.geometry.kind === 'histogram' || series.renderAs === 'histogram';
    if (descriptor.pane === 'overlay') {
      model.overlays.push({
        id,
        kind: 'line',
        color: indicatorStyleColor(series.styleToken),
        values,
        gaps: geometry.kind === 'segmented_line',
      });
    } else if (histogram) {
      const color = indicatorStyleColor(series.styleToken);
      model.paneSeries.push({
        id,
        kind: 'histogram',
        positiveColor: color,
        negativeColor: color,
        values,
      });
    } else {
      model.paneSeries.push({
        id,
        kind: 'line',
        color: indicatorStyleColor(series.styleToken),
        values,
      });
    }
  }
  if (geometry.kind === 'band') {
    const [upper, middle, lower] = descriptor.geometry.series;
    if (!upper || !middle || !lower) {
      throw new Error(`${descriptor.id} band descriptor is incomplete.`);
    }
    model.fills.push({
      upperSeriesId: `${descriptor.id}:${upper.id}`,
      lowerSeriesId: `${descriptor.id}:${lower.id}`,
      color: indicatorStyleColor(middle.styleToken),
      opacity: 0.08,
    });
  } else if (geometry.kind === 'cloud') {
    const spanA = descriptor.geometry.series.find(({ id }) => id === 'spanA');
    const spanB = descriptor.geometry.series.find(({ id }) => id === 'spanB');
    if (spanA && spanB) {
      model.fills.push({
        upperSeriesId: `${descriptor.id}:${spanA.id}`,
        lowerSeriesId: `${descriptor.id}:${spanB.id}`,
        color: indicatorStyleColor(spanA.styleToken),
        opacity: 0.1,
      });
    }
  }
  return model;
}
