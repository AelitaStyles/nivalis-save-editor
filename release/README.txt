NIVALIS SAVE EDITOR  v{{VERSION}}  by RenokK
Unofficial savegame editor for Nivalis Nights. Not affiliated with ION LANDS.
Source code: https://github.com/HiveSolution/nivalis-save-editor

WHAT IT DOES
  - Lists your saves with their screenshots, location, in-game day and playtime
  - Edit your money
  - Edit inventories: your own, your venues' storage, fridges and furniture,
    and vendor stock. Add any of 1,300+ items, change quantities and
    freshness, or make all food fresh again
  - Edit relationships (friend, romance, business, enemy) and your venues'
    level and reviews, plus your debt
  - Browse, search and edit the game's story variables (relationship values,
    venue levels, quest flags and more)
  - Compare two saves to see what changed between them, and copy values over
  - Keeps up to 10 backups of every save, with a comparison of what changed
    and one-click restore

HOW TO USE
  1. Close Nivalis Nights. The editor will not save while the game is running.
  2. Run NivalisSaveEditor.exe. No installation needed.
  3. Pick a save on the left, make your changes, then click "Save changes".
  4. Start the game and load that save.

Your saves are found automatically in:
  %USERPROFILE%\AppData\LocalLow\ION LANDS\Nivalis Nights

BACKUPS
Before every change the editor backs up the save. Open the "Backups" tab to
see up to 10 backups per save, compare any of them with the current save, and
restore one with a click. The oldest backup (the save before you first edited
it) is kept permanently. "Back up now" makes an extra backup at any time.
Restoring also backs up the current save first, so it can be undone.

Backups are stored compressed in
  %LOCALAPPDATA%\Nivalis Save Editor\Backups
outside the save folder, so they are not uploaded to Steam Cloud. Backups
made by older versions of the editor are moved there automatically.

GOOD TO KNOW
  - Story variables control quests and dialogue. Changing them can skip or
    break quest steps. Try changes on a copy of a save first if unsure.
  - The in-game clock cannot be edited (it is stored in hundreds of places).
  - Text variables are shown but cannot be edited yet.
  - Added items are free and start fully fresh. Items that need a fridge are
    marked, and you get a warning when adding them to normal storage.
  - Steam Cloud syncs your saves, so an edited save replaces the cloud copy.
  - Works with the current save format (version 151). If a game update changes
    the format, the editor refuses to open those saves instead of damaging them.

REQUIREMENTS
Windows 10 or 11 with Microsoft Edge WebView2 (included in Windows 11 and
most up-to-date Windows 10 PCs). If the window stays blank, install the
"Evergreen WebView2 Runtime" from Microsoft.

WINDOWS SMARTSCREEN
The exe is not code-signed, so Windows may show "Windows protected your PC".
Click "More info" -> "Run anyway".

LICENSE
Copyright (c) 2026 RenokK. Licensed under Creative Commons
Attribution-NonCommercial 4.0 (CC BY-NC 4.0), see LICENSE.txt.
You may share and modify this tool for noncommercial purposes if you credit
RenokK. Commercial use, including selling it or including it in commercial
products, is not permitted.
