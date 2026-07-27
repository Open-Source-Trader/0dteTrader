import SwiftUI

/// One row of a `HudMenu`.
struct HudMenuOption<Value: Hashable>: Identifiable {
    let value: Value
    let title: String
    var systemImage: String?

    var id: Value { value }

    init(_ value: Value, _ title: String, systemImage: String? = nil) {
        self.value = value
        self.title = title
        self.systemImage = systemImage
    }
}

/// The app's dropdown, standing in for SwiftUI's `Menu` wherever the popup
/// itself is part of the interface rather than an afterthought.
///
/// `Menu` cannot be branded. Its label is ours, but the popup is UIKit's own
/// `UIMenu` — system chrome, whose fill, type, corner radius and row metrics
/// are not reachable from SwiftUI at all. Every one of these dropdowns was
/// landing as a grey iOS card in the middle of a HUD.
///
/// It also fixes a defect, which is what made the strike picker the urgent one.
/// SwiftUI rebuilds a `Menu`'s content every time the enclosing body re-runs,
/// and the trade panel's body re-runs on every option-quote tick, because the
/// chain publishes on each. UIKit answers a replaced element set by rebuilding
/// the presented menu, which drops its scroll offset and cancels whatever touch
/// was in flight — so a strike list long enough to need scrolling could not be
/// scrolled, and frequently would not open at all.
///
/// Presented through `HudMenuController` rather than as a `.popover`: see that
/// type for why, and for how presenting from a screen-level slot turns the copy
/// below into belt-and-braces rather than the only thing holding the fix up.
struct HudMenu<Value: Hashable, Label: View>: View {
    /// Identity of this dropdown's slot in the screen's popup layer.
    let id: String
    let options: [HudMenuOption<Value>]
    /// The row that gets the checkmark; nil for a menu with no current value.
    var selection: Value?
    let onSelect: (Value) -> Void
    /// A destructive row under a divider at the foot of the list — the drawing
    /// tools menu's "Clear All", which is not one of the values being chosen
    /// between and must not read like one.
    var destructive: (title: String, action: () -> Void)?
    /// The screen edge the popup lines up with. Its chip's own side: a menu
    /// that opened from the right of the pane and landed on the left has to be
    /// re-found by eye every time.
    var edge: HorizontalEdge = .leading
    @ViewBuilder let label: () -> Label

    var body: some View {
        HudMenuTrigger(id: id, edge: edge, content: { dismiss in
            AnyView(
                HudMenuList(
                    options: options,
                    selection: selection,
                    destructive: destructive.map { entry in
                        (entry.title, { dismiss(); entry.action() })
                    }
                ) { value in
                    dismiss()
                    onSelect(value)
                }
            )
        }, label: label)
    }
}

/// The popup's body: checkmarked rows in the HUD's own type and accent, on the
/// HUD's own chamfered panel.
struct HudMenuList<Value: Hashable>: View {
    let selection: Value?
    let destructive: (title: String, action: () -> Void)?
    let onSelect: (Value) -> Void

    /// The rows as they stood when the popup opened, copied once.
    ///
    /// This copy is the fix described on `HudMenu`, and it is taken here rather
    /// than by the trigger because this is the view whose lifetime is the
    /// popup's: `@State` seeded in `init` is initialised when the popup is
    /// built and survives every update to the list behind it, so a live chain
    /// tick cannot rebuild the rows under a scroll in progress.
    @State private var options: [HudMenuOption<Value>]
    /// Width of the widest row, settled once in `init` for the same reason.
    private let width: CGFloat

    init(
        options: [HudMenuOption<Value>],
        selection: Value?,
        destructive: (title: String, action: () -> Void)?,
        onSelect: @escaping (Value) -> Void
    ) {
        _options = State(initialValue: options)
        self.selection = selection
        self.destructive = destructive
        self.onSelect = onSelect
        self.width = Self.width(
            options: options,
            destructiveTitle: destructive?.title,
            hasIcons: options.contains { $0.systemImage != nil } || destructive != nil
        )
    }

    /// Tall enough for a real touch target, short enough that a dozen strikes
    /// are on screen at once.
    private static var rowHeight: CGFloat { 40 }
    private static var maxVisibleRows: CGFloat { 9 }
    /// Glyph box for a row's leading icon, and for the trailing checkmark.
    private static var iconColumn: CGFloat { 14 + AppSpacing.sm }
    private static var checkColumn: CGFloat { 12 + AppSpacing.sm }
    /// Nothing in the app has a row anywhere near this wide; it is here so a
    /// pathological label cannot push the popup off the screen.
    private static var maximumWidth: CGFloat { 280 }
    private static var minimumWidth: CGFloat { 96 }

    /// The popup's width: the widest row's text, plus that row's own chrome.
    ///
    /// One string is measured, not one per row. Every title is drawn in the
    /// same monospaced face, so the widest row is simply the one with the most
    /// characters — found by comparing integers, which a four-hundred-strike
    /// chain can afford. Only that single winner is handed to the text engine.
    /// Laying the rows out to find the widest would be four hundred layouts on
    /// every open, and the strike list is the one that most needs opening to be
    /// instant.
    private static func width(
        options: [HudMenuOption<Value>],
        destructiveTitle: String?,
        hasIcons: Bool
    ) -> CGFloat {
        var titles = options.map(\.title)
        if let destructiveTitle { titles.append(destructiveTitle) }
        guard let widest = titles.max(by: { $0.count < $1.count }) else { return minimumWidth }

        let base = UIFont.preferredFont(forTextStyle: .subheadline)
        let font = UIFont.monospacedSystemFont(ofSize: base.pointSize, weight: .medium)
        let text = (widest as NSString).size(withAttributes: [.font: font]).width

        // The checkmark's column is reserved on BOTH sides. Reserved on one it
        // would be the title that moved when a row became the selected one;
        // reserved on neither the title would centre on the space left over
        // rather than on the row.
        let chrome = AppSpacing.md * 2 + checkColumn * 2 + (hasIcons ? iconColumn : 0)
        return min(max((text + chrome).rounded(.up), minimumWidth), maximumWidth)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(options) { option in
                        row(option)
                            .id(option.value)
                        separator
                    }
                    if let destructive {
                        Button {
                            Haptics.impact(.light)
                            destructive.action()
                        } label: {
                            rowContent(
                                title: destructive.title,
                                systemImage: "trash",
                                tint: .sellRed,
                                isSelected: false
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .task {
                // Opening a several-hundred-row strike list at the top means
                // scrolling past every out-of-the-money contract to reach the
                // one being traded.
                //
                // After a hop, not in `onAppear`: the rows are lazy, so on the
                // first pass the target usually has not been built and
                // `scrollTo` silently does nothing.
                guard let selection else { return }
                await Task.yield()
                proxy.scrollTo(selection, anchor: .center)
            }
        }
        .frame(
            // Pinned rather than fixed, so the same call can also cap the
            // height: `frame(width:)` and `frame(maxHeight:)` are different
            // overloads and cannot be combined.
            minWidth: width,
            maxWidth: width,
            // A ceiling, not a height: a six-row interval list must not open as
            // a nine-row panel with three rows of nothing under it.
            maxHeight: Self.rowHeight * Swift.min(CGFloat(options.count), Self.maxVisibleRows)
                + (destructive == nil ? 0 : Self.rowHeight)
        )
        .hudMenuPanel()
    }

    private var separator: some View {
        Rectangle()
            .fill(Color.hudStroke.opacity(0.18))
            .frame(height: 1)
    }

    private func row(_ option: HudMenuOption<Value>) -> some View {
        Button {
            Haptics.selection()
            onSelect(option.value)
        } label: {
            rowContent(
                title: option.title,
                systemImage: option.systemImage,
                tint: .primary,
                isSelected: option.value == selection
            )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(option.value == selection ? .isSelected : [])
    }

    /// Title centred on the row; the checkmark laid *over* the trailing end
    /// rather than laid out after the title, so marking a row selected does not
    /// shift the text the eye is scanning down.
    private func rowContent(
        title: String,
        systemImage: String?,
        tint: Color,
        isSelected: Bool
    ) -> some View {
        ZStack {
            HStack(spacing: AppSpacing.sm) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.caption)
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font(.system(.subheadline, design: .monospaced).weight(.medium))
                    .lineLimit(1)
            }
            if isSelected {
                Image(systemName: "checkmark")
                    .font(.caption.weight(.bold))
                    .accessibilityHidden(true)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .foregroundStyle(isSelected ? Color.appAccent : tint)
        .padding(.horizontal, AppSpacing.md)
        .frame(height: Self.rowHeight)
        .frame(maxWidth: .infinity)
        // The row's fill, not just its glyphs, has to answer the tap: a
        // monospaced strike is a narrow target in a wide popup.
        .contentShape(Rectangle())
        .background(isSelected ? Color.appAccent.opacity(0.12) : .clear)
    }
}

extension View {
    /// The panel an anchored popup is drawn on: the HUD's chamfered silhouette,
    /// opaque, clipped so the rows cannot escape the corner cuts.
    ///
    /// This is exactly what a `.popover` could not be given. Drawn inside one it
    /// only put a HUD silhouette inside an iOS one; drawn here it is the only
    /// container on screen.
    func hudMenuPanel() -> some View {
        clipShape(HudPanelShape(chamfer: 8))
            .background {
                HudPanelShape(chamfer: 8)
                    .fill(Color.hudPanel)
                    .overlay {
                        HudPanelShape(chamfer: 8)
                            .strokeBorder(Color.hudStroke.opacity(0.55), lineWidth: 1)
                    }
                    .compositingGroup()
                    .shadow(color: .black.opacity(0.55), radius: 12, y: 6)
            }
    }
}
