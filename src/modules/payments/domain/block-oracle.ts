import { config } from "@/modules/core/config";

//De dónde se lee la cadena de Bitcoin para el bono (docs/BONO_VERIFICABLE_V1.md §6).
//
//Dos exploradores públicos independientes son OBLIGATORIOS y tienen que coincidir:
//si uno no responde, no hay bono todavía; si discrepan, tampoco. El nodo propio,
//cuando está configurado, es una TERCERA verificación: si contesta y no coincide,
//bloquea; si no contesta, no bloquea — un nodo caído no debe retener regalos que
//dos fuentes públicas ya confirman.

const ORACLE_TIMEOUT_MS = 8_000;
const HASH_RE = /^[0-9a-f]{64}$/;

export class BlockOracleUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockOracleUnavailable";
  }
}

export class BlockOracleDisagreement extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockOracleDisagreement";
  }
}

export interface BlockSource {
  name: string;
  tipHeight(): Promise<number>;
  /** null: esa altura todavía no existe para esta fuente. */
  hashAt(height: number): Promise<string | null>;
  /** La altura de un bloque por su hash. null: esta fuente no conoce ese bloque. */
  heightOf(blockHash: string): Promise<number | null>;
}

function parseHeight(raw: string, source: string): number {
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${source}: altura inválida`);
  }
  return n;
}

function parseHash(raw: string, source: string): string {
  const h = raw.trim().toLowerCase();
  if (!HASH_RE.test(h)) {
    throw new Error(`${source}: hash inválido`);
  }
  return h;
}

/** Un explorador con API Esplora (mempool.space, blockstream.info). */
export function esploraSource(name: string, baseUrl: string): BlockSource {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    name,
    async tipHeight() {
      const res = await fetch(`${base}/blocks/tip/height`, { signal: AbortSignal.timeout(ORACLE_TIMEOUT_MS) });
      if (!res.ok) { throw new Error(`${name}: tip respondió ${res.status}`); }
      return parseHeight(await res.text(), name);
    },
    async hashAt(height) {
      const res = await fetch(`${base}/block-height/${height}`, { signal: AbortSignal.timeout(ORACLE_TIMEOUT_MS) });
      //Esplora contesta 404 "Block not found" para una altura que aún no existe.
      if (res.status === 404) { return null; }
      if (!res.ok) { throw new Error(`${name}: block-height respondió ${res.status}`); }
      return parseHash(await res.text(), name);
    },
    async heightOf(blockHash) {
      const res = await fetch(`${base}/block/${parseHash(blockHash, name)}`, { signal: AbortSignal.timeout(ORACLE_TIMEOUT_MS) });
      //404 (y 400 en algunas instancias) = no conoce ese bloque; no es una caída.
      if (res.status === 404 || res.status === 400) { return null; }
      if (!res.ok) { throw new Error(`${name}: block respondió ${res.status}`); }
      const body = (await res.json()) as { height?: unknown };
      return parseHeight(String(body.height), name);
    },
  };
}

//Nunca las credenciales: sólo el host, para mensajes y logs.
function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return "invalid-url";
  }
}

/** El nodo propio por JSON-RPC, con la misma URL que usa block-template.ts. */
export function nodeSource(nodeUrl: string): BlockSource {
  const host = safeHost(nodeUrl);
  const name = `node@${host}`;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const url = new URL(nodeUrl);
    const auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64");
    const res = await fetch(`${url.protocol}//${url.host}${url.pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
      body: JSON.stringify({ jsonrpc: "1.0", id: "hashimon-bonus", method, params }),
      signal: AbortSignal.timeout(ORACLE_TIMEOUT_MS),
    });
    //bitcoind contesta los errores RPC con HTTP 500 Y un cuerpo JSON: hay que
    //leer el cuerpo antes de mirar el status, o "altura fuera de rango" parece una caída.
    const body = (await res.json().catch(() => null)) as
      | { result?: T; error?: { code: number; message: string } | null }
      | null;
    if (body?.error) {
      const err = new Error(`${name}: rpc ${method} error ${body.error.code}`) as Error & { rpcCode?: number };
      err.rpcCode = body.error.code;
      throw err;
    }
    if (!res.ok || !body || body.result === undefined) {
      throw new Error(`${name}: rpc ${method} respondió ${res.status}`);
    }
    return body.result;
  }

  return {
    name,
    async tipHeight() {
      return parseHeight(String(await rpc<number>("getblockcount", [])), name);
    },
    async hashAt(height) {
      try {
        return parseHash(await rpc<string>("getblockhash", [height]), name);
      } catch (err) {
        //-8 = "Block height out of range": la altura aún no existe para el nodo.
        if ((err as { rpcCode?: number }).rpcCode === -8) { return null; }
        throw err;
      }
    },
    async heightOf(blockHash) {
      try {
        const header = await rpc<{ height: number }>("getblockheader", [parseHash(blockHash, name), true]);
        return parseHeight(String(header.height), name);
      } catch (err) {
        //-5 = "Block not found".
        if ((err as { rpcCode?: number }).rpcCode === -5) { return null; }
        throw err;
      }
    },
  };
}

export interface BlockOracle {
  /**
   * `commitTip`: la punta MÁS ALTA que ve cualquier fuente. Se compromete la altura
   * siguiente a esta, así una fuente atrasada nunca hace comprometer un bloque que
   * otra ya conoce.
   * `confirmedTip`: la punta MÁS BAJA de las obligatorias. Sólo se resuelve cuando
   * ambos exploradores ven las confirmaciones.
   */
  tips(): Promise<{ commitTip: number; confirmedTip: number }>;
  /** null si alguna fuente obligatoria aún no tiene esa altura. */
  hashAt(height: number): Promise<string | null>;
  /**
   * La altura de un bloque por su hash, acordada por las obligatorias. null si alguna
   * no lo conoce (bloque inventado, o de una red de prueba). Mismas reglas que hashAt:
   * discrepar bloquea, y el nodo opcional sólo bloquea si contesta distinto.
   */
  heightOf(blockHash: string): Promise<number | null>;
}

export function composeOracle(
  sources: { required: BlockSource[]; optional?: BlockSource[] },
  opts: { tipTtlMs?: number } = {}
): BlockOracle {
  const required = sources.required;
  const optional = sources.optional ?? [];
  if (required.length < 2) {
    throw new Error("composeOracle: hacen falta al menos dos fuentes obligatorias");
  }
  const tipTtl = opts.tipTtlMs ?? 15_000;
  let tipCache: { at: number; value: { commitTip: number; confirmedTip: number } } | null = null;
  //Un hash ya acordado a una altura con confirmaciones no cambia: se guarda.
  const hashCache = new Map<number, string>();
  //La altura de un bloque tampoco cambia nunca.
  const heightCache = new Map<string, number>();

  return {
    async tips() {
      if (tipCache && Date.now() - tipCache.at < tipTtl) { return tipCache.value; }
      const req = await Promise.allSettled(required.map((s) => s.tipHeight()));
      const failed = req.findIndex((r) => r.status === "rejected");
      if (failed !== -1) {
        throw new BlockOracleUnavailable(`${required[failed]!.name} no respondió la altura`);
      }
      const reqTips = req.map((r) => (r as PromiseFulfilledResult<number>).value);
      const opt = await Promise.allSettled(optional.map((s) => s.tipHeight()));
      const optTips = opt
        .filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled")
        .map((r) => r.value);
      const value = {
        commitTip: Math.max(...reqTips, ...optTips),
        confirmedTip: Math.min(...reqTips),
      };
      tipCache = { at: Date.now(), value };
      return value;
    },

    async hashAt(height) {
      const cached = hashCache.get(height);
      if (cached) { return cached; }

      const req = await Promise.allSettled(required.map((s) => s.hashAt(height)));
      const failed = req.findIndex((r) => r.status === "rejected");
      if (failed !== -1) {
        throw new BlockOracleUnavailable(`${required[failed]!.name} no respondió el hash de ${height}`);
      }
      const hashes = req.map((r) => (r as PromiseFulfilledResult<string | null>).value);
      if (hashes.some((h) => h === null)) { return null; }
      const agreed = hashes[0]!;
      if (hashes.some((h) => h !== agreed)) {
        throw new BlockOracleDisagreement(`los exploradores discrepan en la altura ${height}`);
      }

      const opt = await Promise.allSettled(optional.map((s) => s.hashAt(height)));
      for (const [i, r] of opt.entries()) {
        if (r.status === "fulfilled" && r.value !== null && r.value !== agreed) {
          throw new BlockOracleDisagreement(`${optional[i]!.name} discrepa en la altura ${height}`);
        }
      }

      hashCache.set(height, agreed);
      return agreed;
    },

    async heightOf(blockHash) {
      const key = blockHash.toLowerCase();
      const cached = heightCache.get(key);
      if (cached !== undefined) { return cached; }

      const req = await Promise.allSettled(required.map((s) => s.heightOf(key)));
      const failed = req.findIndex((r) => r.status === "rejected");
      if (failed !== -1) {
        throw new BlockOracleUnavailable(`${required[failed]!.name} no respondió la altura de ${key}`);
      }
      const heights = req.map((r) => (r as PromiseFulfilledResult<number | null>).value);
      if (heights.some((h) => h === null)) { return null; }
      const agreed = heights[0]!;
      if (heights.some((h) => h !== agreed)) {
        throw new BlockOracleDisagreement(`los exploradores discrepan en la altura de ${key}`);
      }

      const opt = await Promise.allSettled(optional.map((s) => s.heightOf(key)));
      for (const [i, r] of opt.entries()) {
        if (r.status === "fulfilled" && r.value !== null && r.value !== agreed) {
          throw new BlockOracleDisagreement(`${optional[i]!.name} discrepa en la altura de ${key}`);
        }
      }

      heightCache.set(key, agreed);
      return agreed;
    },
  };
}

let defaultInstance: BlockOracle | null = null;

/** mempool.space + blockstream.info obligatorios; el nodo, si está configurado. */
export function defaultOracle(): BlockOracle {
  if (!defaultInstance) {
    defaultInstance = composeOracle({
      required: [
        esploraSource("mempool.space", "https://mempool.space/api"),
        esploraSource("blockstream.info", "https://blockstream.info/api"),
      ],
      optional: config.btcNodeUrl ? [nodeSource(config.btcNodeUrl)] : [],
    });
  }
  return defaultInstance;
}
