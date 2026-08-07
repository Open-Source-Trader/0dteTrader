export interface SeriesDataPoint {
  time: unknown;
  value: number;
  color?: string;
}

export type SeriesLifecycleAction = 'setData' | 'update';

/**
 * Chooses between replacing full chart history and updating only the forming point.
 * Parameter changes can alter every historical value without changing IDs, timestamps,
 * or lengths, so every completed point is compared exactly before using update().
 */
export function seriesLifecycleAction(
  previous: readonly SeriesDataPoint[] | undefined,
  next: readonly SeriesDataPoint[],
): SeriesLifecycleAction {
  if (!previous || previous.length !== next.length) return 'setData';
  const previousLast = previous[previous.length - 1];
  const nextLast = next[next.length - 1];
  if (previousLast && nextLast && !Object.is(previousLast.time, nextLast.time)) return 'setData';
  for (let index = 0; index < next.length - 1; index += 1) {
    const before = previous[index];
    const after = next[index];
    if (
      !before ||
      !after ||
      !Object.is(before.time, after.time) ||
      !Object.is(before.value, after.value) ||
      before.color !== after.color
    ) {
      return 'setData';
    }
  }
  return 'update';
}

interface SeriesDataLifecycleOperations {
  setData: () => void;
  update: () => void;
}

/** Executes the selected operation against a renderer adapter. */
export function applySeriesDataLifecycle(
  previous: readonly SeriesDataPoint[] | undefined,
  next: readonly SeriesDataPoint[],
  operations: SeriesDataLifecycleOperations,
  forceReplace = false,
): SeriesLifecycleAction {
  const action = forceReplace ? 'setData' : seriesLifecycleAction(previous, next);
  if (action === 'setData') operations.setData();
  else if (next.length > 0) operations.update();
  return action;
}
