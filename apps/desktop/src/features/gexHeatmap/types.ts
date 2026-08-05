/** One strike's net GEX for a single expiration column. Null renders as "-". */
export interface GexHeatmapCell {
  expiration: string;
  netGex: number | null;
}

/** One row of the grid: a strike and its GEX across every visible expiration. */
export interface GexHeatmapEntry {
  strike: number;
  cells: readonly GexHeatmapCell[];
}

export interface GexHeatmapProps {
  symbol: string;
  spotPrice: number;
  /** Expiration dates shown as columns, left to right, in the order given. */
  expirations: readonly string[];
  entries: readonly GexHeatmapEntry[];
  className?: string;
}

export interface GexCellStyle {
  background: string;
  borderColor: string;
}
