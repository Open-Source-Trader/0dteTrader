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
/// scrolled, and frequently would not open at all. Here the rows are copied
/// once, when the popup opens, and no later tick can reach the open popup.
///
/// Presented as a popover rather than drawn in place: the trade panel clips its
/// content and never scrolls, so an inline dropdown would be cut off at the
/// panel's edge.
struct HudMenu<Value: Hashable, Label: View>: View {
    let options: [HudMenuOption<Value>]
    /// The row that gets the checkmark; nil for a menu with no current value.
    var selection: Value?
    let onSelect: (Value) -> Void
    /// A destructive row under a divider at the foot of the list — the drawing
    /// tools menu's "Clear All", which is not one of the values being chosen
    /// between and must not read like one.
    var destructive: (title: String, action: () -> Void)?
    @ViewBuilder let label: () -> Label

    @State private var isPresented = false

    var body: some View {
        Button {
            Haptics.selection()
            isPresented = true
        } label: {
            label()
        }
        .popover(isPresented: $isPresented) {
            HudMenuList(
                options: options,
                selection: selection,
                destructive: destructive.map { entry in
                    (entry.title, { isPresented = false; entry.action() })
                }
            ) { value in
                isPresented = false
                onSelect(value)
            }
            // Without this a popover becomes a sheet on iPhone, which is the
            // wrong weight entirely for picking a strike.
            .presentationCompactAdaptation(.popover)
            // The popover's container is the one part of this that stays
            // system: its rounded rectangle, its arrow and its shadow are not
            // settable, and clearing the background to draw a chamfered panel
            // inside it only puts a HUD silhouette inside an iOS one. Tinting
            // the container instead gives the fill, the arrow and the rows to
            // the HUD and leaves nothing grey on screen.
            .presentationBackground(Color.hudPanel)
        }
    }
}

/// The popup's body: checkmarked rows in the HUD's own type and accent.
private struct HudMenuList<Value: Hashable>: View {
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
    }

    /// Tall enough for a real touch target, short enough that a dozen strikes
    /// are on screen at once.
    private static var rowHeight: CGFloat { 40 }
    private static var maxVisibleRows: CGFloat { 9 }

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
            // Wide enough for the longest row this menu carries anywhere in the
            // app ("Horizontal Line"); a popover sizes to its content, so a
            // floor here is the only thing stopping a title being ellipsed.
            minWidth: 220,
            maxHeight: Self.rowHeight * Swift.min(CGFloat(options.count), Self.maxVisibleRows)
                + (destructive == nil ? 0 : Self.rowHeight)
        )
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

    private func rowContent(
        title: String,
        systemImage: String?,
        tint: Color,
        isSelected: Bool
    ) -> some View {
        HStack(spacing: AppSpacing.sm) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption)
                    .accessibilityHidden(true)
            }
            Text(title)
                .font(.system(.subheadline, design: .monospaced).weight(.medium))
                .lineLimit(1)
            Spacer(minLength: AppSpacing.sm)
            if isSelected {
                Image(systemName: "checkmark")
                    .font(.caption.weight(.bold))
                    .accessibilityHidden(true)
            }
        }
        .foregroundStyle(isSelected ? Color.appAccent : tint)
        .padding(.horizontal, AppSpacing.md)
        .frame(height: Self.rowHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The row's fill, not just its glyphs, has to answer the tap: a
        // monospaced strike is a narrow target in a wide popup.
        .contentShape(Rectangle())
        .background(isSelected ? Color.appAccent.opacity(0.12) : .clear)
    }
}
