# 登記日攝影大賽

朋友間的小型攝影大賽網站：報名、上傳、投票、公布結果都在同一頁。
純 HTML／CSS／JS，後端只用 Node 內建模組，不需要 `npm install`，也不需要 build。

## 啟動

```bash
ADMIN_PASSWORD=換成你們的密碼 node server.js
```

- 活動頁：`http://localhost:3000/`
- 管理面板：`http://localhost:3000/#admin`
- 沒設 `ADMIN_PASSWORD` 的話，第一次啟動會自動產生一組，存在 `data/admin-password.txt`。
- 可用的環境變數：`PORT`（預設 3000）、`DATA_DIR`（預設 `./data`）。

## 資料

全部存在 `data/`：`db.json`（名單、票、階段）和 `photos/`（照片與縮圖）。
備份或搬家只要複製這個資料夾。部署的主機必須有**不會被清掉的硬碟**，否則重啟後照片會不見。

## 檔案

| 檔案 | 內容 |
|---|---|
| `server.js` | API、身分驗證、靜態檔案 |
| `public/index.html` | 頁面結構與活動資訊文案 |
| `public/styles.css` | 樣式（依 `DESIGN.md`） |
| `public/app.js` | 報名、上傳壓縮、投票、大圖、管理面板 |

活動資訊（時間、地點、規則、獎項）直接寫在 `public/index.html`，要改文案改那裡就好。
