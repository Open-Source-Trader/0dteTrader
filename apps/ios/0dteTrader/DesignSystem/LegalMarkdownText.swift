import Foundation
import SwiftUI

func legalMarkdownAttributedString(_ markdown: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace
    )
    var attributed = (try? AttributedString(markdown: markdown, options: options))
        ?? AttributedString(markdown)
    let unsafeLinkRanges = attributed.runs.compactMap { run -> Range<AttributedString.Index>? in
        guard let link = run.link else { return nil }
        let scheme = link.scheme?.lowercased()
        return scheme == "http" || scheme == "https" ? nil : run.range
    }
    for range in unsafeLinkRanges {
        attributed[range].link = nil
    }
    return attributed
}

struct LegalMarkdownText: View {
    let markdown: String

    var body: some View {
        Text(legalMarkdownAttributedString(markdown))
            .textSelection(.enabled)
    }
}
