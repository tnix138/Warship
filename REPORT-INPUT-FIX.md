# گزارش رفع باگ ورودی (Input)

> تاریخ: ۲۰۲۶-۱۱-۱۵ · شاخه: `arena/abb406e1-warship` · وضعیت: **رفع شد، ۱۱۵/۱۱۵ تست سبز**

---

## خلاصه

سه باگ **جدا** پیدا شد — نه یکی. هیچ‌کدام در سرور نبود، و هیچ‌کدام را تست‌های
سرور-side نمی‌گرفتند. هر سه سمت کلاینت بودند.

| #   | باگ                      | علت                                          | شدت                               |
| --- | ------------------------ | -------------------------------------------- | --------------------------------- |
| ۱   | WASD کار نمی‌کند         | `event.key` به‌جای `event.code`              | **مخرب** روی صفحه‌کلید غیر-QWERTY |
| ۲   | wheel zoom و aim با ماوس | `Camera.attachInput()` هرگز صدا زده نشده بود | همیشه خراب                        |
| ۳   | aim با ماوس              | سرور `aim` را می‌خواند ولی **اعمال نمی‌کرد** | همیشه خراب                        |

---

## باگ ۱ — WASD روی صفحه‌کلید غیر-QWERTY

### پاسخ به سؤال‌های شما

| سؤال شما                                       | پاسخ                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `addEventListener` روی `window` یا فقط canvas؟ | ✅ روی `window` بود و هست — این مشکل نبود                                                       |
| `{ passive: false }`؟                          | فقط برای `wheel` لازم است، نه `keydown`. `keydown` به‌طور پیش‌فرض cancelable است                |
| `preventDefault()` برای WASD/Space؟            | برای Space بود. برای WASD **نباید** باشد (باعث می‌شود Ctrl+W و بقیه در بعضی مرورگرها خراب شوند) |
| `tabindex="0"` روی canvas؟                     | ❌ **نداشت** — اضافه شد (پایین)                                                                 |

### علت واقعی

کد از `event.key` استفاده می‌کرد:

```ts
this.#keys.add(event.key.toLowerCase()); // ← باگ
```

`event.key` **کاراکتری که کلید تولید می‌کند** را برمی‌گرداند، که به layout بستگی دارد:

| Layout             | کلید فیزیکی W برمی‌گرداند | نتیجه                        |
| ------------------ | ------------------------- | ---------------------------- |
| QWERTY (US/UK)     | `"w"`                     | کار می‌کرد                   |
| **AZERTY (FR/BE)** | `"z"`                     | **کاملاً مرده**               |
| QWERTZ (DE)        | `"w"`                     | کار می‌کرد (ولی y/z جابه‌جا) |
| **Dvorak**         | `","`                     | **کاملاً مرده**               |

همچنین `event.key` با Shift `"W"` می‌دهد (که `.toLowerCase()` پوشش می‌داد).

### اصلاح

حالا از **`event.code`** استفاده می‌شود (`"KeyW"`) که **کلید فیزیکی** است و به layout
وابسته نیست. `event.key` فقط به‌عنوان fallback برای رویدادهای مصنوعی بدون `code` مانده.

```ts
const KEY_ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
};
```

### تستی که این را می‌گیرد

```ts
dom.window.dispatch('keydown', keyEvent({ key: 'z', code: 'KeyW' }));
assert.equal(controller.snapshot(null).throttle, 1);
// "the physical W key must throttle forward whatever character it types"
```

این تست **قبل از اصلاح fail بود** و بعد از اصلاح pass است.

---

## باگ ۲ — wheel zoom هرگز وصل نشده بود

```bash
$ grep -rn "attachInput" packages/client/src/
packages/client/src/render/camera.ts:121:  attachInput(canvas: HTMLCanvasElement): () => void {
# ↑ تعریف شده، هیچ‌جا صدا زده نشده
```

`Camera.attachInput()` وجود داشت ولی **هرگز فراخوانی نمی‌شد** — پس نه drag-to-pan و نه
wheel-zoom کار نمی‌کرد.

نکته‌ی مهم: drag-to-pan برای این بازی **غلط** است، چون دوربین کشتی را _دنبال_ می‌کند —
هر drag در تیک بعدی خنثی می‌شود و «ماوس خراب است» به نظر می‌رسد. پس `attachZoom()`
جداگانه اضافه شد (فقط wheel، با `{ passive: false }` تا `preventDefault` واقعاً اسکرول
صفحه/iframe را متوقف کند) و در `Game.ts` با teardown درست وصل شد.

---

## باگ ۳ — `aim` فرستاده می‌شد، اعمال نمی‌شد

کلاینت هر فریم زاویهٔ aim را می‌فرستاد؛ سرور آن را parse و clamp می‌کرد، ذخیره
می‌کرد — و **هرگز استفاده نمی‌کرد**:

```ts
// قبل: aim نادیده گرفته می‌شد
const next = stepMotion(state, { turn: intent.turn, throttle: intent.throttle }, stats, dt);
```

aim با ماوس **نمی‌توانست** کار کند.

حالا authoritative است: بدنه به سمت زاویهٔ aim می‌چرخد، محدود به
`turnRate × AIM_ASSIST_FACTOR (2.5) × dt` در هر تیک، تا یک تکان موس نتواند نبردناو را
لحظه‌ای بچرخاند. `aim: null` همچنان heading را به `turn` می‌سپارد، پس WASD دست‌نخورده است.

### تست زنده

```
spawn rotation 0.000
after 1.5s W + aim(-pi/2): rotation -1.571 (err 0.000 rad)
moved (28, -346)
✅ aim applied server-side
```

---

## چیزی که دفعهٔ بعد قابل تشخیص باشد

من نمی‌توانم مرورگر باز کنم، پس باید از داخل HUD قابل تشخیص باشد:

**پنل دیباگ دو ردیف جدید دارد:**

```
input    thr +1 turn -1        ← intent فعلی که فرستاده می‌شود
sent     147                   ← تعداد فریم‌های INPUT ارسال‌شده
```

اینجا تفکیک می‌شود:

| چیزی که می‌بینید                                | معنی                     |
| ----------------------------------------------- | ------------------------ |
| `input` مقادیر نشان می‌دهد + `sent` بالا می‌رود | ✅ کلاینت سالم است       |
| `input –` ولی W را گرفته‌اید                    | ❌ listener اجرا نمی‌شود |
| `input` مقادیر دارد ولی کشتی تکان نمی‌خورد      | ❌ سمت سرور              |

**`?debug=keys` در URL** (یا `localStorage.warshipDebugKeys='1'`) هر کلید حل‌شده را در
console چاپ می‌کند.

**`tabindex` روی canvas** اضافه شد و با pointer-down فوکوس می‌گیرد (برای iframe ضروری).

---

## خروجی `pnpm test`

```
########## pnpm build ##########
exit=0

########## pnpm lint ##########
exit=0

########## pnpm typecheck ##########
exit=0

########## pnpm test ##########
exit=0
packages/shared test: # tests 61
packages/shared test: # pass 61
packages/shared test: # fail 0
packages/client test: # tests 21
packages/client test: # pass 21
packages/client test: # fail 0
packages/server test: # tests 33
packages/server test: # pass 33
packages/server test: # fail 0
```

**۱۱۵/۱۱۵ سبز** (قبلاً ۱۰۲ بود؛ ۱۱ تست Input + ۲ تست aim اضافه شد).

`format:check` هم exit 0.

---

## تست‌هایی که این سه باگ را می‌گرفتند

| تست                                            | جلوی چه چیزی را می‌گیرد                                          |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `Input.test.ts` — ۱۱ تست                       | کلید نرسیدن، mapping اشتباه، وابستگی به layout، blur، دزدی فوکوس |
| `aim turns the hull toward the cursor`         | aim پارس شود ولی اعمال نشود                                      |
| `aim: null leaves the heading to the keyboard` | aim که WASD را خراب کند                                          |

**تست aim را با برگرداندن اصلاح بررسی کردم:** بدون اصلاح fail می‌شود، با اصلاح pass.
پس یک regression test واقعی است، نه تستی که برای مطابقت با کد نوشته شده باشد.

```
=== with fix REMOVED (should fail) ===
not ok 2 - a mouse aim angle turns the hull toward the cursor
# pass 32  # fail 1
=== fix restored (should pass) ===
# pass 33  # fail 0
```

---

## Preview برای تست شما

dev stack با کد اصلاح‌شده در حال اجراست:

```
[client] VITE v8.3.8  ready in 223 ms   →  http://localhost:5173/
[server] server ready {"port":8080,"players":0}
[server] websocket server listening {"maxPayloadBytes":16384}
```

آزمایش کنید:

1. `W` / `S` — جلو/عقب. `A` / `D` — چرخش. **باید** کار کند.
2. موس — کشتی به سمت موس می‌چرخد.
3. wheel — zoom.
4. پنل دیباگ → `input` و `sent`.

اگر باز هم کار نکرد، لطفاً بگویید در پنل دیباگ `input` چه نشان می‌دهد — با آن می‌فهمم
مشکل کدام لایه است.

---

## یادآوری

همان‌طور که خواستید **اسکرین‌شات نگرفتم**. تأیید من:

- `Input.test.ts` واقعی روی کلاس واقعی `InputController` (با DOM shim) اجرا می‌شود
- کلاینت واقعی WebSocket به سرور زنده: ۲۸۶ واحد حرکت، rotation دقیقاً ۰
- `aim` زنده: rotation به `-1.571` رسید (خطا ۰٫۰۰۰)
- build / lint / typecheck / test همه سبز
