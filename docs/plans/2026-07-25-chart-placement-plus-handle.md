# Chart Placement `+` Handle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the 1.5s long-press that arms a chart order line with a permanent, draggable TradingView-style `+` handle on a dashed guide line, and rebuild the order window it opens in the app's HUD branding with every field editable.

**Architecture:** A _placement guide_ — a dashed horizontal line spanning the chart pane with a small chamfered `+` handle at its right edge — becomes permanent chrome whenever chart trading is on and a contract is selected. It parks at the last traded price, and dragging the handle moves it to any level. Tapping the handle opens the order window at that level. The window is a HUD-styled floating card on both platforms (desktop popover / iOS overlay card, no more modal `Form` sheet) whose price field is two-way bound to the guide. The price-in-range logic is a pure function, mirrored per platform and unit-tested on both, because a guide stranded off-screen would leave a `+` pinned to an edge with no relationship to the level it arms.

**Tech Stack:** React 19 + TypeScript + lightweight-charts + Vitest (desktop); SwiftUI + UIKit + DGCharts + XCTest (iOS).

---

## Context You Need Before Starting

Read these before writing any code. They are the files this plan changes, and the patterns you must match.

**Desktop (`apps/desktop/`)**

- `src/features/chart/OrderLineLayer.tsx` — the canvas that draws order lines. Already has a hover-only `+` (lines 469–494, 550–593) which this plan replaces. Note the `latest` ref pattern at lines 111–132: event handlers are bound once in a mount effect, so fresh props reach them through that ref, never through closure capture.
- `src/features/chart/OrderPlacementPopover.tsx` — the window being restyled.
- `src/features/chart/orderLineGeometry.ts` — the existing pure-geometry module. The new `placementGuide.ts` follows the same shape: pure, DOM-free, unit-tested.
- `src/design/components/SegmentedControl.tsx` and `Stepper.tsx` — shared controls the popover must reuse instead of its private `Segmented`.
- `src/design/hud.css` — HUD primitives. **Important:** `.hud-card` / `.hud-btn` use a 9-slice `border-image` with 21–28px slices, so they visually break on elements shorter than ~56px. The card (240×~320px) can use `.hud-card`; the small Cancel/Place buttons cannot — they get a `clip-path` chamfer like `.hud-badge` instead.
- `src/features/chart/chartColors.ts` — `chartPalette().guide` already resolves `--chart-guide`.

**iOS (`apps/ios/0dteTrader/`)**

- `Features/Chart/OrderLineOverlayView.swift` — the UIKit overlay. `point(inside:)` (line 189) deliberately refuses touches on empty space so the chart keeps pan/zoom; anything newly interactive must be added there or it will never receive a touch.
- `Features/Chart/CandleChartRepresentable.swift` lines 78–99 — the 1.5s `UILongPressGestureRecognizer` this plan deletes.
- `Features/Chart/OrderPlacementSheet.swift` — the stock `Form` sheet this plan replaces.
- `Features/Chart/ChartTradingCoordinator.swift` — turns overlay intent into model calls.
- `DesignSystem/HudShapes.swift` (`HudPanelShape`, `hudCard`) and `DesignSystem/HudControls.swift` (`HudSegmentedControl` — its `Option` takes a per-option accent, which is how BUY renders green and SELL red).

**Verification commands** (you will run these repeatedly):

```bash
npm run test --workspace apps/desktop
```

```bash
cd apps/ios && xcodegen && xcodebuild build -scheme 0dteTrader -destination 'generic/platform=iOS Simulator'
```

---

## Task 1: Desktop placement-guide geometry

Pure module first: where the guide sits is the one rule that has to be right on both platforms, and it is testable without a chart.

**Files:**

- Create: `apps/desktop/src/features/chart/placementGuide.ts`
- Create: `apps/desktop/src/features/chart/placementGuide.test.ts`

**Step 1: Write the failing test**

Create `apps/desktop/src/features/chart/placementGuide.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveGuidePrice } from './placementGuide';

const range = { min: 500, max: 520 };

describe('resolveGuidePrice', () => {
  it('leaves a guide that is already in view where the user put it', () => {
    expect(resolveGuidePrice(507.5, 510, range)).toBe(507.5);
  });

  it('parks at the last traded price when there is no guide yet', () => {
    expect(resolveGuidePrice(null, 510, range)).toBe(510);
  });

  it('re-anchors to the last price when the axis pans away from the guide', () => {
    expect(resolveGuidePrice(480, 510, range)).toBe(510);
  });

  it('clamps into view when the last price is off-screen too', () => {
    expect(resolveGuidePrice(480, 470, range)).toBe(500);
    expect(resolveGuidePrice(560, 570, range)).toBe(520);
  });

  it('falls back to the middle of the range with nothing to seed from', () => {
    expect(resolveGuidePrice(null, null, range)).toBe(510);
  });

  it('leaves the guide alone when the range is degenerate', () => {
    expect(resolveGuidePrice(507.5, 510, { min: 520, max: 500 })).toBe(507.5);
    expect(resolveGuidePrice(507.5, 510, { min: NaN, max: 520 })).toBe(507.5);
  });

  it('ignores a non-finite guide or last price', () => {
    expect(resolveGuidePrice(NaN, 510, range)).toBe(510);
    expect(resolveGuidePrice(null, NaN, range)).toBe(510);
  });

  it('counts the visible edges as in view', () => {
    expect(resolveGuidePrice(500, 510, range)).toBe(500);
    expect(resolveGuidePrice(520, 510, range)).toBe(520);
  });

  it('never hands back a non-finite level', () => {
    expect(resolveGuidePrice(NaN, 510, { min: NaN, max: 520 })).toBeNull();
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
npm run test --workspace apps/desktop -- placementGuide
```

Expected: FAIL — `Failed to resolve import "./placementGuide"`.

**Step 3: Write the implementation**

Create `apps/desktop/src/features/chart/placementGuide.ts`:

```ts
/**
 * Where the permanent order-placement guide sits.
 *
 * Kept pure and out of the canvas component for the same reason the order-line
 * geometry is: the guide is the thing that decides what price a new line gets
 * armed at, and "it looked right when I dragged it" is not a test.
 */

/** Side of the square `+` handle. */
export const PLUS_SIZE = 22;
/** Gap between the handle and the right edge of the pane. */
export const PLUS_MARGIN = 6;
/** Pointer travel before a press on the handle counts as a drag, not a click. */
export const GUIDE_DRAG_THRESHOLD = 3;

export interface PriceRange {
  /** Price at the bottom of the pane. */
  min: number;
  /** Price at the top of the pane. */
  max: number;
}

function isFinite_(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

/**
 * Resolves the guide's price for this frame.
 *
 * The guide is permanent chrome, so it must never end up somewhere the user
 * cannot see or reach. Panning the price axis past it re-anchors it to the last
 * traded price — the level it would have started at — and if that is off-screen
 * too it clamps to the nearest edge. A guide left outside the pane would pin the
 * `+` to a border with no relationship to the price it arms, which is the one
 * way this control can lie about what it is going to do.
 */
export function resolveGuidePrice(
  current: number | null,
  lastPrice: number | null,
  range: PriceRange,
): number | null {
  const { min, max } = range;
  // A degenerate range means the chart has no usable price transform yet; hold
  // whatever we had rather than inventing a level from garbage. `current` is
  // still filtered on the way out — a non-finite level escaping here would
  // become a non-finite y-coordinate and silently erase the guide, which is the
  // exact failure this module exists to prevent.
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return isFinite_(current) ? current : null;
  }

  const inRange = (price: number | null): price is number =>
    isFinite_(price) && price >= min && price <= max;

  if (inRange(current)) return current;
  if (inRange(lastPrice)) return lastPrice;
  if (isFinite_(current)) return Math.min(max, Math.max(min, current));
  return (min + max) / 2;
}
```

**Step 4: Run the test to verify it passes**

```bash
npm run test --workspace apps/desktop -- placementGuide
```

Expected: PASS, 7 tests.

**Step 5: Commit**

```bash
git add apps/desktop/src/features/chart/placementGuide.ts apps/desktop/src/features/chart/placementGuide.test.ts && git commit -m "feat(chart-orders): pure geometry for the persistent placement guide"
```

---

## Task 2: iOS placement-guide geometry

Same rule, same tests, Swift side. Mirrored rather than shared because there is no shared runtime between the two apps — the tests are what keep them honest.

**Files:**

- Create: `apps/ios/0dteTrader/Features/Chart/PlacementGuide.swift`
- Create: `apps/ios/0dteTraderTests/PlacementGuideTests.swift`
- Modify: `apps/ios/project.yml` — **only if** sources are listed file-by-file. Check first:

```bash
grep -n "sources" -A 12 apps/ios/project.yml
```

If it globs a directory (the usual setup here), no change is needed; `xcodegen` picks the new files up.

**Step 1: Write the failing test**

Create `apps/ios/0dteTraderTests/PlacementGuideTests.swift`:

```swift
import XCTest
@testable import ZeroDTETrader

final class PlacementGuideTests: XCTestCase {
    private let min = 500.0
    private let max = 520.0

    func testKeepsAGuideThatIsAlreadyInView() {
        XCTAssertEqual(
            resolveGuidePrice(current: 507.5, lastPrice: 510, min: min, max: max),
            507.5
        )
    }

    func testParksAtTheLastPriceWhenThereIsNoGuideYet() {
        XCTAssertEqual(resolveGuidePrice(current: nil, lastPrice: 510, min: min, max: max), 510)
    }

    func testReanchorsToTheLastPriceWhenTheAxisPansAway() {
        XCTAssertEqual(resolveGuidePrice(current: 480, lastPrice: 510, min: min, max: max), 510)
    }

    func testClampsIntoViewWhenTheLastPriceIsOffScreenToo() {
        XCTAssertEqual(resolveGuidePrice(current: 480, lastPrice: 470, min: min, max: max), 500)
        XCTAssertEqual(resolveGuidePrice(current: 560, lastPrice: 570, min: min, max: max), 520)
    }

    func testFallsBackToTheMiddleWithNothingToSeedFrom() {
        XCTAssertEqual(resolveGuidePrice(current: nil, lastPrice: nil, min: min, max: max), 510)
    }

    func testLeavesTheGuideAloneWhenTheRangeIsDegenerate() {
        XCTAssertEqual(
            resolveGuidePrice(current: 507.5, lastPrice: 510, min: 520, max: 500),
            507.5
        )
        XCTAssertEqual(
            resolveGuidePrice(current: 507.5, lastPrice: 510, min: .nan, max: 520),
            507.5
        )
    }

    func testIgnoresANonFiniteGuideOrLastPrice() {
        XCTAssertEqual(resolveGuidePrice(current: .nan, lastPrice: 510, min: min, max: max), 510)
        XCTAssertEqual(resolveGuidePrice(current: nil, lastPrice: .nan, min: min, max: max), 510)
    }

    func testCountsTheVisibleEdgesAsInView() {
        XCTAssertEqual(resolveGuidePrice(current: 500, lastPrice: 510, min: min, max: max), 500)
        XCTAssertEqual(resolveGuidePrice(current: 520, lastPrice: 510, min: min, max: max), 520)
    }

    func testNeverHandsBackANonFiniteLevel() {
        XCTAssertNil(resolveGuidePrice(current: .nan, lastPrice: 510, min: .nan, max: 520))
    }
}
```

**Step 2: Run the test to verify it fails**

```bash
cd apps/ios && xcodegen && xcodebuild build-for-testing -scheme 0dteTrader -destination 'generic/platform=iOS Simulator'
```

Expected: FAIL — `cannot find 'resolveGuidePrice' in scope`.

**Step 3: Write the implementation**

Create `apps/ios/0dteTrader/Features/Chart/PlacementGuide.swift`:

```swift
import CoreGraphics
import Foundation

/// Placement-guide metrics (pt values).
enum AppPlacementGuide {
    /// Drawn size of the `+` handle.
    static let handleSize: CGFloat = 28
    /// Minimum touch target around it.
    static let handleTouchSize: CGFloat = 44
    /// Gap between the handle and the right edge of the pane.
    static let handleMargin: CGFloat = 6
    /// Chamfer on the handle, matching `HudPanelShape` at chip scale.
    static let handleChamfer: CGFloat = 6
    static let dash: [CGFloat] = [4, 4]
    /// Finger travel before a press on the handle counts as a drag, not a tap.
    static let dragThreshold: CGFloat = 4
}

/// Resolves the guide's price for this frame.
///
/// The guide is permanent chrome, so it must never end up somewhere the user
/// cannot see or reach. Panning the price axis past it re-anchors it to the last
/// traded price — the level it would have started at — and if that is off-screen
/// too it clamps to the nearest edge. A guide left outside the pane would pin the
/// `+` to a border with no relationship to the price it arms, which is the one
/// way this control can lie about what it is going to do.
func resolveGuidePrice(
    current: Double?,
    lastPrice: Double?,
    min lowerBound: Double,
    max upperBound: Double
) -> Double? {
    // A degenerate range means the chart has no usable price transform yet; hold
    // whatever we had rather than inventing a level from garbage. `current` is
    // still filtered on the way out — a non-finite level escaping here would
    // become a non-finite y-coordinate and silently erase the guide, which is
    // the exact failure this function exists to prevent.
    guard lowerBound.isFinite, upperBound.isFinite, upperBound > lowerBound else {
        return (current?.isFinite ?? false) ? current : nil
    }

    func inRange(_ price: Double?) -> Bool {
        guard let price, price.isFinite else { return false }
        return price >= lowerBound && price <= upperBound
    }

    if inRange(current) { return current }
    if inRange(lastPrice) { return lastPrice }
    if let current, current.isFinite { return Swift.min(upperBound, Swift.max(lowerBound, current)) }
    return (lowerBound + upperBound) / 2
}
```

**Step 4: Run the test to verify it passes**

```bash
cd apps/ios && xcrun simctl list devices available | grep -m1 iPhone
```

Use the device name that prints, then:

```bash
cd apps/ios && xcodebuild test -scheme 0dteTrader -destination 'platform=iOS Simulator,name=<DEVICE FROM ABOVE>' -only-testing:0dteTraderTests/PlacementGuideTests
```

Expected: PASS, 7 tests.

**Step 5: Commit**

```bash
git add apps/ios/0dteTrader/Features/Chart/PlacementGuide.swift apps/ios/0dteTraderTests/PlacementGuideTests.swift && git commit -m "feat(chart-orders): pure geometry for the iOS placement guide"
```

---

## Task 3: Desktop — permanent guide and draggable `+`

> **Execute Tasks 3 and 4 together as one unit.** Task 3's render block passes
> `onPriceChange` to `OrderPlacementPopover` and stops passing `top`; Task 4 is
> what adds that prop and removes the `top` dependency. Landing Task 3 alone
> leaves the tree failing `tsc`, so its own Step 8 verification would fail. Do
> both, verify once, commit once.

Replaces the hover-only `+`. The handle's position is written imperatively from the draw loop rather than through React state, because the old `setPlusPrice`/`setPlacementY` on every `pointermove` re-rendered the component on a canvas that is already repainting itself.

**Files:**

- Modify: `apps/desktop/src/features/chart/OrderLineLayer.tsx`

**Step 1: Add the imports and refs**

Add to the imports at the top of the file:

```ts
import { GUIDE_DRAG_THRESHOLD, PLUS_MARGIN, PLUS_SIZE, resolveGuidePrice } from './placementGuide';
```

Replace the three state hooks at lines 106–108:

```ts
/** Price row the pointer is on, which is where the `+` affordance appears. */
const [plusPrice, setPlusPrice] = useState<number | null>(null);
const [placementPrice, setPlacementPrice] = useState<number | null>(null);
const [placementY, setPlacementY] = useState(0);
```

with:

```ts
/** The guide's level. A ref, not state: it changes on every drag frame and
 *  the canvas is already repainting — re-rendering React at 60fps to move an
 *  absolutely-positioned button is pure waste. */
const guidePriceRef = useRef<number | null>(null);
const guideDragRef = useRef(false);
const plusRef = useRef<HTMLButtonElement>(null);
const endGuideDragRef = useRef<() => void>(() => {});
/** Level the open window refers to. State, because the window is React. */
const [placementPrice, setPlacementPrice] = useState<number | null>(null);
```

Add `candles` and `placementPrice` to the `latest` ref (both objects at lines 111–132) so the draw closure can read them — it is bound once and would otherwise capture their mount-time values:

```ts
const latest = useRef({
  settings,
  symbol,
  positions,
  resolveContract,
  selectedContract,
  defaultOrderType,
  onFlatten,
  onCancelOrder,
  rightInset,
  candles,
  placementPrice,
});
latest.current = {
  settings,
  symbol,
  positions,
  resolveContract,
  selectedContract,
  defaultOrderType,
  onFlatten,
  onCancelOrder,
  rightInset,
  candles,
  placementPrice,
};
```

**Step 2: Draw the guide and place the handle**

In `draw()`, immediately after `rowsRef.current = rows;` (line 334) and before the closing brace, insert:

```ts
// Placement guide: permanent dashed level with the `+` handle at its right
// edge. Suppressed when there is no contract to trade, because arming a
// line against nothing is not a state the user can act on.
const guideOn = latest.current.settings.enabled && latest.current.selectedContract !== null;
const open = latest.current.placementPrice;
const guide = guideOn
  ? open !== null
    ? // While the window is open it owns the level, so the guide does not
      // re-anchor underneath the number the user is editing.
      open
    : resolveGuidePrice(guidePriceRef.current, latest.current.candles.at(-1)?.close ?? null, {
        max: series.coordinateToPrice(0) ?? NaN,
        min: series.coordinateToPrice(pane.height) ?? NaN,
      })
  : null;
guidePriceRef.current = guide;
const guideY = guide === null ? null : series.priceToCoordinate(guide);

if (guide !== null && guideY !== null) {
  ctx.strokeStyle = colors.guide;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, guideY);
  ctx.lineTo(rightEdge - PLUS_SIZE - PLUS_MARGIN, guideY);
  ctx.stroke();
  ctx.setLineDash([]);
  // The level only needs calling out while it is moving; the rest of the
  // time the price axis already says where the line is.
  if (guideDragRef.current) {
    ctx.fillStyle = colors.guide;
    ctx.fillText(Format.price(guide), 8, guideY - 6);
  }
}

const plus = plusRef.current;
if (plus) {
  if (guide === null || guideY === null) {
    plus.style.display = 'none';
  } else {
    plus.style.display = 'flex';
    plus.style.top = `${guideY - PLUS_SIZE / 2}px`;
    plus.style.right = `${PLUS_MARGIN + latest.current.rightInset}px`;
    plus.setAttribute('aria-label', `Place an order at ${Format.price(guide)}`);
  }
}
```

**Step 3: Delete the hover `+` logic**

In `onHover`, delete the trailing block (lines 486–493) that sets `plusPrice`/`placementY`, and change the early return at the top so it no longer touches that state:

```ts
const onHover = (event: PointerEvent) => {
  const xy = canvasXY(event);
  if (!xy) return;
  const hit = hitRows(rowsRef.current, xy.x, xy.y);
  const next = hit ? { id: hit.row.id, pill: hit.pill } : null;
  if (next?.id !== hoverRef.current?.id || next?.pill !== hoverRef.current?.pill) {
    hoverRef.current = next;
    scheduleRef.current();
  }
  if (!hit) containerEl.style.cursor = '';
  else containerEl.style.cursor = hit.pill ? 'pointer' : 'ns-resize';
};
```

And simplify `onLeave` (lines 496–502) to drop `setPlusPrice(null)`:

```ts
const onLeave = () => {
  if (hoverRef.current) {
    hoverRef.current = null;
    scheduleRef.current();
  }
};
```

**Step 4: Stop the capture listener from swallowing clicks on the new chrome**

The row `pointerdown` listener is registered in **capture** phase on the container, and the handle and window are children of that container. A row sitting at the same `y` as the handle would `preventDefault()` the press before the button ever sees it. Add this guard as the first two lines of `onPointerDown` (before `canvasXY`):

```ts
    const onPointerDown = (event: PointerEvent) => {
      // The `+` and the placement window live inside this container, so a row
      // at the same y would otherwise eat their press in the capture phase.
      if ((event.target as Element | null)?.closest('[data-chart-placement]')) return;
      const xy = canvasXY(event);
      ...
```

**Step 5: Add the handle's press/drag handler**

Add this above the `placeBracket` function (before line 517):

```ts
/**
 * Press on the handle: a drag moves the guide, a click with no travel opens
 * the window. Same gesture the order lines use, so the two feel identical.
 */
const onPlusPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
  if (latest.current.placementPrice !== null) return; // window owns the level
  event.preventDefault();
  event.stopPropagation();
  const startY = event.clientY;
  guideDragRef.current = false;

  const onMove = (moveEvent: PointerEvent) => {
    if (!guideDragRef.current && Math.abs(moveEvent.clientY - startY) < GUIDE_DRAG_THRESHOLD) {
      return;
    }
    guideDragRef.current = true;
    const xy = canvasXY(moveEvent);
    if (!xy) return;
    const price = series.coordinateToPrice(xy.y);
    if (price === null) return;
    guidePriceRef.current = price;
    scheduleRef.current();
  };

  const detach = () => {
    endGuideDragRef.current = () => {};
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };

  const onUp = () => {
    const dragged = guideDragRef.current;
    guideDragRef.current = false;
    detach();
    scheduleRef.current();
    if (!dragged && guidePriceRef.current !== null) {
      setPlacementPrice(round2(guidePriceRef.current));
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  // Unmounting mid-drag abandons the gesture: the series these coordinates
  // mean is going away.
  endGuideDragRef.current = () => {
    guideDragRef.current = false;
    detach();
  };
};

// Tears the guide drag down if the component unmounts while the pointer is
// still held — the listeners are on `window`, so they would outlive it.
useEffect(() => () => endGuideDragRef.current(), []);
```

**Step 6: Replace the render block**

Replace everything from `const plusVisible = ...` (line 550) through the closing `);` of the returned fragment (line 620) with:

```ts
  return (
    <>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Chart order lines: ${store.visibleOrders.length} working orders.`}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          zIndex: 4,
          pointerEvents: 'none',
        }}
      />
      <button
        ref={plusRef}
        type="button"
        data-chart-placement=""
        className="order-guide-plus"
        aria-label="Place an order"
        onPointerDown={onPlusPointerDown}
        // Positioned imperatively from the draw loop; hidden until it has a level.
        style={{ display: 'none', width: PLUS_SIZE, height: PLUS_SIZE }}
      >
        +
      </button>
      {placementPrice !== null && selectedContract ? (
        <OrderPlacementPopover
          price={placementPrice}
          onPriceChange={(next) => {
            setPlacementPrice(next);
            guidePriceRef.current = next;
            scheduleRef.current();
          }}
          rightInset={rightInset}
          contract={selectedContract}
          defaultQuantity={settings.defaultQuantity}
          defaultOrderType={defaultOrderType}
          onCancel={() => setPlacementPrice(null)}
          onPlace={async (input) => {
            await store.create({
              underlying: selectedContract.underlying,
              triggerPrice: round2(placementPrice),
              side: input.side,
              quantity: input.quantity,
              orderType: input.orderType,
              kind: 'limit',
              optionType: selectedContract.optionType,
              expiration: selectedContract.expiration,
              strike: selectedContract.strike,
            });
            setPlacementPrice(null);
          }}
        />
      ) : null}
    </>
  );
```

Note the `top` prop is gone from the popover — Task 4 centres it vertically instead of chasing the handle, so it can never be clipped against the top of a short pane.

Add `useEffect` to the React import if it is not already there (it is, line 1).

**Step 7: Style the handle**

Append to `apps/desktop/src/features/chart/chart.css`:

```css
/* Permanent placement `+`: chamfered HUD chip. clip-path rather than the
   .hud-chip border-image, whose 21px slices collapse at this size. */
.order-guide-plus {
  position: absolute;
  z-index: 5;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--hud-stroke);
  background: var(--hud-panel-fill);
  color: var(--app-accent);
  font-family: var(--font-mono);
  font-size: 15px;
  line-height: 1;
  cursor: ns-resize;
  clip-path: polygon(
    5px 0,
    calc(100% - 5px) 0,
    100% 5px,
    100% calc(100% - 5px),
    calc(100% - 5px) 100%,
    5px 100%,
    0 calc(100% - 5px),
    0 5px
  );
}
.order-guide-plus:hover {
  background: rgba(46, 143, 255, 0.18);
  box-shadow: var(--shadow-toast);
}
```

**Step 8: Verify**

```bash
npm run lint --workspace apps/desktop && npm run test --workspace apps/desktop
```

Expected: no lint errors, all tests pass. Then run the app and confirm by hand:

```bash
npm run dev:all
```

- A dashed guide with a `+` sits at the last price the moment the chart loads (chart trading on, a contract selected).
- Dragging the handle moves the guide; the price prints next to it while dragging.
- Releasing without moving opens the window.
- Panning the price axis far away re-anchors the guide to the last price.
- Order-line pills (`✕`, `MID`/`MKT`) still respond, including when a line sits at the guide's level.

**Step 9: Commit**

```bash
git add apps/desktop/src/features/chart/OrderLineLayer.tsx apps/desktop/src/features/chart/chart.css && git commit -m "feat(chart-orders): permanent draggable + handle on the desktop chart"
```

---

## Task 4: Desktop — HUD order window with an editable price

**Files:**

- Modify: `apps/desktop/src/features/chart/OrderPlacementPopover.tsx`
- Modify: `apps/desktop/src/features/chart/chart.css`

**Step 1: Rewrite the component**

Replace the whole of `apps/desktop/src/features/chart/OrderPlacementPopover.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { OptionContract, OrderSide, OrderType } from '@0dtetrader/shared-types';
import { SegmentedControl } from '../../design/components/SegmentedControl';
import { Stepper } from '../../design/components/Stepper';
import { Format } from '../../design/format';

export interface OrderPlacementInput {
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
}

interface OrderPlacementPopoverProps {
  /** Level the line will sit at, on the underlying. */
  price: number;
  /** Editing the price here moves the guide on the chart — the number and the
   *  line are the same fact, so they must never disagree. */
  onPriceChange: (price: number) => void;
  rightInset: number;
  contract: OptionContract;
  defaultQuantity: number;
  defaultOrderType: OrderType;
  onPlace: (input: OrderPlacementInput) => Promise<void>;
  onCancel: () => void;
}

/** Trigger price step: one cent, the tick the level is rounded to anyway. */
const PRICE_STEP = 0.01;

/**
 * The window behind the chart's `+`: pick a level, a side, a size, and how the
 * order executes when the level is hit. Every field is editable — the `+` puts
 * you roughly where you meant, and this is where you say exactly.
 *
 * The execution type is offered here (rather than inherited silently) for the
 * same reason it sits on the line itself — `market` into a thin 0DTE spread and
 * `mid` that never fills are both bad in different situations, and the choice
 * should be in front of you when you arm the line.
 */
export function OrderPlacementPopover({
  price,
  onPriceChange,
  rightInset,
  contract,
  defaultQuantity,
  defaultOrderType,
  onPlace,
  onCancel,
}: OrderPlacementPopoverProps) {
  const [side, setSide] = useState<OrderSide>('buy');
  const [quantity, setQuantity] = useState(defaultQuantity);
  const [orderType, setOrderType] = useState<OrderType>(defaultOrderType);
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Escape closes, and so does a click anywhere else — the window must never be
  // the thing standing between the user and their chart.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onCancel();
    };
    window.addEventListener('keydown', onKey);
    // Deferred: the click that opened this window is still propagating.
    const timer = setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
      clearTimeout(timer);
    };
  }, [onCancel]);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onPlace({ side, quantity, orderType });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={ref}
      data-chart-placement=""
      className="hud-card order-placement"
      role="dialog"
      aria-label="Place a chart order"
      style={{ right: 36 + rightInset }}
    >
      <div className="order-placement__title">PLACE ORDER LINE</div>

      <label className="order-placement__row">
        <span>Level</span>
        <input
          type="number"
          step={PRICE_STEP}
          value={price}
          aria-label="Trigger price"
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onPriceChange(Math.round(next * 100) / 100);
          }}
        />
        <Stepper value={price} min={0.01} max={100000} step={PRICE_STEP} onChange={onPriceChange} />
      </label>

      <div className="order-placement__contract">
        {contract.underlying} {Format.strike(contract.strike)}
        {contract.optionType === 'call' ? 'C' : 'P'} · {contract.expiration}
      </div>

      <SegmentedControl
        options={[
          { value: 'buy', label: 'BUY' },
          { value: 'sell', label: 'SELL' },
        ]}
        value={side}
        onChange={(value) => setSide(value as OrderSide)}
      />
      <SegmentedControl
        options={[
          { value: 'mid', label: 'MID' },
          { value: 'market', label: 'MKT' },
        ]}
        value={orderType}
        onChange={(value) => setOrderType(value as OrderType)}
      />

      <label className="order-placement__row">
        <span>Qty</span>
        <input
          type="number"
          min={1}
          max={1000}
          value={quantity}
          aria-label="Quantity"
          onChange={(event) =>
            setQuantity(Math.max(1, Math.min(1000, Number(event.target.value) || 1)))
          }
        />
        <Stepper value={quantity} min={1} max={1000} onChange={setQuantity} />
      </label>

      <p className="order-placement__note">
        Fires an order when {contract.underlying} reaches {Format.price(price)}. Watched by the app
        — not a broker-side resting order.
      </p>

      <div className="order-placement__actions">
        <button type="button" className="order-placement__btn" onClick={onCancel}>
          CANCEL
        </button>
        <button
          type="button"
          className={`order-placement__btn order-placement__btn--${side}`}
          onClick={() => void submit()}
          disabled={submitting}
        >
          {submitting ? 'PLACING…' : 'PLACE'}
        </button>
      </div>
    </div>
  );
}
```

**Step 2: Style it**

Append to `apps/desktop/src/features/chart/chart.css`:

```css
/* Chart order window. Vertically centred rather than anchored to the `+`: on a
   short pane a line-anchored card clips against the top edge, and a window that
   half-disappears is worse than one that is simply always in the same place. */
.order-placement {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 6;
  width: 240px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  font-size: var(--fs-caption);
  color: var(--label-primary);
}
.order-placement__title {
  font-family: var(--font-display);
  font-size: var(--fs-caption2);
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--app-accent);
}
.order-placement__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.order-placement__row > span {
  color: var(--label-secondary);
  min-width: 34px;
}
.order-placement__row input {
  flex: 1;
  min-width: 0;
  padding: 5px 6px;
  border: 1px solid var(--hud-stroke-dim);
  border-radius: 3px;
  background: var(--app-background);
  color: var(--label-primary);
  font-family: var(--font-mono);
}
.order-placement__row input:focus {
  outline: none;
  border-color: var(--hud-stroke);
}
.order-placement__contract {
  color: var(--label-secondary);
  font-family: var(--font-mono);
  font-size: var(--fs-caption2);
}
.order-placement__note {
  margin: 0;
  color: var(--label-secondary);
  font-size: 10px;
  line-height: 1.35;
}
.order-placement__actions {
  display: flex;
  gap: var(--space-2);
}
/* Chamfered via clip-path: the .hud-btn border-image needs ~56px of height and
   these are 34px. */
.order-placement__btn {
  flex: 1;
  padding: 8px 0;
  border: 1px solid var(--hud-stroke);
  background: transparent;
  color: var(--app-accent-text);
  font-family: var(--font-display);
  font-size: var(--fs-caption2);
  font-weight: 700;
  letter-spacing: 0.06em;
  cursor: pointer;
  clip-path: polygon(
    5px 0,
    calc(100% - 5px) 0,
    100% 5px,
    100% calc(100% - 5px),
    calc(100% - 5px) 100%,
    5px 100%,
    0 calc(100% - 5px),
    0 5px
  );
}
.order-placement__btn--buy {
  border-color: var(--buy-green);
  background: rgba(34, 224, 106, 0.16);
  color: var(--buy-green);
}
.order-placement__btn--sell {
  border-color: var(--sell-red);
  background: rgba(255, 59, 78, 0.16);
  color: var(--sell-red);
}
.order-placement__btn:disabled {
  opacity: 0.55;
  cursor: default;
}
```

**Step 3: Verify**

```bash
npm run lint --workspace apps/desktop && npm run test --workspace apps/desktop && npm run build --workspace apps/desktop
```

Then in `npm run dev:all`, confirm:

- The window carries the chamfered HUD frame, Orbitron title, and accent stroke — it reads as part of the app, not a system dialog.
- Typing in the Level field, or clicking its `−`/`+`, moves the dashed guide on the chart in real time.
- BUY/SELL and MID/MKT are clickable and the Place button changes to green/red with the side.
- Escape and an outside click both dismiss without placing.

**Step 4: Commit**

```bash
git add apps/desktop/src/features/chart/OrderPlacementPopover.tsx apps/desktop/src/features/chart/chart.css && git commit -m "feat(chart-orders): HUD-branded order window with an editable level"
```

---

## Task 5: iOS — delete the 1.5s long-press, feed the last price down

> **Execute Tasks 5 and 6 together as one unit.** Task 5 assigns
> `container.orderLineOverlay.lastPrice`, but that property is not declared until Task 6,
> so Task 5 alone does not compile and its own build step would fail. Do both, verify
> once, commit once — or commit twice if you prefer the history, but only after the
> combined tree builds.

Remove the gesture the user called out, and thread the one new value the overlay needs.

**Files:**

- Modify: `apps/ios/0dteTrader/Features/Chart/CandleChartRepresentable.swift`
- Modify: `apps/ios/0dteTrader/Features/Chart/ChartView.swift`

**Step 1: Remove the recognizer**

In `CandleChartRepresentable.swift`, delete lines 78–99 — the comment block, the `UILongPressGestureRecognizer` setup, and the whole `handleLongPress(_:)` method. The `ContainerView` initialiser now ends at `chart.onPostDraw = { ... }`.

**Step 2: Add the `lastPrice` property**

In `CandleChartRepresentable`, after `var placementPrice: Double?` (line 28) add:

```swift
    /// Last traded price — where the placement guide parks when it has nowhere
    /// else to be.
    var lastPrice: Double?
```

In `updateUIView`, next to the other overlay assignments (after line 228):

```swift
        container.orderLineOverlay.lastPrice = lastPrice
```

**Step 3: Pass it from ChartView**

In `ChartView.swift`, in the `CandleChartRepresentable(...)` call, add after `placementPrice: placementPrice,` (line 79):

```swift
                    lastPrice: viewModel.candles.last?.close,
```

**Step 4: Build**

```bash
cd apps/ios && xcodegen && xcodebuild build -scheme 0dteTrader -destination 'generic/platform=iOS Simulator'
```

Expected: BUILD SUCCEEDED. The `+` is unreachable on iOS at this commit — that is intentional; Task 6 puts it back as permanent chrome.

**Step 5: Commit**

```bash
git add apps/ios/0dteTrader/Features/Chart/CandleChartRepresentable.swift apps/ios/0dteTrader/Features/Chart/ChartView.swift && git commit -m "refactor(chart-orders): drop the 1.5s long-press that armed the iOS placement"
```

---

## Task 6: iOS — permanent guide and draggable `+` in the overlay

**Files:**

- Modify: `apps/ios/0dteTrader/Features/Chart/OrderLineOverlayView.swift`
- Modify: `apps/ios/0dteTrader/Features/Chart/ChartTradingCoordinator.swift`

**Decide first:** `AppPlacementGuide.handleTouchSize` (44) and `AppOrderLine.minimumTouchTarget` (44) are the same HIG minimum under two names, and this task makes one file import both namespaces. Either fold the guide's metrics into `AppOrderLine` — the sibling pattern is that the metrics enum lives in the view file that consumes it — or keep them separate and rename `handleTouchSize` to match `minimumTouchTarget`. Do not leave the file disagreeing with itself about what 44pt is called.

**Step 1: Change the delegate protocol**

In `OrderLineOverlayView.swift`, replace the last delegate method (lines 78–79):

```swift
    /// Long-press armed the `+` affordance at a price, or cleared it (nil).
    func orderLineOverlayDidArmPlacement(at price: Double?)
```

with:

```swift
    /// The `+` handle was tapped at this level.
    func orderLineOverlayDidRequestPlacement(at price: Double)
```

**Step 2: Add the guide's state**

After the `rightInset` property (line 96) add:

```swift
    /// Last traded price — where the guide parks when it has nowhere else to be.
    var lastPrice: Double? { didSet { setNeedsDisplay() } }

    /// The guide's level. Owned here because dragging it is a UIKit gesture;
    /// SwiftUI only hears about it when the `+` is tapped.
    private var guidePrice: Double?
    /// The handle as last drawn, for hit-testing.
    private var handleFrame: CGRect = .zero
```

Delete the `armPlacement(at:)` method (lines 181–185) — nothing calls it now that the long-press is gone.

Add near `price(at:)`:

```swift
    /// Whether the placement window is open. While it is, it owns the level and
    /// the handle goes inert — one source of truth at any moment.
    private var isPlacementOpen: Bool { placementPrice != nil }

    /// The level the guide is drawn at: the open window's, or the handle's own.
    private var effectiveGuidePrice: Double? { placementPrice ?? guidePrice }
```

**Step 3: Let the handle receive touches**

Replace `point(inside:)` (lines 189–192):

```swift
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard settings.enabled else { return false }
        if !isPlacementOpen, handleTouchFrame.contains(point) { return true }
        return hitTest(at: point) != nil
    }

    /// Enlarged to the 44pt minimum without moving the drawn glyph.
    private var handleTouchFrame: CGRect {
        guard !handleFrame.isEmpty else { return .zero }
        let inset = (AppPlacementGuide.handleTouchSize - AppPlacementGuide.handleSize) / 2
        return handleFrame.insetBy(dx: -inset, dy: -inset)
    }
```

**Step 4: Handle tap and drag on the handle**

Add a case to the private `Drag` enum (line 140):

```swift
    private enum Drag {
        case move(orderId: String, price: Double)
        case bracket(entry: EntryLineModel, startY: CGFloat, price: Double, engaged: Bool)
        case guideHandle(startY: CGFloat, moved: Bool)
    }
```

In `handleTap(_:)`, insert before the existing `guard let model, let hit = ...` line (line 230):

```swift
        let location = recognizer.location(in: self)
        if !isPlacementOpen, handleTouchFrame.contains(location), let price = effectiveGuidePrice {
            Haptics.impact(.light)
            delegate?.orderLineOverlayDidRequestPlacement(at: price)
            return
        }
```

and change the following line to reuse `location`:

```swift
        guard let model, let hit = hitTest(at: location) else { return }
```

In `handlePan(_:)`, the `.began` case: put this first, before `guard let hit = hitTest(...)`:

```swift
        case .began:
            if !isPlacementOpen, handleTouchFrame.contains(location) {
                drag = .guideHandle(startY: location.y, moved: false)
                return
            }
            guard let hit = hitTest(at: location), hit.pill == nil else { return }
```

Note `handlePan` currently opens with `guard let model else { return }`. Move that guard down into the branches that need it, or the handle drag will be dead whenever the model is nil. Replace the first line of `handlePan` with `let location = recognizer.location(in: self)` and add `guard let model else { return }` inside the `.order` / `.entry` branches that dereference it.

In `.changed`, add the case. Note the clamp — this bit the desktop implementation: an
unclamped `location.y` extrapolates a price outside the visible range, and on the next
frame `resolveGuidePrice` sees an out-of-range `current` against an in-range `lastPrice`
and returns the _last price_, because that branch precedes the clamp branch. The guide
teleports mid-drag instead of stopping at the edge.

```swift
            case .guideHandle(let startY, let moved):
                let travelled = moved || abs(location.y - startY) >= AppPlacementGuide.dragThreshold
                if travelled {
                    guidePrice = price
                    drag = .guideHandle(startY: startY, moved: true)
                }
```

and clamp the location before converting it, at the top of `.changed`:

```swift
        case .changed:
            let content = chart?.viewPortHandler.contentRect ?? bounds
            let clampedY = Swift.min(content.maxY, Swift.max(content.minY, location.y))
            guard let current = drag, let price = price(at: clampedY) else { return }
```

Keep using the unclamped `location` for the order-line and bracket drags if that is the
existing behaviour; only the guide handle needs pinning to the pane.

**Also confirm** `.cancelled` clears the guide drag. The existing `default:` arm sets
`drag = nil`, which covers it — verify rather than assume, because a stranded
`.guideHandle` drag leaves the guide tracking a finger that is no longer down.

In `.ended`, add:

```swift
            case .guideHandle:
                break // the level is already where the finger left it
```

**Step 5: Draw the guide and the handle**

Replace `renderPlacementGuide(in:)` (lines 429–439) with:

```swift
    /// Permanent placement guide: a dashed level with the `+` handle at its
    /// right edge. Suppressed when chart trading is off; the SwiftUI layer
    /// additionally gates it on there being a contract to trade.
    private func renderPlacementGuide(in context: CGContext) {
        let visibleRect = chart?.viewPortHandler.contentRect ?? bounds
        let resolved = isPlacementOpen
            // While the window is open it owns the level, so the guide does not
            // re-anchor underneath the number the user is editing.
            ? placementPrice
            : resolveGuidePrice(
                current: guidePrice,
                lastPrice: lastPrice,
                min: price(at: visibleRect.maxY) ?? .nan,
                max: price(at: visibleRect.minY) ?? .nan
            )
        if !isPlacementOpen { guidePrice = resolved }

        guard let resolved, let y = yPixel(for: resolved) else {
            handleFrame = .zero
            return
        }

        let size = AppPlacementGuide.handleSize
        let frame = CGRect(
            x: bounds.width - rightInset - AppPlacementGuide.handleMargin - size,
            y: y - size / 2,
            width: size,
            height: size
        )
        handleFrame = frame

        strokeLine(
            to: frame.minX - AppPlacementGuide.handleMargin,
            y: y,
            color: .hudAxisLabel,
            width: 1,
            dash: AppPlacementGuide.dash,
            in: context
        )
        // The level only needs calling out while it is moving; the rest of the
        // time the price axis already says where the line is.
        if case .guideHandle(_, true) = drag {
            draw(text: Format.price(resolved), at: CGPoint(x: 8, y: y - 18), color: .hudAxisLabel)
        }
        renderHandle(frame, in: context)
    }

    /// Chamfered HUD chip with a `+` glyph — the same silhouette as
    /// `HudPanelShape` at chip scale, drawn in CoreGraphics because this view
    /// paints itself.
    private func renderHandle(_ frame: CGRect, in context: CGContext) {
        let c = AppPlacementGuide.handleChamfer
        let path = CGMutablePath()
        path.move(to: CGPoint(x: frame.minX + c, y: frame.minY))
        path.addLine(to: CGPoint(x: frame.maxX - c, y: frame.minY))
        path.addLine(to: CGPoint(x: frame.maxX, y: frame.minY + c))
        path.addLine(to: CGPoint(x: frame.maxX, y: frame.maxY - c))
        path.addLine(to: CGPoint(x: frame.maxX - c, y: frame.maxY))
        path.addLine(to: CGPoint(x: frame.minX + c, y: frame.maxY))
        path.addLine(to: CGPoint(x: frame.minX, y: frame.maxY - c))
        path.addLine(to: CGPoint(x: frame.minX, y: frame.minY + c))
        path.closeSubpath()

        context.setFillColor(UIColor.black.withAlphaComponent(0.85).cgColor)
        context.addPath(path)
        context.fillPath()
        context.setStrokeColor(UIColor.appAccent.cgColor)
        context.setLineWidth(1)
        context.addPath(path)
        context.strokePath()

        let arm = frame.width * 0.28
        context.setStrokeColor(UIColor.appAccent.cgColor)
        context.setLineWidth(1.5)
        context.move(to: CGPoint(x: frame.midX - arm, y: frame.midY))
        context.addLine(to: CGPoint(x: frame.midX + arm, y: frame.midY))
        context.move(to: CGPoint(x: frame.midX, y: frame.midY - arm))
        context.addLine(to: CGPoint(x: frame.midX, y: frame.midY + arm))
        context.strokePath()
    }
```

**Dim the handle while the card is open.** It is drawn unconditionally but hit-tested only
when `placementPrice == nil`, so at full opacity it advertises an action it will not
perform. Render it at `AppOpacity.disabled` while the card is open, and give its
accessibility element `.notEnabled` traits, so the declared inertness is legible rather
than a surprise. (The desktop twin had the same gap.)

**Step 6: Add the handle to VoiceOver**

In `rebuildAccessibilityElements()`, after the row loop and before `accessibilityElements = elements`:

```swift
        if !handleFrame.isEmpty, let price = effectiveGuidePrice {
            let handle = UIAccessibilityElement(accessibilityContainer: self)
            handle.accessibilityLabel = "Place an order at \(Format.price(price))"
            handle.accessibilityHint = "Swipe up or down to change the level"
            handle.accessibilityTraits = .button
            handle.accessibilityFrameInContainerSpace = handleTouchFrame
            elements.append(handle)
        }
```

**Step 7: Update the coordinator**

In `ChartTradingCoordinator.swift`, replace `orderLineOverlayDidArmPlacement(at:)` (lines 109–115):

```swift
    func orderLineOverlayDidRequestPlacement(at price: Double) {
        guard let contract = selectedContract() else { return }
        placementRequest = OrderPlacementRequest(price: rounded(price), contract: contract)
    }

    /// The window's own price field moved the level; the guide follows it.
    func updatePlacementPrice(_ price: Double) {
        guard let request = placementRequest else { return }
        placementRequest = OrderPlacementRequest(price: rounded(price), contract: request.contract)
    }
```

`OrderPlacementRequest` has `let id = UUID()`, so rebuilding it changes its identity and would re-present a `.sheet(item:)` from scratch on every keystroke. Task 8 replaces that sheet with an inline card, so this is safe — but make `id` stable anyway so nothing downstream can be surprised. In `OrderPlacementSheet.swift` (which Task 7 replaces), the struct moves to the new file with:

```swift
struct OrderPlacementRequest: Identifiable, Equatable {
    /// Stable across price edits: the window is one continuous interaction, not
    /// a new request per keystroke.
    let id = "chart-placement"
    let price: Double
    let contract: OptionContract
}
```

**Step 8: Build**

```bash
cd apps/ios && xcodegen && xcodebuild build -scheme 0dteTrader -destination 'generic/platform=iOS Simulator'
```

Expected: BUILD SUCCEEDED.

**Step 9: Commit**

```bash
git add apps/ios/0dteTrader/Features/Chart/OrderLineOverlayView.swift apps/ios/0dteTrader/Features/Chart/ChartTradingCoordinator.swift && git commit -m "feat(chart-orders): permanent draggable + handle on the iOS chart"
```

---

## Task 7: iOS — HUD order card replacing the Form sheet

> **Execute Tasks 7 and 8 together as one unit.** Task 7 deletes
> `OrderPlacementSheet.swift` while `TradeScreenView` still references it, so the tree does
> not build until Task 8 rewires it. Never leave a commit that does not compile. Do both,
> verify once, commit once.

**Files:**

- Create: `apps/ios/0dteTrader/Features/Chart/OrderPlacementCard.swift`
- Delete: `apps/ios/0dteTrader/Features/Chart/OrderPlacementSheet.swift`

**Validate the level field.** The desktop twin shipped a defect here: clearing the price
input yielded `0`, which is finite and so passed every guard, and PLACE would submit a
chart order with a trigger price of zero. The `rounded(_:)` helper below already floors at
`0.01` and falls back to the current price on a non-finite value — keep both, and
additionally disable PLACE whenever the level is not a usable price. An order-entry
control must not be able to submit a level the user did not mean.

**Note on failure handling:** `placeFromSheet` already checks `create(draft) != nil`
before clearing `placementRequest`, so a failed placement correctly leaves the card open.
The desktop side did not, and had to be fixed. Do not "simplify" this away.

**Step 1: Write the card**

Create `apps/ios/0dteTrader/Features/Chart/OrderPlacementCard.swift`:

```swift
import SwiftUI

/// What the placement card collects before a line is armed.
struct OrderPlacementRequest: Identifiable, Equatable {
    /// Stable across price edits: the window is one continuous interaction, not
    /// a new request per keystroke.
    let id = "chart-placement"
    /// Level on the underlying the guide was left at.
    let price: Double
    let contract: OptionContract
}

/// The window behind the chart's `+`: pick a level, a side, a size, and how the
/// order executes when the level is hit. Every field is editable — the `+` puts
/// you roughly where you meant, and this is where you say exactly.
///
/// A HUD card floating over the chart rather than a sheet: the level you are
/// arming is on the chart, and a sheet covers it at exactly the moment you want
/// to look at it. The execution type is offered here (rather than inherited
/// silently) for the same reason it sits on the line itself — `market` into a
/// thin 0DTE spread and `mid` that never fills are both bad in different
/// situations, and the choice belongs in front of you when you arm the line.
struct OrderPlacementCard: View {
    let request: OrderPlacementRequest
    let defaultQuantity: Int
    let defaultOrderType: OrderType
    /// Editing the level here moves the guide on the chart — the number and the
    /// line are the same fact, so they must never disagree.
    let onPriceChange: (Double) -> Void
    let onPlace: (OrderSide, Int, OrderType) async -> Void
    let onCancel: () -> Void

    @State private var side: OrderSide = .buy
    @State private var quantity: Int
    @State private var orderType: OrderType
    @State private var isSubmitting = false
    @FocusState private var priceFocused: Bool

    /// Trigger price step: one cent, the tick the level is rounded to anyway.
    private let priceStep = 0.01

    init(
        request: OrderPlacementRequest,
        defaultQuantity: Int,
        defaultOrderType: OrderType,
        onPriceChange: @escaping (Double) -> Void,
        onPlace: @escaping (OrderSide, Int, OrderType) async -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.request = request
        self.defaultQuantity = defaultQuantity
        self.defaultOrderType = defaultOrderType
        self.onPriceChange = onPriceChange
        self.onPlace = onPlace
        self.onCancel = onCancel
        _quantity = State(initialValue: defaultQuantity)
        _orderType = State(initialValue: defaultOrderType)
    }

    private var accent: Color { side == .buy ? .buyGreen : .sellRed }

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            HStack {
                Text("PLACE ORDER LINE")
                    .font(.chipLabel)
                    .kerning(1.2)
                    .foregroundStyle(Color.appAccent)
                Spacer()
                Button(action: onCancel) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.secondary)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Dismiss")
            }

            levelRow
            contractLine

            HudSegmentedControl(
                options: [
                    .init(OrderSide.buy, "BUY", accent: .buyGreen),
                    .init(OrderSide.sell, "SELL", accent: .sellRed),
                ],
                selection: $side,
                minHeight: 32
            )
            HudSegmentedControl(
                options: [.init(OrderType.mid, "MID"), .init(OrderType.market, "MKT")],
                selection: $orderType,
                minHeight: 32
            )

            quantityRow

            Text(
                "Fires an order when \(request.contract.underlying) reaches "
                    + "\(Format.price(request.price)). Watched by the app — not a "
                    + "broker-side resting order."
            )
            .font(.caption2)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: AppSpacing.sm) {
                cardButton("CANCEL", accent: .hudStroke, action: onCancel)
                cardButton(isSubmitting ? "PLACING…" : "PLACE", accent: accent) {
                    guard !isSubmitting else { return }
                    isSubmitting = true
                    Task {
                        await onPlace(side, quantity, orderType)
                        isSubmitting = false
                    }
                }
                .disabled(isSubmitting)
                .opacity(isSubmitting ? AppOpacity.dimmedAction : 1)
            }
        }
        .padding(AppSpacing.md)
        .frame(width: 260)
        // No glow: this sits over a chart that repaints on every tick, and every
        // glow is an offscreen render pass.
        .hudCard(accent: .hudStroke, glow: false)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Place a chart order")
    }

    private var levelRow: some View {
        HStack(spacing: AppSpacing.sm) {
            Text("LEVEL")
                .font(.chipLabel)
                .foregroundStyle(.secondary)
            TextField(
                "Level",
                value: Binding(get: { request.price }, set: { onPriceChange(rounded($0)) }),
                format: .number.precision(.fractionLength(2))
            )
            .keyboardType(.decimalPad)
            .focused($priceFocused)
            .font(.priceSmall)
            .multilineTextAlignment(.trailing)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, AppSpacing.sm)
            .frame(height: 30)
            .background {
                HudPanelShape(chamfer: 5)
                    .fill(Color.black.opacity(0.35))
                    .overlay {
                        HudPanelShape(chamfer: 5)
                            .strokeBorder(
                                priceFocused ? Color.hudStroke : Color.hudStrokeDim,
                                lineWidth: 1
                            )
                    }
            }
            stepper(
                decrement: { onPriceChange(rounded(request.price - priceStep)) },
                increment: { onPriceChange(rounded(request.price + priceStep)) },
                label: "level"
            )
        }
    }

    private var contractLine: some View {
        Text(
            "\(request.contract.underlying) \(Format.strike(request.contract.strike))"
                + "\(request.contract.optionType == .call ? "C" : "P") · "
                + "\(request.contract.expiration)"
        )
        .font(.priceSmall)
        .foregroundStyle(.secondary)
    }

    private var quantityRow: some View {
        HStack(spacing: AppSpacing.sm) {
            Text("QTY")
                .font(.chipLabel)
                .foregroundStyle(.secondary)
            Text("\(quantity)")
                .font(.priceSmall)
                .monospacedDigit()
                .frame(maxWidth: .infinity, alignment: .trailing)
            stepper(
                decrement: { quantity = max(1, quantity - 1) },
                increment: { quantity = min(1000, quantity + 1) },
                label: "quantity"
            )
        }
    }

    private func stepper(
        decrement: @escaping () -> Void,
        increment: @escaping () -> Void,
        label: String
    ) -> some View {
        HStack(spacing: AppSpacing.xs) {
            stepperButton("minus", label: "Decrease \(label)", action: decrement)
            stepperButton("plus", label: "Increase \(label)", action: increment)
        }
    }

    private func stepperButton(
        _ symbol: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            Haptics.selection()
            action()
        } label: {
            Image(systemName: symbol)
                .font(.caption.weight(.bold))
                .foregroundStyle(Color.appAccent)
                .frame(width: 34, height: 30)
                .background {
                    HudPanelShape(chamfer: 5)
                        .fill(Color.hudStroke.opacity(0.12))
                        .overlay {
                            HudPanelShape(chamfer: 5)
                                .strokeBorder(Color.hudStrokeDim, lineWidth: 1)
                        }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(AppPressStyle())
        .accessibilityLabel(label)
    }

    /// Chamfered at chip scale: `HudActionButtonStyle`'s double frame needs more
    /// height than these 36pt buttons have.
    private func cardButton(
        _ title: String,
        accent: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(.chipLabel)
                .kerning(1)
                .foregroundStyle(accent)
                .frame(maxWidth: .infinity, minHeight: 36)
                .background {
                    HudPanelShape(chamfer: 6)
                        .fill(accent.opacity(0.16))
                        .overlay {
                            HudPanelShape(chamfer: 6)
                                .strokeBorder(accent, lineWidth: 1.2)
                        }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(AppPressStyle())
    }

    private func rounded(_ value: Double) -> Double {
        guard value.isFinite else { return request.price }
        return max(0.01, (value * 100).rounded() / 100)
    }
}
```

**Step 2: Delete the old sheet**

```bash
git rm apps/ios/0dteTrader/Features/Chart/OrderPlacementSheet.swift
```

**Step 3: Build**

```bash
cd apps/ios && xcodegen && xcodebuild build -scheme 0dteTrader -destination 'generic/platform=iOS Simulator'
```

Expected: FAIL — `TradeScreenView.swift` still references `OrderPlacementSheet`. This is why Tasks 7 and 8 are one unit: continue straight into Task 8 and build again there. Do not commit a tree that does not compile.

---

## Task 8: iOS — host the card on the chart

**Files:**

- Modify: `apps/ios/0dteTrader/Features/Chart/ChartView.swift`
- Modify: `apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift`

**Step 1: Give ChartView the card's inputs**

In `ChartView.swift`, replace `var placementPrice: Double?` (line 19) with:

```swift
    /// Open placement request; nil means the guide is idle.
    var placementRequest: OrderPlacementRequest?
    var placementDefaultQuantity: Int = 1
    var placementDefaultOrderType: OrderType = .mid
    var onPlacementPriceChange: (Double) -> Void = { _ in }
    var onPlacementPlace: (OrderSide, Int, OrderType) async -> Void = { _, _, _ in }
    var onPlacementCancel: () -> Void = {}
```

Update the initialiser signature and body to match (replace the `placementPrice` parameter and its assignment with the six above, each with the same defaults).

Change the representable call (line 79) to:

```swift
                    placementPrice: placementRequest?.price,
```

**Step 2: Overlay the card**

In the chart's `ZStack` (line 63), after the `CandleChartRepresentable(...)` call and before `resetButton { ... }`, add:

```swift
                if let request = placementRequest {
                    // Tap-away dismiss, matching the desktop window: this must
                    // never be the thing standing between you and your chart.
                    Color.black.opacity(0.001)
                        .contentShape(Rectangle())
                        .onTapGesture(perform: onPlacementCancel)
                    OrderPlacementCard(
                        request: request,
                        defaultQuantity: placementDefaultQuantity,
                        defaultOrderType: placementDefaultOrderType,
                        onPriceChange: onPlacementPriceChange,
                        onPlace: onPlacementPlace,
                        onCancel: onPlacementCancel
                    )
                    // Centred vertically rather than anchored to the guide: on a
                    // short pane a line-anchored card clips against the top edge,
                    // and a window that half-disappears is worse than one that is
                    // always in the same place.
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
                    .padding(.trailing, AppSpacing.sm)
                    .transition(.opacity)
                }
```

**Step 3: Rewire the trade screen**

In `TradeScreenView.swift`, delete the whole `.sheet(item: $chartTrading.placementRequest) { ... }` block (lines 147–161).

In the `ChartView(...)` call, replace `placementPrice: chartTrading.placementRequest?.price,` (line 477) with:

```swift
            placementRequest: chartTrading.placementRequest,
            placementDefaultQuantity: chartTrading.settings.defaultQuantity,
            placementDefaultOrderType: tradeViewModel.orderType,
            onPlacementPriceChange: { chartTrading.updatePlacementPrice($0) },
            onPlacementPlace: { side, quantity, orderType in
                await chartTrading.placeFromSheet(
                    side: side,
                    quantity: quantity,
                    orderType: orderType
                )
            },
            onPlacementCancel: { chartTrading.dismissPlacement() },
```

**Step 4: Build and test**

```bash
cd apps/ios && xcodegen && xcodebuild build -scheme 0dteTrader -destination 'generic/platform=iOS Simulator'
```

Expected: BUILD SUCCEEDED.

```bash
cd apps/ios && xcodebuild test -scheme 0dteTrader -destination 'platform=iOS Simulator,name=<DEVICE FROM TASK 2>'
```

Expected: all tests pass.

**Step 5: Verify by hand in the simulator**

Launch the app, open the trade screen with chart trading enabled and a contract selected, and confirm:

- A dashed guide with a `+` chip sits at the last price from the moment the chart draws — no press-and-wait.
- Dragging the `+` moves the guide and prints the level; the chart does not pan underneath it.
- Panning or pinching the chart anywhere else still works; the handle only claims its own 44pt square.
- Tapping the `+` opens the HUD card over the chart with the guide still visible.
- The Level field and its `−`/`+` move the dashed guide live; BUY/SELL and MID/MKT are tappable; PLACE turns green for buy and red for sell.
- Tapping outside the card dismisses it and the guide stays where it was.

**Step 6: Commit**

```bash
git add apps/ios/0dteTrader/Features/Chart/OrderPlacementCard.swift apps/ios/0dteTrader/Features/Chart/ChartView.swift apps/ios/0dteTrader/Features/Trade/TradeScreenView.swift && git commit -m "feat(chart-orders): HUD-branded iOS order card replacing the Form sheet"
```

---

## Task 9: Full verification and changelog

**Files:**

- Modify: `CHANGELOG.md` (match the existing entry style — check `git show 6c2b0e4` for the last chart-trading entry)

**Step 1: Run everything**

```bash
npm run lint && npm run format:check && npm run test && npm run build
```

Expected: clean across all workspaces. Fix anything that fails before continuing.

```bash
cd apps/ios && xcodegen && xcodebuild test -scheme 0dteTrader -destination 'platform=iOS Simulator,name=<DEVICE FROM TASK 2>'
```

Expected: BUILD SUCCEEDED, all tests pass.

**Step 2: Confirm the gesture is really gone**

```bash
grep -rn "minimumPressDuration\|LongPress" apps/ios/0dteTrader/Features/Chart/
```

Expected: no results.

```bash
grep -rn "plusPrice\|placementY\|OrderPlacementSheet\|DidArmPlacement" apps/desktop/src apps/ios/0dteTrader
```

Expected: no results.

**Step 3: Diff the two platforms against each other**

Read `OrderLineLayer.tsx`'s guide block and `OrderLineOverlayView.swift`'s `renderPlacementGuide` side by side. They must agree on: when the guide is suppressed, when it re-anchors, what the handle looks like, and what a drag versus a tap does. Anywhere they disagree, one of them is a bug.

**Step 4: Write the changelog entry**

Add an entry covering: the removed 1.5s long-press, the permanent draggable `+` on both platforms, the editable level, and the HUD restyle of the order window.

**Step 5: Commit**

```bash
git add CHANGELOG.md && git commit -m "docs: changelog for the chart placement + handle"
```

---

## Review

Fill this in as you execute:

- [ ] Task 1 — desktop guide geometry + tests
- [ ] Task 2 — iOS guide geometry + tests
- [ ] Task 3 — desktop permanent `+`
- [ ] Task 4 — desktop HUD window
- [ ] Task 5 — iOS long-press removed
- [ ] Task 6 — iOS permanent `+`
- [ ] Task 7 — iOS HUD card
- [ ] Task 8 — iOS wiring
- [ ] Task 9 — full verification

**Notes / deviations:**

_(record anything you had to change from this plan, and why)_
