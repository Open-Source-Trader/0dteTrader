import SwiftUI

/// TWC bias banner pinned to one of nine chart positions (Pine table analog;
/// TwcBiasBanner in ChartView.tsx is the desktop counterpart).
struct TwcBiasBannerView: View {
    let banner: TwcBanner

    var body: some View {
        VStack {
            if vertical == .bottom { Spacer() }
            if vertical == .middle { Spacer() }
            HStack {
                if horizontal == .trailing { Spacer() }
                if horizontal == .center { Spacer() }
                // Pine renders the banner with a fully transparent
                // background: colored text only.
                Text(banner.text)
                    .font(.system(size: fontSize, weight: .semibold))
                    .foregroundStyle(Color(uiColor: UIColor(twcColor: banner.color)))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 3)
                    .lineLimit(1)
                if horizontal == .leading { Spacer() }
                if horizontal == .center { Spacer() }
            }
            if vertical == .top { Spacer() }
            if vertical == .middle { Spacer() }
        }
        .padding(8)
        .allowsHitTesting(false)
    }

    private enum Vertical { case top, middle, bottom }
    private enum Horizontal { case leading, center, trailing }

    private var vertical: Vertical {
        if banner.position.hasPrefix("Top") { return .top }
        if banner.position.hasPrefix("Middle") { return .middle }
        return .bottom
    }

    private var horizontal: Horizontal {
        if banner.position.hasSuffix("Left") { return .leading }
        if banner.position.hasSuffix("Right") { return .trailing }
        return .center
    }

    private var fontSize: CGFloat {
        switch banner.size {
        case "Small": return 12
        case "Normal": return 14
        case "Large": return 17
        default: return 10
        }
    }
}
