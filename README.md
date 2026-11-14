# 登記日攝影大賽

朋友間的小型攝影大賽網站：報名、上傳、投票、公布結果都在同一頁。
前端是純 HTML／CSS／JS（`public/`），放在 GitHub Pages；資料和照片存在 Supabase。不需要 build，也不用顧主機。

## 上線步驟（第一次）

1. **建立 Supabase 專案**（免費方案即可）
2. **建資料庫**：Supabase → SQL Editor → New query → 貼上 `supabase/schema.sql` 整份 → Run
3. **設定管理密碼**：在 SQL Editor 執行下面這行（把密碼換掉）：
   ```sql
   update public.settings set admin_hash = extensions.crypt('換成你們的密碼', extensions.gen_salt('bf', 8)) where id = 1;
   ```
4. **填連線設定**：Supabase → Project Settings → API，把 Project URL 和 anon public key 填進 `public/config.js`
   > 只放 anon key。`service_role` key 絕對不要放進這個 repo。
5. **開啟 GitHub Pages**：repo 的 Settings → Pages → Source 選「GitHub Actions」
6. push 到 `main`，幾分鐘後網站就會出現在 `https://<帳號>.github.io/photo-contest/`

## 管理

網址後面加 `#admin`，輸入管理密碼後可以：
- 切換階段：報名・上傳 → 投票 → 公布結果
- 看即時票數
- 挑「我們的最愛」
- 移除名單上的人

## 本機預覽

```bash
python3 -m http.server 3000 --directory public
```

本機預覽一樣會連到 `config.js` 裡的 Supabase。

## 檔案

| 檔案 | 內容 |
|---|---|
| `public/index.html` | 頁面結構與活動資訊文案（時間、地點、規則、獎項直接改這裡） |
| `public/styles.css` | 樣式（依 `DESIGN.md`） |
| `public/app.js` | 報名、上傳壓縮、投票、大圖、管理面板 |
| `public/config.js` | Supabase 連線設定 |
| `supabase/schema.sql` | 資料表、權限、所有資料庫函式、照片儲存空間 |

## 安全性

- 資料表全部關閉直接讀寫，所有動作都經過 `schema.sql` 裡的函式，伺服器端檢查身分、階段、張數、不能投自己
- 密碼以 bcrypt 雜湊保存；同一個名字或管理密碼錯 8 次會鎖 5 分鐘
- 不會公開誰投給誰；公布結果之前，任何人都看不到票數
- 照片網址是公開的（知道網址就看得到）。被刪除的照片，檔案仍會留在 Storage，需要的話可以到 Supabase → Storage 手動清掉
