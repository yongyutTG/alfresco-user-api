const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

const app = express();
const PORT = Number(process.env.PORT || 3001);
const ALFRESCO_HOST = process.env.ALFRESCO_HOST || "http://172.17.1.21";
const ALFRESCO_CMIS = `${ALFRESCO_HOST}/alfresco/api/-default-/public/cmis/versions/1.1/browser`;
const USER_SESSION_TTL_MS = Number(process.env.USER_SESSION_TTL_MS || 8 * 60 * 60 * 1000);
const userSessions = new Map();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/user-api/alfresco", requireUserSession);

function createAlfrescoAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return { Authorization: `Basic ${token}` };
}

function getBearerToken(req) {
  const authorization = req.get("authorization") || "";
  const [scheme, token] = authorization.split(" ");
  return scheme === "Bearer" ? token : null;
}

function cleanupExpiredUserSessions() {
  const now = Date.now();
  for (const [token, session] of userSessions.entries()) {
    if (session.expiresAt <= now) userSessions.delete(token);
  }
}

function createUserSession(username, password) {
  cleanupExpiredUserSessions();
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();

  // Session อยู่ใน memory เท่านั้น ไม่เขียน username/password ลงไฟล์หรือ database
  userSessions.set(token, {
    username,
    headers: createAlfrescoAuthHeader(username, password),
    createdAt: now,
    lastUsedAt: now,
    expiresAt: now + USER_SESSION_TTL_MS,
  });

  return token;
}

function requireUserSession(req, res, next) {
  cleanupExpiredUserSessions();

  const token = getBearerToken(req);
  const session = token ? userSessions.get(token) : null;

  if (!session) {
    return res.status(401).json({ message: "Unauthorized: missing or invalid user session token" });
  }

  session.lastUsedAt = Date.now();
  req.userSessionToken = token;
  req.alfrescoUsername = session.username;
  req.alfrescoAuthHeaders = session.headers;
  next();
}

function cmisUrlForPath(folderPath = "/") {
  const normalizedPath = String(folderPath || "/").trim();
  if (normalizedPath === "/") return `${ALFRESCO_CMIS}/root`;

  const encodedSegments = normalizedPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `${ALFRESCO_CMIS}/root/${encodedSegments}`;
}

function getProp(properties, key) {
  const value = properties?.[key]?.value ?? null;
  if (Array.isArray(value)) return value.length === 1 ? value[0] : value;
  return value;
}

function mapCmisObject(item, contentRoutePrefix = "/user-api/alfresco") {
  const object = item.object || item;
  const props = object.properties || {};
  const type = getProp(props, "cmis:baseTypeId");
  const name = getProp(props, "cmis:name");
  const id = getProp(props, "cmis:objectId");

  return {
    id,
    name,
    path: getProp(props, "cmis:path"),
    type,
    objectTypeId: getProp(props, "cmis:objectTypeId"),
    isFolder: type === "cmis:folder",
    isDocument: type === "cmis:document",
    mimeType: getProp(props, "cmis:contentStreamMimeType"),
    size: getProp(props, "cmis:contentStreamLength"),
    createdBy: getProp(props, "cmis:createdBy"),
    creationDate: getProp(props, "cmis:creationDate"),
    lastModifiedBy: getProp(props, "cmis:lastModifiedBy"),
    lastModificationDate: getProp(props, "cmis:lastModificationDate"),
    title: getProp(props, "cm:title"),
    description: getProp(props, "cm:description") || getProp(props, "cmis:description"),
    downloadUrl: type === "cmis:document"
      ? `${contentRoutePrefix}/documents/${encodeURIComponent(id)}/content?name=${encodeURIComponent(name || "download")}`
      : null,
  };
}

function escapeCmisString(value) {
  return String(value).replace(/'/g, "''");
}

function escapeCmisLike(value) {
  return escapeCmisString(value).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function safeErrorData(err) {
  const data = err.response?.data;
  if (!data) return err.message;
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data.status || data.message || data.exception) return data;
  return { message: err.message, contentType: err.response?.headers?.["content-type"] };
}

function handleError(res, message, err) {
  const status = err.response?.status || 500;
  res.status(status).json({ message, status, error: safeErrorData(err) });
}

async function validateAlfrescoLogin(username, password) {
  await axios.get(`${ALFRESCO_CMIS}/root`, {
    headers: createAlfrescoAuthHeader(username, password),
    params: { cmisselector: "object" },
  });
}

async function getChildrenByPath(folderPath, headers) {
  const result = await axios.get(cmisUrlForPath(folderPath), {
    headers,
    params: { cmisselector: "children" },
  });

  return (result.data.objects || []).map((item) => mapCmisObject(item));
}

async function getObjectByPath(objectPath, headers) {
  const result = await axios.get(cmisUrlForPath(objectPath), {
    headers,
    params: { cmisselector: "object" },
  });

  return mapCmisObject(result.data);
}

async function queryDocumentsInTree(folderPath, headers, options = {}) {
  const folder = await getObjectByPath(folderPath, headers);
  const maxItems = Math.min(Number(options.maxItems || 1000), 60000);
  const skipCount = Math.max(Number(options.skipCount || 0), 0);
  const query = `SELECT * FROM cmis:document WHERE IN_TREE('${escapeCmisString(folder.id)}')`;

  const result = await axios.get(ALFRESCO_CMIS, {
    headers,
    params: { cmisselector: "query", q: query, maxItems, skipCount },
  });

  return {
    path: folderPath,
    folderId: folder.id,
    count: result.data.results?.length || 0,
    total: result.data.numItems ?? null,
    hasMoreItems: Boolean(result.data.hasMoreItems),
    maxItems,
    skipCount,
    files: (result.data.results || []).map((item) => mapCmisObject(item)),
  };
}

async function searchDocumentsInTree(folderPath, searchText, headers, options = {}) {
  const folder = await getObjectByPath(folderPath, headers);
  const maxItems = Math.min(Number(options.maxItems || 100), 5000);
  const skipCount = Math.max(Number(options.skipCount || 0), 0);
  const normalizedSearchText = String(searchText || "").trim();

  if (!normalizedSearchText) {
    return { path: folderPath, folderId: folder.id, q: "", count: 0, total: 0, hasMoreItems: false, maxItems, skipCount, files: [] };
  }

  const query = [
    "SELECT * FROM cmis:document",
    `WHERE IN_TREE('${escapeCmisString(folder.id)}')`,
    `AND cmis:name LIKE '%${escapeCmisLike(normalizedSearchText)}%'`,
  ].join(" ");

  const result = await axios.get(ALFRESCO_CMIS, {
    headers,
    params: { cmisselector: "query", q: query, searchAllVersions: false, maxItems, skipCount },
  });

  return {
    path: folderPath,
    folderId: folder.id,
    q: normalizedSearchText,
    count: result.data.results?.length || 0,
    total: result.data.numItems ?? null,
    hasMoreItems: Boolean(result.data.hasMoreItems),
    maxItems,
    skipCount,
    files: (result.data.results || []).map((item) => mapCmisObject(item)),
  };
}

async function streamDocumentContent(res, id, name, headers) {
  if (!id || id === "DOCUMENT_ID") {
    return res.status(400).json({ message: "Missing real document id" });
  }

  const result = await axios.get(`${ALFRESCO_CMIS}/root`, {
    headers,
    params: { cmisselector: "content", objectId: id },
    responseType: "stream",
  });

  const fileName = path.basename(name || "download");
  res.setHeader("Content-Type", result.headers["content-type"] || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(fileName)}"`);
  result.data.pipe(res);
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", async (req, res) => {
  try {
    const result = await axios.get(`${ALFRESCO_HOST}/alfresco/service/api/server`);
    res.json({ ok: true, mode: "user-session", alfresco: result.data });
  } catch (err) {
    handleError(res, "Cannot connect to Alfresco", err);
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({ message: "Missing username or password" });
    }

    await validateAlfrescoLogin(username, password);
    const token = createUserSession(username, password);

    res.json({
      tokenType: "Bearer",
      accessToken: token,
      expiresInMs: USER_SESSION_TTL_MS,
      username,
    });
  } catch (err) {
    handleError(res, "Cannot login to Alfresco", err);
  }
});

app.get("/auth/me", requireUserSession, (req, res) => {
  const session = userSessions.get(req.userSessionToken);
  res.json({
    username: req.alfrescoUsername,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
  });
});

app.post("/auth/logout", requireUserSession, (req, res) => {
  userSessions.delete(req.userSessionToken);
  res.json({ ok: true });
});

app.get("/user-api/alfresco/folders", async (req, res) => {
  try {
    const folderPath = req.query.path || "/";
    const items = await getChildrenByPath(folderPath, req.alfrescoAuthHeaders);
    res.json(items.filter((item) => item.isFolder));
  } catch (err) {
    handleError(res, "Cannot list Alfresco folders for user", err);
  }
});

app.get("/user-api/alfresco/documents", async (req, res) => {
  try {
    const folderPath = req.query.folderPath || req.query.path || "/Sites/tg-saving/documentLibrary";
    const q = req.query.q || req.query.keyword || req.query.name;
    const options = { maxItems: req.query.maxItems, skipCount: req.query.skipCount };

    const result = q && String(q).trim()
      ? await searchDocumentsInTree(folderPath, q, req.alfrescoAuthHeaders, options)
      : await queryDocumentsInTree(folderPath, req.alfrescoAuthHeaders, options);

    res.json({
      ...result,
      username: req.alfrescoUsername,
      nextSkipCount: result.hasMoreItems ? result.skipCount + result.count : null,
    });
  } catch (err) {
    handleError(res, "Cannot list Alfresco documents for user", err);
  }
});

app.get("/user-api/alfresco/documents/:id/content", async (req, res) => {
  try {
    await streamDocumentContent(res, req.params.id, req.query.name, req.alfrescoAuthHeaders);
  } catch (err) {
    handleError(res, "Cannot download Alfresco document for user", err);
  }
});

app.listen(PORT, () => {
  console.log(`Alfresco user API running at http://localhost:${PORT}`);
  console.log(`Alfresco server: ${ALFRESCO_HOST}`);
});
