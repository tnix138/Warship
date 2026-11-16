# گزارش گام ۳ — interpolation + prediction + AoI + delta compression

> تاریخ: ۲۰۲۶-۱۱-۱۵ · شاخه: `arena/abb406e1-warship` · وضعیت: **کامل و سبز**

---

## بخش اول — تأیید/اصلاح چهار مورد درخواستی

### ۱. مهاجرت `HullClass` ← `ShipClass` — ✅ تأیید شد

| مورد                                                                               | وضعیت                                                                               |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `assets.ts` از `ShipClass` استفاده می‌کند                                          | ✅ (نه `HullClass`)                                                                 |
| `computeShipStats` پیاده شده                                                       | ✅ — **اصلاح شد**: قبلاً `computeHullStats` بود                                      |
| `shipClass` در `Player`، `SnapshotEntity`، `PlayerStateMessage` از نوع `ShipClass` | ✅                                                                                  |
| نگاشت اسپرایت‌ها                                                                   | ✅ speed←`ship-scout.png`، normal←`ship-destroyer.png`، power←`ship-battleship.png` |
| هیچ reference به `HullClass` یا `HULLS`                                            | ✅ `grep` روی کل `packages/*/src` → **NONE FOUND**                                  |

**یک اصلاح لازم بود:** تابع و نوع هنوز `computeHullStats`/`HullStats` نام داشتند.
تغییر نام دادم به `computeShipStats`/`ShipStats` تا با `ShipClass` هم‌خوان باشد.
الان `grep -rn "HullStats\|computeHullStats"` روی سورس → **چیزی پیدا نمی‌شود**.

```bash
$ grep -rn "HullClass\|HULLS\b" packages/*/src
(خروجی: خالی)
```

### ۲. Rate limit از ۳۰ به ۴۰ — ✅ انجام شد

`NETWORK_MAX_MESSAGES_PER_SECOND = 40` با بودجهٔ مستند: INPUT 20Hz + heartbeat 1/s +
جهش‌های PICKUP/UPGRADE. تست rate-limit هم از ثابت مشتق می‌شود، نه عدد سخت‌کدشده —
پس با تغییر بودجه، تست خودش هماهنگ می‌ماند.

### ۳. `NETWORK_MAX_PAYLOAD_BYTES` به ۱۶KB — ✅ انجام شد، با یک تصحیح

**نکته‌ی مهم که پرسیدید:** این ثابت به `maxPayloadLength` در uWS داده می‌شود که
**فقط inbound** را محدود می‌کند. uWS هیچ سقفی روی چیزی که سرور _می‌فرستد_ ندارد. پس
فرض شما درست بود: جا برای inbound آینده (reconnect که snapshot آپلود کند) دارد.

```ts
// فقط inbound: uWS maxPayloadLength
maxPayloadLength: NETWORK_MAX_PAYLOAD_BYTES,   // 16 KiB
```

یک snapshot کامل ۱۰۰ موجودیتی ~۷KB است، پس ۱۶KB با حاشیهٔ راحت هم Churn را رد
می‌کند و هم زباله را زود می‌بندد.

### ۴. `PLAYER_STATE` فوراً در join — ✅ تأیید شد (با اندازه‌گیری)

`sendPlayerState` بلافاصله بعد از ساخت بازیکن صدا زده می‌شود (`server.ts:360`).
برای اینکه مطمئن شوم این یک «شانس تایمینگ» نیست، کلاینت را **عمداً روی تیکی که مضرب ۵
نیست** join کردم:

```
tick at join            : 1 | not a multiple of 5: true
frames                  : 201,203,204,202,...
PLAYER_STATE arrival    : 10ms  tick=1
first SNAPSHOT arrival  : 31ms  tick=2
=> PLAYER_STATE before any SNAPSHOT : true
=> a 5-tick wait would be 250ms; actual: 10ms
```

یعنی **۱۰ میلی‌ثانیه**، در تیک ۱، قبل از هر snapshot. (فاصلهٔ ۵ تیک = ۲۵۰ms بود.)

---

## بخش دوم — گام ۳

### ۱. Client-side interpolation — `packages/client/src/net/Interpolation.ts`

سرور ۲۰Hz تیک می‌زند، صفحه ۶۰–۱۴۴Hz رفرش می‌شود. رسم مستقیم آخرین snapshot باعث
پرش ۱۲ واحدی می‌شود. راه‌حل: **در گذشته رندر کن** — ۱۰۰ms (دو تیک) عقب، و بین دو
snapshotای که آن لحظه را احاطه کرده‌اند blend کن.

- **چرخش** با `angleDelta` blend می‌شود: چرخش از 3.0 به -3.0 رادیان قوس کوتاه را
  می‌رود، نه یک دور کامل به عقب.
- **زمان‌ها receive-time محلی هستند**، نه ساعت سرور — کلاینتی که ساعتش دقیقه‌ها
  اختلاف دارد باز درست interpolate می‌کند.
- موجودیت‌های رفته **fade** می‌شوند (۱۸۰ms)، نه pop.
- بافر سقف ۳۲ فریم دارد.

### ۲. Client-side prediction — `packages/client/src/game/Prediction.ts`

ورودی خودت را **همان لحظه** اعمال می‌کند، با `stepMotion` — **همان تابعی که سرور
اجرا می‌کند**، import شده از `@warship/shared`. پس هرگز نمی‌توانند از هم جدا شوند.

```
pending = [i1, i2, i3, i4]
on snapshot:
   drop هر input با seq <= ackSeq     // ackSeq روی موجودیت خودت سوار است
   position = server position         // اقتدار را باور کن
   replay بقیهٔ inputها               // حرکت روان بماند
```

خطای بیشتر از ۶۴ واحد → **snap** (نه ease؛ ease کردن خطای بزرگ مثل کش لاستیکی است).
دامنه: **فقط movement + rotation**، نه combat.

### ۳. AoI server-side — `packages/server/src/game/AoI.ts`

شعاع ۳۰۰۰ واحد. دو نکته که باگ‌ها آنجا زندگی می‌کنند:

1. **شعاع، نه همسایگی.** 3000/2000 = 1.5 سلول، پس کشتی نزدیک گوشهٔ سلول **دو**
   سلول دورتر را می‌بیند. کد `gridCellsInRadius` را می‌پیماید نه یک بلوک ۳×۳.
   (روی شبکهٔ ۴×۴ دنیا، شعاع ۳۰۰۰ در واقع همهٔ ۱۶ سلول را لمس می‌کند — دقیقاً به
   همین دلیل culling باید با فاصلهٔ واقعی باشد نه عضویت در سلول.)
2. **دیده‌شدن یک تفاضل مجموعه است.** کلاینت فقط اگر _به او گفته شود_ می‌فهمد چیزی
   رفته. هر بازیکن مجموعهٔ idهایی که تیک قبل به او گفته شده را نگه می‌دارد؛ هرچه از
   آن بیرون برود یک `removed` صریح می‌شود.

فاصله **toroidal** است: (10, 4000) و (7990, 4000) فقط ۲۰ واحد دورند، نه ۷۹۸۰.

### ۴. Delta compression — `packages/server/src/game/Loop.ts`

`SNAPSHOT` حالا `full: boolean` دارد:

- **`full`** — فریم اول هر session + **یک keyframe در ثانیه** (تا هر desync حداکثر
  ۱ ثانیه عمر کند).
- **`delta`** — فقط موجودیت‌هایی که position/rotation/hp عوض کرده‌اند + `removed`.
  کشتی‌ای که فقط جابه‌جا شده `shipClass` را نمی‌فرستد.
- **هیچ فریمی** وقتی هیچ چیز عوض نشده — کشتی ساکن در آب خالی صفر بایت است.

---

## بخش سوم — نتایج اندازه‌گیری‌شده

### Bandwidth — ۲۰ بازیکن، ۲ ثانیه با 20Hz

نصف بازیکنان در حرکت، پخش‌شده روی نقشه (صحنهٔ واقعی، نه worst case).

|                                        | کل بایت   | به‌ازای هر کلاینت      |
| -------------------------------------- | --------- | ---------------------- |
| **قبل** (full snapshot به همه، هر تیک) | ۱٬۵۵۰٬۴۰۰ | 6056 kbit/s            |
| **بعد** (AoI + delta + keyframe 1Hz)   | ۴۷۲٬۵۸۰   | 1846 kbit/s            |
| **کاهش**                               | **۶۹٫۵٪** | **۳٫۲۸ برابر کوچک‌تر** |

میانگین فریم delta: **۵۰۳ بایت**. (هدف شما ≥۵۰٪ بود — به ۶۹٫۵٪ رسید.)

### یک فریم با ۱۰ موجودیت در دید، ۴ در حرکت

|                                              | بایت      |
| -------------------------------------------- | --------- |
| قبل (full، ۱۰ رکورد، `shipClass` روی هرکدام) | ۱٬۰۲۰     |
| بعد (delta، ۴ رکورد، بدون `shipClass`)       | ۳۹۶       |
| **کاهش**                                     | **۶۱٫۲٪** |

### نمونهٔ واقعی از خروجی `state` (کلاینت واقعی، سرور زنده)

```
── t+3.0s ─────────────────────────────────
  tick            2452
  self            6f803ab6  normal
  position        (3893.2, 4519.7)
  rotation        -2.574 rad  (turn rate 1.7 rad/s)
  hull            140/140
  entities in view 2  (AoI radius 3000)
     · e4905d0f power   (4834, 4000) hp 240
  snapshots       4 full, 56 delta
  bandwidth       15.3 KiB in 3.0s  (40.8 kbit/s)
  avg delta size  261 bytes
  events          join
```

### AoI — ۲۰ بازیکن شبیه‌سازی‌شده

بیننده **۱۱ از ۲۰** را می‌بیند: خودش + ۱۰ نزدیک، و **هیچ‌کدام** از ۹ بازیکن بیرون
شعاع. تست هر دو جهت را assert می‌کند.

### e2e دو کلاینت دور از هم — ✅

```
ok 10 - Area of Interest
  ✓ two players far apart never see each other      (5657 واحد، بیرون شعاع ۳۰۰۰)
  ✓ two players close together do see each other    (۴۰۰ واحد)
  ✓ a ship leaving the radius is removed from the other client
```

---

## بخش چهارم — خروجی `pnpm build && pnpm lint && pnpm typecheck && pnpm test`

```
########## build ##########
exit=0
packages/client build: ✓ built in 613ms
packages/client build: Done

########## lint ##########
exit=0

########## typecheck ##########
exit=0
packages/shared typecheck: Done
packages/server typecheck: Done
packages/client typecheck: Done

########## test ##########
exit=0
packages/shared test: # tests 61
packages/shared test: # pass 61
packages/shared test: # fail 0
packages/client test: # tests 10
packages/client test: # pass 10
packages/client test: # fail 0
packages/server test: # tests 31
packages/server test: # pass 31
packages/server test: # fail 0
```

**مجموع: ۱۰۲ تست، همه قبول.** (`format:check` هم exit 0.)

---

## بخش پنجم — فایل‌های جدید/تغییرکرده

### جدید

| فایل                                            | نقش                                 |
| ----------------------------------------------- | ----------------------------------- |
| `packages/client/src/net/Interpolation.ts`      | بافر snapshot، blend با delay ۱۰۰ms |
| `packages/client/src/net/Interpolation.test.ts` | **۱۰ تست**                          |
| `packages/client/src/game/Prediction.ts`        | prediction + reconciliation         |
| `packages/server/src/game/AoI.ts`               | culling + ردیابی visible/removed    |
| `packages/server/src/game/AoI.test.ts`          | **۱۵ تست**                          |
| `packages/server/src/tools/state.ts`            | کلاینت headless برای بازبینی state  |
| `MILESTONE-3.md`                                | مستند کامل گام ۳                    |

### تغییرکرده

- `packages/shared/src/protocol.ts` — `full`، `removed[]`، `ackSeq`، `shipClass?`
- `packages/shared/src/constants.ts` — `AOI_INTEREST_RADIUS`، `SNAPSHOT_KEYFRAME_INTERVAL_TICKS`، rate limit ۴۰، payload ۱۶KB، `PROTOCOL_VERSION` → ۳
- `packages/shared/src/upgrades.ts` + `formulas.ts` — `ShipStats`/`computeShipStats`
- `packages/server/src/game/{Loop,World,Grid}.ts` — snapshot per-viewer، `resetAoiMemory`، `idsInCells`، spawn override
- `packages/server/src/net/server.test.ts` — `materialise()`، ۳ تست AoI e2e
- `packages/client/src/game/{Game,World}.ts` — روزنهٔ delta-aware، اتصال prediction/interpolation
- `packages/client/src/render/EntityRenderer.ts` — می‌گیرد لیست pose با alpha
- `packages/client/src/ui/GameHud.ts` + `index.html` — buffer/pending/corrections
- `README.md` — بخش Milestone 3

---

## بخش ششم — نکات مهم و انحرافات

1. **پروتکل v2 → v3.** شکل snapshot عوض شد و **بی‌صدا** خراب می‌شد: کلاینت v2 یک
   delta را full می‌خواند و هر موجودیتی که در آن نبود را حذف می‌کرد. پس نسخه بالا
   رفت تا کلاینت قدیمی در handshake با `4001` رد شود، نه اینکه دیدش خراب شود.

2. **تست‌ها مجبور شدند عوض شوند.** هر تستی که یک فریم را می‌خواند و نتیجه
   می‌گرفت «این موجودیت رفته» تحت delta غلط بود. حالا suite دقیقاً مثل کلاینت واقعی
   state را بازسازی می‌کند (`materialise()`) — که تست بهتری هم هست.

3. **تست AoI اولش به‌خاطر هندسه fail شد، نه کد.** دو بازیکن را در (1000,1000) و
   (7000,7000) گذاشتم و انتظار داشتم دور باشند. **روی torus فاصله‌شان ۲۸۲۸ است** —
   داخل شعاع. بیشترین فاصلهٔ ممکن روی torus 8000×8000 فقط **۵۶۵۷** است، پس تست به
   antipode واقعی تغییر کرد: (2000,2000) vs (6000,6000).

4. **شعاع AoI (۳۰۰۰) بزرگ‌تر از `GRID_SIZE` (۲۰۰۰) است.** عمدی است: برد سلاح
   (حداکثر ۱۱۰۰) همیشه داخل شعاع دید است، پس هر کشتی که می‌توانی بزنی را می‌توانی
   ببینی.

5. **بدون bit-packing.** delta فقط «full یا partial» است، همان‌طور که خواستید.

---

## بخش هفتم — محدودیت‌ها

- **بازبینی بصری ممکن نیست** (مرورگر در sandbox نیست). همان‌طور که خواستید
  **اسکرین‌شات نگرفتم**؛ به جایش `packages/server/src/tools/state.ts` را نوشتم.
- AoI از نقطهٔ مرکز کشتی استفاده می‌کند (in یا out کامل). با شعاع ۳۰ واحد در دید
  ۳۰۰۰ واحدی، در عمل هرگز مسئله نمی‌شود.
- Prediction شلیک را پیش‌بینی نمی‌کند — عمدی.
- تأخیر interpolation ثابت ۱۰۰ms است؛ delay تطبیقی بر اساس jitter اندازه‌گیری‌شده
  بهتر است.

---

## برای تأیید بصری شما

```bash
pnpm dev
# در ترمینال دوم:
pnpm --filter @warship/server run state -- --watch --seconds 10
```

در HUD انتظار داشته باشید:

- `buffer` بین ۲ تا ۵
- `pending` بین ۰ تا ۲ در حال حرکت
- `corrections` روی `0` (یا `0 (max 0.0u)`)
- حرکت کشتی روان، بدون جهش هر تیک
