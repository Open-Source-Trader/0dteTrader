import type {
  AutoScoringRanking,
  AutoScoringPreferences,
  AutoScoringResult,
  FreshOrderBookSnapshot,
  IVAlert,
  OrderBookIndicators,
  OrderBookSnapshot,
  OrderSelection,
  StreamClientMessage,
  StreamServerMessage,
} from '../dist/index.js';

const preferences: AutoScoringPreferences = {
  schemaVersion: 1,
  preset: 'conservative',
  targetAbsDelta: 0.25,
  strikeRungs: 5,
  maxSpreadBps: 500,
  maxPremiumDollars: 250,
  minOpenInterest: 100,
  gammaMode: 'avoid',
  weights: { delta: 0.3, spread: 0.25, openInterest: 0.2, gamma: 0.1, iv: 0.15 },
};

const classicSelection: OrderSelection = {
  mode: 'auto_otm',
  optionType: 'call',
  classicFallbackAcknowledged: false,
};
const scoredSelection: OrderSelection = {
  mode: 'auto_scored',
  optionType: 'put',
  expiration: '2026-08-05',
  autoScoring: {
    selectedSymbol: 'SPXW260805P06000000',
    preferences,
    scoredConfirmationAccepted: true,
    rankedAt: '2026-08-05T15:00:00.000Z',
  },
};
const explicitSelection: OrderSelection = {
  mode: 'explicit',
  optionType: 'call',
  expiration: '2026-08-05',
  strike: 6000,
};

declare const ranking: AutoScoringRanking;
const passingResult: AutoScoringResult = {
  selectedSymbol: 'SPXW260805P06000000',
  rankings: [ranking],
  exclusions: [],
  noPass: false,
  requiresConfirmation: true,
  rankedAt: '2026-08-05T15:00:00.000Z',
};
const noPassResult: AutoScoringResult = {
  selectedSymbol: null,
  rankings: [],
  exclusions: [],
  noPass: true,
  requiresConfirmation: true,
  rankedAt: '2026-08-05T15:00:00.000Z',
};

const bookIndicators: OrderBookIndicators = {
  spreadAbs: 1,
  spreadBps: 10,
  spreadPercentile: 50,
  topBookImbalance: 0,
  tickPressure: null,
  depthImbalance: 0,
  cumulativePressure: null,
  touchDepletion: null,
};
const bookSnapshot: FreshOrderBookSnapshot = {
  symbol: 'SPY',
  provider: 'webull',
  capability: 'nasdaq_totalview_non_display',
  freshness: 'fresh',
  timestamp: '2026-08-05T15:00:00.000Z',
  receivedAt: '2026-08-05T15:00:00.100Z',
  depth: 1,
  bids: [{ price: 100, size: 10 }],
  asks: [{ price: 101, size: 10 }],
};
const ivAlert: IVAlert = {
  symbol: 'SPX',
  direction: 'expansion',
  currentIv: 0.24,
  baselineIv: 0.2,
  zScore: 4,
  timestamp: '2026-08-05T15:00:00.000Z',
};

// @ts-expect-error auto_scored requires its scored selection payload.
const scoredWithoutPayload: OrderSelection = { mode: 'auto_scored', optionType: 'call' };
// @ts-expect-error explicit selection requires a strike.
const explicitWithoutStrike: OrderSelection = { mode: 'explicit', optionType: 'call' };
// @ts-expect-error auto_otm cannot carry a scored payload.
const classicWithScoring: OrderSelection = {
  mode: 'auto_otm',
  optionType: 'call',
  autoScoring: scoredSelection.autoScoring,
};
const classicWithLegacyOffset: OrderSelection = {
  mode: 'auto_otm',
  optionType: 'call',
  // @ts-expect-error Classic is fixed to exactly one strike OTM and exposes no offset control.
  otmOffset: 2,
};
// @ts-expect-error auto_scored cannot carry Classic fallback acknowledgement.
const scoredWithClassicAcknowledgement: OrderSelection = {
  ...scoredSelection,
  classicFallbackAcknowledged: true,
};
const unconfirmedScoredSelection: OrderSelection = {
  ...scoredSelection,
  // @ts-expect-error scored Auto cannot be submitted without affirmative confirmation.
  autoScoring: { ...scoredSelection.autoScoring, scoredConfirmationAccepted: false },
};
// @ts-expect-error no-pass results cannot name a selected contract.
const noPassWithSelection: AutoScoringResult = {
  ...noPassResult,
  selectedSymbol: 'SPXW260805P06000000',
};
// @ts-expect-error passing results require a selected contract and at least one ranking.
const passingWithoutWinner: AutoScoringResult = { ...noPassResult, noPass: false };
const oldBookSnapshot: OrderBookSnapshot = {
  symbol: 'SPY',
  provider: 'webull',
  capability: 'nasdaq_totalview_non_display',
  freshness: 'fresh',
  // @ts-expect-error old order-book field spellings are not part of the public contract.
  sourceTimestamp: '2026-08-05T15:00:00.000Z',
  receivedTimestamp: '2026-08-05T15:00:00.100Z',
  publishedDepth: 1,
  bids: [],
  asks: [],
};
// @ts-expect-error l2Data was replaced by the authoritative l2Snapshot discriminant.
const oldL2Message: StreamServerMessage = { type: 'l2Data', data: { snapshot: bookSnapshot } };
const oldIvAlert: IVAlert = {
  symbol: 'SPX',
  direction: 'expansion',
  // @ts-expect-error old IV alert field spellings are not accepted.
  atmIv: 0.24,
  baseline: 0.2,
  score: 4,
  observedAt: '2026-08-05T15:00:00.000Z',
};

const clientMessages: StreamClientMessage[] = [
  { type: 'subscribe', symbols: ['SPX'] },
  { type: 'l2Subscribe', symbol: 'SPY', levels: 5 },
  { type: 'l2Unsubscribe', symbol: 'SPY' },
  {
    type: 'ivAlertConfigure',
    data: {
      enabled: true,
      symbols: ['SPX'],
      lookbackMinutes: 30,
      thresholdK: 3,
      consecutiveBreaches: 2,
      warmupMinutes: 10,
      warmupSamples: 10,
      cooldownMinutes: 5,
    },
  },
];
const serverMessages: StreamServerMessage[] = [
  {
    type: 'l2Snapshot',
    data: { snapshot: bookSnapshot, indicators: bookIndicators },
  },
  {
    type: 'ivAlert',
    data: ivAlert,
  },
];

declare const serverMessage: StreamServerMessage;
void [
  classicSelection,
  scoredSelection,
  explicitSelection,
  passingResult,
  noPassResult,
  bookSnapshot,
  ivAlert,
  clientMessages,
  serverMessages,
  serverMessage,
  scoredWithoutPayload,
  explicitWithoutStrike,
  classicWithScoring,
  classicWithLegacyOffset,
  scoredWithClassicAcknowledgement,
  unconfirmedScoredSelection,
  noPassWithSelection,
  passingWithoutWinner,
  oldBookSnapshot,
  oldL2Message,
  oldIvAlert,
];
