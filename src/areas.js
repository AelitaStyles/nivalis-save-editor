// Scene index stored in the save header -> area name. The index is the numeric prefix of the
// scene files in the game's build settings (Assets/_Scenes/<n>_<Name>.unity), verified in-game.
// Unknown indices fall back to "Area N".
const AREAS = {
  1: 'Lowtown',
  2: 'Meridian Market',
  3: 'Docks',
  4: 'Central Canyon',
  5: 'Oil Rig',
  6: 'Eastern Residential',
  7: 'Sewers',
  8: 'Industrial District',
  9: 'Seaside Boardwalk',
  10: 'Helix Monumental',
  11: 'Hive Mall',
  12: 'SkyHigh Gardens',
  13: 'Stacks',
  14: 'Space Port',
  15: 'Metro Hub',
  16: 'Mountain Town',
  17: 'Calypso Island',
  18: 'Spire',
};

export function areaName(index) {
  return AREAS[index] ?? `Area ${index}`;
}
