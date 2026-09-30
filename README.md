# Nivalis Save Editor

A small desktop editor for **Nivalis Nights** save files (`.sav`), built with Tauri.

- Browse your saves with their screenshots, location, in-game day and playtime
- Edit **money**
- Browse, search and edit the game's **1,800+ story variables** (flags and numbers: relationships, venue levels, quest steps, …)
- **Compare** two saves to see which variables a quest step changed, and copy values across
- Every write makes a backup first (`SaveEditorBackups/` next to your saves), and every edit is verified by re-reading the result before it is written

Saves live in `%USERPROFILE%\AppData\LocalLow\ION LANDS\Nivalis Nights\`. **Close the game before saving.** Steam Cloud syncs this folder, so the edited file becomes the synced version.

Only save version **151** is supported; the editor refuses to open anything else rather than risk corrupting it.

## Development

Requirements: Node 20+, Rust (stable, MSVC toolchain), Visual Studio C++ build tools, WebView2 (built into Windows 10/11).

```sh
npm install
npm test              # parser tests against the sample saves in the parent folder (or NN_SAVE_DIR)
npm run app:dev       # run the app with hot reload
npm run app:portable  # release exe: src-tauri/target/release/nivalis-save-editor.exe
npm run app:build     # NSIS installer in src-tauri/target/release/bundle/nsis/
npm run release       # tests + portable build + release/out/NivalisSaveEditor-v<version>.zip
```

CLI for inspection and scripted edits:

```sh
npm run cli -- info  <save.sav>
npm run cli -- vars  <save.sav> [filter]
npm run cli -- diff  <old.sav> <new.sav>
npm run cli -- check <save.sav>...
npm run cli -- edit  <save.sav> --money 2500.00 --set GameState.Debt=0 -o out.sav
```

## Layout

| Path | Contents |
|---|---|
| `core/` | Save-format parser and editor. Pure JS, no framework imports; runs in Node and in the webview |
| `cli/` | Node command-line tool built on `core/` |
| `test/` | `node:test` suite; round-trips and edits every sample save |
| `src/` | Web UI (vanilla JS + Vite) |
| `src-tauri/` | Rust shell: locate saves, read files, backup + atomic write, game-running check |

## Save format notes (version 151)

Reverse-engineered; the game is an IL2CPP Unity build with a custom `BinaryWriter`-style serializer. Little-endian; strings are 7-bit-length-prefixed UTF-8. No compression, encryption or checksum found.

**Header**

| Offset | Type | Meaning |
|---|---|---|
| 0 | int32 | Save version (151) |
| 4 | int32 | Scene/area index (e.g. 2 = Meridian Market) |
| 8 | float | Playtime in seconds |
| 12 | int32 | Unix timestamp of the save |
| 16 | int32 | In-game clock in seconds (day = value / 86400) |
| 20 | int32 | Money in **cents** (155880 = 1558.80 credits) |
| 24 | int32 + strings | GUID list, followed by more header data up to the string `END_HEADER` |

**Manager sections.** Around 30 sections, each introduced by an uppercase GUID string, without a length prefix. Class names from the game metadata include `PlayerManagerSave`, `InventoriesSave`, `EconomyManagerSave`, `ArticyGlobalVariablesSave`, `SkillLevelsControllerSave`, `TimeOfDayManagerSave`.

**Story variables (articy:draft globals).** Stored **twice**, and the copies must stay identical:

| Section key | int | bool | string |
|---|---|---|---|
| `BD57C1E7-3EAE-4896-A466-73822A382AE4` | 1 | 3 | 4 |
| `53BD367F-1E7D-4886-91D8-D8988CDF96EC` | 3 | 2 | 4 |

Layout: `int32 count`, then for each entry `string name, int32 type, value`. Ints are int32, bools are 1 byte, strings are length-prefixed.

**Ghost blocks (world entities).** `string "Ghost_<guid>"`, `int32 absolute end offset`, payload, `string "Ghost_<guid>"` (closing tag). There are more than 13,000 of them and they are not nested. Any edit that changes the file size must rewrite every end offset after the edit point, which is why the editor currently only makes same-size edits.

**Money.** Stored twice: in the header (offset 20) and as an int32 immediately after the player's Ghost block, which follows the string `Guid_PLAYER_MANAGER_SAVE`.

**In-game time.** The clock value is also stamped into hundreds of world records, so the editor keeps it read-only.

**Not decoded yet.** Inventory contents (`PLAYER_INVENTORY` containers), item names (32-hex asset GUIDs that can be resolved from `resources.assets`), and the player position (floats at the end of the file).

## License

Copyright (c) 2026 RenokK. Licensed under [CC BY-NC 4.0](LICENSE.txt). You may share and modify it for noncommercial purposes with attribution; commercial use, including reselling or bundling it into commercial products, is not permitted.
