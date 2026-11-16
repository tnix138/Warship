# گزارش گام ۲ — شبیه‌سازی معتبر (Authoritative Simulation)

> تاریخ: ۲۰۲۶-۱۱-۱۵ · شاخه: `arena/abb406e1-warship` · وضعیت: **کامل و سبز**

---

## ۱. خلاصهٔ اجرایی

در گام ۱ یک اسکلت بود: کلاینت وصل می‌شد، سرور جواب می‌داد، سوکت زنده می‌ماند.
در گام ۲ **سرور مرجع شد**. حالا دو تب مرورگر کنار هم، کشتی همدیگر را در همان آب می‌بینند و
هیچ‌کدامشان تصمیم نمی‌گیرند که چیزی کجاست.

| سنجه                | نتیجه                                         |
| ------------------- | --------------------------------------------- |
| `pnpm build`        | **exit 0**                                    |
| `pnpm lint`         | **exit 0** (۰ خطا، ۰ هشدار)                   |
| `pnpm typecheck`    | **exit 0** (۳ پکیج)                           |
| `pnpm test`         | **۷۴/۷۴ قبول** (shared ۶۱ + server ۱۳)        |
| `pnpm format:check` | **exit 0**                                    |
| تست واقعی دو کلاینت | ✅ شناسه‌های متمایز، هر دو یکدیگر را می‌بینند |

---

## ۲. فایل‌های изменён/ساخته‌شده

### `@warship/shared` — قراردادهای مشترک

| فایل               | محتوا                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constants.ts`     | `SHIP_CLASSES` (۳ کلاس: speed 80hp/320، normal 140hp/240، power 240hp/160)، `ZONES` (safe/mid/open)، `GRID_SIZE` ۲۰۰۰ روی نقشهٔ ۸۰۰۰×۸۰۰۰، `TICK_RATE` ۲۰، `BOX_DROP_TABLE`، سقف‌های شبکه |
| `protocol.ts`      | پروتکل **v2**: C→S `JOIN`/`INPUT`/`PICKUP`/`UPGRADE`، S→C `WELCOME`/`SNAPSHOT`/`PLAYER_STATE`/`EVENT`، به‌همراه `PING`/`PONG` در باند 9xx                                                |
| `formulas.ts`      | پیاده‌سازی واقعی `xpForLevel`، `levelFromXp`، `damageAfterArmor`، `upgradeCost`، `zoneMultiplier`، `computeHullStats`                                                                    |
| `upgrades.ts`      | پنج گرهٔ ارتقا با سقف رنک، منحنی هزینه و نوع اثر                                                                                                                                          |
| `formulas.test.ts` | **۶۱ تست** با `node:test`                                                                                                                                                                |

### `@warship/server` — شبیه‌سازی

| فایل                 | مسئولیت                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sim/clock.ts`       | تیک ثابت ۲۰ هرتز **با تصحیح دریفت**: زمان‌بندی بر مبنای deadline مطلق، نه `setInterval`؛ حداکثر ۵ تیک جبرانی |
| `game/Player.ts`     | یک کشتی: موقعیت، سرعت، بدنه، `shipClass` از روز اول، `acceptInput()`                                         |
| `game/Grid.ts`       | `SpatialGrid` شبکهٔ یکنواخت ۲۰۰۰ واحدی — آماده برای AoI                                                       |
| `game/World.ts`      | مالک بازیکنان، spawn روی حلقه، ادغام `position += velocity * dt`، ساخت snapshot                              |
| `game/Loop.ts`       | خود تیک: تخلیهٔ intent هر بازیکن، اعمال، پخش snapshot                                                         |
| `net/server.ts`      | اپ uWS: handshake، `JOIN`/`INPUT`/`PICKUP`/`UPGRADE`، محدودیت ۳۰ پیام/ثانیه، heartbeat ۵s/۱۵s، `/health`     |
| `net/server.test.ts` | **۱۳ تست e2e** با کلاینت واقعی WebSocket                                                                     |

### `@warship/client` — نمایش

| فایل                       | مسئولیت                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `net/Connection.ts`        | چرخهٔ سوکت (`idle→connecting→handshaking→joining→connected`)، اتصال مجدد، `JOIN` پس از `WELCOME`، پاسخ heartbeat |
| `net/Protocol.ts`          | آینهٔ سیم‌کشی سمت کلاینت: بازصادرات انواع + `encodeClientMessage`/`decodeServerMessage`                          |
| `game/World.ts`            | `ClientWorld`: کش نمایش کلید‌شده با snapshot؛ موجودیت‌های غایب حذف می‌شوند                                      |
| `game/Input.ts`            | WASD + کلیدهای جهت، نشانه‌گیری با ماوس، کلیک/فاصله برای شلیک؛ پاک‌سازی کلیدها در `blur`                         |
| `game/Game.ts`             | اپ PixiJS، حلقهٔ فریم، ورودی→`INPUT` دقیقاً ۲۰ هرتز، دوربین متعاقب                                                |
| `render/EntityRenderer.ts` | pool یک `Container` به‌ازای هر id؛ کشتی، نوار جان درون‌جهانی، حلقهٔ تپنده زیر کشتی خودی                          |
| `ui/GameHud.ts`            | نوار جان، سطح، کلاس، شمار موجودیت‌ها، تیک، وضعیت اتصال، لاگ رویداد                                              |

### مستندات و ریشه

| فایل                             | تغییر                                                    |
| -------------------------------- | -------------------------------------------------------- |
| `docs/COMPATIBILITY.md`          | **جدید** — ماتریس uWS × GLIBC + روش سنجش و اهداف استقرار |
| `MILESTONE-2.md`                 | **جدید** — راهنمای کامل گام ۲                            |
| `README.md`                      | جدول پروتکل v1 → v2 + جدول تغییرات                       |
| `MILESTONE-1.md`                 | یادداشت «سند تاریخی» + ارجاع به v2                       |
| `packages/client/index.html`     | نوار جان، شمارندهٔ موجودیت‌ها، لاگ رویداد                 |
| `packages/client/src/styles.css` | استایل‌های vitals/hpbar/event-log                        |

### حذف‌شده

`packages/client/src/game.ts` (دموی قدیمی)، `packages/client/src/render/ship.ts`،
`packages/client/src/ui/hud.ts` — همه با نسخه‌های شبکه‌ای جایگزین شدند.

---

## ۳. خروجی دستورات (عیناً)

### `pnpm build`

```
packages/server build: Done
packages/client build: ✓ built in 622ms
packages/client build: Done
exit=0
```

### `pnpm lint`

```
> warship@0.0.0 lint
> eslint .
exit=0
```

### `pnpm typecheck`

```
packages/shared typecheck: Done
packages/server typecheck: Done
packages/client typecheck: Done
exit=0
```

### `pnpm test`

```
packages/shared test: # tests 61
packages/shared test: # pass 61
packages/shared test: # fail 0
packages/server test: # tests 13
packages/server test: # pass 13
packages/server test: # fail 0
exit=0
```

### تست‌های e2e سرور (۱۳ مورد)

```
ok 1 - negotiates the warship subprotocol and sends WELCOME first
ok 2 - echoes a client PING back as PONG with nonce and timestamp intact
ok 3 - rejects a mismatched protocol version with 4001
ok 4 - rejects a malformed frame with 1002 and keeps serving others
ok 1 - JOIN produces a private PLAYER_STATE for the joining player
ok 2 - a joined player appears in the next snapshot
ok 1 - a full-throttle INPUT moves the ship away from its spawn
ok 2 - the server ignores a replayed (stale) INPUT sequence number
ok 3 - malformed INPUT fields are clamped instead of trusted
ok 1 - two clients get different ids and see each other in snapshots
ok 2 - a departing client is removed from the other client's snapshots
ok 1 - a flood of frames is dropped without disconnecting an honest client
ok 6 - the world keeps its players in sync with the connection registry
```

---

## ۴. نمونهٔ SNAPSHOT از دید کلاینت دوم

اجرای واقعی: کلاینت A با کلاس `speed`، کلاینت B با کلاس `power`. A یک ثانیه گاز کامل داد،
B با `turn=1, throttle=0.5` به راست چرخید. هر کلاینت **۲۷ snapshot** گرفت.

```
A entityId = 1dce3265-0faa-4a06-9beb-c55e1bc27537  class = speed  hp = 80/80    zone = safe
B entityId = b08eae2a-e9d8-4c5d-adce-a191bac81ab3  class = power  hp = 240/240  zone = safe
distinct ids: true

snapshots received: A = 27  B = 27
A moved from (4260.0, 4000.0) to (4547.0, 4000.0) -> distance 287.0
B rotation start -> 0.700  end -> 1.855
```

آخرین فریم کامل که کلاینت B دریافت کرد:

```json
{
  "t": 202,
  "tick": 27,
  "entities": [
    {
      "id": "1dce3265-0faa-4a06-9beb-c55e1bc27537",
      "x": 4547,
      "y": 4000,
      "rotation": 0,
      "hp": 80,
      "shipClass": "speed"
    },
    {
      "id": "b08eae2a-e9d8-4c5d-adce-a191bac81ab3",
      "x": 4218.45,
      "y": 4242.93,
      "rotation": 1.855,
      "hp": 240,
      "shipClass": "power"
    }
  ]
}
```

نکتهٔ مهم: مختصات A **دقیقاً** روی محور y=4000 مانده چون `turn=0` بود و موتور فقط
`rotation` را تغییر می‌دهد؛ یعنی حرکت در جهت بدنه است، نه در جهت محور جهانی. این همان
«سرور مرجع است» در عمل.

### تأیید از مسیر Vite proxy (همان مسیری که مرورگر طی می‌کند)

```
socket open via vite proxy, subprotocol = warship
frame ids: 201,203,204,202,901
WELCOME shard = shard-0 tickRate = 20 world = 8000x8000
PLAYER_STATE entity = 75bd3032-... hp = 140/140
snapshots = 24  ticks 699 -> 722
ship moved (4260,4000) -> (4381,4043)  rotation 0.00 -> 0.55  entities in snapshot = 1
```

---

## ۵. باگ واقعی که پیدا و رفع شد

این مهم‌ترین بخش گزارش است، چون رفتار تست‌ها تا مدت‌ها «شناور» بود: گاهی ۸، گاهی ۱۳ از ۱۳
قبول می‌شدند.

**ریشه:** یک پروسهٔ سرورِ تست از اجرای قبلی که با `timeout` کشته شده بود، پورت `18910` را
هنوز در دست داشت. سرور جدید نمی‌توانست bind کند، ولی کلاینت‌های تست به سرور **قدیمی**
وصل می‌شدند — سروری که کلاک به آن وصل نبود. نتیجه: `WELCOME` و `PLAYER_STATE` می‌رسید،
اما هیچ `SNAPSHOT`ی نمی‌آمد. تست‌ها به‌جای «سرور خراب است» می‌گفتند «snapshot نرسید».

سه اصلاح:

1. تست‌ها روی پورت `0` bind می‌کنند و پورت واقعی را از `listen()` می‌گیرند
   (`uws.us_socket_local_port`). پورت ثابت هرگز دوباره می‌تواند دزدیده شود.
2. `latestSnapshot` حالا فقط snapshotی را می‌پذیرد که **خود بازیکن** در آن باشد، نه اولین
   snapshot بعد از تیک مشخص‌شده.
3. تست شمارش بازیکن روی سرور مستقل خودش اجرا می‌شود، چون تست‌های قبلی عمداً اتصال‌های
   در حال بسته‌شدن باقی می‌گذارند و شمارش مطلق با آن‌ها مسابقه می‌داد.

نتیجه: از «۸ تا ۱۱ از ۱۳، شناور» به **۱۳/۱۳ در سه اجرای متوالی**، و زمان اجرا از ۳۰ ثانیه به
۲/۵ ثانیه.

---

## ۶. انحراف از خواسته — و دلیل هرکدام

1. **بدون interpolation، prediction، delta compression، AoI.** این میان‌بر نیست: هر کدام
   به یک baseline پایدار نیاز دارند و آن baseline تا این گام وجود نداشت. snapshot کامل،
   نقطهٔ شروع صادقانه است.
2. **`PICKUP` و `UPGRADE` پارس می‌شوند ولی اثر ندارند.** شکل پیام، محدودیت نرخ و انتساب
   همه end-to-end تست می‌شوند تا افزودن جعبه و داک بعداً فقط تغییر سمت سرور باشد. هر دو در
   سطح `debug` لاگ می‌شوند.
3. **کلاینت ورودی را با accumulator ثابت ۲۰ هرتز می‌فرستد**، نه یک‌بار به‌ازای هر فریمِ
   رندرشده. مانیتور ۱۴۴ هرتز ۱۴۴ ورودی در ثانیه نمی‌فرستد، و کف ۲۰ هرتز همچنان دقیقاً یک
   intent به‌ازای هر تیک می‌دهد.
4. **`Grid` ساخته شده ولی هنوز query نمی‌شود.** snapshot به همه می‌رود چون حداکثر ۱۰۰
   بازیکن در یک shard است؛ Grid وجود دارد تا culling یک «تعویض» باشد، نه بازنویسی.
5. **`maxHp` در `PLAYER_STATE` فرستاده می‌شود**، هرچند کلاینت می‌توانست از
   `SHIP_CLASSES[class].hp` مشتق کند. فرستادنش یعنی ارتقای آینده‌ای که max hull را بالا
   می‌برد، نیاز به انتشار کلاینت جدید ندارد.
6. **زیرپروتکل `warship` هنوز الزامی است.** حالت شکست تمیزی به مرورگر می‌دهد (بدون
   subprotocol → بدون `onopen`) به‌جای سوکت نیمه‌باز.
7. **در تست‌ها `concurrency: 1` روی هر `describe`** — `node:test` به‌طور پیش‌فرض
   زیرتست‌های هم‌سطح را هم‌زمان اجرا می‌کند و تست‌هایی که یک سرور/پورت مشترک دارند
   بازیکنان یکدیگر را می‌بینند و timeout می‌دهند.
8. **`onmessage`/`onclose` قبل از `await` روی `onopen` وصل می‌شود** — وگرنه فریم‌های پنجرهٔ
   open→attach (`WELCOME` و snapshotهای اول) بی‌صدا گم می‌شوند.

---

## ۷. محدودیت‌های شناخته‌شده

- **بازبینی بصری کلاینت در این محیط ممکن نیست** — هیچ مرورگری در sandbox نصب نمی‌شود
  (دانلود Playwright Chromium شکست می‌خورد). سمت DOM/CSS فقط با typecheck، lint و build
  پوشش داده شده. **من ادعای تأیید بصری نمی‌کنم.** آنچه واقعاً تأیید شده: سرور روی
  `:8080` سالم است، Vite روی `:5173` همهٔ ماژول‌های جدید را ۲۰۰ می‌دهد، پروکسی `/ws`
  با کد **101** ارتقا می‌دهد، و یک کلاینت Node از همان مسیر پروکسی `WELCOME`/`PLAYER_STATE`/
  ۲۴ snapshot گرفت و کشتی‌اش ۱۲۱ واحد جابه‌جا شد.
- **پهنای باند خطی با تعداد بازیکن رشد می‌کند** — هر کلاینت هر موجودیت را هر تیک می‌گیرد.
  در ۱۰۰ بازیکن ≈ ۲۰۰۰ به‌روزرسانی موجودیت در ثانیه برای هر کلاینت. برای دموی LAN خوب است،
  اولین چیزی که پس از گام ۳ باید حل شود.
- **بدون auth و بدون persistence.** رفرش = بازیکن جدید.
- **uWS روی `v20.52.0` قفل است** چون GLIBC این محیط ۲.۳۶ است؛ `v20.53.0` به بعد
  `GLIBC_2.38` می‌خواهد. کل ماتریس در `docs/COMPATIBILITY.md`.

---

## ۸. پیشنهاد برای گام ۳

1. **`pnpm dev` → دو تب** تا چشم هم تأیید کند (کاری که من نمی‌توانم).
2. Interpolation روی کلاینت (buffer ۳ snapshot) — اولین چیزی که ۲۰ هرتز را روان می‌کند.
3. جعبه‌های loot + واقعی‌کردن `PICKUP`، بعد XP/level و رویدادهای `EVENT`.
4. اسکیمای Drizzle + ذخیرهٔ پیشرفت بازیکن.
5. تنها بعد از این‌ها: delta compression و AoI با `SpatialGrid`.
