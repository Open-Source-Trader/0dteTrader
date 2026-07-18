# Screen i16: Drawing overlay (trend lines, rays, boxes, alert lines)

- **App:** iOS
- **Location:** `apps/ios/0dteTrader/Features/Chart/DrawingOverlayView.swift` (canvas, gestures, rendering), `apps/ios/0dteTrader/Features/Chart/ChartDrawings.swift` (model, tools, persistence, alerts), `apps/ios/0dteTrader/Features/Chart/ChartView.swift:176-208` (drawing-tools menu), `apps/ios/0dteTrader/Features/Chart/CandleChartRepresentable.swift:19-40` (overlay hosting)
- **Visual:** UNVERIFIED-VISUAL — no macOS/Xcode available; layout reconstructed from code (CG coordinates, font metrics, padding values)
- **Scores:** Composition 4/10 · Typography 5/10 · Color 6/10 · Density 6/10 · DataViz 5/10 · Motion 2/10 · States 3/10 · Platform 3/10 · A11y 2/10 · Consistency 4/10 → **Overall 40/100**
- **Score justifications:**
  - **Composition 4:** Annotation canvas is layout-free by design, but the toolbar that drives it crams three ~33pt controls into a 12pt-padded header (`ChartView.swift:116-172`), and the only persistent chrome — the price tag — is pinned to the left edge at `x: 4` over the axis gutter (`DrawingOverlayView.swift:339`), fighting the chart's own labels.
  - **Typography 5:** Price tags correctly use `monospacedDigitSystemFont` (tabular figures) — but at a fixed 10pt (`DrawingOverlayView.swift:335`) with no Dynamic Type scaling, and an emoji prefix (`:323`) that ignores the font's metrics and the app's SF-Symbols-only iconography.
  - **Color 6:** Accent `#568FF7` on `#0B0C10` background ≈ 6.2:1 and black tag text on accent ≈ 6.7:1 both pass AA; alerts are orange **and** dashed (not color-only) — but the accent is a hardcoded literal duplicating `AppColors.appAccent`'s dark variant only (`:38`), so light mode gets the wrong blue.
  - **Density 6:** Chrome is admirably minimal — nothing but lines, handles, and tags — but selection affordance (+0.75pt width, two 10pt handles, `:272`,`:345-355`) is too weak to carry the "what is selected?" information load.
  - **DataViz 5:** Anchoring to (time, price) via the chart transformer so shapes track pan/zoom is genuinely excellent; undermined by left-edge price tags that collide with axis labels, a `× 100` ray-extension hack (`:239`,`:302`), no magnet snapping, and persisted invisible zero-length shapes.
  - **Motion 2:** Zero animation anywhere — selection, placement, deletion are all instantaneous; a 30fps `CADisplayLink` (`:64-72`) repaints the whole canvas every frame even when idle, with no reduced-motion handling.
  - **States 3:** No empty-state/hint when a draw tool is armed, no undo, no confirmation on "Clear All Drawings", no feedback when a tap misses; the only designed state is the chart's bare `ProgressView` spinner (`ChartView.swift:44-47`).
  - **Platform 3:** SF Symbols used for tools ✓, but every touch target is far under the 44pt HIG minimum (10pt handles, 20pt line hit band, ~33pt header buttons), and no haptics exist anywhere in the draw/select/drag/alert flow despite a `Haptics` helper being available.
  - **A11y 2:** The canvas is a pure `CGContext` bitmap with zero accessibility elements — drawings, alerts, price tags, and selection are completely invisible to VoiceOver; fixed 10pt font; hit areas ~10–20pt.
  - **Consistency 4:** Accent literal duplicates the design token (`:38` vs `AppColors.swift:53-58`), emoji vs SF Symbols, and 15+ inline magic numbers (5, 10, 1.25, 2, 1.5, [5,4], 0.12, 100, 4/8/2) with no spacing/radius/stroke tokens.

## Findings

### [P1] — Canvas is 100% invisible to VoiceOver: drawings, alerts, prices, selection
- **What/Why:** `DrawingOverlayView` renders everything with `CGContext` and exposes no accessibility elements. A VoiceOver user cannot perceive that annotations exist, where alert lines sit, or what is selected — a core trading feature (price alerts!) is unusable. Violates Accessibility + Platform Fidelity; Apple HIG requires all content-bearing views to be accessible. Hit areas compound it: `handleRadius = 5` → 10pt handles, `hitDistance = 10` → 20pt line band vs the 44×44pt HIG minimum (`DrawingOverlayView.swift:40-41`).
- **Location:** `apps/ios/0dteTrader/Features/Chart/DrawingOverlayView.swift:12` (whole class), `:40-41`
- **Exact fix:** Synthesize one `UIAccessibilityElement` per drawing/alert whenever the model changes, and enlarge hit slop without changing visuals:
  ```swift
  // In DrawingOverlayView, make model a didSet property:
  var model: ChartDrawingsModel? { didSet { rebuildAccessibilityElements() } }

  private func rebuildAccessibilityElements() {
      guard let model else { accessibilityElements = nil; return }
      var elements: [UIAccessibilityElement] = []
      for drawing in model.drawings {
          guard let a = pixel(for: drawing.p1) else { continue }
          let b = drawing.p2.flatMap { pixel(for: $0) } ?? a
          let el = UIAccessibilityElement(accessibilityContainer: self)
          el.accessibilityLabel = "\(drawing.kind.rawValue) at \(Format.price(drawing.p1.price))"
          el.accessibilityTraits = [.button, .adjustable]
          el.accessibilityFrameInContainerSpace = CGRect(
              x: min(a.x, b.x) - 22, y: min(a.y, b.y) - 22,
              width: abs(b.x - a.x) + 44, height: max(abs(b.y - a.y) + 44, 44))
          el.accessibilityHint = "Double-tap to select"
          elements.append(el)
      }
      for alert in model.alerts {
          guard let p = pixel(for: DrawingPoint(time: firstTime, price: alert.price)) else { continue }
          let el = UIAccessibilityElement(accessibilityContainer: self)
          el.accessibilityLabel = "Price alert at \(Format.price(alert.price))"
          el.accessibilityTraits = .button
          el.accessibilityFrameInContainerSpace = CGRect(x: 0, y: p.y - 22, width: bounds.width, height: 44)
          elements.append(el)
      }
      accessibilityElements = elements
  }
  // And bump the constants (visual radius stays 5):
  private let hitDistance: CGFloat = 22          // was 10 → 44pt line band
  // hitTest: hypot(...) <= 22                  // was handleRadius + 5
  ```

### [P1] — "Clear All Drawings" wipes every annotation with one tap, no confirmation, no undo
- **What/Why:** `removeSelectedOrClear()` bound to a `role: .destructive` menu button executes immediately (`ChartView.swift:189-198` → `ChartDrawings.swift:131-141`). One mis-tap destroys a trader's entire annotation set for the symbol, persisted instantly to UserDefaults. Violates State Coverage (destructive actions need a guardrail) — iOS convention (Photos, Notes) is a confirmation dialog for irreversible multi-item deletes.
- **Location:** `apps/ios/0dteTrader/Features/Chart/ChartView.swift:190-197`, `apps/ios/0dteTrader/Features/Chart/ChartDrawings.swift:136-139`
- **Exact fix:** Gate the bulk clear behind a confirmation dialog in `ChartView`:
  ```swift
  @State private var showClearConfirm = false
  // In the Menu, replace the destructive Button action:
  Button(role: .destructive) {
      if drawings.selectedId != nil {
          drawings.removeSelectedOrClear()   // single delete: fine without confirm
      } else {
          showClearConfirm = true
      }
  } label: {
      Label(drawings.selectedId != nil ? "Delete Selection" : "Clear All Drawings",
            systemImage: "trash")
  }
  // Attach to the Menu label:
  .confirmationDialog("Clear all drawings and alerts for this symbol?",
                      isPresented: $showClearConfirm, titleVisibility: .visible) {
      Button("Clear All", role: .destructive) { drawings.removeSelectedOrClear() }
      Button("Cancel", role: .cancel) {}
  }
  ```

### [P1] — Touch targets far below 44pt across the entire flow
- **What/Why:** Selection handles are 10pt circles (`handleRadius = 5`, `DrawingOverlayView.swift:40`), line hit band is 20pt (`hitDistance = 10`, `:41`), and the header's drawing-tool menu / interval chip / settings buttons are all ~33pt or less: `.subheadline` glyph (~15pt) + `padding(8)` ≈ 31pt (`ChartView.swift:200-205`, `:163-168`); interval chip ≈ 12pt text + 12pt vertical padding ≈ 24pt tall (`:151-156`). HIG minimum is 44×44pt; on a trading screen where a missed tap mis-places an order-adjacent annotation, this is a P1.
- **Location:** `apps/ios/0dteTrader/Features/Chart/DrawingOverlayView.swift:40-41`, `apps/ios/0dteTrader/Features/Chart/ChartView.swift:153-156,166,203`
- **Exact fix:** Decouple hit slop from visual size (see fix 1 for canvas). For the header controls, enforce 44pt frames:
  ```swift
  // drawingToolsMenu label and the settings Button label:
  Image(systemName: ...)
      .font(.subheadline)
      .frame(width: 44, height: 44)                 // replaces .padding(8)
      .background(drawings.tool == .cursor ? Color.appSurfaceElevated : Color.appAccent)
      .clipShape(Circle())
  // interval chip:
  Text(viewModel.interval.rawValue)
      .font(.chipLabel)
      .padding(.horizontal, 12)
      .frame(minHeight: 44)                          // replaces .padding(.vertical, 6)
      .background(Color.appSurfaceElevated)
      .clipShape(Capsule())
  ```

### [P1] — Zero-length drawings are persisted as invisible, undeletable junk
- **What/Why:** On `.ended` the draft is committed unconditionally (`DrawingOverlayView.swift:144-149`). A tap-like micro-drag with a trend/ray/rect tool armed stores `p1 == p2`: the ray guard `a != b` (`:301`) means it strokes a zero-length path — nothing renders, but the shape lives in `drawings`, persists to UserDefaults, and can never be selected visually (its only hit area is a 20pt blob at one point). Violates State Coverage / DataViz integrity.
- **Location:** `apps/ios/0dteTrader/Features/Chart/DrawingOverlayView.swift:144-149`
- **Exact fix:** Reject degenerate drafts using pixel distance:
  ```swift
  case .ended:
      if var finished = draft {
          finished.p2 = dataPoint(at: location)
          let a = pixel(for: finished.p1)
          let b = finished.p2.flatMap { pixel(for: $0) }
          let length = (a != nil && b != nil) ? hypot(b!.x - a!.x, b!.y - a!.y) : 0
          if length >= 12 {                       // ~one candle width minimum
              model.add(finished)
          }
      }
      draft = nil
  ```

### [P1] — Arming a draw tool gives zero guidance; taps on empty space silently do nothing
- **What/Why:** Selecting "Trend Line", "Ray", or "Box" from the menu only recolors the header pill (`ChartView.swift:200-204`). Nothing tells the user these tools are drag-placed while Horizontal/Alert are tap-placed (`DrawingOverlayView.swift:115-116` `break // Placed by drag`). In cursor mode, a tap that misses every shape silently sets `selectedId = nil` (`:114`). First-run users will conclude the feature is broken. Violates State Coverage (no designed empty/armed state) — Robinhood/TradingView both show a contextual hint banner.
- **Location:** `apps/ios/0dteTrader/Features/Chart/DrawingOverlayView.swift:107-117`, `apps/ios/0dteTrader/Features/Chart/ChartView.swift:176-208`
- **Exact fix:** Overlay a dismissible hint capsule at the top of the chart in `ChartView.body`'s `ZStack`, driven by the active tool:
  ```swift
  if drawings.tool != .cursor {
      Text(drawings.tool == .trend || drawings.tool == .ray || drawings.tool == .rect
           ? "Drag on the chart to draw"
           : "Tap the chart to place")
          .font(.chipLabel)
          .foregroundStyle(.white)
          .padding(.horizontal, 12).padding(.vertical, 6)
          .background(Color.appAccent, in: Capsule())
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
          .padding(.top, 8)
          .allowsHitTesting(false)
          .transition(.opacity)
          .animation(.easeInOut(duration: 0.2), value: drawings.tool)
  }
  ```

### [P2] — Zero motion design; 30fps CADisplayLink repaints the canvas forever, even idle
- **What/Why:** `didMoveToWindow` starts a 30fps `CADisplayLink` whose `tick` calls `setNeedsDisplay()` unconditionally (`DrawingOverlayView.swift:59-73`) — the full annotation layer is redrawn ~1,800×/min with zero changes, burning battery on a trading screen that runs all session. Meanwhile every state change that *should* be animated (selection, placement, deletion) is instantaneous. No `UIAccessibilityIsReduceMotionEnabled` consideration. Violates Motion & Micro-interactions.
- **Location:** `apps/ios/0dteTrader/Features/Chart/DrawingOverlayView.swift:59-73`
- **Exact fix:** Invalidate only on actual change — model publications and chart transforms:
  ```swift
  // Replace the display link entirely. In DrawingOverlayView:
  private var cancellables: Set<AnyCancellable> = []
  var model: ChartDrawingsModel? {
      didSet {
          cancellables = []
          model?.$drawings.merge(with: model!.$alerts.map { _ in [] })
              .sink { [weak self] _ in self?.setNeedsDisplay() }
              .store(in: &cancellables)
          model?.$selectedId.sink { [weak self] _ in self?.setNeedsDisplay() }.store(in: &cancellables)
          setNeedsDisplay()
      }
  }
  // In ContainerView (CandleChartRepresentable.swift:19-40), forward chart transforms:
  // set chart.delegate = self and implement
  // chartTranslated(_:dX:dY:) { overlay.setNeedsDisplay() }
  ```
  Then animate selection in the model consumer: wrap `model.selectedId = …` mutations with `withAnimation(.spring(response: 0.25, dampingFraction: 0.8))` where surfaced in SwiftUI, and gate any future animated hints behind `withAnimation(UIAccessibilityIsReduceMotionEnabled() ? .none : .easeInOut(duration: 0.2))`.

### [P2] — No haptics anywhere in the draw/select/drag/alert flow
- **What/Why:** `Haptics.swift` ships `selection()`, `impact()`, `success()` and the header uses `Haptics.selection()` for symbol search (`ChartView.swift:118`), but placing a drawing, grabbing a handle, selecting a shape, and an alert firing are all haptically silent. Violates Platform Fidelity — haptic confirmation on placement is exactly the "delight" bar (Robinhood order-submit tick).
- **Location:** `apps/ios/0dteTrader/Features/Chart/DrawingOverlayView.swift:104-204`, `apps/ios/0dteTrader/Features/Chart/ChartViewModel.swift:127-132`
- **Exact fix:**
  ```swift
  // DrawingOverlayView.handlePan, in .ended after model.add(finished):
  Haptics.impact(.light)
  // handleCursorPan .began, after model.selectedId = hit.id:
  Haptics.selection()
  // ChartViewModel.handleLiveQuote, inside the for alert loop after alertNotice is set:
  Haptics.success()
  ```

### [P2] — Accent color hardcoded as a literal, duplicates the design token, and is light-mode-wrong
- **What/Why:** `accentColor = UIColor(red: 0.337, green: 0.561, blue: 0.969)` (`DrawingOverlayView.swift:38`) is byte-identical to `AppColors.appAccent`'s **dark** variant (`AppColors.swift:54-58`) but is not dynamic — light mode (fully supported per the palette's doc comment) renders the dark-mode blue, and the white handle fill (`:350`) disappears against a white chart. Violates Consistency (token bypass) + Color correctness.
- **Location:** `apps/ios/0dteTrader/Features/Chart/DrawingOverlayView.swift:38,350`
- **Exact fix:** Mirror the token's dynamic provider (or expose a `UIColor` companion in `AppColors.swift`):
  ```swift
  private let accentColor = UIColor { traits in
      traits.userInterfaceStyle == .dark
          ? UIColor(red: 0.337, green: 0.561, blue: 0.969, alpha: 1)
          : UIColor(red: 0.192, green: 0.427, blue: 0.878, alpha: 1)
  }
  // renderHandle: replace UIColor.white with a surface-contrasting dynamic fill
  context.setFillColor(UIColor { $0.userInterfaceStyle == .dark
      ? UIColor.white : UIColor(white: 0.11, alpha: 1) }.cgColor)
  ```

### [P2] — Price tags pinned to left edge collide with the y-axis; fixed 10pt ignores Dynamic Type
- **What/Why:** `renderPriceTag` draws the tag background at `x: 4` (`DrawingOverlayView.swift:339`) — directly over the left price axis whose labels are also 10pt monospaced (`CandleChartRepresentable.swift:81-82`), producing overlapping price text at different scales. TradingView pins these tags on the price axis at the line's level. The font is also a fixed `UIFont.monospacedDigitSystemFont(ofSize: 10)` (`:335`) — no Dynamic Type, breaking Accessibility (text-size) and consistency with `AppTypography` (which has no UIKit price-tag token — gap).
- **Location:** `apps/ios/0dteTrader/Features/Chart/DrawingOverlayView.swift:333-343`
- **Exact fix:** Pin to the right edge inside the plot, scale via `UIFontMetrics`, and round the corners:
  ```swift
  let font = UIFontMetrics(forTextStyle: .caption2)
      .scaledFont(for: UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium))
  let attributes: [NSAttributedString.Key: Any] = [
      .font: font, .foregroundColor: UIColor.black,
  ]
  let size = label.size(withAttributes: attributes)
  let background = CGRect(x: bounds.width - size.width - 12,
                          y: y - size.height / 2 - 2,
                          width: size.width + 8, height: size.height + 4)
  let path = UIBezierPath(roundedRect: background, cornerRadius: 4)
  context.setFillColor(color.cgColor)
  context.addPath(path.cgPath); context.fillPath()
  label.draw(at: CGPoint(x: background.minX + 4, y: background.minY + 2), withAttributes: attributes)
  ```

### [P2] — Emoji "⏰" in the alert tag violates the SF Symbols design language and breaks tag metrics
- **What/Why:** `renderPriceTag(..., prefix: "⏰ ", ...)` (`DrawingOverlayView.swift:323`) mixes an emoji — which ignores the monospaced font, renders at platform-dependent metrics, and clashes with the SF-Symbols-only iconography used everywhere else (`ChartDrawings.swift:26-35`). The alert already has a non-color channel (dashed `[5,4]` line) — the emoji adds noise, not meaning. Violates Consistency + Typography.
- **Location:** `apps/ios/0dteTrader/Features/Chart/DrawingOverlayView.swift:323`
- **Exact fix:** Drop the emoji; render the SF Symbol tint-matched to the tag instead:
  ```swift
  // renderAlert: change the call to renderPriceTag(price: price, y: point.y, color: alertColor, in: context)
  // and inside renderPriceTag, prepend a bell glyph when color == alertColor:
  if let bell = UIImage(systemName: "bell.fill")?
      .withConfiguration(UIImage.SymbolConfiguration(pointSize: 8, weight: .bold)) {
      let tinted = bell.withTintColor(.black, renderingMode: .alwaysOriginal)
      tinted.draw(at: CGPoint(x: background.minX + 4,
                              y: background.midY - tinted.size.height / 2))
      label.draw(at: CGPoint(x: background.minX + 6 + tinted.size.width,
                             y: background.minY + 2), withAttributes: attributes)
  }
  // (widen `background` by tinted.size.width + 2 accordingly)
  ```

### [P2] — Selection affordance is a +0.75pt line width and two 10pt dots; no edit/delete surface
- **What/Why:** Selected state = line width 1.25→2 (`DrawingOverlayView.swift:272`) plus two 10pt handles (`:345-355`). There is no color change, no glow, and no floating action bar — to delete a selection the user must open the header menu and find "Delete Selection" (`ChartView.swift:193-195`), two taps away and undiscoverable. TradingView shows a contextual floating toolbar on selection; that is the competitive bar. Violates Density (hierarchy) + Platform.
- **Location:** `apps/ios/0dteTrader/Features/Chart/DrawingOverlayView.swift:270-312`, `apps/ios/0dteTrader/Features/Chart/ChartView.swift:189-198`
- **Exact fix:** Add a SwiftUI contextual bar in `ChartView`'s chart `ZStack`, bottom-aligned, appearing when `drawings.selectedId != nil`:
  ```swift
  if drawings.selectedId != nil {
      HStack(spacing: 16) {
          Button { drawings.removeSelectedOrClear(); Haptics.impact(.light) } label: {
              Image(systemName: "trash").frame(width: 44, height: 44)
          }
          Button { drawings.selectedId = nil } label: {
              Image(systemName: "xmark").frame(width: 44, height: 44)
          }
      }
      .font(.subheadline.weight(.semibold))
      .foregroundStyle(.primary)
      .background(Color.appSurfaceElevated, in: Capsule())
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
      .padding(.bottom, 12)
      .transition(.move(edge: .bottom).combined(with: .opacity))
      .animation(.spring(response: 0.3, dampingFraction: 0.8), value: drawings.selectedId)
  }
  ```

### [P2] — 15+ magic numbers inline; no stroke/radius/alpha tokens
- **What/Why:** `handleRadius: 5`, `hitDistance: 10` (`:40-41`), widths `1.25/2/1/1.5` (`:272,317,353`), dash `[5,4]` (`:318`), rect fill alpha `0.12` (`:290`), ray multiplier `100` (`:239,302`), tag insets `4/8/2` (`:339,342`), hit slop `+5`/`-3` (`:219,222,233`) — every one inline, while the project has zero spacing/radius/stroke tokens (confirmed: `DesignSystem/` contains only colors + typography). Violates Consistency; any future theming pass must grep the canvas.
- **Location:** `apps/ios/0dteTrader/Features/Chart/DrawingOverlayView.swift:38-41,272,290,302,318,335-342,353`
- **Exact fix:** Add a `DesignSystem/AppCanvas.swift` token namespace and reference it:
  ```swift
  /// Drawing-canvas metrics (UIKit; pt values).
  enum AppCanvas {
      static let handleRadius: CGFloat = 5
      static let hitSlop: CGFloat = 22
      static let strokeNormal: CGFloat = 1.25
      static let strokeSelected: CGFloat = 2
      static let strokeAlert: CGFloat = 1
      static let handleRingWidth: CGFloat = 1.5
      static let alertDash: [CGFloat] = [5, 4]
      static let rectFillAlpha: CGFloat = 0.12
      static let tagCornerRadius: CGFloat = 4
      static let tagPaddingH: CGFloat = 4
      static let tagPaddingV: CGFloat = 2
  }
  ```

### [P3] — Ray extension `× 100` produces coordinates tens of thousands of points outside the bounds
- **What/Why:** `end = CGPoint(x: a.x + (b.x - a.x) * 100, y: a.y + (b.y - a.y) * 100)` (`:239,302`) sends the stroke to e.g. 40,000pt — Core Graphics clips it, but extreme offsets invite float-precision artifacts on long rays and make the hit-test segment (`:241`) equally huge, so taps far from the visible ray can "hit" its invisible extension. Violates DataViz discipline.
- **Location:** `apps/ios/0dteTrader/Features/Chart/DrawingOverlayView.swift:239,302`
- **Exact fix:** Extend parametrically only to the bounds edge:
  ```swift
  func rayEnd(from a: CGPoint, through b: CGPoint) -> CGPoint {
      let d = CGPoint(x: b.x - a.x, y: b.y - a.y)
      guard d.x != 0 || d.y != 0 else { return b }
      var t = CGFloat.greatestFiniteMagnitude
      if d.x > 0 { t = min(t, (bounds.width - a.x) / d.x) }
      if d.x < 0 { t = min(t, -a.x / d.x) }
      if d.y > 0 { t = min(t, (bounds.height - a.y) / d.y) }
      if d.y < 0 { t = min(t, -a.y / d.y) }
      return CGPoint(x: a.x + d.x * t, y: a.y + d.y * t)
  }
  // use in both hitTest and render: let end = rayEnd(from: a, through: b)
  ```

### [P3] — No magnet/snap-to-OHLC when placing or dragging anchors
- **What/Why:** `dataPoint(at:)` maps the raw touch pixel straight to (time, price) (`:93-100`). TradingView's magnet mode (snap to open/high/low/close of the nearest candle) is table stakes for precision annotation and is the kind of detail that produces "holy shit". Without it, anchoring a trend line exactly to a wick on a 390pt-wide phone chart is luck. Violates DataViz / "delight" bar.
- **Location:** `apps/ios/0dteTrader/Features/Chart/DrawingOverlayView.swift:93-100`
- **Exact fix:** Snap in `dataPoint(at:)` when within 12pt of a candle OHLC (requires passing candles into the overlay alongside `firstTime`/`intervalSeconds`):
  ```swift
  var candles: [Candle] = []   // set from CandleChartRepresentable.updateUIView
  private func dataPoint(at pixel: CGPoint) -> DrawingPoint {
      // ... existing transform to (time, price) ...
      let index = Int(((time - firstTime) / intervalSeconds).rounded())
      guard candles.indices.contains(index) else { return DrawingPoint(time: time, price: price) }
      let c = candles[index]
      let candidates = [c.open, c.high, c.low, c.close]
      if let nearest = candidates.min(by: { abs($0 - price) < abs($1 - price) }),
         let snappedPixel = self.pixel(for: DrawingPoint(time: time, price: nearest)),
         abs(snappedPixel.y - pixel.y) <= 12 {
          return DrawingPoint(time: time, price: nearest)
      }
      return DrawingPoint(time: time, price: price)
  }
  ```

### [P3] — Fired alerts vanish silently, taking the price level with them
- **What/Why:** `checkAlerts` removes crossed alerts and persists (`ChartDrawings.swift:145-154`); the only trace is a transient `alertNotice` string (`ChartViewModel.swift:127-132`). A trader who set an alert at a key level loses the visual level at the exact moment it becomes relevant. Violates State Coverage (feedback should be persistent, not just ephemeral).
- **Location:** `apps/ios/0dteTrader/Features/Chart/ChartDrawings.swift:145-154`
- **Exact fix:** Keep fired alerts rendered dimmed until dismissed — add `var firedAt: Date?` to `PriceAlert`, set it instead of removing in `checkAlerts`, render fired alerts with `alertColor.withAlphaComponent(0.35)` in `renderAlert`, and let the existing "Delete Selection / Clear All" path remove them. (Structural: touches `Payload` Codable — default `firedAt = nil` on decode for backward compatibility.)

### [P3] — Chart loading state is a bare spinner, not a candle skeleton
- **What/Why:** While candles load, the chart area shows only `ProgressView().tint(.secondary)` (`ChartView.swift:44-47`) over an empty background — a layout-shifting void where the densest screen in the app will appear. A gray candle skeleton preserves layout and sets density expectations (Robinhood/TradingView both skeleton their charts). Violates State Coverage (skeletons > spinners).
- **Location:** `apps/ios/0dteTrader/Features/Chart/ChartView.swift:44-47`
- **Exact fix:** Replace the spinner with a static skeleton drawn into the same `ZStack`:
  ```swift
  if viewModel.isLoading && viewModel.candles.isEmpty {
      HStack(alignment: .bottom, spacing: 3) {
          ForEach(0..<28, id: \.self) { i in
              RoundedRectangle(cornerRadius: 1)
                  .fill(Color.appSurfaceElevated)
                  .frame(width: 6, height: CGFloat([36, 58, 44, 72, 52, 64, 40][i % 7]))
          }
      }
      .padding(.horizontal, 16).padding(.bottom, 24)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
      .redacted(reason: .placeholder)
      .allowsHitTesting(false)
  }
  ```

## Quick wins vs structural work

**Landable in <1 hour:**
- Confirmation dialog on "Clear All Drawings" (fix 2)
- 44pt frames on header tool buttons + interval chip (fix 3, SwiftUI half)
- Reject degenerate zero-length drafts (fix 4)
- Armed-tool hint capsule (fix 5)
- Three haptic calls (fix 7)
- Dynamic accent color + handle fill (fix 8)
- Drop the emoji prefix (fix 10)
- `AppCanvas` token enum + constant swap (fix 13)
- Ray-end clamp to bounds (fix 14)

**Needs refactor / cross-file design:**
- VoiceOver accessibility elements + 22pt canvas hit slop (fix 1 — needs model-observation wiring and AX audit)
- Remove CADisplayLink in favor of change-driven invalidation (fix 6 — needs Combine subscriptions + `ChartViewDelegate` forwarding in `ContainerView`)
- Selection floating action bar (fix 12 — new SwiftUI component + state plumbing)
- Magnet/snap-to-OHLC (fix 15 — overlay needs candle data; touches `CandleChartRepresentable`)
- Fired-alert persistence with `firedAt` (fix 16 — Codable schema change, migration)
- Candle loading skeleton (fix 17 — new component, worth coordinating with other screens' skeletons)
