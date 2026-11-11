// Downloads for the fetch_reference tool: reference material (datasheets, drawings, vendor
// models) into the project. Only data file types, public http(s) hosts, a size limit, and
// redirects followed by hand so every hop is checked. Uses Chromium's network stack (net.fetch),
// which honours the system proxy settings.
import { net } from "electron";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const REFERENCE_EXT = ["step", "stp", "iges", "igs", "brep", "stl", "3mf", "obj", "sc", "dxf", "svg", "pdf",
  "png", "jpg", "jpeg", "webp", "gif", "txt", "md", "csv", "json"];
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 120_000;

export interface Downloaded { data: Buffer; name: string; contentType: string; finalUrl: string; sha256: string }

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function checkHost(u: URL): Promise<void> {
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`only http(s) URLs can be downloaded (got ${u.protocol})`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost")) throw new Error("local network addresses are not allowed");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (addrs.some(privateAddress)) throw new Error("local or private network addresses are not allowed");
}

/** A safe file name with an allowed extension, from the agent's choice, the headers or the URL. */
export function referenceName(wanted: string | undefined, url: URL, disposition: string | null): string {
  const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? "")?.[1];
  let raw = wanted || (fromHeader ? decodeURIComponent(fromHeader) : "") || decodeURIComponent(url.pathname.split("/").pop() || "");
  raw = raw.split(/[\\/]/).pop()!.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  const ext = raw.includes(".") ? raw.split(".").pop()!.toLowerCase() : "";
  if (!REFERENCE_EXT.includes(ext)) throw new Error(`"${raw || url.pathname}" is not an accepted file type (${REFERENCE_EXT.join(", ")}). Pass a filename with the right extension if the URL has none.`);
  return raw;
}

export async function downloadReference(rawUrl: string, wantedName?: string): Promise<Downloaded> {
  let url = new URL(rawUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await checkHost(url);
      res = await net.fetch(url.toString(), { redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": "SlashCAD (reference download)" } });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location")!, url);
        continue;
      }
      break;
    }
    if (!res || res.status >= 300) throw new Error(`download failed: HTTP ${res?.status ?? "?"}`);
    const contentType = res.headers.get("content-type") ?? "";
    const name = referenceName(wantedName, url, res.headers.get("content-disposition"));
    if (/text\/html/i.test(contentType)) throw new Error("the URL returned a web page, not a file; find the direct download link");
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) throw new Error(`file too large (${(declared / 1e6).toFixed(0)} MB; limit ${MAX_BYTES / 1e6} MB)`);
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { ctrl.abort(); throw new Error(`file too large (limit ${MAX_BYTES / 1e6} MB)`); }
      chunks.push(Buffer.from(value));
    }
    const data = Buffer.concat(chunks);
    return { data, name, contentType, finalUrl: url.toString(), sha256: createHash("sha256").update(data).digest("hex") };
  } finally {
    clearTimeout(timer);
  }
}
