import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export type FetchedRecipePage = {
  html: string;
  url: URL;
};

type RecipeRequest = (
  url: URL,
  validatedAddress: string,
  init: RequestInit,
  timeoutMs: number,
) => Promise<Response>;

export type RecipeFetchDependencies = {
  /** Test-only transport seam. Callers must opt in with allowTestTransport. */
  requestImpl?: RecipeRequest;
  /** Legacy test-only fetch seam. It does not pin the validated DNS address. */
  fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>;
  allowTestTransport?: boolean;
  resolveHostname?: (hostname: string) => Promise<readonly string[]>;
  requestInit?: Omit<RequestInit, "redirect">;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
};

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function isBlockedIpv4(address: string): boolean {
  const value = ipv4Number(address);
  return (
    value < 0x01000000
    || (value >= 0x0a000000 && value <= 0x0affffff)
    || (value >= 0x64400000 && value <= 0x647fffff)
    || (value >= 0x7f000000 && value <= 0x7fffffff)
    || (value >= 0xa9fe0000 && value <= 0xa9feffff)
    || (value >= 0xac100000 && value <= 0xac1fffff)
    || (value >= 0xc0000000 && value <= 0xc00000ff)
    || (value >= 0xc0000200 && value <= 0xc00002ff)
    || (value >= 0xc0586300 && value <= 0xc05863ff)
    || (value >= 0xc0a80000 && value <= 0xc0a8ffff)
    || (value >= 0xc6120000 && value <= 0xc613ffff)
    || (value >= 0xc6336400 && value <= 0xc63364ff)
    || (value >= 0xcb007100 && value <= 0xcb0071ff)
    || value >= 0xe0000000
  );
}

function expandIpv6(address: string): number[] {
  const [left = "", right = ""] = address.toLowerCase().split("::", 2);
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  const omitted = 8 - leftParts.length - rightParts.length;
  return [...leftParts, ...Array(Math.max(omitted, 0)).fill("0"), ...rightParts]
    .map((part) => Number.parseInt(part || "0", 16));
}

function isBlockedIpv6(address: string): boolean {
  const parts = expandIpv6(address);
  const [first = 0, second = 0, third = 0, fourth = 0, fifth = 0, sixth = 0, seventh = 0, eighth = 0] = parts;

  if (parts.every((part) => part === 0) || parts.slice(0, 7).every((part) => part === 0) && eighth === 1) {
    return true;
  }
  const isIpv4Mapped = first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0 && sixth === 0xffff;
  if (isIpv4Mapped) {
    return isBlockedIpv4(`${seventh >> 8}.${seventh & 0xff}.${eighth >> 8}.${eighth & 0xff}`);
  }

  // Public IPv6 unicast allocations are inside 2000::/3. Keeping a
  // conservative allow-list blocks local-use translation, site-local,
  // unique-local, link-local, multicast, and future reserved space.
  if ((first & 0xe000) !== 0x2000) return true;

  // IANA special-purpose ranges inside 2000::/3 that are not globally
  // routable, including protocol assignments, documentation, and 6to4.
  if (first === 0x2001 && second <= 0x01ff) return true;
  if (first === 0x2001 && second === 0x0db8) return true;
  if (first === 0x2002) return true;
  if (first === 0x3fff && (second & 0xf000) === 0) return true;

  return false;
}

function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  return version === 4 ? isBlockedIpv4(address) : version === 6 ? isBlockedIpv6(address) : true;
}

function hostnameWithoutBrackets(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

function validateUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS recipe URLs are allowed");
  }

  const hostname = hostnameWithoutBrackets(url);
  if (isIP(hostname) && isBlockedAddress(hostname)) {
    throw new Error(`Recipe URL host is not publicly routable: ${url.hostname}`);
  }
}

async function resolveValidatedAddress(
  url: URL,
  resolveHostname: (hostname: string) => Promise<readonly string[]>,
): Promise<string> {
  const hostname = hostnameWithoutBrackets(url);
  const addresses = isIP(hostname) ? [hostname] : await resolveHostname(hostname);
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new Error(`Recipe URL host is not publicly routable: ${url.hostname}`);
  }
  return addresses[0]!;
}

async function defaultResolveHostname(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
}

function responseHeaders(headers: import("node:http").IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) result.append(name, entry);
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

export function createPinnedLookup(address: string): typeof import("node:dns").lookup {
  const family = isIP(address) as 4 | 6;
  return ((_hostname: string, options: unknown, callback?: (...args: unknown[]) => void) => {
    const resolvedCallback = typeof options === "function" ? options : callback;
    if (typeof resolvedCallback !== "function") {
      throw new TypeError("DNS lookup callback is required");
    }
    const all = typeof options === "object"
      && options !== null
      && "all" in options
      && options.all === true;
    queueMicrotask(() => {
      if (all) resolvedCallback(null, [{ address, family }]);
      else resolvedCallback(null, address, family);
    });
  }) as typeof import("node:dns").lookup;
}

function requestPinnedAddress(
  url: URL,
  validatedAddress: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const method = init.method?.toUpperCase() ?? "GET";
    if (method !== "GET") {
      reject(new Error(`Recipe requests only support GET, received ${method}`));
      return;
    }

    const headers = new Headers(init.headers);
    headers.set("host", url.host);
    const family = isIP(validatedAddress) as 4 | 6;
    const commonOptions = {
      method,
      headers: Object.fromEntries(headers.entries()),
      signal: init.signal ?? undefined,
      lookup: createPinnedLookup(validatedAddress),
    };
    const onResponse = (incoming: import("node:http").IncomingMessage) => {
      incoming.once("end", cleanup);
      incoming.once("close", cleanup);
      incoming.once("error", cleanup);
      resolve(new Response(Readable.toWeb(incoming) as unknown as BodyInit, {
        status: incoming.statusCode ?? 500,
        statusText: incoming.statusMessage ?? "",
        headers: responseHeaders(incoming.headers),
      }));
    };
    const request = url.protocol === "https:"
      ? httpsRequest(url, { ...commonOptions, servername: hostnameWithoutBrackets(url) }, onResponse)
      : httpRequest(url, commonOptions, onResponse);
    const timer = setTimeout(() => {
      request.destroy(new Error(`Recipe request timed out after ${timeoutMs}ms: ${url.href}`));
    }, timeoutMs);
    timer.unref();
    const cleanup = () => clearTimeout(timer);

    request.once("error", (error) => {
      cleanup();
      reject(error);
    });
    request.end();
  });
}

async function readHtmlWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Recipe response exceeds the ${maxBytes} byte limit`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      throw new Error(`Recipe response exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchRecipePage(
  url: URL,
  dependencies: RecipeFetchDependencies = {},
): Promise<FetchedRecipePage> {
  if ((dependencies.requestImpl || dependencies.fetchImpl) && dependencies.allowTestTransport !== true) {
    throw new Error("Custom recipe transports require allowTestTransport: true");
  }

  const requestImpl: RecipeRequest = dependencies.requestImpl
    ?? (dependencies.fetchImpl
      ? (requestUrl, _address, init) => dependencies.fetchImpl!(requestUrl, init)
      : requestPinnedAddress);
  const resolveHostname = dependencies.resolveHostname ?? defaultResolveHostname;
  const maxBytes = dependencies.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = dependencies.maxRedirects ?? 5;
  const timeoutMs = dependencies.timeoutMs ?? 10_000;
  let currentUrl = new URL(url);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    validateUrl(currentUrl);
    const validatedAddress = await resolveValidatedAddress(currentUrl, resolveHostname);
    const response = await requestImpl(currentUrl, validatedAddress, {
      ...dependencies.requestInit,
      redirect: "manual",
    }, timeoutMs);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error(`Recipe redirect is missing a Location header: ${currentUrl.href}`);
      if (redirectCount === maxRedirects) {
        throw new Error(`Recipe request exceeded ${maxRedirects} redirects: ${url.href}`);
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Recipe request failed with HTTP ${response.status}: ${currentUrl.href}`);
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
      await response.body?.cancel();
      throw new Error(`Recipe response has unsupported Content-Type: ${contentType ?? "missing"}`);
    }

    return { html: await readHtmlWithLimit(response, maxBytes), url: currentUrl };
  }

  throw new Error(`Recipe request exceeded ${maxRedirects} redirects: ${url.href}`);
}
