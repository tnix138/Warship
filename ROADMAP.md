# Warship — نقشه راه پروژه (Roadmap)

* **چشم‌انداز:** یک بازی نبرد دریایی آنلاین، سریع و تاکتیکی در مرورگر (سبک `.io` + تاکتیک کشتی‌رانی) با سرور مقتدر، ورود آنی بدون نیاز به ثبت‌نام اجبار، و عمق گیم‌پلی بالا.
* **هسته فعلی:** تیک ۲۰ هرتز، `uWebSockets.js`، `MessagePack`، `Interpolation/Prediction`، `AOI Culling`، `Delta Compression`، سیستم مبارزه، NPCها، جعبه‌های لوت، سیستم XP/ارتقا، HUD و Minimap.

---

## فاز ۱: هسته گیم‌پلی و محیط بازی
- [x] شبیه‌سازی ۲۰ هرتز و حرکت کشتی‌ها
- [x] سیستم مبارزه، پرتابه‌ها و هدف‌گیری خودکار/دستی
- [x] کشتی‌های NPC و جعبه‌های لوت (`Box.ts`, `Npc.ts`)
- [x] سیستم XP و ارتقای کشتی (`Progression.ts`)
- [x] جزیره‌ها و موانع فیزیکی در نقشه

## فاز ۲: رابط کاربری (HUD) و تجربه کاربری (UX)
- [x] HUD داخل بازی (`GameHud.ts`) و مینی‌مپ (`Minimap.ts`)
- [x] افکت‌های بصری مبارزه و انفجار (`CombatRenderer.ts`)
- [x] افکت‌های صوتی پایه (`SoundManager.ts`)

## فاز ۳: پایداری، دیتابیس و مقیاس‌پذیری
- [x] تست‌های واحد و یکپارچه‌سازی (`packages/shared`, `packages/server`, `packages/client`)
- [x] محدودسازی نرخ درخواست (`rateLimit.ts`)
- [x] تست فشار (Load Test) برای شبیه‌سازی کلاینت‌های هم‌زمان (`loadtest.ts`)
- [x] اتصال کامل دیتابیس (`SQLite` + `Drizzle ORM`) برای ثبت آمار و رکوردها (`Database.ts`)
- [x] مدیریت چند اتاق / مچ‌میکینگ (`RoomManager.ts`)

## فاز ۴: استقرار و انتشار عمومی (Production)
- [x] `Dockerfile` و `docker-compose.yml`
- [x] تنظیمات `nginx.conf` برای Reverse Proxy و WebSocket
