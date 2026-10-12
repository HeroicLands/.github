// SPDX-License-Identifier: GPL-3.0-or-later
//
// Approve Renovate's patch-group pull requests as heroiclands-bot.
//
// `main` requires one approving review and Gitea cannot exempt a user, so the
// review comes from the release bot. Only the patch group qualifies: its head
// branch is `renovate/patch`, opened by the `renovate` user from the
// repository itself. A new push dismisses an approval, so a review counts only
// when it names the pull request's current head commit.
//
// Environment: FORGE_API (default https://git.pupluppy.org/api/v1),
// RELEASE_BOT_TOKEN, ORG (default HeroicLands).

import { pathToFileURL } from "node:url";

export const PATCH_BRANCH = "renovate/patch";
export const DEPENDENCY_USER = "renovate";
export const APPROVER = "heroiclands-bot";

/** Whether a pull request is the open, non-draft patch group Renovate opened. */
export function isPatchGroup(pr) {
    return (
        pr.state === "open" &&
        pr.user?.login === DEPENDENCY_USER &&
        pr.head?.ref === PATCH_BRANCH &&
        pr.head?.repo?.full_name === pr.base?.repo?.full_name &&
        !/^(WIP:|\[WIP\])/i.test(pr.title ?? "")
    );
}

/** Whether the approver has an approval standing on the pull request's current head. */
export function isApprovedAtHead(pr, reviews) {
    return reviews.some(
        (review) =>
            review.user?.login === APPROVER &&
            review.state === "APPROVED" &&
            !review.dismissed &&
            !review.stale &&
            review.commit_id === pr.head.sha,
    );
}

/** The pull requests that need an approval, given each one's reviews. */
export function needingApproval(entries) {
    return entries.filter(({ pr, reviews }) => isPatchGroup(pr) && !isApprovedAtHead(pr, reviews)).map(({ pr }) => pr);
}

async function main() {
    const api = (process.env.FORGE_API ?? "https://git.pupluppy.org/api/v1").replace(/\/$/, "");
    const org = process.env.ORG ?? "HeroicLands";
    const token = process.env.RELEASE_BOT_TOKEN;
    if (!token) throw new Error("RELEASE_BOT_TOKEN is not set");

    const call = async (path, init = {}) => {
        const response = await fetch(`${api}${path}`, {
            ...init,
            headers: { Authorization: `token ${token}`, "Content-Type": "application/json", ...init.headers },
        });
        if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
        return response.status === 204 ? undefined : response.json();
    };
    const pages = async (path) => {
        const all = [];
        for (let page = 1; ; page += 1) {
            const batch = await call(`${path}${path.includes("?") ? "&" : "?"}limit=50&page=${page}`);
            all.push(...batch);
            if (batch.length < 50) return all;
        }
    };

    let failed = 0;
    // `/orgs/{org}/repos` needs read:organization, which the release bot's
    // token does not carry; the bot owns the organization, so its own
    // repository list holds every one.
    const repos = (await pages("/user/repos")).filter((repo) => repo.owner?.login === org);
    for (const repo of repos) {
        if (repo.archived) continue;
        const pulls = await pages(`/repos/${repo.full_name}/pulls?state=open`);
        for (const pr of pulls.filter(isPatchGroup)) {
            try {
                const reviews = await pages(`/repos/${repo.full_name}/pulls/${pr.number}/reviews`);
                if (isApprovedAtHead(pr, reviews)) {
                    console.log(`${repo.full_name}#${pr.number}: already approved`);
                    continue;
                }
                await call(`/repos/${repo.full_name}/pulls/${pr.number}/reviews`, {
                    method: "POST",
                    body: JSON.stringify({
                        event: "APPROVED",
                        commit_id: pr.head.sha,
                        body: "Patch-only dependency update; the scheduled merge waits for checks.",
                    }),
                });
                console.log(`${repo.full_name}#${pr.number}: approved ${pr.head.sha.slice(0, 10)}`);
            } catch (error) {
                failed += 1;
                console.error(`${repo.full_name}#${pr.number}: error: ${error.message}`);
            }
        }
    }
    if (failed > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
