/**
 * Upgrade definitions and the tech tree.
 *
 * Data-only: the *shape* of an upgrade lives here so the server can validate a
 * purchase and the client can render the dock UI from one source of truth. The
 * maths (what a rank costs, what it does) lives in `formulas.ts`.
 */

/* -------------------------------------------------------------------------- */
/*  Ship stats                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Effective stats of a ship, after ship class and purchased upgrades.
 * `ShipClassDefinition` in `constants.ts` is the *base*; this is the *result*.
 */
export interface ShipStats {
  readonly maxHp: number;
  readonly maxSpeed: number;
  readonly turnRate: number;
  readonly radius: number;
  readonly damage: number;
  readonly armor: number;
  readonly range: number;
  readonly reloadTime: number;
  /**
   * Shots per second the weapon is *allowed* to sustain.
   *
   * Distinct from `1 / reloadTime`: reload is how fast the gun can cycle, fireRate is
   * the trigger discipline on top of it. The server fires automatically now, so this is
   * the knob that keeps an auto-trigger from being strictly better than a human one.
   */
  readonly fireRate: number;
}

/* -------------------------------------------------------------------------- */
/*  Upgrade categories & stats                                                */
/* -------------------------------------------------------------------------- */

/** Which subsystem an upgrade belongs to. Used for grouping in the dock UI. */
export const UpgradeCategory = {
  Hull: 'hull',
  Engine: 'engine',
  Weapon: 'weapon',
  Utility: 'utility',
} as const;

export type UpgradeCategory = (typeof UpgradeCategory)[keyof typeof UpgradeCategory];

/** Every stat an upgrade is allowed to modify. Keys match `HullDefinition` fields. */
export const UpgradeStat = {
  Hp: 'hp',
  MaxSpeed: 'maxSpeed',
  TurnRate: 'turnRate',
  Reload: 'reload',
  Damage: 'damage',
  Range: 'range',
  Armor: 'armor',
} as const;

export type UpgradeStat = (typeof UpgradeStat)[keyof typeof UpgradeStat];

/** How a single upgrade changes its target stat. */
export type UpgradeEffect =
  | { readonly kind: 'flat'; readonly amount: number }
  | { readonly kind: 'percent'; readonly factor: number }
  | { readonly kind: 'unlock'; readonly flag: string };

/** Definition of a purchasable upgrade node in the tech tree. */
export interface UpgradeDefinition {
  readonly id: UpgradeId;
  readonly category: UpgradeCategory;
  readonly displayName: string;
  /** Short line shown under the name in the dock. */
  readonly description: string;
  /** Currency cost. MVP has a single soft currency ("scrap"). */
  readonly cost: number;
  /** Ranks the node can be bought up to; each rank multiplies `cost` by `costGrowth`. */
  readonly maxRank: number;
  readonly costGrowth: number;
  /** Which stat this node touches, if any (utility nodes may only unlock a flag). */
  readonly stat: UpgradeStat | null;
  /** Effect applied per rank. */
  readonly effect: UpgradeEffect;
  /** Nodes that must be owned before this one can be bought. */
  readonly requires: readonly UpgradeId[];
}

/* -------------------------------------------------------------------------- */
/*  Upgrade ids                                                               */
/* -------------------------------------------------------------------------- */

/** String ids of every upgrade in the MVP tech tree. */
export const UpgradeId = {
  ReinforcedHull: 'reinforced-hull',
  ArmorPlating: 'armor-plating',
  MarineBoiler: 'marine-boiler',
  SteeringGear: 'steering-gear',
  RapidLoader: 'rapid-loader',
  HeavyShells: 'heavy-shells',
  ExtendedRange: 'extended-range',
  SpotterPlane: 'spotter-plane',
} as const;

export type UpgradeId = (typeof UpgradeId)[keyof typeof UpgradeId];

/* -------------------------------------------------------------------------- */
/*  The MVP tech tree                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Upgrades the MVP actually offers: speed, damage, hull.
 *
 * The rest of the tree — armour, turn rate, reload, range, the spotter plane — is kept
 * and still correct; it is simply not offered. Three one-line upgrades are enough to
 * prove "kill things, get stronger, kill bigger things", and a picker with three
 * mutually exclusive choices is far easier to reason about while the game is still
 * being made playable. Widening this list is the only change needed to restore the
 * full tree.
 */
export const MVP_UPGRADE_IDS: readonly UpgradeId[] = [
  UpgradeId.ReinforcedHull,
  UpgradeId.MarineBoiler,
  UpgradeId.HeavyShells,
];

export const UPGRADES: Readonly<Record<UpgradeId, UpgradeDefinition>> = {
  [UpgradeId.ReinforcedHull]: {
    id: UpgradeId.ReinforcedHull,
    category: UpgradeCategory.Hull,
    displayName: 'Reinforced Hull',
    description: '+10% hull points per rank.',
    cost: 120,
    maxRank: 5,
    costGrowth: 1.35,
    stat: UpgradeStat.Hp,
    effect: { kind: 'percent', factor: 0.1 },
    requires: [],
  },
  [UpgradeId.ArmorPlating]: {
    id: UpgradeId.ArmorPlating,
    category: UpgradeCategory.Hull,
    displayName: 'Armor Plating',
    description: '+6 flat damage reduction per rank.',
    cost: 200,
    maxRank: 3,
    costGrowth: 1.5,
    stat: UpgradeStat.Armor,
    effect: { kind: 'flat', amount: 6 },
    requires: [UpgradeId.ReinforcedHull],
  },
  [UpgradeId.MarineBoiler]: {
    id: UpgradeId.MarineBoiler,
    category: UpgradeCategory.Engine,
    displayName: 'Marine Boiler',
    description: '+8% top speed per rank.',
    cost: 140,
    maxRank: 4,
    costGrowth: 1.4,
    stat: UpgradeStat.MaxSpeed,
    effect: { kind: 'percent', factor: 0.08 },
    requires: [],
  },
  [UpgradeId.SteeringGear]: {
    id: UpgradeId.SteeringGear,
    category: UpgradeCategory.Engine,
    displayName: 'Steering Gear',
    description: '+10% turn rate per rank.',
    cost: 110,
    maxRank: 3,
    costGrowth: 1.3,
    stat: UpgradeStat.TurnRate,
    effect: { kind: 'percent', factor: 0.1 },
    requires: [],
  },
  [UpgradeId.RapidLoader]: {
    id: UpgradeId.RapidLoader,
    category: UpgradeCategory.Weapon,
    displayName: 'Rapid Loader',
    description: '-7% reload time per rank.',
    cost: 180,
    maxRank: 4,
    costGrowth: 1.45,
    stat: UpgradeStat.Reload,
    effect: { kind: 'percent', factor: -0.07 },
    requires: [],
  },
  [UpgradeId.HeavyShells]: {
    id: UpgradeId.HeavyShells,
    category: UpgradeCategory.Weapon,
    displayName: 'Heavy Shells',
    description: '+12% weapon damage per rank.',
    cost: 240,
    maxRank: 3,
    costGrowth: 1.55,
    stat: UpgradeStat.Damage,
    effect: { kind: 'percent', factor: 0.12 },
    /* Ungated for the MVP: its old requirement (`Rapid Loader`) is no longer offered,
       so leaving the gate would make the damage upgrade unreachable forever. */
    requires: [],
  },
  [UpgradeId.ExtendedRange]: {
    id: UpgradeId.ExtendedRange,
    category: UpgradeCategory.Weapon,
    displayName: 'Extended Range',
    description: '+10% firing range per rank.',
    cost: 160,
    maxRank: 3,
    costGrowth: 1.4,
    stat: UpgradeStat.Range,
    effect: { kind: 'percent', factor: 0.1 },
    requires: [],
  },
  [UpgradeId.SpotterPlane]: {
    id: UpgradeId.SpotterPlane,
    category: UpgradeCategory.Utility,
    displayName: 'Spotter Plane',
    description: 'Unlocks the minimap ping ability.',
    cost: 300,
    maxRank: 1,
    costGrowth: 1,
    stat: null,
    effect: { kind: 'unlock', flag: 'ability.spotter-ping' },
    requires: [UpgradeId.ExtendedRange],
  },
} as const;

/** Every upgrade id in tech-tree order, convenient for UI iteration. */
export const UPGRADE_ORDER: readonly UpgradeId[] = [
  UpgradeId.ReinforcedHull,
  UpgradeId.ArmorPlating,
  UpgradeId.MarineBoiler,
  UpgradeId.SteeringGear,
  UpgradeId.RapidLoader,
  UpgradeId.HeavyShells,
  UpgradeId.ExtendedRange,
  UpgradeId.SpotterPlane,
] as const;

/** The purchased state of one node, as stored per player. */
export interface OwnedUpgrade {
  readonly id: UpgradeId;
  readonly rank: number;
}
