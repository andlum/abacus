import SwiftUI
import UIKit

// Clementine's colours, the same ones the web app uses (apps/web globals.css).
// Each lives in Assets.xcassets with a light and a dark value: pith and white
// cards by day, the grove green at night. The orange is the accent colour.
extension Color {
    static let pith = Color("Background")
    static let card = Color("Card")
    static let title = Color("Title")
}

/// A List on pith (the grove at night), its rows on cards.
struct CardList<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        List { Group { content }.listRowBackground(Color.card) }
            .scrollContentBackground(.hidden)
            .background(Color.pith)
    }
}

/// A Form on pith (the grove at night), its rows on cards.
struct CardForm<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        Form { Group { content }.listRowBackground(Color.card) }
            .scrollContentBackground(.hidden)
            .background(Color.pith)
    }
}

enum Theme {
    /// Navigation titles in a heavy serif, as the web app sets its headings.
    /// The web uses Fraunces; the phone uses the system serif (New York) so
    /// the app bundles no font files.
    static func apply() {
        let title = UIColor(named: "Title") ?? .label
        let bar = UINavigationBarAppearance()
        bar.configureWithTransparentBackground()
        bar.largeTitleTextAttributes = [.font: serif(34, .black), .foregroundColor: title]
        bar.titleTextAttributes = [.font: serif(17, .bold), .foregroundColor: title]
        let appearance = UINavigationBar.appearance()
        appearance.standardAppearance = bar
        appearance.scrollEdgeAppearance = bar
        appearance.compactAppearance = bar
    }

    private static func serif(_ size: CGFloat, _ weight: UIFont.Weight) -> UIFont {
        let base = UIFont.systemFont(ofSize: size, weight: weight)
        guard let descriptor = base.fontDescriptor.withDesign(.serif) else { return base }
        return UIFont(descriptor: descriptor, size: size)
    }
}
