/*
 * Copyright (c) 2026 Tom Rodriguez ("Toasty") — <toasty@heroiclands.org>
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * What the composite actions share about the forge they run on: where its API
 * is, whether it is GitHub, and how to read a whole list from it.
 *
 * The API base is `GITHUB_API_URL`, which both GitHub and Gitea set for a job;
 * no host is written here beyond GitHub's own default. The forge is told apart
 * by comparing `GITHUB_SERVER_URL` with `https://github.com`, never by a
 * variable only one runner sets.
 * @module
 */

/** GitHub's own server address. */
export const GITHUB_URL = "https://github.com";

/** The most pages a single list read follows before it gives up. */
const MAX_PAGES = 1000;

/** The most times one idempotent read is attempted before it fails. */
const MAX_ATTEMPTS = 4;

/** Milliseconds waited before each retry; their sum bounds the total delay. */
const BACKOFF_MS = [250, 500, 1000];

/** Network error codes that mark an interrupted, retryable connection. */
const TRANSIENT_CODES = new Set([
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
]);

/** Response statuses that mark a forge or proxy that is briefly unavailable. */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

/**
 * Collaborators a request can be given in place of the real ones.
 *
 * @typedef {object} RequestOptions
 * @property {typeof fetch} [fetch] defaults to the global `fetch`
 * @property {(ms: number) => Promise<void>} [sleep] defaults to a timer
 */

/** A response that was not a success. */
export class ApiError extends Error {
    constructor(method, path, status, body) {
        super(`${method} ${path} failed: ${status} ${body}`);
        this.status = status;
        this.body = body;
    }
}

/**
 * The forge a job runs on.
 *
 * @param {Record<string, string | undefined>} env the job's environment
 * @returns {{github: boolean, api: string, headers: (token?: string) => Record<string, string>}}
 */
export function forgeOf(env = process.env) {
    const server = (env.GITHUB_SERVER_URL || GITHUB_URL).replace(/\/+$/, "");
    const github = server === GITHUB_URL;
    const api = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
    return {
        github,
        api,
        headers(token) {
            return {
                Accept: github ? "application/vnd.github+json" : "application/json",
                ...(github ? { "X-GitHub-Api-Version": "2022-11-28" } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            };
        },
    };
}

/** A response header, or `null` when the response carries no such header. */
function header(res, name) {
    return res.headers?.get?.(name) ?? null;
}

/** The network error code carried by an error or anywhere in its cause chain. */
function transientCode(err) {
    for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
        if (TRANSIENT_CODES.has(e.code)) return e.code;
    }
    return null;
}

/**
 * The text of an error response. A body that cannot be read leaves the status
 * authoritative, so the text is a note saying so.
 */
async function errorBody(res) {
    try {
        return await res.text();
    } catch {
        return "(response body unreadable)";
    }
}

/**
 * One GET whose body is read as JSON, retried on transient failures.
 *
 * Only a transport interruption (while sending the request or reading the
 * body) or a 502, 503 or 504 response is retried, up to `MAX_ATTEMPTS`
 * attempts with `BACKOFF_MS` between them. Any other status fails at once as
 * that status, even when its error body cannot be read.
 *
 * @returns {Promise<{res: Response, body: any}>}
 * @throws {ApiError} on a non-success status
 * @throws {Error} when the attempts end on a transport failure; the message
 *   names the request and the cause
 */
async function getJson(url, path, headers, options) {
    const doFetch = options.fetch ?? globalThis.fetch;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 1; ; attempt++) {
        let failure;
        try {
            const res = await doFetch(url, { headers });
            if (res.ok) return { res, body: await res.json() };
            const error = new ApiError("GET", path, res.status, await errorBody(res));
            if (!TRANSIENT_STATUSES.has(res.status)) throw error;
            failure = { error, reason: `status ${res.status}` };
        } catch (err) {
            if (err instanceof ApiError && !TRANSIENT_STATUSES.has(err.status)) throw err;
            const code = err instanceof ApiError ? err.status : transientCode(err);
            if (code === null) throw err;
            failure = { error: err, reason: err.cause?.message ?? err.message, code };
        }
        if (attempt >= MAX_ATTEMPTS) {
            if (failure.error instanceof ApiError) throw failure.error;
            throw new Error(
                `GET ${path} failed after ${attempt} attempts: ${failure.code}: ${failure.reason}`,
                { cause: failure.error },
            );
        }
        await sleep(BACKOFF_MS[attempt - 1]);
    }
}

/**
 * Every item of a list endpoint.
 *
 * Both `per_page` and `limit` are sent, because GitHub reads the first and
 * Gitea the second (clamped to its own maximum, which can be well under 100).
 * A short page therefore proves nothing about the end of the list. The end is,
 * in order of preference: the item total the forge reports, the absence of a
 * `rel="next"` link when the forge sends links, and otherwise an empty page.
 *
 * @param {ReturnType<typeof forgeOf>} forge
 * @param {string} path the endpoint, with no query string
 * Each page is retried on a transient failure (see `getJson`), so an
 * interrupted connection does not fail the read.
 *
 * @param {string | undefined} token
 * @param {RequestOptions} [options]
 * @returns {Promise<any[]>}
 * @throws {ApiError} when any page cannot be read; a partial list is never returned
 * @throws {Error} when a page stays unreachable after every attempt
 */
export async function readAll(forge, path, token, options = {}) {
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const { res, body: batch } = await getJson(
            `${forge.api}${path}?per_page=100&limit=50&page=${page}`,
            path,
            forge.headers(token),
            options,
        );
        items.push(...batch);
        if (batch.length === 0) return items;
        const total = header(res, "x-total-count");
        if (total !== null && Number.isFinite(Number(total))) {
            if (items.length >= Number(total)) return items;
            continue;
        }
        const link = header(res, "link");
        if (link !== null && !/rel="?next"?/.test(link)) return items;
    }
    throw new Error(`GET ${path} did not end after ${MAX_PAGES} pages`);
}

/**
 * One request that changes something. It is never retried, because repeating
 * it could apply the change twice.
 *
 * @param {RequestOptions} [options]
 * @throws {ApiError} on a non-success status
 */
export async function send(forge, method, path, token, body, options = {}) {
    const res = await (options.fetch ?? globalThis.fetch)(`${forge.api}${path}`, {
        method,
        headers: { ...forge.headers(token), "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new ApiError(method, path, res.status, await errorBody(res));
}
