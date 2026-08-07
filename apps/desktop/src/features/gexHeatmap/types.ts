/** One strike's net GEX for a single grid column. Null renders as "-". */
export interface GexHeatmapCell {
  /** Identifies which column this cell belongs to — an expiration date in
   *  the term-structure view, an ISO timestamp in the time-series view. */
  columnKey: string;
  netGex: number | null;
}

/** One row of the grid: a strike and its GEX across every visible column. */
export interface GexHeatmapEntry {
  strike: number;
  cells: readonly GexHeatmapCell[];
}

/** One column of the grid — its identity plus the label shown in the header. */
export interface GexHeatmapColumn {
  key: string;
  label: string;
}

export interface GexHeatmapProps {
  symbol: string;
  spotPrice: number;
  /** Columns shown left to right, in the order given. */
  columns: readonly GexHeatmapColumn[];
  entries: readonly GexHeatmapEntry[];
  className?: string;
}

export interface GexCellStyle {
  background: string;
  borderColor: string;
}
