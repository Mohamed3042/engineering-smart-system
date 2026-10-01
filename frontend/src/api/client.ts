/**
 * Thin fetch wrapper for the local backend (/api). Errors come back as
 * {"detail": {"code", "message", ...}}; validation errors as {"detail": [...]}.
 */

export class ApiError extends Error {
  status: number;
  code: string;
  detail: Record<string, unknown>;

  constructor(status: number, code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

type Query = Record<string, string | number | boolean | null | undefined | Array<string | number>>;

/** "/projects" → "/api/projects"; paths already under /api or /mcp stay as they are. */
export function buildUrl(path: string, query?: Query): string {
  const url = /^\/(api|mcp)(\/|$)/.test(path) ? path : `/api${path.startsWith("/") ? "" : "/"}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)));
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const d = detail as Record<string, unknown>;
    return new ApiError(res.status, String(d.code ?? "error"), String(d.message ?? res.statusText), d);
  }
  if (Array.isArray(detail)) {
    const first = detail[0] as { loc?: unknown[]; msg?: string } | undefined;
    const field = first?.loc?.slice(1).join(".");
    return new ApiError(res.status, "invalid", `${field ? `${field}: ` : ""}${first?.msg ?? "Invalid request"}`, {
      errors: detail,
    });
  }
  if (typeof detail === "string") return new ApiError(res.status, "error", detail);
  if (res.status === 0 || res.status >= 502)
    return new ApiError(res.status, "offline", "The local server is not responding. Check that it is running.");
  return new ApiError(res.status, "error", res.statusText || "Request failed");
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), init);
  } catch {
    throw new ApiError(0, "offline", "The local server is not responding. Check that it is running.");
  }
  if (!res.ok) {
    const err = await parseError(res);
    if (res.status === 401) window.dispatchEvent(new CustomEvent("ess:unauthorized"));
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>("GET", path, undefined, query),
  post: <T>(path: string, body?: unknown, query?: Query) => request<T>("POST", path, body ?? {}, query),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
  /** multipart upload: fields become form fields, files are appended under `fileField`. */
  upload: <T>(path: string, files: File | File[], fields: Record<string, string> = {}, fileField = "file") => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const f of Array.isArray(files) ? files : [files]) form.append(fileField, f);
    return request<T>("POST", path, form);
  },
};

/** Human message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

export function isApiError(err: unknown, code?: string): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code);
}
