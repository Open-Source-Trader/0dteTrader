interface OptionsAnalyticsStrikeCandidate {
  strike: number;
  grossGammaExposure: number;
}

export function optionsAnalyticsRailWidth(paneWidth: number): number {
  return Math.min(112, Math.max(56, paneWidth * 0.28));
}

/** Applies the viewport predicate before ranking and capping the profile. */
export function selectVisibleOptionsAnalyticsStrikes<
  Candidate extends OptionsAnalyticsStrikeCandidate,
>(
  candidates: Candidate[],
  limit: number,
  isVisible: (candidate: Candidate) => boolean,
  score: (candidate: Candidate) => number = (candidate) => Math.abs(candidate.grossGammaExposure),
): Candidate[] {
  return candidates
    .filter(isVisible)
    .sort((left, right) => score(right) - score(left) || left.strike - right.strike)
    .slice(0, Math.max(0, limit))
    .sort((left, right) => left.strike - right.strike);
}
