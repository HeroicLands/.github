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
 * @param {string | undefined} token
 * @returns {Promise<any[]>}
 * @throws {ApiError} when any page cannot be read; a partial list is never returned
 */
export async function readAll(forge, path, token) {
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await fetch(
            `${forge.api}${path}?per_page=100&limit=50&page=${page}`,
            { headers: forge.headers(token) },
        );
        if (!res.ok) throw new ApiError("GET", path, res.status, await res.text());
        const batch = await res.json();
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
 * One request that changes something.
 *
 * @throws {ApiError} on a non-success status
 */
export async function send(forge, method, path, token, body) {
    const res = await fetch(`${forge.api}${path}`, {
        method,
        headers: { ...forge.headers(token), "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new ApiError(method, path, res.status, await res.text());
}
