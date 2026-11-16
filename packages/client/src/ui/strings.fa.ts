/**
 * Persian (فارسی) strings for every piece of text the player sees.
 *
 * Kept in one file rather than sprinkled through the HUD for three reasons:
 *
 *  1. **One place to proof-read.** UI copies in this codebase used to be inline in
 *     `index.html`, in `GameHud.ts`, and in `Game.ts`'s event formatter — three files to
 *     open to change one label, and no way to see whether the wording was consistent.
 *  2. **One place for RTL decisions.** `dir="rtl"` on `<html>` flips the whole layout,
 *     but individual values (a number, a ship class, a `key` label) must stay LTR or
 *     they render backwards. Anything that must not flip is marked with `LTR` below.
 *  3. **It is a locale, not a translation layer.** There is no i18n runtime and no
 *     language switcher; adding one before there is a second language to switch to
 *     would be scaffolding around a decision nobody has made yet.
 *
 * ## Persian typography notes
 *
 * - Persian uses Persian digits (۰۱۲۳۴۵۶۷۸۹) when a number is read as text, but
 *   **Latin digits for HUD counters** is also normal and is far easier to scan while
 *   playing. Live numbers use Latin digits here, matching the reference art; prose
 *   that reads as a sentence uses Persian digits where it reads more naturally.
 * - The ZWNJ (نیم‌فاصله, U+200C) is used for compound words like «هدف‌گیری», because
 *   without it the two halves read as separate words.
 */

/** A value that must never be reordered by the bidi algorithm. */
const LTR = '\u2066';
const POP = '\u2069';

/** Wrap a value so it renders left-to-right inside an RTL page. */
export function ltr(value: string | number): string {
  return `${LTR}${String(value)}${POP}`;
}

export const FA = {
  /* --- shell ----------------------------------------------------------- */
  gameTitle: 'نبرد کشتی‌ها',
  loading: 'در حال بارگذاری…',

  /* --- connection ------------------------------------------------------ */
  offline: 'قطع',
  connecting: 'در حال اتصال…',
  online: 'متصل',
  reconnecting: 'اتصال مجدد…',
  disconnect: 'ارتباط با سرور قطع شد',

  /* --- vitals ---------------------------------------------------------- */
  hull: 'بدنه',
  level: 'سطح',
  xp: 'تجربه',
  scrap: 'آذوقه',
  points: 'امتیاز',
  shipClass: 'کلاس',
  danger: 'خطر',

  /* --- ship classes ---------------------------------------------------- */
  shipSpeedName: 'سریع',
  shipSpeedDesc: 'تند و شکننده. جثه‌ی کم، بازگذاری سریع، برد کوتاه.',
  shipNormalName: 'متعادل',
  shipNormalDesc: 'همه‌فن‌حریف. انتخاب پیش‌فرض.',
  shipPowerName: 'پرقدرت',
  shipPowerDesc: 'کند و سنگین. برد بلند، بازگذاری کند.',

  /* --- NPC tiers ------------------------------------------------------- */
  tierSmall: 'گشتی',
  tierMedium: 'غارتگر',
  tierLarge: 'رزم‌ناو',

  /* --- zones ----------------------------------------------------------- */
  zoneSafe: 'آب آرام',
  zoneMid: 'آب مورد مناقشه',
  zoneOpen: 'دریای آزاد',

  /* --- upstream labels (kept as short codes) ---------------------------- */
  isNewPlayer: 'تازه‌وارد',
  isProtected: 'محافظت‌شده',

  /* --- upgrades -------------------------------------------------------- */
  levelUp: 'ارتقا',
  levelUpHint: 'یکی از ارتقاها را انتخاب کن.',
  levelUpLater: 'بعداً',
  levelUpChoice: (level: number) => `به سطح ${String(level)} رسیدی`,
  buy: 'خرید',
  owned: 'خریداری‌شده',
  locked: 'قفل',
  cost: 'هزینه',
  rank: 'رتبه',
  noPoints: 'امتیاز کافی نداری',

  upgradeReinforcedHull: 'بدنه‌ی تقویت‌شده',
  upgradeReinforcedHullDesc: 'هر رتبه ۱۰٪ بدنه بیشتر.',
  upgradeArmorPlating: 'ورق زرهی',
  upgradeArmorPlatingDesc: 'هر رتبه ۶ واحد کاهش آسیب.',
  upgradeMarineBoiler: 'دیگ بخار دریایی',
  upgradeMarineBoilerDesc: 'هر رتبه ۸٪ سرعت بیشتر.',
  upgradeSteeringGear: 'فرمان بهبودیافته',
  upgradeSteeringGearDesc: 'هر رتبه ۱۰٪ سرعت چرخش بیشتر.',
  upgradeRapidLoader: 'بارگذار سریع',
  upgradeRapidLoaderDesc: 'هر رتبه ۷٪ بازگذاری کوتاه‌تر.',
  upgradeHeavyShells: 'گلوله‌ی سنگین',
  upgradeHeavyShellsDesc: 'هر رتبه ۱۲٪ آسیب بیشتر.',
  upgradeExtendedRange: 'برد بلندتر',
  upgradeExtendedRangeDesc: 'هر رتبه ۱۰٪ برد بیشتر.',
  upgradeSpotterPlane: 'هواپیمای شناسایی',
  upgradeSpotterPlaneDesc: 'هر رتبه ۱۲٪ برد هدف‌گیری بیشتر.',

  /* --- death ----------------------------------------------------------- */
  hullLost: 'بدنه از دست رفت',
  respawnIn: (seconds: number) => `${String(seconds)} ثانیه تا بازگشت`,
  progressKept: 'پیشرفتت حفظ می‌شود.',
  respawn: 'بازگشت',

  /* --- events ---------------------------------------------------------- */
  evKill: 'کشتی منهدم شد',
  evLevelUp: (level: number) => `ارتقا به سطح ${String(level)}`,
  evDamaged: (amount: number) => `${String(amount)} آسیب به بدنه`,
  evPickup: 'جعبه برداشته شد',
  evJoin: 'کشتی وارد آب شد',
  evLeave: 'کشتی از آب خارج شد',

  /* --- controls footer ------------------------------------------------- */
  ctrlMove: 'جلو / عقب',
  ctrlTurn: 'چرخش',
  ctrlSelect: 'انتخاب هدف',
  ctrlClear: 'لغو هدف',
  ctrlZoom: 'بزرگ‌نمایی',

  /* --- debug ----------------------------------------------------------- */
  debugFps: 'فریم',
  debugEntities: 'موجودیت',
  debugTick: 'تیک',
  debugInput: 'ورودی',
  debugSent: 'ارسالی',
  debugZoom: 'بزرگ‌نمایی',
  debugCamera: 'دوربین',
  debugRenderer: 'رندرر',
} as const;
