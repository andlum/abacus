# Clementine for iOS

A SwiftUI app over the `/api/v1` HTTP API. It has no package dependencies.

The project, target and scheme are still named `Abacus`, as are the bundle ID
(`app.abacus.ios`) and the Keychain service, so an installed copy keeps its
token. People see "Clementine": the home-screen name, icon and titles.

What it does today:

- Sign in with a server address and a token.
- Show who owes whom, with the history behind it, and what needs attention on the web.
- List every expense, newest first, loading the next page at the end of the
  list (`GET /expenses`); a month at a time under "By month". Void one with a
  swipe.
- Add an expense, split by the household's rules.

## The server computes every split

The phone never works a split out. While an amount is typed, the add screen
calls `POST /expenses/preview` and shows the server's answer. Saving sends the
same fields to `POST /expenses`.

## Models

`Abacus/Models.swift` is written by hand to match
`apps/web/src/lib/openapi.ts`. `openapi.test.ts` checks that every route's
answer matches that spec, so a change on the server that breaks the phone
shows up as a spec change there first. Generating the models from the spec is
a later step.

## Build and run

Open `Abacus.xcodeproj` in Xcode and run the `Abacus` scheme on a simulator.
Files added under `Abacus/` join the target on their own.

Colours, the app icon and the sign-in mark are in `Abacus/Assets.xcassets`,
with the same values as the web app; `Abacus/Theme.swift` puts them on screen.

From the command line:

```bash
xcodebuild -project apps/ios/Abacus.xcodeproj -scheme Abacus -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/abacus-dd CODE_SIGN_IDENTITY=- build
```

The build must be signed, even ad hoc (`CODE_SIGN_IDENTITY=-`). With
`CODE_SIGNING_ALLOWED=NO` the Keychain refuses to store the token, and sign-in
says so.

A real iPhone needs a development team set under Signing & Capabilities.

## Sign in

1. Run the web app (`pnpm dev` in `apps/web`, or a hosted server).
2. In the web app, open Settings → Devices and make a token. It is shown once.
3. In the phone app, enter the server address and paste the token.

A simulator reaches a server on the Mac at `http://localhost:<port>`.

The token is kept in the Keychain on this device only. The server address is
kept in `UserDefaults`.
