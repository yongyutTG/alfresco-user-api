# Code Flow Steps

เอกสารนี้อธิบายว่าโค้ดแต่ละส่วนเรียก function ไหนต่อ เป็นลำดับ Step 1, 2, 3 เพื่ออ่านคู่กับ `server.js` และ `public/frontend/index.html`

## ภาพรวม

```text
Frontend: public/frontend/index.html
        |
        | fetch / window.open
        v
Backend: server.js
        |
        | axios + CMIS Browser Binding
        v
Alfresco Server
```

Backend เรียก Alfresco ด้วยสิทธิ์ของ user ที่ login อยู่ โดยเก็บข้อมูล session ไว้ใน `userSessions` ฝั่ง Node.js

## Flow 1: เปิดหน้า Frontend

URL:

```text
http://localhost:3001/frontend/
```

Step 1: Browser โหลดไฟล์

```text
public/frontend/index.html
```

Step 2: JavaScript ตั้งค่าเริ่มต้น

```js
const state = {
  token: sessionStorage.getItem(tokenKey) || "",
  username: sessionStorage.getItem(usernameKey) || "",
}
```

Step 3: เรียก function แสดงสถานะ login

```js
renderSession();
setLoading(false);
if (state.token) loadFolders();
```

ความหมาย:

- ถ้ายังไม่มี token จะแสดง form login
- ถ้ามี token ใน `sessionStorage` จะลองโหลด folder ต่อทันที

## Flow 2: Login

ผู้ใช้กรอก username/password แล้วกด Login

### Frontend Steps

Step 1: form submit เรียก `login()`

```js
els.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  login(els.username.value.trim(), els.password.value);
});
```

Step 2: `login(username, password)` เรียก backend

```js
fetch("/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password }),
});
```

### Backend Steps

Step 3: route `/auth/login` ใน `server.js` รับ request

```js
app.post("/auth/login", async (req, res) => { ... });
```

Step 4: backend ตรวจ username/password กับ Alfresco

```js
await validateAlfrescoLogin(username, password);
```

Step 5: `validateAlfrescoLogin()` เรียก Alfresco CMIS root

```js
axios.get(`${ALFRESCO_CMIS}/root`, {
  headers: createAlfrescoAuthHeader(username, password),
  params: { cmisselector: "object" },
});
```

Step 6: ถ้า login ผ่าน backend สร้าง session

```js
const token = createUserSession(username, password);
```

Step 7: `createUserSession()` สร้าง token และเก็บ session ไว้ใน memory

```js
userSessions.set(token, {
  username,
  headers: createAlfrescoAuthHeader(username, password),
  createdAt: now,
  lastUsedAt: now,
  expiresAt: now + USER_SESSION_TTL_MS,
});
```

Step 8: backend set cookie ให้ browser

```js
setUserSessionCookie(res, token);
```

Step 9: backend ส่ง response กลับ frontend

```json
{
  "tokenType": "Bearer",
  "accessToken": "...",
  "expiresInMs": 28800000,
  "username": "alfresco_user"
}
```

### Frontend หลัง Login

Step 10: frontend เก็บ token

```js
setLoggedIn(data.accessToken, data.username);
```

Step 11: `setLoggedIn()` เก็บ token ลง state และ sessionStorage

```js
state.token = token;
sessionStorage.setItem(tokenKey, token);
```

Step 12: login เสร็จแล้วโหลด folder

```js
await loadFolders();
```

## Flow 3: List Folders

ใช้ตอน login เสร็จ หรือ user ต้องการโหลดรายชื่อ folder ใต้ documentLibrary

### Frontend Steps

Step 1: `loadFolders()` ถูกเรียก

```js
await loadFolders();
```

Step 2: `loadFolders()` เรียก API

```js
fetchJson(`/user-api/alfresco/folders?${params.toString()}`);
```

Step 3: `fetchJson()` แนบ Bearer token ให้อัตโนมัติ

```js
headers: {
  ...authHeaders(),
}
```

Step 4: `authHeaders()` สร้าง header

```js
Authorization: `Bearer ${state.token}`
```

### Backend Steps

Step 5: request เข้า middleware ก่อน

```js
app.use("/user-api/alfresco", requireUserSession);
```

Step 6: `requireUserSession()` ตรวจ token

```js
const token = getBearerToken(req) || getCookie(req, "alfresco_user_session");
const session = userSessions.get(token);
```

Step 7: ถ้าเจอ session จะผูก Alfresco auth header ไว้ใน request

```js
req.alfrescoAuthHeaders = session.headers;
req.alfrescoUsername = session.username;
```

Step 8: route list folders ทำงาน

```js
app.get("/user-api/alfresco/folders", async (req, res) => { ... });
```

Step 9: route เรียก `getChildrenByPath()`

```js
const items = await getChildrenByPath(folderPath, req.alfrescoAuthHeaders);
```

Step 10: `getChildrenByPath()` เรียก Alfresco

```js
axios.get(cmisUrlForPath(folderPath), {
  headers,
  params: { cmisselector: "children" },
});
```

Step 11: แปลงข้อมูลด้วย `mapCmisObject()` และส่งเฉพาะ folder กลับ frontend

```js
res.json(items.filter((item) => item.isFolder));
```

## Flow 4: List/Search Documents

เกิดเมื่อ user เลือก folder หรือกดค้นหา

### Frontend Steps

Step 1: user เลือก folder

```js
els.folderSelect.addEventListener("change", () => {
  syncSearchState();
  loadFiles(true);
});
```

Step 2: `syncSearchState()` อ่านค่าจาก UI ลง state

```js
state.folderPath = els.folderSelect.value || "";
state.q = els.keyword.value.trim();
state.maxItems = Number(els.pageSize.value);
```

Step 3: `loadFiles()` สร้าง URL

```js
buildDocumentsUrl();
```

Step 4: `buildDocumentsUrl()` คืน URL เช่น

```text
/user-api/alfresco/documents?folderPath=/Sites/tg-saving/documentLibrary/การเงิน&q=026277&maxItems=100&skipCount=0
```

Step 5: `loadFiles()` เรียก API ผ่าน `fetchJson()`

```js
const data = await fetchJson(buildDocumentsUrl());
```

### Backend Steps

Step 6: request ผ่าน `requireUserSession()` ก่อนเหมือน Flow 3

Step 7: route documents รับ request

```js
app.get("/user-api/alfresco/documents", async (req, res) => { ... });
```

Step 8: route อ่าน parameter

```js
const folderPath = req.query.folderPath || req.query.path || "/Sites/tg-saving/documentLibrary";
const q = req.query.q || req.query.keyword || req.query.name;
```

Step 9: ถ้ามี keyword จะเรียก search

```js
await searchDocumentsInTree(folderPath, q, req.alfrescoAuthHeaders, options);
```

Step 10: ถ้าไม่มี keyword จะเรียก list

```js
await queryDocumentsInTree(folderPath, req.alfrescoAuthHeaders, options);
```

### กรณี List ทั้งหมด

Step 11A: `queryDocumentsInTree()` หา folder object ก่อน

```js
const folder = await getObjectByPath(folderPath, headers);
```

Step 12A: `getObjectByPath()` เรียก Alfresco เพื่อเอา folder id

```js
params: { cmisselector: "object" }
```

Step 13A: `queryDocumentsInTree()` สร้าง CMIS query

```sql
SELECT * FROM cmis:document WHERE IN_TREE('folderId')
```

Step 14A: เรียก Alfresco query API

```js
axios.get(ALFRESCO_CMIS, {
  headers,
  params: { cmisselector: "query", q: query, maxItems, skipCount },
});
```

### กรณี Search

Step 11B: `searchDocumentsInTree()` หา folder object ก่อน

```js
const folder = await getObjectByPath(folderPath, headers);
```

Step 12B: สร้าง CMIS query แบบ LIKE

```sql
SELECT * FROM cmis:document
WHERE IN_TREE('folderId')
AND cmis:name LIKE '%keyword%'
```

Step 13B: เรียก Alfresco query API

```js
axios.get(ALFRESCO_CMIS, {
  headers,
  params: { cmisselector: "query", q: query, searchAllVersions: false, maxItems, skipCount },
});
```

### Response กลับ Frontend

Step 15: backend ส่ง JSON กลับ

```js
res.json({
  ...result,
  username: req.alfrescoUsername,
  nextSkipCount: result.hasMoreItems ? result.skipCount + result.count : null,
});
```

Step 16: frontend render ตาราง

```js
renderRows(data.files || []);
```

## Flow 5: Open File

เกิดเมื่อ user กดปุ่ม `เปิด`

### Frontend Steps

Step 1: ในตาราง แต่ละไฟล์มีปุ่มที่เก็บ `downloadUrl`

```html
<button data-download-url="/user-api/alfresco/documents/:id/content?name=file.pdf">เปิด</button>
```

Step 2: user click ปุ่ม เปิด

```js
els.rows.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-download-url]");
  if (button) openDocument(button.dataset.downloadUrl);
});
```

Step 3: `openDocument()` เปิด URL ตรง

```js
window.open(url, "_blank", "noopener");
```

หมายเหตุ:

- `window.open()` แนบ `Authorization` header เองไม่ได้
- browser จึงใช้ cookie `alfresco_user_session` ที่ backend set ไว้หลัง login
- browser ส่ง cookie ไปกับ request อัตโนมัติ

### Backend Steps

Step 4: request เข้า `/user-api/alfresco/documents/:id/content`

```js
app.get("/user-api/alfresco/documents/:id/content", async (req, res) => { ... });
```

Step 5: request ผ่าน `requireUserSession()` ก่อน

```js
const token = getBearerToken(req) || getCookie(req, "alfresco_user_session");
```

กรณี browser เปิดไฟล์:

```text
ใช้ token จาก cookie
```

กรณี dev/Postman เปิดไฟล์:

```text
ใช้ token จาก Authorization: Bearer <accessToken>
```

Step 6: route เรียก `streamDocumentContent()`

```js
await streamDocumentContent(res, req.params.id, req.query.name, req.alfrescoAuthHeaders);
```

Step 7: `streamDocumentContent()` เรียก Alfresco content API

```js
axios.get(`${ALFRESCO_CMIS}/root`, {
  headers,
  params: { cmisselector: "content", objectId: id },
  responseType: "stream",
});
```

Step 8: backend set response header

```js
res.setHeader("Content-Type", result.headers["content-type"] || "application/octet-stream");
res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(fileName)}"`);
```

Step 9: backend stream file กลับ browser

```js
result.data.pipe(res);
```

Step 10: browser แสดง PDF/content ใน tab ใหม่

## Flow 6: Logout

### Frontend Steps

Step 1: user กด Logout

```js
els.logoutBtn.addEventListener("click", async () => { ... });
```

Step 2: frontend เรียก backend

```js
fetch("/auth/logout", { method: "POST", headers: authHeaders() });
```

Step 3: frontend ล้าง state และ sessionStorage

```js
clearSession();
```

### Backend Steps

Step 4: route logout รับ request

```js
app.post("/auth/logout", requireUserSession, (req, res) => { ... });
```

Step 5: backend ลบ session ใน memory

```js
userSessions.delete(req.userSessionToken);
```

Step 6: backend ลบ cookie

```js
clearUserSessionCookie(res);
```

Step 7: response กลับ

```json
{ "ok": true }
```

## สรุป Function หลัก

| Function | อยู่ไฟล์ | หน้าที่ |
|---|---|---|
| `login()` | `public/frontend/index.html` | ส่ง username/password ไป `/auth/login` |
| `setLoggedIn()` | `public/frontend/index.html` | เก็บ accessToken ลง state/sessionStorage |
| `authHeaders()` | `public/frontend/index.html` | สร้าง `Authorization: Bearer <token>` |
| `fetchJson()` | `public/frontend/index.html` | เรียก API แบบ JSON พร้อมแนบ token |
| `loadFolders()` | `public/frontend/index.html` | โหลดรายชื่อ folder |
| `loadFiles()` | `public/frontend/index.html` | โหลดหรือค้นหาไฟล์ |
| `openDocument()` | `public/frontend/index.html` | เปิดไฟล์ด้วย `window.open()` |
| `validateAlfrescoLogin()` | `server.js` | ตรวจ login กับ Alfresco |
| `createUserSession()` | `server.js` | สร้าง session token ใน memory |
| `setUserSessionCookie()` | `server.js` | set cookie ให้ browser |
| `requireUserSession()` | `server.js` | ตรวจ Bearer token หรือ cookie ก่อนเข้า `/user-api/alfresco/*` |
| `getChildrenByPath()` | `server.js` | เรียก Alfresco เพื่อ list children |
| `getObjectByPath()` | `server.js` | หา object/folder id จาก path |
| `queryDocumentsInTree()` | `server.js` | list เอกสารทั้งหมดใต้ folder |
| `searchDocumentsInTree()` | `server.js` | ค้นหาเอกสารจากชื่อไฟล์ |
| `streamDocumentContent()` | `server.js` | stream file จาก Alfresco กลับ browser/client |

