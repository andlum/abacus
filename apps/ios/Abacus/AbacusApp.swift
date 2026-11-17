import SwiftUI

@main
struct AbacusApp: App {
    @State private var session = Session()

    init() { Theme.apply() }

    var body: some Scene {
        WindowGroup {
            Group {
                if let client = session.client {
                    HomeView(client: client)
                } else {
                    SignInView()
                }
            }
            .environment(session)
            // The asset catalog names AccentColor as the app's accent, but
            // buttons and the text cursor stayed system blue without this.
            .tint(Color("AccentColor"))
        }
    }
}
