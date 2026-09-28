import type { Database } from "bun:sqlite";

const MAX_URL_LENGTH = 2_048;
const MAX_HEADER_LENGTH = 1_024;
const MEDIA_TYPES = new Set([
  "text/plain",
  "application/xml",
  "text/xml",
  "text/html",
  "application/xhtml+xml",
]);

export type HttpCacheEntry = {
  readonly url: string;
  readonly finalUrl: string;
  readonly mediaType: string;
  readonly body: string;
  readonly fetchedAt: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
};

export type HttpCachePut = Omit<HttpCacheEntry, "fetchedAt">;

export type HttpCacheOptions = {
  readonly maxEntries: number;
  readonly maxBodyBytes: number;
  readonly now?: () => string;
};

type CacheRow = {
  url: unknown;
  finalUrl: unknown;
  mediaType: unknown;
  body: unknown;
  fetchedAt: unknown;
  etag: unknown;
  lastModified: unknown;
  accessSequence: unknown;
};

function validateUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new Error(`${label} must be a bounded URL string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw new Error(`${label} must be an HTTP(S) URL without credentials`);
  }
  if (url.hash !== "") throw new Error(`${label} must not contain a fragment`);
  if (url.href !== value) throw new Error(`${label} must be in canonical URL form`);
  return value;
}

function validateOptionalHeader(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_HEADER_LENGTH
    || /[\r\n\0]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validateEtag(value: unknown): string | null {
  const etag = validateOptionalHeader(value, "HTTP cache ETag");
  if (etag !== null && !/^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/u.test(etag)) {
    throw new Error("HTTP cache ETag is invalid");
  }
  return etag;
}

function validateLastModified(value: unknown): string | null {
  const lastModified = validateOptionalHeader(value, "HTTP cache Last-Modified");
  if (lastModified !== null && Number.isNaN(Date.parse(lastModified))) {
    throw new Error("HTTP cache Last-Modified is invalid");
  }
  return lastModified;
}

export class HttpCacheRepository {
  private readonly maxEntries: number;
  private readonly maxBodyBytes: number;
  private readonly now: () => string;

  constructor(private readonly database: Database, options: HttpCacheOptions) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0 || options.maxEntries > 10_000) {
      throw new Error("HTTP cache entry bound must be between 1 and 10000");
    }
    if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes <= 0 || options.maxBodyBytes > 16 * 1024 * 1024) {
      throw new Error("HTTP cache body bound must be between 1 and 16777216 bytes");
    }
    this.maxEntries = options.maxEntries;
    this.maxBodyBytes = options.maxBodyBytes;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get(url: string): HttpCacheEntry | null {
    const identity = validateUrl(url, "HTTP cache URL");
    return this.database.transaction(() => {
      const row = this.database.query<CacheRow, [string]>(`
        SELECT url, final_url AS finalUrl, media_type AS mediaType, body,
               fetched_at AS fetchedAt, etag, last_modified AS lastModified,
               access_sequence AS accessSequence
        FROM http_cache WHERE url = ?
      `).get(identity);
      if (row === null) return null;
      const validated = this.validateRow(row);
      this.database.query("UPDATE http_cache SET access_sequence = ? WHERE url = ?")
        .run(this.nextSequence(), identity);
      return validated;
    }).immediate();
  }

  put(input: HttpCachePut): HttpCacheEntry {
    const fetchedAt = this.now();
    const candidate = this.validateRow({ ...input, fetchedAt, accessSequence: 0 });
    return this.database.transaction(() => {
      const accessSequence = this.nextSequence();
      this.database.query(`
        INSERT INTO http_cache (
          url, final_url, media_type, body, fetched_at, etag, last_modified, access_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
          final_url = excluded.final_url,
          media_type = excluded.media_type,
          body = excluded.body,
          fetched_at = excluded.fetched_at,
          etag = excluded.etag,
          last_modified = excluded.last_modified,
          access_sequence = excluded.access_sequence
      `).run(
        candidate.url,
        candidate.finalUrl,
        candidate.mediaType,
        candidate.body,
        candidate.fetchedAt,
        candidate.etag,
        candidate.lastModified,
        accessSequence,
      );
      const excess = (this.database.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM http_cache",
      ).get()?.count ?? 0) - this.maxEntries;
      if (excess > 0) {
        this.database.query(`
          DELETE FROM http_cache WHERE url IN (
            SELECT url FROM http_cache ORDER BY access_sequence, url LIMIT ?
          )
        `).run(excess);
      }
      return candidate;
    }).immediate();
  }

  count(): number {
    return this.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM http_cache").get()?.count ?? 0;
  }

  private nextSequence(): number {
    const maximum = this.database.query<{ value: number }, []>(
      "SELECT coalesce(max(access_sequence), 0) AS value FROM http_cache",
    ).get()?.value ?? 0;
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum >= Number.MAX_SAFE_INTEGER) {
      throw new Error("HTTP cache access sequence is invalid or exhausted");
    }
    return maximum + 1;
  }

  private validateRow(row: CacheRow): HttpCacheEntry {
    const url = validateUrl(row.url, "HTTP cache URL");
    const finalUrl = validateUrl(row.finalUrl, "HTTP cache final URL");
    if (typeof row.mediaType !== "string" || !MEDIA_TYPES.has(row.mediaType)) {
      throw new Error("HTTP cache media type is invalid");
    }
    if (typeof row.body !== "string" || Buffer.byteLength(row.body, "utf8") > this.maxBodyBytes) {
      throw new Error(`HTTP cache body exceeds ${this.maxBodyBytes} bytes`);
    }
    if (
      typeof row.fetchedAt !== "string"
      || row.fetchedAt.length > 30
      || Number.isNaN(Date.parse(row.fetchedAt))
      || new Date(row.fetchedAt).toISOString() !== row.fetchedAt
    ) {
      throw new Error("HTTP cache fetched-at timestamp is invalid");
    }
    if (!Number.isSafeInteger(row.accessSequence) || (row.accessSequence as number) < 0) {
      throw new Error("HTTP cache access sequence is invalid");
    }
    return {
      url,
      finalUrl,
      mediaType: row.mediaType,
      body: row.body,
      fetchedAt: row.fetchedAt,
      etag: validateEtag(row.etag),
      lastModified: validateLastModified(row.lastModified),
    };
  }
}
