/* SPDX-License-Identifier: GPL-3.0-or-later */

/**
 * Test support: a `fetch` that answers list endpoints the way each forge does.
 *
 * GitHub honours `per_page` up to 100 and sends a `Link` header only when
 * another page follows. Gitea ignores `per_page`, clamps `limit` to 50 (30
 * when absent), and sends `X-Total-Count` and a `Link` header with `rel="next"`
 * while more remain.
 */

/**
 * @param {Record<string, any[]>} routes endpoint path suffix to the full list it serves
 * @param {"github" | "gitea"} style
 * @returns {typeof fetch}
 */
export function pagedFetch(routes, style) {
    return async (url) => {
        const u = new URL(url);
        const key = Object.keys(routes).find((suffix) => u.pathname.endsWith(suffix));
        if (!key) return new Response("not found", { status: 404 });
        const all = routes[key];
        const page = Number(u.searchParams.get("page") ?? 1);
        const size =
            style === "github"
                ? Math.min(Number(u.searchParams.get("per_page") ?? 30), 100)
                : Math.min(Number(u.searchParams.get("limit") ?? 30), 50);
        const slice = all.slice((page - 1) * size, page * size);
        const more = page * size < all.length;
        const headers = {};
        if (style === "gitea") headers["X-Total-Count"] = String(all.length);
        if (more) headers.Link = `<${u.origin}${u.pathname}?page=${page + 1}>; rel="next"`;
        return new Response(JSON.stringify(slice), { status: 200, headers });
    };
}

/** Environment variables a job on each forge carries. */
export const FORGE_ENV = {
    github: { GITHUB_SERVER_URL: "https://github.com", GITHUB_API_URL: "https://api.github.com" },
    gitea: {
        GITHUB_SERVER_URL: "http://atlas.pupluppy.internal:3080",
        GITHUB_API_URL: "http://atlas.pupluppy.internal:3080/api/v1",
    },
};
