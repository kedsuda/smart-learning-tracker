# Deploy: Railway (backend + MySQL) + Cloudflare Pages (frontend)

เป้าหมาย: ออนไลน์ตลอด ไม่ต้องเปิดคอม เข้าถึงได้ทุกที่

```
ผู้ใช้ ─► Cloudflare Pages (React)  ──API──►  Railway (Laravel)  ─►  Railway MySQL
```

---

## 0) เตรียม: push โค้ดขึ้น GitHub
Railway และ Cloudflare Pages deploy จาก GitHub repo

```bash
git add -A
git commit -m "Add deploy config (Dockerfile, _redirects)"
# สร้าง repo บน github.com ก่อน แล้ว:
git remote add origin https://github.com/<you>/smart-learning-tracker.git
git branch -M main
git push -u origin main
```
> `.env` ถูก gitignore อยู่แล้ว (ค่าลับจะตั้งใน dashboard แทน) ✅

---

## 1) Backend + MySQL บน Railway
1. ไป https://railway.app → **New Project → Deploy from GitHub repo** → เลือก repo นี้
   - Railway จะเจอ `Dockerfile` ที่ราก แล้ว build เอง
2. ในโปรเจกต์เดียวกัน กด **New → Database → MySQL**
3. ไปที่ service ของ **backend → Variables** ใส่ค่าต่อไปนี้:

   | Variable | ค่า |
   |---|---|
   | `APP_KEY` | `base64:QpeI7UDb5pCHgznjkQSv+V8vtQOYSkzWJDQih0AoGOQ=` (หรือรัน `php artisan key:generate --show`) |
   | `APP_ENV` | `production` |
   | `APP_DEBUG` | `false` |
   | `APP_URL` | URL ของ backend (ได้หลังเปิด domain ในข้อ 4) |
   | `DB_CONNECTION` | `mysql` |
   | `DB_HOST` | `${{MySQL.MYSQLHOST}}` |
   | `DB_PORT` | `${{MySQL.MYSQLPORT}}` |
   | `DB_DATABASE` | `${{MySQL.MYSQLDATABASE}}` |
   | `DB_USERNAME` | `${{MySQL.MYSQLUSER}}` |
   | `DB_PASSWORD` | `${{MySQL.MYSQLPASSWORD}}` |
   | `AI_PROVIDER` | `groq` |
   | `GROQ_API_KEY` | (คีย์ของคุณ) |
   | `GEMINI_API_KEY` | (ถ้าใช้) |
   | `FRONTEND_ORIGINS` | URL ของ Cloudflare Pages (เติมในข้อ 3 หลังได้ URL) เช่น `https://smart-learning-tracker.pages.dev` |

   > `${{MySQL.xxx}}` คืออ้างอิงค่าจาก service MySQL อัตโนมัติ (พิมพ์ตามนี้ได้เลย)
4. แท็บ **Settings → Networking → Generate Domain** → ได้ URL เช่น `https://smart-learning-tracker-production.up.railway.app`
   - Dockerfile จะรัน `php artisan migrate --force` อัตโนมัติตอนเริ่ม → สร้างตารางให้เอง
5. ทดสอบ: เปิด `https://<backend>/api/subjects` ควรได้ `{"message":"Unauthenticated."}` (ถูกต้อง)

---

## 2) Frontend บน Cloudflare Pages
1. ไป https://dash.cloudflare.com → **Workers & Pages → Create → Pages → Connect to Git** → เลือก repo นี้
2. ตั้ง Build settings:
   - **Framework preset:** None
   - **Build command:** `cd frontend && npm install && npm run build`
   - **Build output directory:** `public/app`
3. **Environment variables** (Production):
   | Variable | ค่า |
   |---|---|
   | `VITE_API_URL` | URL ของ backend Railway เช่น `https://smart-learning-tracker-production.up.railway.app` |
   | `VITE_GOOGLE_CLIENT_ID` | (ถ้าใช้ Google login) |
   | `VITE_DEV_LOGIN` | `false` |
   | `VITE_GOOGLE_LOGIN_ENABLED` | `true` หรือ `false` |
4. กด **Save and Deploy** → ได้ URL `https://<ชื่อ>.pages.dev`
   - ไฟล์ `frontend/public/_redirects` ทำให้ route ของ React (เช่น /document-summary) ทำงานบน Pages

---

## 3) เชื่อม 2 ฝั่งเข้าหากัน (CORS)
- กลับไป Railway → backend → Variables → ตั้ง `FRONTEND_ORIGINS` = URL ของ Pages (จากข้อ 2.4) → redeploy
- เสร็จแล้ว frontend จะยิง API ไป backend ได้ ไม่ติด CORS

---

## 4) (ถ้าต้องการข้อมูลเดิม) import ฐานข้อมูล
Railway → MySQL service → **Data / Connect** → ใช้ค่าเชื่อมต่อ import ไฟล์ `db_651998018 (9).sql`:
```bash
mysql -h <MYSQLHOST> -P <MYSQLPORT> -u <MYSQLUSER> -p<MYSQLPASSWORD> <MYSQLDATABASE> < "db_651998018 (9).sql"
```
> ถ้าไม่ import = เริ่มฐานเปล่า (migrate สร้างตารางให้) แล้วสมัครผู้ใช้ใหม่ได้เลย

---

## 5) (ทางเลือก) โดเมนของตัวเอง + Google OAuth
- Cloudflare: เพิ่ม Custom domain ให้ Pages และชี้ DNS
- ถ้าใช้ Google login: เพิ่ม origin ของ Pages/โดเมน ใน Google Cloud Console → Authorized JavaScript origins (แก้ปัญหา origin_mismatch แบบถาวร เพราะ URL คงที่แล้ว)

---

## หมายเหตุ
- Render ก็ใช้ `Dockerfile` เดียวกันได้ (New → Web Service → Docker) + เพิ่ม MySQL จากที่อื่น (Railway/PlanetScale/Aiven) แล้วตั้ง `DB_*` เอง
- `php artisan serve` ใน Dockerfile เพียงพอสำหรับการใช้งานทั่วไป/โปรเจกต์เรียน ถ้าโหลดสูงค่อยเปลี่ยนเป็น nginx + php-fpm ภายหลัง
