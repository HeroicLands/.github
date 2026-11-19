// SPDX-License-Identifier: GPL-3.0-or-later
import {
    contextFor,
    currentPullRequest,
} from "../../trusted-deploy/actions/internal-site-deploy/publish.mjs";

const context = contextFor({
    mode: "pr",
    repository: "HeroicLands/thalorna",
    package: "thalorna",
    prNumber: process.env.PR_NUMBER,
    sourceSha: process.env.SOURCE_SHA,
});
const pr = await currentPullRequest(context, process.env.GITEA_TOKEN);
if (
    pr.base.ref !== "main" ||
    pr.state !== "open" ||
    pr.draft ||
    /^WIP:/i.test(pr.title) ||
    pr.head.sha !== context.sourceSha
)
    throw new Error("diagnostic requires a current ready same-repository PR");
console.log(context.baseUrl);
