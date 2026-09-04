// Site API catalog: turns captured page traffic into WebMCP tool
// descriptors and builds replayable requests from agent arguments.
//
// This module is pure: it runs unchanged inside the JXA session and
// under the Node test runner.

export const WEBMCP_LIMITS = Object.freeze({
  maxEndpointsPerSite: 200,
  maxSamples: 3,
  maxSampleBytes: 4 * 1024,
  // The newest sample keeps more of the body so DOM matching can see the
  // whole first page of a list, not just its first item.
  maxLatestSampleBytes: 32 * 1024,
  maxToolResultBytes: 1024 * 1024,
  maxToolResultBytesCeiling: 8 * 1024 * 1024,
  maxMissedUrls: 40
});

const STATIC_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "css", "map",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "webm", "ogg", "wav", "m3u8", "ts",
  "pdf", "zip", "wasm", "html", "htm", "xml", "txt"
]);

const TRACKER_HOSTS = [
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "doubleclick.net",
  "sentry.io",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "hotjar.com",
  "clarity.ms",
  "browser-intake-datadoghq.com",
  "datadoghq.com",
  "newrelic.com",
  "nr-data.net",
  "bugsnag.com",
  "amplitude.com",
  "posthog.com/e",
  "facebook.net",
  "scorecardresearch.com",
  "mcs.snssdk.com",
  "mon.zijieapi.com",
  "fundingchoicesmessages.google.com",
  "apm-fe.xiaohongshu.com",
  "t2.xiaohongshu.com",
  "zhihu-web-analytics.zhihu.com",
  "prodregistryv2.org",
  "pdscrb.com",
  "transcend-cdn.com",
  "px.ads.linkedin.com",
  "veta.naver.com",
  "statsig.com",
  "launchdarkly.com",
  "optimizely.com",
  "intercom.io",
  "intercomcdn.com",
  "fullstory.com",
  "logrocket.com",
  "browser-intake-us5-datadoghq.com"
];

// Second-level public suffixes where "last two labels" would merge
// unrelated sites. Kept deliberately small; extend as needed.
const SECOND_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.au", "net.au", "org.au",
  "co.jp", "ne.jp", "or.jp",
  "co.kr", "or.kr",
  "com.hk", "com.tw", "com.sg", "com.br", "com.mx",
  "co.in", "co.nz", "co.za",
  "com.tr", "com.ar"
]);

export function isJsonish(contentType) {
  return Boolean(contentType) && /json/i.test(String(contentType));
}

// The JXA runtime has no URL or URLSearchParams globals, so the catalog
// carries its own minimal http(s) URL parser and query formatter.
function decodeQueryComponent(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, " "));
  } catch (error) {
    return String(value);
  }
}

export function parseQuery(search) {
  const text = String(search || "");
  const trimmed = text.startsWith("?") ? text.slice(1) : text;

  if (!trimmed) {
    return [];
  }

  return trimmed.split("&").filter(Boolean).map(pair => {
    const separator = pair.indexOf("=");
    return separator === -1
      ? [decodeQueryComponent(pair), ""]
      : [
          decodeQueryComponent(pair.slice(0, separator)),
          decodeQueryComponent(pair.slice(separator + 1))
        ];
  });
}

export function formatQuery(entries) {
  const parts = entries.map(([name, value]) =>
    encodeURIComponent(name) + "=" + encodeURIComponent(value)
  );
  return parts.length === 0 ? "" : "?" + parts.join("&");
}

export function parseUrl(input) {
  const text = String(input);
  const match =
    /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(text);

  if (!match) {
    throw new Error(`invalid_url: ${text}`);
  }

  const protocol = match[1].toLowerCase();
  const authority = match[2];
  const host = (
    authority.includes("@")
      ? authority.slice(authority.lastIndexOf("@") + 1)
      : authority
  ).toLowerCase();
  const hostname = host.replace(/:\d+$/, "");
  const pathname = match[3] || "/";
  const search = match[4] || "";

  return {
    href: text,
    protocol,
    host,
    hostname,
    origin: `${protocol}//${host}`,
    pathname,
    search,
    searchParams: parseQuery(search)
  };
}

export function siteKeyFor(hostname) {
  const host = String(hostname || "").toLowerCase();
  const labels = host.split(".");

  if (labels.length < 2 || /^[\d.]+$/.test(host)) {
    return host;
  }

  const lastTwo = labels.slice(-2).join(".");

  if (SECOND_LEVEL_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }

  return lastTwo;
}

// Telemetry endpoints are never useful tools; drop them by shape as well
// as by host so first-party analytics (zhihu-web-analytics, x.com
// promoted_content/log.json, ...) stay out of the catalog.
const NOISE_HOST_RE = /(^|[.-])(analytics|telemetry|metrics|beacon|logs?|stats?|tracking|sentry|apm|rum|mon|mcs)[.-]/i;
const NOISE_PATH_RE =
  /\/(za\/)?logs?(\/|\.json$|$)|\/log\.json$|\/collect(\/|$)|\/track(ing)?(\/|$)|\/beacon|\/metrics?(\/|$)|\/telemetry|\/analytics|\/pixel(\/|$)|\/report(\/|\.json|$)|\/rum(\/|$)|\/perf(\/|$)|\/monitor(\/|$)|\/rgstr(\/|$)|\/web_logger\/|\/logger\/|\/metalytics(\/|$)|\/initialize(\/|$)|\/sdk\/|\/heartbeat(\/|$)|\/ping(\/|$)/i;

export function isNoiseUrl(url) {
  return NOISE_HOST_RE.test(url.hostname + ".") || NOISE_PATH_RE.test(url.pathname);
}

export function sniffsAsJson(text) {
  if (typeof text !== "string") {
    return false;
  }

  const head = text.slice(0, 64).replace(/^﻿/, "").trimStart();
  return head.startsWith("{") || head.startsWith("[");
}

// Known telemetry vendors. Used only as a scoring prior, never as a hard
// filter: the catalog learns what is noise from the responses themselves.
export function matchesNoiseSeed(url) {
  const hostAndPath = url.hostname + url.pathname;
  return TRACKER_HOSTS.some(tracker =>
    url.hostname === tracker ||
    url.hostname.endsWith("." + tracker) ||
    hostAndPath.startsWith(tracker)
  ) || isNoiseUrl(url);
}

export function shouldCapturePre(method, url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  const upper = String(method).toUpperCase();

  if (upper === "OPTIONS" || upper === "HEAD") {
    return false;
  }

  const lastSegment = url.pathname.split("/").pop() || "";
  const dot = lastSegment.lastIndexOf(".");

  if (dot > 0) {
    const extension = lastSegment.slice(dot + 1).toLowerCase();

    if (STATIC_EXTENSIONS.has(extension)) {
      return false;
    }
  }

  return true;
}

export function shouldKeep(capture) {
  if (capture.status < 200 || capture.status >= 300) {
    return false;
  }

  if (isJsonish(capture.responseContentType)) {
    return true;
  }

  // Responses without a readable content type (missing header, text/plain,
  // opaque CORS metadata) still count when the body is JSON.
  if (sniffsAsJson(capture.responseBody)) {
    return true;
  }

  return (
    capture.requestBody !== undefined &&
    isJsonish(capture.requestContentType)
  );
}

// --- URL templating -------------------------------------------------

const NUMERIC_RE = /^\d+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;
const OPAQUE_RE = /^[\w-]{16,}$/;

function classifySegment(segment) {
  if (NUMERIC_RE.test(segment)) {
    return "numeric";
  }

  if (UUID_RE.test(segment)) {
    return "uuid";
  }

  if (LONG_HEX_RE.test(segment)) {
    return "hash";
  }

  if (
    OPAQUE_RE.test(segment) &&
    /\d/.test(segment) &&
    /[a-zA-Z]/.test(segment)
  ) {
    return "hash";
  }

  return null;
}

function singularize(word) {
  return word.length > 3 && word.endsWith("s")
    ? word.slice(0, -1)
    : word;
}

function paramNameFor(previousLiteral) {
  if (!previousLiteral) {
    return "id";
  }

  const cleaned = previousLiteral.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned ? singularize(cleaned) + "Id" : "id";
}

export function templatePath(pathname) {
  const segments = String(pathname).split("/");
  const pathParams = [];
  const usedNames = new Set();
  let previousLiteral;
  let lastNonEmpty = -1;

  segments.forEach((segment, index) => {
    if (segment !== "") {
      lastNonEmpty = index;
    }
  });

  const templated = segments.map((segment, index) => {
    if (segment === "") {
      return segment;
    }

    const isGraphqlQueryId =
      previousLiteral?.toLowerCase() === "graphql" &&
      index < lastNonEmpty;
    const kind = isGraphqlQueryId ? "hash" : classifySegment(segment);

    if (kind === null) {
      previousLiteral = segment;
      return segment;
    }

    let name = isGraphqlQueryId
      ? "queryId"
      : paramNameFor(previousLiteral);

    if (usedNames.has(name)) {
      let suffix = 2;

      while (usedNames.has(name + suffix)) {
        suffix += 1;
      }

      name += suffix;
    }

    usedNames.add(name);
    pathParams.push({ name, index, kind, sample: segment });
    return `{${name}}`;
  });

  return { templatePath: templated.join("/"), pathParams };
}

export function fillTemplate(template, args) {
  return String(template).replace(/\{([^}]+)\}/g, (_, name) => {
    const value = args[name];

    if (value === undefined || value === null) {
      throw new Error(`missing required path parameter "${name}"`);
    }

    return encodeURIComponent(String(value));
  });
}

// --- JSON Schema inference -------------------------------------------

const MAX_DEPTH = 5;
const MAX_PROPERTIES = 50;
const MAX_ARRAY_SAMPLES = 5;

export function inferSchema(value, depth = 0) {
  if (value === null) {
    return { type: "null" };
  }

  switch (typeof value) {
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "number":
      return { type: Number.isInteger(value) ? "integer" : "number" };
    default:
      break;
  }

  if (depth >= MAX_DEPTH) {
    return {};
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { type: "array" };
    }

    let items;

    for (const element of value.slice(0, MAX_ARRAY_SAMPLES)) {
      const schema = inferSchema(element, depth + 1);
      items = items === undefined ? schema : mergeSchemas(items, schema);
    }

    return { type: "array", items };
  }

  if (typeof value === "object") {
    const properties = {};
    const required = [];

    for (const key of Object.keys(value).slice(0, MAX_PROPERTIES)) {
      properties[key] = inferSchema(value[key], depth + 1);
      required.push(key);
    }

    return { type: "object", properties, required };
  }

  return {};
}

export function mergeSchemas(a, b) {
  if (a.type === undefined || b.type === undefined) {
    return {};
  }

  if (a.type === "null") {
    return { ...b };
  }

  if (b.type === "null") {
    return { ...a };
  }

  if (a.type !== b.type) {
    const numeric = new Set(["integer", "number"]);
    return numeric.has(a.type) && numeric.has(b.type)
      ? { type: "number" }
      : {};
  }

  if (a.type === "object") {
    const properties = {};
    const keys = new Set([
      ...Object.keys(a.properties ?? {}),
      ...Object.keys(b.properties ?? {})
    ]);

    for (const key of keys) {
      const left = a.properties?.[key];
      const right = b.properties?.[key];
      properties[key] = left && right
        ? mergeSchemas(left, right)
        : { ...(left ?? right) };
    }

    const required = (a.required ?? []).filter(key =>
      (b.required ?? []).includes(key)
    );
    return { type: "object", properties, required };
  }

  if (a.type === "array") {
    if (a.items && b.items) {
      return { type: "array", items: mergeSchemas(a.items, b.items) };
    }

    return { type: "array", items: a.items ?? b.items };
  }

  return { type: a.type };
}

export function inferScalarFromString(value) {
  if (/^-?\d+$/.test(value)) {
    return { type: "integer" };
  }

  if (/^-?\d*\.\d+$/.test(value)) {
    return { type: "number" };
  }

  if (value === "true" || value === "false") {
    return { type: "boolean" };
  }

  return { type: "string" };
}

// --- Naming ----------------------------------------------------------

const MAX_NAME_LENGTH = 64;

function sanitize(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, MAX_NAME_LENGTH);
}

function snakeCase(raw) {
  return sanitize(String(raw).replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

export function toolNameFor(method, template, gqlOperation, existingNames) {
  let base;

  if (gqlOperation) {
    base = sanitize(`${method.toLowerCase()}_graphql_${snakeCase(gqlOperation)}`);
  } else {
    const literals = String(template)
      .split("/")
      .filter(segment => segment !== "" && !segment.startsWith("{"));
    base =
      sanitize(`${method.toLowerCase()}_${literals.join("_")}`) ||
      sanitize(method.toLowerCase());
  }

  if (!existingNames.has(base)) {
    return base;
  }

  const lastParam = String(template).match(/\{([^}]+)\}(?!.*\{)/)?.[1];

  if (lastParam) {
    const withParam = sanitize(`${base}_by_${lastParam}`);

    if (!existingNames.has(withParam)) {
      return withParam;
    }

    base = withParam;
  }

  let suffix = 2;

  while (existingNames.has(`${base}_${suffix}`)) {
    suffix += 1;
  }

  return `${base}_${suffix}`;
}

export function buildDescription(endpoint, host) {
  const parts = [];

  if (endpoint.gqlOperation) {
    parts.push(
      `GraphQL operation "${endpoint.gqlOperation}" via ` +
      `${endpoint.method} ${endpoint.templatePath} on ${host}.`
    );
  } else {
    parts.push(`${endpoint.method} ${endpoint.templatePath} on ${host}.`);
  }

  const queryNames = Object.keys(endpoint.querySchema);

  if (queryNames.length > 0) {
    parts.push(`Query params: ${queryNames.join(", ")}.`);
  }

  const sample = endpoint.samples[endpoint.samples.length - 1];

  if (sample?.body) {
    const snippet = sample.body.length > 200
      ? sample.body.slice(0, 200) + "…"
      : sample.body;
    parts.push(`Returns JSON like: ${snippet}`);
  }

  return parts.join(" ");
}

// --- Redaction --------------------------------------------------------

const SENSITIVE_NAME_RE =
  /(authorization|cookie|csrf|xsrf|token|secret|passw|api[-_]?key|session|signature|credential|bearer|^x-s$|^x-t$)/i;
const REDACTED = "«redacted»";

export function isSensitiveName(name) {
  return SENSITIVE_NAME_RE.test(String(name));
}

export function redactHeaders(headers) {
  const out = {};

  for (const [name, value] of Object.entries(headers || {})) {
    out[name] = isSensitiveName(name) ? REDACTED : value;
  }

  return out;
}

export function redactRecord(record, options = {}) {
  const out = {};
  const maxLength = options.maxLength ?? Infinity;

  for (const [name, value] of Object.entries(record || {})) {
    if (isSensitiveName(name)) {
      out[name] = REDACTED;
    } else if (typeof value === "string" && value.length > maxLength) {
      out[name] =
        value.slice(0, maxLength) + `…(${value.length} chars, replayed in full)`;
    } else {
      out[name] = value;
    }
  }

  return out;
}

// --- Result shaping ---------------------------------------------------

function pickOne(value, path) {
  const tokens = String(path)
    .replace(/\[(\*|\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current = [value];

  for (const token of tokens) {
    const next = [];

    for (const item of current) {
      if (item === null || item === undefined) {
        continue;
      }

      if (token === "*") {
        if (Array.isArray(item)) {
          next.push(...item);
        } else if (typeof item === "object") {
          next.push(...Object.values(item));
        }
      } else if (Array.isArray(item) && /^\d+$/.test(token)) {
        next.push(item[Number(token)]);
      } else if (typeof item === "object") {
        next.push(item[token]);
      }
    }

    current = next;
  }

  return String(path).includes("*") ? current : current[0];
}

export function pickPaths(value, paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return value;
  }

  const out = {};

  for (const path of paths) {
    out[path] = pickOne(value, path);
  }

  return out;
}

// --- Aggregation -------------------------------------------------------

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) : text;
}

function detectGraphQLOperation(url, requestBody) {
  const lastSegment = url.pathname.split("/").filter(Boolean).pop();

  if (lastSegment !== "graphql" || !requestBody) {
    return undefined;
  }

  try {
    const body = JSON.parse(requestBody);

    if (typeof body?.operationName === "string" && body.operationName) {
      return body.operationName;
    }
  } catch (error) {
    // not JSON
  }

  return undefined;
}

function fingerprint(endpoint) {
  const query = Object.fromEntries(
    Object.entries(endpoint.querySchema).map(([key, stat]) => [
      key,
      {
        t: stat.schema.type,
        req: stat.seenCount === endpoint.observationCount
      }
    ])
  );

  return JSON.stringify({
    tp: endpoint.templatePath,
    pp: endpoint.pathParams.map(param => param.name),
    q: query,
    b: endpoint.bodySchema,
    bReq: endpoint.bodySeenCount === endpoint.observationCount
  });
}

export function emptySite(site) {
  return { site, endpoints: {}, captures: 0, updatedAt: Date.now() };
}

export function mergeCapture(siteData, capture) {
  const url = parseUrl(capture.url);
  const gqlOperation = detectGraphQLOperation(url, capture.requestBody);
  const templated = gqlOperation
    ? { templatePath: url.pathname, pathParams: [] }
    : templatePath(url.pathname);
  const key =
    `${capture.method} ${url.host}${templated.templatePath}` +
    (gqlOperation ? `#${gqlOperation}` : "");
  let endpoint = siteData.endpoints[key];
  const isNew = endpoint === undefined;

  if (isNew) {
    const keys = Object.keys(siteData.endpoints);

    if (keys.length >= WEBMCP_LIMITS.maxEndpointsPerSite) {
      const oldest = Object.values(siteData.endpoints)
        .sort((a, b) => a.lastSeen - b.lastSeen)[0];

      if (oldest) {
        delete siteData.endpoints[oldest.key];
      }
    }

    const existingNames = new Set(
      Object.values(siteData.endpoints).map(item => item.toolName)
    );
    endpoint = {
      key,
      method: capture.method,
      origin: url.origin,
      host: url.host,
      templatePath: templated.templatePath,
      pathParams: templated.pathParams,
      gqlOperation,
      querySchema: {},
      lastQuery: {},
      bodySchema: undefined,
      bodySeenCount: 0,
      lastBody: undefined,
      lastHeaders: {},
      samples: [],
      observationCount: 0,
      firstSeen: capture.timestamp,
      lastSeen: capture.timestamp,
      toolName: toolNameFor(
        capture.method,
        templated.templatePath,
        gqlOperation,
        existingNames
      ),
      description: "",
      descriptionEdited: false,
      updatedAt: capture.timestamp
    };
    siteData.endpoints[key] = endpoint;
  }

  const before = isNew ? "" : fingerprint(endpoint);

  endpoint.observationCount += 1;
  endpoint.lastSeen = capture.timestamp;
  endpoint.lastHeaders = capture.requestHeaders || {};
  endpoint.lastQuery = Object.fromEntries(url.searchParams);
  endpoint.lastCredentials = capture.credentials || endpoint.lastCredentials;
  endpoint.via = capture.via || endpoint.via;

  for (const [name, value] of url.searchParams) {
    const schema = inferScalarFromString(value);
    const stat = endpoint.querySchema[name];

    if (stat === undefined) {
      endpoint.querySchema[name] = { schema, seenCount: 1 };
    } else {
      stat.schema = mergeSchemas(stat.schema, schema);
      stat.seenCount += 1;
    }
  }

  if (capture.requestBody !== undefined) {
    try {
      const parsed = JSON.parse(capture.requestBody);
      const schema = inferSchema(parsed);
      endpoint.bodySchema = endpoint.bodySchema === undefined
        ? schema
        : mergeSchemas(endpoint.bodySchema, schema);
      endpoint.bodySeenCount += 1;
      endpoint.lastBody = capture.requestBody;
    } catch (error) {
      // non-JSON body
    }
  }

  if (capture.responseBody !== undefined) {
    for (const previous of endpoint.samples) {
      previous.body = truncate(previous.body, WEBMCP_LIMITS.maxSampleBytes);
    }

    endpoint.samples.push({
      status: capture.status,
      body: truncate(capture.responseBody, WEBMCP_LIMITS.maxLatestSampleBytes),
      fullLength: capture.responseBody.length,
      timestamp: capture.timestamp
    });

    if (endpoint.samples.length > WEBMCP_LIMITS.maxSamples) {
      endpoint.samples.splice(
        0,
        endpoint.samples.length - WEBMCP_LIMITS.maxSamples
      );
    }
  }

  if (isNew || fingerprint(endpoint) !== before) {
    endpoint.updatedAt = Date.now();

    if (!endpoint.descriptionEdited) {
      endpoint.description = buildDescription(endpoint, url.host);
    }
  }

  siteData.captures += 1;
  siteData.updatedAt = Date.now();
  return endpoint;
}

const SKIP_REPLAY_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "accept-encoding",
  "accept-charset",
  "origin",
  "referer",
  "user-agent",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "date",
  "dnt",
  "expect",
  "cookie"
]);

function parseLastBody(endpoint) {
  if (endpoint.lastBody === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(endpoint.lastBody);
  } catch (error) {
    return undefined;
  }
}

export function buildInputSchema(endpoint) {
  const properties = {};
  const required = [];

  for (const param of endpoint.pathParams) {
    properties[param.name] = {
      type: "string",
      description: `Path parameter, e.g. "${param.sample}"`
    };
    required.push(param.name);
  }

  const reserved = new Set([
    ...endpoint.pathParams.map(param => param.name),
    "body"
  ]);
  const queryParams = [];

  for (const [name, stat] of Object.entries(endpoint.querySchema)) {
    const arg = reserved.has(name) ? `${name}_q` : name;
    properties[arg] = {
      ...stat.schema,
      description: `Query parameter "${name}"`
    };
    queryParams.push({ arg, name });

    if (stat.seenCount === endpoint.observationCount) {
      required.push(arg);
    }
  }

  if (endpoint.bodySchema !== undefined) {
    const example = parseLastBody(endpoint);
    properties.body = {
      ...endpoint.bodySchema,
      description:
        "Full JSON request body. `example` is a real recorded request " +
        "that works; send all of its fields and change only the ones " +
        "you need. Omitted fields are filled from it automatically.",
      ...(example !== undefined ? { example } : {})
    };

    if (endpoint.bodySeenCount === endpoint.observationCount) {
      required.push("body");
    }
  }

  return { inputSchema: { type: "object", properties, required }, queryParams };
}

function replayHeaders(endpoint) {
  const headers = {};

  for (const [name, value] of Object.entries(endpoint.lastHeaders)) {
    if (!SKIP_REPLAY_HEADERS.has(name)) {
      headers[name] = value;
    }
  }

  return headers;
}

function paramDefaults(endpoint, queryParams) {
  const defaults = {};

  for (const param of endpoint.pathParams) {
    defaults[param.name] = param.sample;
  }

  for (const { arg, name } of queryParams) {
    if (endpoint.lastQuery[name] !== undefined) {
      defaults[arg] = endpoint.lastQuery[name];
    }
  }

  return defaults;
}

export function isFirstParty(site, host) {
  const hostname = String(host || "").replace(/:\d+$/, "").toLowerCase();
  return hostname === site || hostname.endsWith("." + site);
}

// --- Usefulness scoring ------------------------------------------------
//
// Instead of a hard-coded blocklist, every endpoint is scored from what it
// actually returned: data-bearing JSON scores high, empty or constant
// acknowledgements score low. Known telemetry vendors only add a prior.

function parseSample(endpoint) {
  const sample = endpoint.samples[endpoint.samples.length - 1];

  if (!sample?.body) {
    return { parsed: undefined, size: 0 };
  }

  try {
    return { parsed: JSON.parse(sample.body), size: sample.body.length };
  } catch (error) {
    // Truncated sample: still count size, treat as unparsed object.
    return { parsed: undefined, size: sample.body.length, truncated: true };
  }
}

function largestArrayLength(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") {
    return 0;
  }

  let best = Array.isArray(value) ? value.length : 0;
  const children = Array.isArray(value) ? value.slice(0, 20) : Object.values(value);

  for (const child of children) {
    best = Math.max(best, largestArrayLength(child, depth + 1));
  }

  return best;
}

function countKeys(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== "object") {
    return 0;
  }

  const own = Array.isArray(value) ? 0 : Object.keys(value).length;
  return own + Object.values(value).slice(0, 20).reduce(
    (sum, child) => sum + countKeys(child, depth + 1),
    0
  );
}

export function scoreEndpoint(site, endpoint) {
  const reasons = [];
  let score = 0;
  const readOnly = isReadOnlyEndpoint(endpoint);
  const firstParty = isFirstParty(site, endpoint.host);
  const { parsed, size, truncated } = parseSample(endpoint);
  const arrayLength = largestArrayLength(parsed);
  const keys = countKeys(parsed);

  if (readOnly) {
    score += 2;
    reasons.push("read");
  }

  if (firstParty) {
    score += 1;
    reasons.push("first-party");
  } else {
    score -= 1;
    reasons.push("third-party");
  }

  const fullLength = endpoint.samples[endpoint.samples.length - 1]?.fullLength ?? size;

  if (endpoint.samples.length === 0 && endpoint.observationCount > 0) {
    score -= 2;
    reasons.push("no-body");
  } else if (size > 0 && size < 40) {
    score -= 2;
    reasons.push("tiny-body");
  } else if (truncated || fullLength >= WEBMCP_LIMITS.maxSampleBytes) {
    score += 2;
    reasons.push("large-body");
  }

  if (arrayLength >= 3) {
    score += 2;
    reasons.push(`list(${arrayLength})`);
  } else if (keys >= 8) {
    score += 1;
    reasons.push(`object(${keys} keys)`);
  }

  if (
    endpoint.observationCount >= 3 &&
    endpoint.samples.length >= 2 &&
    new Set(endpoint.samples.map(sample => sample.body)).size === 1
  ) {
    score -= 1;
    reasons.push("constant-response");
  }

  if (!readOnly && endpoint.lastBody !== undefined && size < 200) {
    score -= 1;
    reasons.push("fire-and-forget");
  }

  try {
    if (matchesNoiseSeed(parseUrl(endpoint.origin + endpoint.templatePath))) {
      score -= 2;
      reasons.push("telemetry-vendor");
    }
  } catch (error) {
    // unparsable origin
  }

  // A third-party ".json" file with no parameters is a static asset
  // (animation data, translations), not an API.
  if (
    !firstParty &&
    /\.json$/i.test(endpoint.templatePath) &&
    Object.keys(endpoint.querySchema).length === 0 &&
    endpoint.pathParams.length === 0
  ) {
    score -= 3;
    reasons.push("static-json");
  }

  if (typeof endpoint.tierOverride === "string") {
    reasons.push(`user:${endpoint.tierOverride}`);
  }

  // data: read + first-party + evidence of a list or a large body.
  // config: readable but small. noise: acknowledgements and telemetry.
  const tier = endpoint.tierOverride ||
    (score >= 5 ? "data" : score >= 1 ? "config" : "noise");

  return { score, tier, reasons };
}

// --- DOM ↔ API matching ---------------------------------------------------
//
// Which recorded endpoint produced what the user sees? Compare the text in
// an ARIA snapshot with the string values in each endpoint's response
// sample; endpoints sharing many texts with the page back its visible list.

export function snapshotTexts(snapshot) {
  const texts = new Set();

  for (const rawLine of String(snapshot || "").split("\n")) {
    const line = rawLine.trim();

    for (const match of line.matchAll(/"([^"]{3,120})"/g)) {
      texts.add(match[1].trim());
    }

    const textMatch = /^-\s*text:\s*(.+)$/.exec(line);

    if (textMatch && textMatch[1].length >= 3) {
      texts.add(textMatch[1].replace(/^"|"$/g, "").trim());
    }
  }

  return [...texts].filter(text => !/^[\d\s.,:%/-]+$/.test(text));
}

function sampleStrings(value, out = [], depth = 0) {
  if (depth > 8 || out.length > 2000) {
    return out;
  }

  if (typeof value === "string") {
    if (value.length >= 3 && value.length <= 2000) {
      out.push(value);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      sampleStrings(item, out, depth + 1);
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      sampleStrings(item, out, depth + 1);
    }
  }

  return out;
}

export function matchSnapshot(site, endpoints, snapshot, options = {}) {
  const texts = snapshotTexts(snapshot);
  const minMatches = options.minMatches ?? 2;
  const suggestions = [];

  if (texts.length === 0) {
    return suggestions;
  }

  for (const endpoint of endpoints) {
    const { parsed } = parseSample(endpoint);

    if (parsed === undefined) {
      continue;
    }

    const strings = sampleStrings(parsed);

    if (strings.length === 0) {
      continue;
    }

    const joined = strings.join(" ");
    const matched = [];

    for (const text of texts) {
      if (joined.includes(text)) {
        matched.push(text);
      } else if (text.length > 24) {
        const head = text.slice(0, 24);

        if (joined.includes(head)) {
          matched.push(text);
        }
      }
    }

    // Two shared texts, or one long distinctive one (a title, a full
    // sentence), is enough evidence that this endpoint feeds the page.
    const strongSingle = matched.length === 1 && matched[0].length >= 12;

    if (matched.length >= minMatches || strongSingle) {
      const { score, tier } = scoreEndpoint(site, endpoint);
      suggestions.push({
        name: endpoint.toolName,
        method: endpoint.method,
        templatePath: endpoint.templatePath,
        readOnly: isReadOnlyEndpoint(endpoint),
        tier,
        score,
        matched: matched.length,
        of: texts.length,
        items: largestArrayLength(parsed),
        examples: matched.slice(0, 3)
      });
    }
  }

  return suggestions
    .sort((a, b) => b.matched - a.matched || b.score - a.score)
    .slice(0, options.limit ?? 3);
}

export function formatSuggestions(suggestions) {
  if (!suggestions || suggestions.length === 0) {
    return "";
  }

  const lines = suggestions.map(s =>
    `# webmcp: ${s.readOnly ? "" : "[write] "}${s.name} (${s.method} ${s.templatePath}) ` +
    `matched ${s.matched}/${s.of} visible texts` +
    (s.items ? `, returns ${s.items} items` : "") +
    (s.readOnly
      ? ` → tab.webmcp.callTool("${s.name}") returns this data in one call`
      : " → needs user confirmation before replay")
  );

  return lines.join("\n");
}

// --- Cross-session memory -------------------------------------------------
//
// A skeleton remembers which endpoints a site has, without headers, body
// examples, response samples, or sensitive query values. On the next visit
// the GET ones are probed so the catalog fills in seconds instead of after
// the user scrolls.

function probeUrlFor(endpoint) {
  if (!isReadOnlyEndpoint(endpoint) || endpoint.method !== "GET") {
    return undefined;
  }

  const pathArgs = {};

  for (const param of endpoint.pathParams) {
    pathArgs[param.name] = param.sample;
  }

  try {
    const path = fillTemplate(endpoint.templatePath, pathArgs);
    const query = Object.entries(endpoint.lastQuery || {}).filter(
      ([name]) => !isSensitiveName(name)
    );
    return endpoint.origin + path + formatQuery(query);
  } catch (error) {
    return undefined;
  }
}

export function skeletonFor(site, siteData, now = Date.now()) {
  return {
    format: "webmcp-site-memory",
    version: 1,
    site,
    savedAt: now,
    endpoints: Object.values(siteData?.endpoints || {})
      .filter(endpoint => endpoint.observationCount > 0 || endpoint.remembered)
      .map(endpoint => {
        const observed = endpoint.observationCount > 0;
        const rating = observed
          ? scoreEndpoint(site, endpoint)
          : { score: endpoint.rememberedScore ?? 0, tier: endpoint.rememberedTier || "config" };
        const { score, tier } = rating;
        return {
          key: endpoint.key,
          method: endpoint.method,
          origin: endpoint.origin,
          host: endpoint.host,
          templatePath: endpoint.templatePath,
          gqlOperation: endpoint.gqlOperation,
          toolName: endpoint.toolName,
          pathParams: endpoint.pathParams,
          probeUrl: observed ? probeUrlFor(endpoint) : endpoint.probeUrl,
          score,
          tier,
          tierOverride: endpoint.tierOverride,
          readOnlyOverride: endpoint.readOnlyOverride,
          description: endpoint.descriptionEdited ? endpoint.description : undefined,
          lastSeen: endpoint.lastSeen,
          sessions: (endpoint.sessions || 0) + (observed ? 1 : 0)
        };
      })
  };
}

export function applySkeleton(siteData, skeleton) {
  if (!skeleton || skeleton.format !== "webmcp-site-memory") {
    return 0;
  }

  let applied = 0;

  for (const remembered of skeleton.endpoints || []) {
    if (!remembered?.key || !remembered.templatePath || !remembered.origin) {
      continue;
    }

    let endpoint = siteData.endpoints[remembered.key];

    if (!endpoint) {
      let host = remembered.host;

      if (!host) {
        try {
          host = parseUrl(remembered.origin).host;
        } catch (error) {
          continue;
        }
      }

      endpoint = {
        key: remembered.key,
        method: remembered.method,
        origin: remembered.origin,
        host,
        templatePath: remembered.templatePath,
        pathParams: remembered.pathParams || [],
        gqlOperation: remembered.gqlOperation,
        querySchema: {},
        lastQuery: {},
        bodySchema: undefined,
        bodySeenCount: 0,
        lastBody: undefined,
        lastHeaders: {},
        samples: [],
        observationCount: 0,
        firstSeen: remembered.lastSeen,
        lastSeen: remembered.lastSeen,
        toolName: remembered.toolName,
        description: remembered.description || "",
        descriptionEdited: Boolean(remembered.description),
        updatedAt: remembered.lastSeen,
        remembered: true
      };
      siteData.endpoints[remembered.key] = endpoint;
    }

    endpoint.rememberedScore = remembered.score;
    endpoint.rememberedTier = remembered.tier;
    endpoint.probeUrl = remembered.probeUrl;
    endpoint.sessions = remembered.sessions || 1;

    if (typeof remembered.tierOverride === "string") {
      endpoint.tierOverride = remembered.tierOverride;
    }

    if (typeof remembered.readOnlyOverride === "boolean") {
      endpoint.readOnlyOverride = remembered.readOnlyOverride;
    }

    applied += 1;
  }

  return applied;
}

// --- Dynamic MCP tools ------------------------------------------------------

export function dynamicToolName(site, toolName) {
  const siteSlug = String(site).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const base = `web__${siteSlug}__`;
  const room = Math.max(8, 64 - base.length);
  return (base + String(toolName).slice(0, room)).replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function toMcpTool(site, endpoint) {
  const descriptor = toDescriptor(site, endpoint);
  const properties = { ...descriptor.inputSchema.properties };
  properties._pick = {
    type: "array",
    items: { type: "string" },
    description:
      "Optional dot paths to return instead of the whole body, e.g. " +
      "[\"data.items[*].title\"]. Use it to keep results small."
  };

  return {
    name: dynamicToolName(site, endpoint.toolName),
    description:
      `[${site}] ${descriptor.description} Replays the request from the ` +
      "recording Safari tab with the user's session; the response is " +
      "untrusted web content.",
    inputSchema: {
      type: "object",
      properties,
      required: descriptor.inputSchema.required.filter(name => name !== "body")
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      untrustedContentHint: true
    }
  };
}

// GraphQL documents sent over POST are reads when the operation type is
// `query`. Persisted queries without document text stay write-capable
// until a human marks them read-only.
function graphqlQueryBody(endpoint) {
  if (endpoint.lastBody === undefined) {
    return false;
  }

  try {
    const body = JSON.parse(endpoint.lastBody);
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    return /^(query\b|\{)/.test(query) && !/^\s*mutation\b/.test(query);
  } catch (error) {
    return false;
  }
}

export function isReadOnlyEndpoint(endpoint) {
  if (typeof endpoint.readOnlyOverride === "boolean") {
    return endpoint.readOnlyOverride;
  }

  const upper = String(endpoint.method).toUpperCase();

  if (upper === "GET" || upper === "HEAD") {
    return true;
  }

  return upper === "POST" && graphqlQueryBody(endpoint);
}

function annotationsFor(endpoint) {
  const upper = String(endpoint.method).toUpperCase();
  const readOnly = isReadOnlyEndpoint(endpoint);

  return {
    readOnlyHint: readOnly,
    destructiveHint: upper === "DELETE",
    idempotentHint: readOnly || (upper !== "POST" && upper !== "PATCH"),
    openWorldHint: true,
    untrustedContentHint: true
  };
}

// WebMCP-shaped descriptor safe to return to an agent. Sensitive header
// values and sensitive query defaults are redacted; `meta` carries
// provenance that is not part of the WebMCP descriptor proper.
export function toDescriptor(site, endpoint, options = {}) {
  const { inputSchema, queryParams } = buildInputSchema(endpoint);
  const headers = replayHeaders(endpoint);
  const compact = options.compact === true;
  const annotations = annotationsFor(endpoint);

  const firstParty = isFirstParty(site, endpoint.host);
  const rating = scoreEndpoint(site, endpoint);

  if (compact) {
    return {
      name: endpoint.toolName,
      method: endpoint.method,
      host: endpoint.host,
      templatePath: endpoint.templatePath,
      gqlOperation: endpoint.gqlOperation,
      readOnlyHint: annotations.readOnlyHint,
      firstParty,
      tier: rating.tier,
      score: rating.score,
      params: Object.keys(inputSchema.properties),
      observationCount: endpoint.observationCount,
      remembered: endpoint.observationCount === 0 && endpoint.remembered === true
    };
  }

  const descriptor = {
    name: endpoint.toolName,
    description: endpoint.description,
    inputSchema,
    annotations,
    meta: {
      site,
      origin: endpoint.origin,
      firstParty,
      method: endpoint.method,
      templatePath: endpoint.templatePath,
      gqlOperation: endpoint.gqlOperation,
      via: endpoint.via,
      credentials: endpoint.lastCredentials,
      tier: rating.tier,
      score: rating.score,
      reasons: rating.reasons,
      observationCount: endpoint.observationCount,
      firstSeen: endpoint.firstSeen,
      lastSeen: endpoint.lastSeen,
      replayHeaders: Object.keys(headers),
      paramDefaults: redactRecord(paramDefaults(endpoint, queryParams), {
        maxLength: 160
      })
    }
  };

  if (options.samples) {
    descriptor.meta.samples = endpoint.samples.map(sample => ({
      status: sample.status,
      timestamp: sample.timestamp,
      fullLength: sample.fullLength,
      body: truncate(sample.body, WEBMCP_LIMITS.maxSampleBytes)
    }));
  }

  return descriptor;
}

// Export form: strictly the WebMCP descriptor fields plus provenance,
// no replay headers and no recorded parameter values.
export function toExportDescriptor(site, endpoint) {
  const descriptor = toDescriptor(site, endpoint);
  const properties = {};

  for (const [name, schema] of Object.entries(
    descriptor.inputSchema.properties
  )) {
    const { example, ...rest } = schema;
    properties[name] = name === "body" && example !== undefined
      ? { ...rest, example: redactRecord(
          typeof example === "object" && example !== null &&
          !Array.isArray(example)
            ? example
            : {}
        ) }
      : rest;
  }

  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: { ...descriptor.inputSchema, properties },
    annotations: descriptor.annotations,
    meta: {
      site,
      origin: endpoint.origin,
      method: endpoint.method,
      templatePath: endpoint.templatePath,
      gqlOperation: endpoint.gqlOperation
    }
  };
}

// Resolve agent arguments into one concrete HTTP request. Path and
// query values fall back to the last recorded value when the caller
// omits or blanks them (session tokens the agent cannot know). A
// partial JSON body is merged over the last recorded body.
export function buildReplayRequest(endpoint, args = {}) {
  const { queryParams } = buildInputSchema(endpoint);
  const defaults = paramDefaults(endpoint, queryParams);
  const resolve = name => {
    const value = args[name];
    return value === undefined || value === null || value === ""
      ? defaults[name]
      : value;
  };
  const pathArgs = { ...args };

  for (const param of endpoint.pathParams) {
    pathArgs[param.name] = resolve(param.name);
  }

  const path = fillTemplate(endpoint.templatePath, pathArgs);
  const query = new Map();

  for (const { arg, name } of queryParams) {
    const value = resolve(arg);

    if (value === undefined || value === null) {
      continue;
    }

    query.set(
      name,
      typeof value === "object" ? JSON.stringify(value) : String(value)
    );
  }

  const url = endpoint.origin + path + formatQuery([...query.entries()]);
  const headers = replayHeaders(endpoint);
  let body;

  if (endpoint.method !== "GET" && endpoint.method !== "HEAD") {
    const provided = args.body;
    const example = parseLastBody(endpoint);
    const isObject = value =>
      typeof value === "object" && value !== null && !Array.isArray(value);

    if (typeof provided === "string") {
      body = provided;
    } else if (provided !== undefined && provided !== null) {
      body = JSON.stringify(
        isObject(example) && isObject(provided)
          ? { ...example, ...provided }
          : provided
      );
    } else if (example !== undefined) {
      body = JSON.stringify(example);
    }

    if (body !== undefined) {
      headers["content-type"] ??= "application/json";
    } else {
      delete headers["content-type"];
    }
  } else {
    delete headers["content-type"];
  }

  return {
    method: endpoint.method,
    url,
    headers,
    body,
    credentials: endpoint.lastCredentials || "include"
  };
}

// --- Session store ------------------------------------------------------

export function createWebmcpStore(now = Date.now) {
  const sites = new Map();
  const recordingTabs = new Map();

  function siteData(site, create) {
    let data = sites.get(site);

    if (!data && create) {
      data = emptySite(site);
      sites.set(site, data);
    }

    return data;
  }

  function endpointByName(site, name) {
    const data = siteData(site, false);

    if (!data) {
      throw new Error(`webmcp_unknown_site: ${site}`);
    }

    const endpoint = Object.values(data.endpoints).find(
      item => item.toolName === name
    );

    if (!endpoint) {
      throw new Error(`webmcp_unknown_tool: ${name}`);
    }

    return endpoint;
  }

  // Highest usefulness score first, then most recently seen. Endpoints that
  // are only remembered from an earlier session (never observed now) sort
  // last; noise is hidden unless asked for.
  function sortedEndpoints(site, options = {}) {
    const data = siteData(site, false);

    if (!data) {
      return [];
    }

    return Object.values(data.endpoints)
      .map(endpoint => ({ endpoint, rating: scoreEndpoint(site, endpoint) }))
      .filter(({ endpoint, rating }) =>
        options.all === true ||
        (rating.tier !== "noise" &&
          (endpoint.observationCount > 0 || options.includeRemembered === true))
      )
      .sort((a, b) =>
        Number(b.endpoint.observationCount > 0) - Number(a.endpoint.observationCount > 0) ||
        b.rating.score - a.rating.score ||
        b.endpoint.lastSeen - a.endpoint.lastSeen
      )
      .map(({ endpoint }) => endpoint);
  }

  return {
    record(tabId, site, identity = null) {
      const existing = recordingTabs.get(String(tabId));
      recordingTabs.set(String(tabId), {
        site,
        identity: identity || existing?.identity || null,
        startedAt: existing?.startedAt ?? now()
      });
      siteData(site, true);
    },

    // Tab ids are "window:index" coordinates that shift when other tabs
    // close. Callers that hold the persistent tab identity object can
    // re-key the recording entry after the identity has been re-resolved.
    syncIdentity(identity) {
      if (!identity) {
        return null;
      }

      for (const [tabId, entry] of recordingTabs) {
        if (entry.identity === identity) {
          if (tabId !== String(identity.id)) {
            recordingTabs.delete(tabId);
            recordingTabs.set(String(identity.id), entry);
          }

          return entry;
        }
      }

      return null;
    },

    setOptions(tabId, options) {
      const entry = recordingTabs.get(String(tabId));

      if (entry) {
        entry.options = { ...(entry.options || {}), ...(options || {}) };
      }

      return entry || null;
    },

    setSite(tabId, site) {
      const entry = recordingTabs.get(String(tabId));

      if (entry && site && entry.site !== site) {
        entry.site = site;
        siteData(site, true);
      }

      return entry || null;
    },

    stop(tabId) {
      return recordingTabs.delete(String(tabId));
    },

    recording(tabId) {
      return recordingTabs.get(String(tabId)) || null;
    },

    recordingTabIds() {
      return [...recordingTabs.keys()];
    },

    retarget(oldTabId, newTabId) {
      const entry = recordingTabs.get(String(oldTabId));

      if (entry && String(oldTabId) !== String(newTabId)) {
        recordingTabs.delete(String(oldTabId));
        recordingTabs.set(String(newTabId), entry);
      }
    },

    mergeCaptures(site, captures) {
      const data = siteData(site, true);
      let merged = 0;

      for (const capture of captures || []) {
        try {
          if (
            typeof capture?.method === "string" &&
            typeof capture?.url === "string" &&
            shouldKeep(capture)
          ) {
            mergeCapture(data, capture);
            merged += 1;
          }
        } catch (error) {
          // one malformed capture must not poison the batch
        }
      }

      return merged;
    },

    listTools(site, options = {}) {
      return sortedEndpoints(site, options).map(endpoint =>
        toDescriptor(site, endpoint, options)
      );
    },

    // Endpoints worth exposing as first-class MCP tools: observed, read-only,
    // data-bearing. Capped so a busy site cannot flood the tool list.
    exposable(site, limit = 40) {
      return sortedEndpoints(site)
        .filter(endpoint =>
          isReadOnlyEndpoint(endpoint) &&
          scoreEndpoint(site, endpoint).tier === "data"
        )
        .slice(0, limit);
    },

    mcpTools(limit = 40) {
      const tools = [];

      for (const site of sites.keys()) {
        for (const endpoint of this.exposable(site, limit)) {
          tools.push({
            site,
            toolName: endpoint.toolName,
            tool: toMcpTool(site, endpoint)
          });
        }
      }

      return tools;
    },

    suggest(site, snapshot, options) {
      return matchSnapshot(site, sortedEndpoints(site), snapshot, options);
    },

    setTier(site, name, tier) {
      const endpoint = endpointByName(site, name);

      if (!["data", "config", "noise"].includes(tier)) {
        throw new Error(`webmcp_invalid_tier: ${tier}`);
      }

      endpoint.tierOverride = tier;
      endpoint.updatedAt = now();
      return toDescriptor(site, endpoint);
    },

    skeleton(site) {
      return skeletonFor(site, siteData(site, false), now());
    },

    remember(site, skeleton) {
      return applySkeleton(siteData(site, true), skeleton);
    },

    // GET URLs worth probing on a fresh visit: remembered read endpoints
    // that have not been observed in this session yet.
    rememberedProbeUrls(site, limit = 20) {
      const data = siteData(site, false);

      if (!data) {
        return [];
      }

      return Object.values(data.endpoints)
        .filter(endpoint =>
          endpoint.observationCount === 0 &&
          typeof endpoint.probeUrl === "string" &&
          endpoint.rememberedTier !== "noise"
        )
        .sort((a, b) => (b.rememberedScore || 0) - (a.rememberedScore || 0))
        .slice(0, limit)
        .map(endpoint => endpoint.probeUrl);
    },

    // Signature of the exposable tool set, for tools/list_changed.
    exposureSignature(limit = 40) {
      return this.mcpTools(limit).map(entry => entry.tool.name).sort().join("\n");
    },

    describe(site, name) {
      return toDescriptor(site, endpointByName(site, name), {
        samples: true
      });
    },

    endpoint(site, name) {
      return endpointByName(site, name);
    },

    buildRequest(site, name, args) {
      return buildReplayRequest(endpointByName(site, name), args);
    },

    setDescription(site, name, text) {
      const endpoint = endpointByName(site, name);
      endpoint.description = String(text);
      endpoint.descriptionEdited = true;
      endpoint.updatedAt = now();
      return toDescriptor(site, endpoint);
    },

    // A human-confirmed override for read endpoints that use POST (persisted
    // GraphQL queries, "browse"/"search" style RPCs). The agent must obtain
    // the user's confirmation before marking a tool read-only.
    setReadOnly(site, name, readOnly) {
      const endpoint = endpointByName(site, name);
      endpoint.readOnlyOverride = Boolean(readOnly);
      endpoint.updatedAt = now();
      return toDescriptor(site, endpoint);
    },

    sites() {
      return [...sites.values()].map(data => ({
        site: data.site,
        endpoints: Object.keys(data.endpoints).length,
        captures: data.captures,
        recordingTabs: [...recordingTabs.entries()]
          .filter(([, entry]) => entry.site === data.site)
          .map(([tabId]) => tabId),
        updatedAt: data.updatedAt
      }));
    },

    summary(site) {
      const data = siteData(site, false);
      return {
        site,
        endpoints: data ? Object.keys(data.endpoints).length : 0,
        captures: data ? data.captures : 0
      };
    },

    exportSite(site) {
      return {
        format: "webmcp-tools",
        version: 1,
        site,
        exportedAt: now(),
        tools: sortedEndpoints(site).map(endpoint =>
          toExportDescriptor(site, endpoint)
        )
      };
    },

    clear(site) {
      if (site === undefined || site === null) {
        sites.clear();
        return { cleared: "all" };
      }

      sites.delete(site);
      return { cleared: site };
    },

    reset() {
      sites.clear();
      recordingTabs.clear();
    }
  };
}
