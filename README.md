# HeroicLands org defaults

Shared GitHub configuration for the HeroicLands organisation: Actions every
repository uses, and community health files GitHub falls back to when a
repository has none of its own.

Nothing here is published to npm. The build toolchain,
[`package-build`](https://github.com/HeroicLands/package-build), delivers a
single command line and is scoped by what it *reads*: the content tree, `lang/`,
`styles/`, `src/`, the assets and the manifest. Repository governance is none of
those, which is what this repository is for.

## `.github/workflows/deploy-package-site.yml`

Builds a package's website and publishes it at
`https://www.heroiclands.org/<package>/`. The first reusable workflow here, so
it sets the convention: reusable **workflows** live in `.github/workflows/`
(GitHub requires it) and are called with `uses:`; composite **actions** live in
`actions/` and are used as a step.

```yaml
# .github/workflows/deploy-site.yml — in the package repository
name: Deploy the site

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  deploy:
    uses: HeroicLands/.github/.github/workflows/deploy-package-site.yml@main
    with:
      project: sohl-thalorna
      min-pages: 1200
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

| Input | Default | |
| --- | --- | --- |
| `project` | — | the Cloudflare Pages project hosting this package |
| `min-pages` | `0` | fewest pages a complete build emits; **required** in `content` mode, **rejected** in `homepage` mode |
| `max-pages` | `0` | most it emits, `0` for no ceiling; rejected in `homepage` mode |
| `build-script` | `build:site` | the npm script that builds the site |
| `site-dir` | `build/site` | the directory uploaded — the deployment root |
| `config` | `package-build.config.yaml` | read for `contentPackage` and `publish.site` |
| `node-version` | `24` | |
| `hugo-version` | `0.163.3` | shared across packages; `""` skips installing Hugo |
| `domain-suffix` | `pkg.heroiclands.org` | the namespace the router derives an origin in |
| `allow-unpublished` | `false` | build and verify without credentials instead of failing |

Secrets are **named, never `secrets: inherit`** — see [Secrets](#secrets)
below.

### The build contract: one named npm script

The workflow runs `npm run build:site` and takes whatever tree it leaves
behind. **It does not know the steps**, and this is the load-bearing decision:
thalorna's script is `build:site-content && hugo && build:site-root`, sohl's is
`docs:prepare && docs:html && build:kb && site:assemble`, and a package added a
year from now will differ again. Teaching this workflow any of those shapes
would mean editing *this* repository every time a package changed how it
builds — the coupling the shared workflow exists to remove.

What the workflow requires of the script is only its **output**: the site under
`<site-dir>/<package>/`, i.e. Hugo's `publishDir` set to
`build/site/<package>`, with `<site-dir>` uploaded whole. The deployed tree
then carries its own prefix physically, so the router proxies `/<package>/…`
straight through without rewriting the path and the deployment behaves
identically at the project's own address
([heroiclands-site#25](https://github.com/HeroicLands/heroiclands-site/issues/25)).
A build that publishes Hugo's default `public/` 404s at every address this
deploy serves — and only once the route is live.

The checkout is unshallow (`fetch-depth: 0`, so tags come with it) and
`GH_TOKEN` is in the build step's environment. That is what lets a package's
build resolve and check out **another ref of its own repository** — sohl
documents its newest release tag, not `main` — with nothing here knowing that
any package does so.

### The completeness guard

A Cloudflare Pages deploy **replaces the whole tree**, so a build that silently
emits nothing takes the live site down and reports success. Nothing is uploaded
until the tree has been proven. Every mode is checked; the mode only changes the
page count.

| | `publish.site: content` | `publish.site: homepage` |
| --- | --- | --- |
| `<pkg>/index.html` | non-empty | non-empty |
| `<pkg>/404.html` | non-empty | non-empty |
| `<site-dir>/_headers` | non-empty | non-empty |
| `<pkg>/homepage-*/index.html` | non-empty, on package-build ≥ 15 | non-empty, on package-build ≥ 15 |
| pages (`index.html` count) | `min-pages` ≤ n ≤ `max-pages` | **exactly 1** |
| bounds settable by the caller | yes, and `min-pages` is required | **no** |

**The landing is required, and which file that is depends on the toolchain.**
Before package-build 15 the landing *was* `<pkg>/index.html`, so losing it
emptied the package root and the root check caught the collapse. Since
[package-build#182](https://github.com/HeroicLands/package-build/issues/182)
the landing is an addressed note at `<pkg>/homepage-<shortcode>/` and Hugo
writes the site root regardless — so a build that emitted **no landing at all**
leaves one `index.html`, tallies one page, passes every other check, and
replaces the live site with chrome around an empty `<main>`
([#21](https://github.com/HeroicLands/.github/issues/21)).

The two shapes are identical on disk, so the guard asks the **installed**
`@heroiclands/package-build` — a fact about the tree that was actually built,
readable after `npm ci` — rather than the declared range, which is a claim:
`>=9.0.0` permits 15 while the lockfile pins 9, and reading permission as
resolution would refuse a legitimate old-shape build. From 15 on, no landing is
a collapsed build and is refused; below 15 the root is the landing and is
counted as it always was. A version that cannot be read is refused too — the
question only arises once the landing is already missing. When every caller is
on 15 the branch goes, along with the discount's condition.

**Homepage-only is the stricter check, not the absent one.** It is two-sided: a
build that emitted nothing fails, and so does a build that emitted more than the
homepage. `kethira` and `harnadventures` publish one page because publishing
their content would breach the fan-content licences they ship under (Keléstia's
Fan Material Guidelines; Lythia's terms), so "exactly one page" is a licensing
boundary. The caller cannot widen it — passing `min-pages` or `max-pages` in
homepage mode fails the run, because a boundary an input can widen is not a
boundary.

**`min-pages` is required in `content` mode.** A content package that states no
floor has no guard at all, and a guard that cannot fail is the failure mode this
workflow exists to prevent. Set it below the real figure with room for growth —
it catches a collapsed build, it is not an assertion about today's page count.

The two fixed checks are not optional extras. `404.html` is what makes Pages
answer an unmatched path with a real 404 instead of a 200 carrying the home
page, which reads as success to every link checker there is. `_headers` marks
every address the deployment answers on that is not the canonical one `noindex`,
and Pages reads it **only at the deployment root** — which is why it is checked
there rather than in the package subtree.

**The workflow writes `_headers` for you if the build does not.** It is
identical for every package — `:project`, `:version` and `:package` are
Cloudflare's own placeholders, so not even the package name appears in it — and
the reason it exists is generic too, so each package copying the same rules only
spread the payload and lost the reasoning with it. The default is written after
the build and before the guard; a package that emits its own keeps it byte for
byte, and an **empty** `_headers` is still the package's file and still fails the
guard.

There are **three** rules, one per family of address a deployment answers on
besides its canonical path: `<project>.pages.dev`, one
`<deployment>.<project>.pages.dev` per deployment, and the
`<package>.<domain-suffix>` custom domain this workflow gives the project. The
third was missing until HeroicLands/.github#9 — every live package answered 200
with no `X-Robots-Tag` at its `pkg.heroiclands.org` address, which is the newest
of the three and the only one a reader is plausibly handed.

The rules are deliberately scoped to those hostnames rather than applied
globally: under its own domain a copy of the repository stays indexable, and
only the host-assigned addresses do not. A placeholder matches **one label** —
inside a host the delimiter is the dot — so `:package.pkg.heroiclands.org` needs
four labels and a literal `pkg`, and `www.heroiclands.org` cannot match it. That
holds only while `domain-suffix` names a dedicated namespace and not the domain
the canonical site itself is served from.

`heroiclands-site`'s router strips `X-Robots-Tag` when it proxies, because the
hosting cannot tell its request from a reader's, so the header reaches the
canonical address and is removed there. **The third rule is the one that depends
on that strip**, since the custom domain is the origin the router fetches; the
first two never reach it. The strip is asserted in the router's own suite, which
gates every pull request there (heroiclands-site#30), and it was live end to end
until heroiclands-site#26 moved the origin off `*.pages.dev`.

**The mode is read from `package-build.config.yaml`, never passed in**, so the
guard cannot be told one thing while the build does another. `publish.site` was
a boolean before package-build 5.0; a boolean is refused here with the same
message the toolchain gives, rather than mapped onto the nearest mode.

### The hosting project and the custom domain

Both are created if missing, idempotently, before the upload — checked first, so
a genuine error (a bad token, a revoked scope) still fails the run rather than
hiding inside a tolerated create.

A Pages project is **account** state, not repository state, so without creating
it a clone of a package repository plus a scoped token still could not publish.
The custom domain is `<package>.<domain-suffix>`, e.g.
`kethira.pkg.heroiclands.org`: the router derives a package's origin from that
prefix alone and holds no list of packages, so adding a package is no edit to
`heroiclands-site` — but only if the hostname exists.

**Registering the domain does not create its DNS record.**
`POST …/pages/projects/{project}/domains` attaches a hostname and answers
`success: true` for the half it did; the dashboard hides the difference, because
**Activate domain** does both. A separate step therefore creates
`CNAME <package>.pkg → <project>.pages.dev`, **proxied**, since the router
fetches these hostnames as origins.

Two things about that step are load-bearing and should survive any tidying:

- **It stays separate from the domain step.** That step returns early when the
  hostname is already registered — exactly the state this bug leaves behind — so
  folding the record creation into it would skip every package that already has
  the problem.
- **A record that already exists pointing elsewhere is a warning, not an
  overwrite.** The step creates what is missing; it does not replace deliberate
  state.

The zone is resolved by name from `domain-suffix` rather than hardcoded, walking
the suffix a label at a time (`pkg.heroiclands.org` → zone `heroiclands.org`),
so a consumer publishing under another suffix still works.

### Secrets

**The API token needs two permissions, both of them:**

| Permission | What it is for |
| --- | --- |
| Account → Cloudflare Pages → Edit | the hosting project, the custom domain, the upload |
| Zone → DNS → Edit (on the zone behind `domain-suffix`) | the CNAME that makes the domain resolve |

The second is not optional and not only for a new package. A token carrying
Pages access alone runs every step green, registers the hostname, and publishes
an address that does not resolve — which is precisely what happened four times
on 2026-08-29. A DNS call that fails, including on a permissions error, now
fails the run and names the missing permission.

Passed **by name**, never `secrets: inherit`. Inheriting hands a workflow in
another repository every secret the caller holds — npm publish tokens, Foundry
credentials, release tokens — for a job that needs two of them. Naming them also
documents the requirement at the call site and fails when one is missing rather
than three steps later.

Both are declared optional, so a repository still being set up can call this for
the build-and-guard half. It has to **say so** with `allow-unpublished: true`;
otherwise missing credentials fail the run. Skipping the upload quietly would
make this a deploy workflow that reports success without deploying, which is the
same failure the completeness guard exists to catch.

### The six callers

One shape, twice parameterised. `sohl` and `thalorna` publish content and so
state a floor; the other four publish a homepage and cannot.

```yaml
# sohl-thalorna/.github/workflows/deploy-site.yml — what all six look like
name: Deploy the site
on:
  push: { branches: [main] }
  workflow_dispatch:
permissions: { contents: read }
jobs:
  deploy:
    uses: HeroicLands/.github/.github/workflows/deploy-package-site.yml@main
    with: { project: sohl-thalorna, min-pages: 1200 }
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

| repository | `project` | `min-pages` |
| --- | --- | --- |
| `Song-of-Heroic-Lands-FoundryVTT` | `sohl-site` | `1000` |
| `sohl-thalorna` | `sohl-thalorna` | `1200` |
| `HarnMaster-3-FoundryVTT` | `hm3-site` | — |
| `sohl-kethira-basic` | `sohl-kethira-basic` | — |
| `harn-ensemble` | `harn-ensemble` | — |
| `harn-adventures` | `harn-adventures` | — |

`sohl` is the one exception: its workflow is `deploy-sohl.yml` and it also runs
on a new release, because half of what it publishes — the API documentation —
tracks the newest release tag rather than `main`.

The floors are each package's own, taken from a real build with room to spare:
`sohl`'s knowledgebase compiles ~1,500 pages and `thalorna`'s content tree
~2,500. Raise a floor when a package grows; never raise one to make a red run
green.

Everything else — the package name, the publishing mode, the origin hostname,
the guard, the runner, the Hugo version — is derived or shared. **Adding the
seventh package is a `project:` name and, if it publishes content, a floor.**

### Adding a package

1. Set `contentPackage` and `publish.site` in `package-build.config.yaml`.
2. Give the repository a `build:site` script that writes
   `build/site/<package>/` (Hugo `publishDir`) with a `404.html` in it.
   `build/site/_headers` is written for you unless the build produces one.
3. Add the four secrets-and-`project` lines above, with a
   `CLOUDFLARE_API_TOKEN` carrying **both** permissions in the table above.
4. Push. The hosting project, the custom domain and its DNS record are created
   on the first run; the router already knows how to reach them.

### Workflow, action, or package

A composite action is a step; a reusable workflow is a whole job — a runner, a
checkout, a toolchain, a `concurrency` group, an environment. An action can
declare none of those, so when the thing being copied is a **job**, `uses:` at
the job level is what moves it; when it is a **step**, it is an action.

When it is neither — CI code that runs on a push, talks to the GitHub API and
wants nothing but a token — it is still an action rather than an npm package.
Minting a package to hold a few hundred lines of `fetch` calls would add a
release pipeline to maintain, and neither build toolchain is the right home for
repository governance.

`@main` is deliberate throughout: these are org-internal and every caller wants
the current one. A caller that needs to pin can reference a SHA.

## `.github/workflows/release-foundry-package.yml`

Versions a Foundry package with changesets and cuts the GitHub Release that
Foundry installs from.

```yaml
# .github/workflows/release.yml — in the package repository
name: Version and Release

on:
  push:
    branches: [main]
  # Manual recovery: re-runs the decision for a version that is merged and
  # versioned but never got its release. An existing tag is skipped rather
  # than duplicated, so running this is safe.
  workflow_dispatch:

permissions:
  contents: write # push the version branch, create the tag and Release
  pull-requests: write # open and update the Version Packages pull request

jobs:
  release:
    uses: HeroicLands/.github/.github/workflows/release-foundry-package.yml@main
    with:
      package-kind: module
```

| Input | Default | |
| --- | --- | --- |
| `package-kind` | — | `system` or `module`; selects `build/dist/<kind>.zip` and `.json` |
| `build-script` | `build:noci` | the npm script that builds and verifies the tree |
| `post-release-script` | `""` | an npm script run after the Release, same job, built tree intact |
| `node-version` | `24` | |

`permissions` are declared by the **caller**, not here. A reusable workflow
cannot grant itself more than the caller holds, and one caller — `sohl` —
needs two more (`id-token: write`, `actions: write`) for what its
`post-release-script` does. Declaring a fixed block here would have capped
every caller at the narrowest set.

### The two contracts: two named npm scripts

The workflow runs `npm run <build-script>` and `npm run build:pack-release`,
and knows nothing about what either does — the same contract
`deploy-package-site.yml` makes with `build:site`. What it requires is only the
**output**: `build/dist/<package-kind>.zip` and `build/dist/<package-kind>.json`,
both non-empty.

`build:pack-release` is fixed rather than an input because all six callers
spell it the same way. An input for an axis nothing varies on is not
flexibility; it is a knob that invites divergence, which is the disease being
treated.

`build-script` **must not begin with its own `npm ci`** — dependencies are
already installed by the time it runs. That is why the default is `build:noci`
and not `build`: in all six repositories `build` is literally
`npm ci && npm run build:noci`, so passing it installs twice.

**Every caller takes the default**, so nothing varies on this axis either. It
stays an input where `build:pack-release` did not, because it is the same
named-script seam `deploy-package-site.yml` makes with `build:site` — the
contract is "one npm script, contents unknown here", and a package whose script
is named differently should be able to call this without editing it. An input
that every caller leaves alone is a seam; the one to avoid is an input that
invites callers to differ where they currently agree.

### The standing rule: check every output name against the pinned major

**Every `steps.<id>.outputs.*` reference must be re-checked against the pinned
major's `action.yml` whenever that pin moves.** This is the defect the whole
workflow exists to end, and it is worth stating as a rule because nothing
catches it:

An output name that does not exist resolves to the **empty string**. No error,
no warning, and `actionlint` is clean — a workflow cannot know an action's
output names without resolving the action. So
`if: steps.changesets.outputs.hasChangesets == 'false'` becomes `'' == 'false'`,
always false; the gated step is skipped forever and the job reports **green**
while releasing nothing.

`changesets/action` renamed every multi-word output at v2:

| v1 | v2 |
| --- | --- |
| `hasChangesets` | `has-changesets` |
| `publishedPackages` | `published-packages` |
| `pullRequestNumber` | `pr-number` |
| `published` | `published` (unchanged) |

One dependency bump introduced that into every copy at once, and it was found
in three only because someone went looking after noticing it in one
([#12](https://github.com/HeroicLands/.github/issues/12)). Kebab-case names
need bracket notation — `outputs['has-changesets']` — because a hyphen inside a
property name parses as subtraction.

The names above were verified against `changesets/action` at the `v2` tag when
this workflow was written. Re-verify at the tag, not on the default branch.

### The already-released guard fails closed

Release happens only when **both** hold: no changesets remain (a bump just
landed) and this version is not already tagged (an ordinary push, a re-run or a
hand-cut tag must not re-release).

The second half branches on `git ls-remote`'s **exit code**, not on truthiness
([#13](https://github.com/HeroicLands/.github/issues/13)):

| exit | meaning | what happens |
| --- | --- | --- |
| 0 | the tag exists | skip — nothing to release |
| 2 | no matching ref | release |
| 128 | the remote could not be reached | **fail the job** |

The obvious `if git ls-remote …; then skip; else release; fi` conflates 2 and
128, so a transient network or auth failure reads as *this version is untagged*
and the workflow proceeds to release a version that may already have one. Every
other guard in the file fails closed; that one failed **open**, and did the
irreversible thing on failure. stderr is deliberately not redirected — on 128 it
carries the only explanation.

A second guard covers the other silent direction: the two assets are checked
non-empty **before** the Release is created. A Release is published the instant
it exists and is what every installed copy updates from, so a pack script that
failed quietly would otherwise produce a tag, a Release, and nothing to install.

### Patch releases are prereleases

**A version `X.Y.Z` with `Z` non-zero publishes as a GitHub prerelease; `X.Y.0`
publishes as a normal release and takes "Latest".** No exceptions, no
per-package opt-in — it is org-wide, and it applies to future releases only.
Published releases are history and are never relabelled.

The digits carry a release **channel** here, not a severity:

| bump | channel |
| --- | --- |
| `major` / `minor` | goes to users — a real release |
| `patch` | beta only, never meant to be consumed |

`0.9.1`, `0.9.2`, … accumulate toward the next user release, which one `minor`
then cuts as `0.10.0`.

The channel lives in the digits rather than in a semver prerelease component
because Foundry has to sort these. Foundry's own versions are `<major>.<build>`
and its `isNewerVersion` is a naive dot-split with a string fallback — it has no
notion of `-beta.0`, so `0.9.0-beta.0` would sort wrongly against `0.9.0`. A
numeric-only scheme sorts correctly; what it cannot do on its own is *say* which
channel a version is on. The GitHub label is what says that to a human.

The decision is keyed on the `version` the `decide` step already reads from
`package.json`, not on the tag string — the tag is that same value with a `v`
glued on, and re-parsing it would make the rule depend on the tag spelling.

`prerelease` and `make_latest` are set **together and always explicitly**, both
verified against `softprops/action-gh-release`'s `action.yml` at the `v3` tag
per the standing rule above. Both defaults are wrong for this family: the action
defaults `prerelease` to false and GitHub defaults `make_latest` to true, so an
unlabelled patch would be published as the current release *and* would take the
Latest badge off the last real one. Labelling the prerelease while leaving
Latest to the default fixes only half of it — a prerelease that still claims
Latest defeats the point.

| version | `prerelease` | `make_latest` | published as |
| --- | --- | --- | --- |
| `0.9.0` | `false` | `true` | release, Latest |
| `0.9.1` | `true` | `false` | prerelease |
| `0.10.0` | `false` | `true` | release, Latest |
| `1.0.0` | `false` | `true` | release, Latest |
| `0.0.1` | `true` | `false` | prerelease |
| `0.5.3` | `true` | `false` | prerelease |
| `1.2.3.4`, `1.0.0-beta.1`, `0.9`, `01.2.3`, `v0.9.1`, … | — | — | **the run fails** |

The parse is strict — exactly three dot-separated numeric components, no leading
zeros — and it **fails closed**, like every other guard in the file. A version
this rule cannot classify stops the run rather than falling through to
"release", because "release" is the outcome with consequences: it is published
the instant it exists, it takes the Latest badge, and every installed copy
updates from it. An unclassifiable shape must not be resolved by guessing the
irreversible answer. It also catches the specific mistake this scheme invites —
a `1.0.0-beta.1` written by someone reaching for changesets' prerelease mode,
which is exactly the spelling Foundry mis-sorts.

**Blast radius.** Packages that already shipped patch releases as ordinary
releases — `sohl-kethira-basic` (v0.5.1, v0.5.2, v0.5.3) and `harn-adventures`
(v0.0.1) — will publish their **next** patch release as a prerelease. That is
the intended consequence of an org-wide rule, not a regression, and nothing
already published changes.

### What each of the six passes

Five callers are one line. Only `sohl` is not, and the difference is what it
does *after* the release, not how it builds.

| repository | `package-kind` | also passes |
| --- | --- | --- |
| `harn-adventures` | `module` | — |
| `harn-ensemble` | `module` | — |
| `sohl-thalorna` | `module` | — |
| `sohl-kethira-basic` | `module` | — |
| `HarnMaster-3-FoundryVTT` | `system` | — |
| `Song-of-Heroic-Lands-FoundryVTT` | `system` | `post-release-script: release:post` |

```yaml
# the five: permissions, then one line
permissions:
  contents: write
  pull-requests: write
jobs:
  release:
    uses: HeroicLands/.github/.github/workflows/release-foundry-package.yml@main
    with: { package-kind: module }
```

`sohl` grants two permissions more — `id-token: write` for npm Trusted
Publishing and `actions: write` to dispatch its site deploy — and its
`release:post` script does the two things no other package does: republish
`/sohl/` from the new tag, and publish `@heroiclands/sohl-types`. Nothing here
knows what that script contains, which is the point; it runs **after** the
Release, so a package's own follow-on work can never be why the Release was not
cut.

### What is not here: the two npm publishers

`package-build` and `heroiclands-hugo-theme` publish to npm, and their release
workflows are a different shape — `changesets/action` is given a
`publish-script` and does the tag, the Release and the `npm publish` itself, so
there is no decision step, no packaging and no assets. They are not callers of
this workflow and are not made one by it.

**The question that blocked them is answered, though, and the answer is the
encouraging one.** npm Trusted Publishing authorizes the workflow that
*initiates* the run, not the reusable one it calls: npm's own documentation
notes that with `workflow_call` "validation checks the calling workflow's name
instead of the workflow that actually contains the publish command". So a
publisher can move its body into a reusable workflow **without reconfiguring
its trusted publisher on npm**, provided:

- the caller keeps the filename npm is already configured with (`release.yml`
  — the file name is load-bearing, and both repositories' workflows already say
  so at the top); and
- `id-token: write` is granted in **both** the caller and the called workflow.

That removes the risk [#12](https://github.com/HeroicLands/.github/issues/12)
flagged as the blocker. Centralising those two is still a separate change with
its own shape, and it should follow the six, not lead them.

### Verifying a caller

Parse it; don't read it. The check that matters is that the job delegates and
carries no steps of its own — a half-migrated file looks right at a glance.

```bash
gh api repos/HeroicLands/<repo>/contents/.github/workflows/release.yml?ref=main \
  --jq .content | base64 -d | yq '.jobs[] | has("steps")'   # must be false
```

Two runs prove a release path, not one, because "green while doing nothing" is
the shape being guarded against: the release cuts a tag and a Release with both
assets, **and** the next ordinary push runs green cutting nothing.

**A gate that only runs at release time is not a gate.** Migrating the six found
that three of them had a red `build:noci` no CI job executed — the release
workflow was the only thing that ran it, so a release was the first place anyone
would have found out, and two of the six had never cut one. Before pointing new
automation at a repository's build, run it.

## `SECURITY.md`

The organisation's default security policy, inherited by every repository that
publishes none of its own. Four repositories had none at all —
`harn-adventures`, `heroiclands-site`, `package-build` and this one
([#14](https://github.com/HeroicLands/.github/issues/14)) — and `package-build`
is the one that mattered most: it executes during every consuming package's
build and is published to npm, which makes it the organisation's highest-value
supply-chain target and it had no policy, no chooser entry and no private
reporting.

**A repository publishing its own keeps it whole.** GitHub does not merge the
two — the local file wins outright — so a repository with genuinely different
scope publishes one, and a repository with nothing to add publishes nothing.
Six do today; the four above inherit this.

### What a default cannot do, and why the chooser is not one

A default file is rendered for many repositories, so **it can name none of
them**. This one says "this repository's Security tab" rather than linking an
address, and it carries no relative links — a relative link in a default file
resolves against *this* repository, not the one displaying it, so
`.github/ISSUE_REPORTING.md#7` would land here and 404 for every inheritor.

The same limit is why **`.github/ISSUE_TEMPLATE/config.yml` is deliberately not
defaulted**, even though GitHub supports it as one. Its private-reporting entry
is a `contact_link` holding a literal URL:

```yaml
- name: Report a security vulnerability (private)
  url: https://github.com/HeroicLands/<repo>/security/advisories/new
```

There is no templating, so a single default would send every repository's
reporter to whichever repository was hardcoded. **That is the exact bug that
opened #14** — `harn-ensemble`'s chooser pointed at `sohl-kethira-basic` — so
defaulting the chooser would institutionalise it rather than fix it. Six
repositories carry a correct self-referencing entry; the three without one want
their own, not a shared wrong one.

### The half that is not a file

Private vulnerability reporting is a **repository setting**, so no pull request
can turn it on and this file does not make the advisory form appear. Nine of the
ten eligible repositories have it off while six advertise it, which means a
reporter who follows the instruction finds no form and is left with giving up or
opening a public issue — the outcome the policy exists to prevent, since every
repository sets `blank_issues_enabled: false` and the chooser is the only entry
point.

It can be enabled from the API, one call per repository:

```bash
for r in sohl-thalorna sohl-kethira-basic heroiclands-hugo-theme \
         harn-adventures harn-ensemble HarnMaster-3-FoundryVTT \
         heroiclands-site package-build .github; do
  gh api --method PUT "repos/HeroicLands/$r/private-vulnerability-reporting"
done
```

`Song-of-Heroic-Lands-FoundryVTT` already has it on. Verify with
`gh api repos/HeroicLands/<repo>/private-vulnerability-reporting --jq .enabled`,
which must report `true` for all ten before #14 is done.

## `actions/labels`

Checks a repository's `.github/labels.yml`, or syncs GitHub's labels to it.

```yaml
# .github/workflows/labels.yml
name: Labels

on:
  pull_request:
    paths: [".github/labels.yml"]
  push:
    branches: [main]
    paths: [".github/labels.yml"]

permissions:
  issues: write

jobs:
  labels:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: HeroicLands/.github/actions/labels@main
        with:
          # A pull request reports what a sync would change and writes nothing;
          # main applies it. The consequence is reviewed before it happens.
          mode: ${{ github.event_name == 'push' && 'sync' || 'check' }}
          token: ${{ secrets.GITHUB_TOKEN }}
```

| Input | Default | |
| --- | --- | --- |
| `mode` | `check` | `check` validates and reports; `sync` applies |
| `registry` | `.github/labels.yml` | path to the registry |
| `token` | — | needs `issues: write`; without one, `check` validates the file alone |

**The registry is a closed set.** A label the file declares is created or
corrected; a label GitHub has and the file does not is **deleted**, along with
its presence on every issue carrying it. That is the point of a registry rather
than a starting point — labels otherwise accumulate from templates,
integrations and typos until the set means nothing — and it is why `check` runs
on the pull request that changes the file, so the deletion is reviewed before it
is applied.

Findings are reported as `file:line:column: severity: message`, the form every
C-family compiler and ESLint emit, so an error matcher resolves them without
being taught the layout.

## `actions/todos`

Fails when a committed comment carries a `TODO`/`FIXME` marker.

```yaml
# as a step in an existing workflow — it needs a checkout and nothing else
- uses: actions/checkout@v4
- uses: HeroicLands/.github/actions/todos@main
```

| Input | Default | |
| --- | --- | --- |
| `paths` | `src` | files and directories to scan, comma- or newline-separated |
| `extensions` | `.ts,.tsx,.js,.jsx,.mjs,.cjs` | which files to pick out of a scanned directory |
| `markers` | `TODO,FIXME` | the forbidden words, matched case-sensitively |

A directory is walked recursively, skipping `node_modules`; a path naming a
file is scanned as named, whatever its extension. A path that does not exist
fails, and so does a run that selected no files at all — a check that examined
nothing is not a passing check.

**Why a marker is forbidden at all.** It is a note to nobody. It duplicates the
issue that should carry the work and drifts out of sync with it, and in a
published doc comment it leaks onto the API site as documentation prose. File
or find an issue, record the code-site context there, and leave the code clean.

**What it will not flag.** String and template-literal *contents* are blanked
before matching, and only the comment portion of a line is examined — so
`const label = "TODO"` is not a finding. One useful consequence: a markdown
code span is a backtick string to the blanker, so a doc comment can state the
rule (``the `TODO` marker``) without tripping it.

Findings are `file:line:column: severity: message`, and the column is the
marker's own rather than the start of the line, so an editor opens on the word.

The rule is universal, and only the file selection ever differed between
repositories — which is why those are inputs and nothing else is. Like the
label registry, this is repository hygiene rather than a build: it runs in CI,
it needs no build, and it wants nothing but a checkout. It takes no dependency
either, not even to format a finding: it is four fields joined by colons, and
acquiring a build toolchain to write one line would be the wrong trade.

## `actions/no-attribution`

Fails a pull request whose title, body, or commit messages credit an AI
assistant.

```yaml
# .github/workflows/no-attribution.yml
name: No Attribution

on:
  pull_request:
    types: [opened, edited, reopened, synchronize]

permissions:
  contents: read
  pull-requests: read

jobs:
  no-attribution:
    name: No AI attribution
    runs-on: ubuntu-latest
    steps:
      # Needs no checkout: the subjects are the pull request, not the tree.
      - uses: HeroicLands/.github/actions/no-attribution@main
        with:
          token: ${{ github.token }}
```

| Input | Default | |
| --- | --- | --- |
| `token` | — | needs `contents: read` and `pull-requests: read` |

Two forms are refused: a `Co-Authored-By:` trailer naming an assistant, and a
signature line saying the work was generated by one. Three subjects are read —
the title and body, which a human edits, and the commit messages, which survive
the merge. Every finding is reported in one run, so a two-line fix is not two
round trips.

**The pattern is anchored to the start of a line, and that is the whole trick.**
Real attribution is a trailer or signature standing at column zero, so anchoring
lets a pull request *describe* the rule — this section, for instance — without
tripping it. The first version was unanchored and failed its own pull request.

Findings are `address:line:column: severity: message`. The address is not a file
path, because none of these subjects is a file; it is the subject's own address
in the repository — `pull/123/body`, `commit/<sha>` — so a finding names
something you can open or `git show`, and the column is the trailer's own rather
than the start of the line.

Nothing is edited. The check reports and fails, and the fix stays a human
decision — which matters more here than elsewhere, since the thing being removed
is a claim about who wrote the work.

**The git hook is the one copy that cannot move here.** Repositories that also
want the rule *before* a commit exists keep a local `.githooks/commit-msg`
carrying the same pattern — a hook runs on a developer's machine, from their
checkout — so the Action and that hook are the pair to keep in sync, and the
only pair.
