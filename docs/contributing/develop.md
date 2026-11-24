# Set up to develop

This guide takes you from a fresh clone to a Mac that can typecheck and test Lifestream, run a home
from the checkout, and build the apps. Read [Architecture](./architecture.md) first if the parts
are new to you.

## Before you start

- A Mac with Apple silicon and macOS 14.2 or later. A release is built for `darwin-arm64`.
- Xcode 27, for the Swift packages and the apps. The check on GitHub uses Xcode 27.0. Open it
  once so it installs its components, then make it the Xcode the command line uses and accept its
  license. Git comes with it.

  ```sh
  sudo xcode-select -s /Applications/Xcode.app
  sudo xcodebuild -license accept
  ```

- [nvm](https://github.com/nvm-sh/nvm), to install Node.
- Google Chrome in `/Applications`, which some tests drive.
- For the iPhone app's check only: `xcodegen` 2.46.0, `rg` (ripgrep) and the iOS 26.0 simulator
  runtime.

## Install Node and the dependencies

1. Clone the repository and open its folder in a terminal. Run every command below from that
   folder.
2. Install the Node version that `.nvmrc` names, 22.23.3. The home refuses the older SQLite that
   older Node builds carry.

   ```sh
   nvm install
   ```

3. Install the dependencies of the packages, the dashboard, the MCP server and the Chrome
   extension. Each has its own lock file.

   ```sh
   for folder in . dashboard mcp extension; do npm ci --prefix "$folder"; done
   ```

4. Install Chrome for Testing, which the tests of the extension and the browser connection load.

   ```sh
   npx --yes playwright@1.61.0 install chromium
   ```

5. Check the types.

   ```sh
   npx tsc --project tsconfig.json --noEmit
   ```

   The typecheck prints nothing when it passes.

6. Install the pre-commit hook. It refuses a commit with conflict markers, a comment
   `tools/check-comments.ts` does not allow, or a broken link in the docs, before the check on
   GitHub would.

   ```sh
   ln -s ../../tools/pre-commit.sh .git/hooks/pre-commit
   ```

## Rules

Every change keeps the rules in [CONTRIBUTING.md](../../CONTRIBUTING.md#if-you-do-send-a-pull-request),
and the check refuses most breaks of them. One rule needs the team: before you change a source's
identity, such as a source id or a connector's kinds and keys, open an issue and wait for an
answer.

## Run the tests

Run the typecheck, and the test files your change reaches: `npx vitest run <file>…` for a test of
the packages, `npm test --prefix dashboard -- test/<file>.mjs` (or `--prefix mcp`) for the
dashboard's and the MCP server's, and `tools/test-lock.sh swift test --package-path <folder>
--filter <Target>` for a Swift package. Every run goes through `tools/test-lock.sh`, which holds a
test slot so that only a few runs share the Mac at once.

Before you hand in a change, run the check once. It runs every test suite your change can reach,
and only those:

```sh
npm run check
```

`npm run check -- --plan` prints the suites it would run, and runs nothing. If your Mac has no
iOS 26.0 simulator runtime, leave the iPhone app's suite out with `npm run check -- --without ios`.

## Run a home from your checkout

A home made this way starts empty, with no devices and no connectors. It is for trying a change to the
home, the door or the dashboard. In each command, `bin/lifestream` runs the `lifestream` command
from your checkout; `bin/lifestream help` lists its verbs.

1. Keep this home's machine files inside the checkout, apart from a home the Mac app runs. Set this
   in every terminal you use for the home. Without it, `bin/lifestream adopt` and `move` refuse
   when this Mac already has a home, so a home from your checkout never takes the place of the
   one the Mac app runs.

   ```sh
   export LIFESTREAM_MACHINE_DIR="$PWD/.build/dev/machine"
   ```

2. Make a home in a new folder.

   ```sh
   bin/lifestream adopt .build/dev/home
   ```

3. If the Mac app already runs a home on this Mac, its door holds ports 4680 and 4682. Give this
   home's door other ports.

   ```sh
   bin/lifestream settings set door.port 4690
   bin/lifestream settings set door.lan_port 4692
   ```

4. Start the home. It runs until you press Ctrl-C.

   ```sh
   bin/lifestream serve
   ```

5. In a second terminal, start the door.

   ```sh
   npx tsx packages/home/door-main.ts serve
   ```

6. In a third terminal, ask the home how it is.

   ```sh
   bin/lifestream status
   ```

7. Start the dashboard with the pass the home wrote for it. If you changed the door's port in
   step 3, also set `LIFESTREAM_DOOR=http://127.0.0.1:4690`.

   ```sh
   VIEWER_STATE_DIR="$LIFESTREAM_MACHINE_DIR/dashboard" npm start --prefix dashboard
   ```

The dashboard prints its address, `http://127.0.0.1:4317`. If the Mac app's dashboard already
holds that port, set `PORT=4318` as well. To add a source or a device to this home, see the verbs
`bin/lifestream help` lists.

## Build the Mac app

The Mac app carries a release of the home, so one build makes both. The build refuses ad hoc
signing, because macOS would ask for every permission again after each build. If you have no
Developer ID, make a signing identity of your own once:

```sh
python3 macos-app/setup-local-signing.py
```

Then build. The build needs the Node of `.nvmrc`, and no changes in the app's Swift, `homelink/` or
`design/swift/`: the app and its release come from one commit.

```sh
bash macos-app/build-app.sh
```

The app is `macos-app/dist/Lifestream.app`. To build it, install it in `~/Applications` and open
it, run `python3 macos-app/install-app.py` instead. Its first run makes a home and starts the home's
programs, as it does for anyone who installs Lifestream. Its tests run from the repository root with
`tools/test-lock.sh swift test --package-path macos-app --filter <Target>`.

## Build the iPhone app

The simulator needs no Apple account. Get the iOS 26.0 simulator once, with
`xcodebuild -downloadPlatform iOS -buildVersion 26.0` or in Xcode › Settings › Components, then open
`ios-app/LifestreamCapture.xcodeproj`, choose the scheme **LifestreamCapture** and an iPhone
simulator, and click Run.

The iPhone app's check builds the app for the simulator, without signing, and runs its tests. It
also needs `xcodegen` 2.46.0 and `rg`:

```sh
ios-app/check.sh
```

The iPhone scripts use the Xcode that `DEVELOPER_DIR` names, else the one `xcode-select -p` names.

Your own iPhone needs iOS 26 or later and an Apple Account. A free one works: choose the scheme
**PersonalTeam**, which leaves out Screen Time, the one part only a paid Apple Developer Program
membership can sign, and build again every 7 days. Write your team ID and a bundle prefix of your
own in `ios-app/Signing/Local.xcconfig`, which git ignores, then Run from Xcode with your iPhone
chosen:

```
DEVELOPMENT_TEAM = ABCDE12345
LIFESTREAM_BUNDLE_PREFIX = io.github.yourusername
```

[The iPhone app's README](../../ios-app/) has every step, and which of
its scripts are the project's own release tools.

## Next

- [Add a connector](../../packages/connect/SKILL.md): bring a new source into the home.
