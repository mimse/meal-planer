const MAX_PATH_LENGTH = 2_048;

function decodePathOnce(pathname: string, label: string): string {
  if (pathname.length > MAX_PATH_LENGTH) throw new Error(`${label} exceeds ${MAX_PATH_LENGTH} characters`);
  if (/%(?![0-9a-f]{2})/iu.test(pathname)) throw new Error(`${label} contains a malformed percent escape`);
  if (/%(?:25|2f|5c)/iu.test(pathname)) {
    throw new Error(`${label} contains unsafe source path encoding`);
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new Error(`${label} contains invalid percent-encoded UTF-8`);
  }
  if (decoded.includes("\\")) throw new Error(`${label} contains an unsafe source path separator`);
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} contains an unsafe source path traversal segment`);
  }
  return decoded;
}

function rawPathname(value: string): string {
  const end = value.search(/[?#]/u);
  const route = end === -1 ? value : value.slice(0, end);
  const authority = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(route)?.[0] ?? (route.startsWith("//") ? "//" : null);
  if (authority === null) return route;
  const pathStart = route.indexOf("/", authority.length);
  return pathStart === -1 ? "/" : route.slice(pathStart);
}

export function assertSafeRawUrlPath(value: string, label: string): void {
  if (value.includes("\\")) throw new Error(`${label} contains an unsafe source path separator`);
  decodePathOnce(rawPathname(value), label);
}

/**
 * Enforces a conservative routing-equivalent path boundary. Encoded separators
 * and encoded percent signs are rejected so no downstream layer can reinterpret
 * the path with an additional decode pass.
 */
export function assertUrlWithinSourcePath(
  candidate: URL,
  base: URL,
  label: string,
  rawValue?: string,
): void {
  if (rawValue !== undefined) assertSafeRawUrlPath(rawValue, label);
  const candidatePath = decodePathOnce(candidate.pathname, label);
  const basePath = decodePathOnce(base.pathname, "Source base URL path");
  if (basePath === "/") return;
  const scope = basePath.replace(/\/+$/u, "");
  if (candidatePath !== scope && !candidatePath.startsWith(`${scope}/`)) {
    throw new Error(`${label} is outside configured source path scope`);
  }
}
