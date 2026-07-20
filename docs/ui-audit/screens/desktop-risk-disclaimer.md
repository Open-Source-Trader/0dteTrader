# Screen d2: Risk disclaimer

- **App:** Desktop
- **Location:** `apps/desktop/src/features/auth/RiskDisclaimerView.tsx` (whole file, lines 1–60); supporting: `apps/desktop/src/design/base.css:106-117` (`.button-primary`), `apps/desktop/src/design/tokens.css` (all tokens), `apps/desktop/src/features/auth/AuthStore.ts:41-45` (`acceptDisclaimer`)
- **Visual:** screenshot `docs/ui-audit/shots/01-risk-disclaimer.png` (860×1864 = 430×932 @2x; shows iPhone chrome — status bar/island/home indicator are the desktop phone-frame cosmetic chrome from `base.css:38-56` + `components.css:4-54`)
- **Scores:** Composition 5/10 · Typography 4/10 · Color 4/10 · Density 4/10 · DataViz 10/10 · Motion 2/10 · States 6/10 · Platform 4/10 · A11y 4/10 · Consistency 5/10 → **Overall 48/100**
- **Score justifications:**
  - Composition 5 — clean top-content/bottom-CTA skeleton, but paragraph inset 28px ≠ button inset 24px (`RiskDisclaimerView.tsx:39` vs `:20`), a ~31%-of-viewport dead zone between last paragraph (y≈56%) and CTA (y≈87%), and off-grid `gap: 14`.
  - Typography 4 — legal body copy set at `--fs-footnote` (13px, `tokens.css:51`) with browser-default line-height ~1.2; title scale (28px/700) is the only correct move.
  - Color 4 — body text contrast ~6.3:1 (passes) but primary content is semantically demoted to `--label-secondary`; white on `--app-accent` `#568ff7` measures **3.15:1**, failing WCAG AA 4.5:1 for 17px/600 text.
  - Density 4 — the one screen whose entire job is the disclosure renders it in the smallest, faintest type; hierarchy is inverted (chrome > title > button > content).
  - DataViz 10 — vacuous; no charts/axes/figures on this screen, nothing violates the bar.
  - Motion 2 — zero motion: no entrance, no hover, no `:active` press state, no transition on `.button-primary` (`base.css:106-117` has none).
  - States 6 — scroll overflow handled (`overflowY: auto`, `:34`) and accept is synchronous so no spinner is needed; but no pressed/disabled state and no persistence-failure path (`AuthStore.ts:41-45`).
  - Platform 4 — desktop bar unmet: no `:hover`, no `:focus-visible` ring, scroll region not keyboard-focusable; only `cursor: pointer` (from global `base.css:63`) is right.
  - A11y 4 — 13px legal text, 3.15:1 button label contrast, no focus indicator; native `<h1>`/`<p>`/`<button>` semantics and 50px target height are the saving grace.
  - Consistency 5 — reuses `.button-primary`, `.text-secondary`, `.hide-scrollbar` and font/color tokens, but every layout value is a magic number in inline `style={{}}` (gap 20, paddingTop 32, gap 14, `0 4px`, marginBottom 8) because no spacing tokens exist.

## Findings

### [P1] — Disclosure body copy is 13px footnote in de-emphasized secondary color

- **What/Why:** The screen's _only_ job is getting the user to read a legally material disclosure, yet it is set at `--fs-footnote` (13px, `tokens.css:51`) in `--label-secondary` (`rgba(235,235,245,0.6)`) with browser-default line-height (~1.2 ≈ 15.6px). Violates Typography + Information Density: primary content is styled as tertiary metadata. 13px is 2 sizes below iOS body (17px) and below the 14px practical floor for extended reading.
- **Location:** `apps/desktop/src/features/auth/RiskDisclaimerView.tsx:36-44`
- **Exact fix:** Drop the `text-secondary` class and set explicit type:
  ```tsx
  <div
    style={{
      fontSize: 'var(--fs-subheadline)', // 15px
      lineHeight: 1.47,                  // ~22px, 8pt-friendly rhythm
      color: 'var(--label-primary)',
      padding: 0,                        // see P2 alignment finding
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}
  >
  ```
  If a two-tier hierarchy is wanted, keep paragraph 1 (`RiskDisclaimerView.tsx:4`) at `--label-primary` and paragraphs 2–4 at `--label-secondary` — never all-secondary.

### [P1] — CTA label contrast 3.15:1 fails WCAG AA (needs 4.5:1)

- **What/Why:** `.button-primary` renders `#fff` text on `--app-accent` `#568ff7` = **3.15:1** (relative luminance 0.283 vs 1.0). At 17px/600 the label does _not_ qualify as WCAG "large text" (needs ≥18.66px bold), so 4.5:1 applies. Violates Color&Contrast + Accessibility. This is also the app's conversion-critical first-run CTA.
- **Location:** `apps/desktop/src/design/base.css:106-117` (consumed at `RiskDisclaimerView.tsx:52`)
- **Exact fix:** Use a darker filled-button accent (keeps `--app-accent` for text/icons, which pass on dark bg). In `tokens.css:12` add and apply:
  ```css
  --app-accent-fill: #3a6bd8; /* white text = 4.9:1, passes AA */
  ```
  ```css
  .button-primary {
    background: var(--app-accent-fill);
  }
  ```
  (Verify Login/Register screens — same class — before/after; the change is class-wide.)

### [P1] — Desktop CTA has no hover, focus-visible, or press state

- **What/Why:** `.button-primary` defines no `:hover`, `:active`, or `:focus-visible` rules and no `transition` (`base.css:106-117`); the global reset leaves only `cursor: pointer` (`base.css:63`). On a mouse/keyboard platform this reads as a static bitmap — violates Platform Fidelity + Motion (press feedback should be 120–250ms eased).
- **Location:** `apps/desktop/src/design/base.css:106-121`
- **Exact fix:**
  ```css
  .button-primary {
    transition:
      transform 120ms ease-out,
      filter 120ms ease-out;
  }
  .button-primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .button-primary:active:not(:disabled) {
    transform: scale(0.97);
    filter: brightness(0.92);
  }
  .button-primary:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: 3px;
  }
  @media (prefers-reduced-motion: reduce) {
    .button-primary {
      transition: none;
    }
    .button-primary:active:not(:disabled) {
      transform: none;
    }
  }
  ```

### [P2] — ~31% of the viewport is dead space; content is top-heavy

- **What/Why:** Measured on the screenshot (÷2 for logical pt): last paragraph ends at y≈525 (56% of 932), CTA top sits at y≈815 (87%). The intervening ~290px (31%) is empty background, and there is a further ~56px void between the status bar and the title (`paddingTop: 32` + `gap: 20` + `--pad-screen: 24` = 76px of stacked top space). The composition reads "two islands at opposite edges," not a designed whole — golden-ratio (~62/38) would put the content block's optical center near y≈45%, not y≈35% with a void after it. Violates Composition&Proportion + Density.
- **Location:** `apps/desktop/src/features/auth/RiskDisclaimerView.tsx:13-32`
- **Exact fix:** Vertically center the reading block while keeping the CTA pinned, and drop the stacked top padding:
  ```tsx
  // outer container: keep gap: 20, padding: 'var(--pad-screen)'
  <h1 style={{ fontSize: 'var(--fs-title)', fontWeight: 700, textAlign: 'center' }}>
    Risk Disclosure
  </h1>
  <div
    className="hide-scrollbar"
    style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', alignItems: 'center' }}
  >
    <div style={{ width: '100%', /* paragraph styles from P1 finding */ }}>
  ```
  (`alignItems: 'center'` centers when content underflows; with `minHeight: 0` + `overflowY: 'auto'` it still scrolls correctly when it overflows.)

### [P2] — Off-grid spacing and 4px left/right misalignment between text and CTA

- **What/Why:** (a) `gap: 14` between paragraphs is not on the 4pt grid (14/4 = 3.5); (b) `padding: '0 4px'` insets paragraphs to 24+4 = **28px** while the button sits at **24px** — visible in the screenshot as the text block being 8px narrower than the CTA (text x∈[28,402], button x∈[24,406]); (c) `marginBottom: 8`, `gap: 20`, `paddingTop: 32` are arbitrary per-screen one-offs. Violates Composition (8pt grid, alignment) + Consistency.
- **Location:** `apps/desktop/src/features/auth/RiskDisclaimerView.tsx:19` (gap 20), `:27` (paddingTop 32), `:39` (`0 4px`), `:42` (gap 14), `:53` (marginBottom 8)
- **Exact fix:** Remove the horizontal inset and normalize to the grid: `padding: 0` (delete), `gap: 14` → `gap: 16`, `gap: 20` → `gap: 24`, delete `paddingTop: 32` (superseded by the centering fix above), keep `marginBottom: 8`. Paragraph and button edges then share the 24px screen margin.

### [P2] — All layout values are inline magic numbers; no spacing tokens exist

- **What/Why:** Every geometry value on this screen is an inline `style={{}}` literal (`gap: 20`, `paddingTop: 32`, `gap: 14`, `'0 4px'`, `marginBottom: 8`). `tokens.css` defines colors, font sizes, radii, heights and `--pad-screen` but **zero spacing tokens**, so each screen invents its own rhythm — this is the systemic root of the off-grid values above. Violates Consistency.
- **Location:** `apps/desktop/src/features/auth/RiskDisclaimerView.tsx:14-21, 27, 39-42, 53`; gap in `apps/desktop/src/design/tokens.css:55-66`
- **Exact fix:** Add an 8pt spacing scale to `tokens.css` and use it here verbatim:
  ```css
  /* tokens.css */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  ```
  ```tsx
  gap: 'var(--space-6)',                 // outer container
  gap: 'var(--space-4)',                 // paragraph stack
  style={{ marginBottom: 'var(--space-2)' }} // CTA
  ```

### [P3] — No entrance motion; screen pops in instantly

- **What/Why:** First screen a user ever sees, and it hard-cuts into existence — no fade/rise on the title, body, or CTA. The design bar (Robinhood-grade first-run delight) calls for a 200–250ms eased entrance; the token `--sheet-anim` curve (`tokens.css:64`) exists but nothing uses it here. Violates Motion&Micro-interactions.
- **Location:** `apps/desktop/src/features/auth/RiskDisclaimerView.tsx:12-58`
- **Exact fix:** Add a staggered fade-rise to the outer container:
  ```css
  /* components.css */
  @keyframes disclaimer-in {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  .disclaimer-enter > * {
    animation: disclaimer-in 240ms cubic-bezier(0.32, 0.72, 0, 1) both;
  }
  .disclaimer-enter > *:nth-child(2) {
    animation-delay: 60ms;
  }
  .disclaimer-enter > *:nth-child(3) {
    animation-delay: 120ms;
  }
  @media (prefers-reduced-motion: reduce) {
    .disclaimer-enter > * {
      animation: none;
    }
  }
  ```
  and `className="disclaimer-enter"` on the outer `div` (`RiskDisclaimerView.tsx:13`).

### [P3] — Hidden scrollbar with no scroll affordance

- **What/Why:** `.hide-scrollbar` (`base.css:84-89`) removes the scrollbar and no fade mask, chevron, or "scroll to continue" cue replaces it. If legal copy is ever lengthened (or Dynamic-Type-style scaling lands on desktop), content is silently clipped with zero discoverability. Violates State Coverage + DataViz-style legibility discipline (affordances for overflow).
- **Location:** `apps/desktop/src/features/auth/RiskDisclaimerView.tsx:34`; `apps/desktop/src/design/base.css:84-89`
- **Exact fix:** Add a scroll-fade mask on the scroll container so clipped text visibly fades:
  ```css
  .scroll-fade-y {
    mask-image: linear-gradient(
      to bottom,
      transparent 0,
      #000 24px,
      #000 calc(100% - 24px),
      transparent 100%
    );
  }
  ```
  applied alongside `hide-scrollbar` at `RiskDisclaimerView.tsx:34` (only fade the edge that can actually scroll, if tracking scroll position; otherwise both).

### [P3] — Scroll region is not keyboard-focusable

- **What/Why:** A `div` with `overflowY: 'auto'` and no `tabIndex` cannot receive keyboard focus, so keyboard/screen-reader users cannot scroll the disclosure independently of the single Tab stop (the button). Violates Accessibility (focus order / operability).
- **Location:** `apps/desktop/src/features/auth/RiskDisclaimerView.tsx:34`
- **Exact fix:**
  ```tsx
  <div className="hide-scrollbar" tabIndex={0} role="region" aria-label="Risk disclosure text"
       style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
  ```

### [P3] — React key derived from `paragraph.slice(0, 24)`

- **What/Why:** `key={paragraph.slice(0, 24)}` is collision-prone and breaks the moment legal edits two paragraphs to share a 24-char prefix — silently dropping a disclosure paragraph is a _compliance_ bug, not just a React smell. Violates Consistency/correctness hygiene.
- **Location:** `apps/desktop/src/features/auth/RiskDisclaimerView.tsx:46`
- **Exact fix:** `key={index}` (list is static) — `{DISCLAIMER_PARAGRAPHS.map((paragraph, index) => (<p key={index}>{paragraph}</p>))}`.

## Quick wins vs structural work

**<1 hour:**

- Bump body to `--fs-subheadline` + `lineHeight: 1.47`, `gap: 16`, drop `padding: '0 4px'` (P1 type + P2 grid/alignment in one edit of `RiskDisclaimerView.tsx:36-44`).
- Add `--app-accent-fill: #3a6bd8` and apply to `.button-primary` (contrast fix, 2 lines).
- Add `.button-primary` hover/active/focus-visible rules to `base.css` (~15 lines CSS).
- Remove `paddingTop: 32`, center the scroll block with `display: flex; alignItems: center` (composition fix).
- `key={index}`; `tabIndex={0}` + `role="region"` + `aria-label` on the scroll div.

**Structural:**

- Introduce the `--space-*` 8pt spacing scale in `tokens.css` and migrate all feature components off inline geometry literals (repo-wide; this screen is one consumer).
- Add the `.disclaimer-enter` staggered entrance + global `prefers-reduced-motion` handling (no reduced-motion support exists anywhere in the stylesheet today).
- Scroll-affordance system (`.scroll-fade-y` mask or scroll-position-aware fades) shared by all `hide-scrollbar` containers.
- Audit-wide decision on `--app-accent` vs `--app-accent-fill` so text-accent and fill-accent are separate tokens everywhere (Login/Register share `.button-primary`).
