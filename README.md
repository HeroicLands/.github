# HeroicLands org defaults

Shared GitHub configuration for the HeroicLands organisation: Actions every
repository uses, and community health files GitHub falls back to when a
repository has none of its own.

Nothing here is published to npm. The two build toolchains —
[`content-build`](https://github.com/HeroicLands/content-build) and
[`package-build`](https://github.com/HeroicLands/package-build) — each deliver a
single command line, and each is scoped by what it *reads*: content-build reads
the content tree, package-build reads `lang/`, `styles/`, `src/`, the assets and
the manifest. Repository governance is neither, which is what this repository is
for.

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
| pages (`index.html` count) | `min-pages` ≤ n ≤ `max-pages` | **exactly 1** |
| bounds settable by the caller | yes, and `min-pages` is required | **no** |

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

Both are created if missing, idempotently, before the upload.

A Pages project is **account** state, not repository state. Without creating it,
a clone of a package repository plus a scoped token still could not publish:
somebody would have to know to visit a dashboard first, and removing exactly
that hidden step is what makes a package movable. It is checked before it is
created, so a genuine error — a bad token, a revoked scope — still fails the run
rather than hiding inside a tolerated create.

The custom domain is `<package>.<domain-suffix>`, e.g.
`kethira.pkg.heroiclands.org`. The router derives a package's origin from its
prefix alone and holds no list of packages, so adding a package is no edit to
`heroiclands-site` — but only if the hostname exists, and the only place that
can be guaranteed is here, beside the project creation. Adding it is idempotent
by inspection (list, then add if absent) and tolerant on the race (an add that
lost to a concurrent run is verified, not assumed).

**Registering the domain is only half of it, and the DNS record is the other
half.** `POST …/pages/projects/{project}/domains` attaches a hostname to a Pages
project; it does not write a DNS record, and it answers `success: true` for the
half it did. The dashboard hides the difference — adding a custom domain by hand
shows a *Confirm new DNS record* screen and **Activate domain** does both — so
the gap only surfaced when the first automated deploys ran. Four packages
deployed green on 2026-08-29 and all four addresses were NXDOMAIN
([#10](https://github.com/HeroicLands/.github/issues/10)).

So a second step creates the record — `CNAME <package>.pkg → <project>.pages.dev`,
**proxied**, because the router fetches these hostnames as origins. It is
idempotent the same way the domain step is (look first, create only what is
absent) and it is a *separate* step for a specific reason: the domain step
returns early when the hostname is already registered, which is exactly the
state this bug leaves behind, so folding the record creation into it would skip
every package that already has the problem. The zone is resolved by name from
`domain-suffix` rather than hardcoded, walking the suffix a label at a time
(`pkg.heroiclands.org` → zone `heroiclands.org`), so a consumer publishing under
another suffix still works. A record that already exists pointing somewhere else
is reported as a warning and left alone — this step creates a missing record, it
does not overwrite deliberate state.

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

`sohl` and `thalorna` publish content; the other four publish a homepage. Note
what changes between them: a project name, and — for content packages — a floor.

```yaml
# Song-of-Heroic-Lands-FoundryVTT/.github/workflows/deploy-sohl.yml
# `sohl` also deploys on a new release, because half of what it publishes (the
# API documentation) tracks the newest release tag rather than `main`.
on:
  push: { branches: [main] }
  workflow_dispatch:
permissions: { contents: read }
jobs:
  deploy:
    uses: HeroicLands/.github/.github/workflows/deploy-package-site.yml@main
    with: { project: sohl-site, min-pages: 1000 }
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

```yaml
# sohl-thalorna/.github/workflows/deploy-site.yml
jobs:
  deploy:
    uses: HeroicLands/.github/.github/workflows/deploy-package-site.yml@main
    with: { project: sohl-thalorna, min-pages: 1200 }
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

```yaml
# HarnMaster-3-FoundryVTT/.github/workflows/deploy-site.yml
jobs:
  deploy:
    uses: HeroicLands/.github/.github/workflows/deploy-package-site.yml@main
    with: { project: hm3-site }
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

```yaml
# sohl-kethira-basic/.github/workflows/deploy-site.yml
# Homepage-only, and no bound is stated: the guard fixes it at exactly one page
# and this caller could not raise it if it tried. That is deliberate — the bound
# is Keléstia's Fan Material Guidelines, not a preference.
jobs:
  deploy:
    uses: HeroicLands/.github/.github/workflows/deploy-package-site.yml@main
    with: { project: sohl-kethira-basic }
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

```yaml
# harn-ensemble/.github/workflows/deploy-site.yml
jobs:
  deploy:
    uses: HeroicLands/.github/.github/workflows/deploy-package-site.yml@main
    with: { project: harn-ensemble }
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

```yaml
# harn-adventures/.github/workflows/deploy-site.yml
jobs:
  deploy:
    uses: HeroicLands/.github/.github/workflows/deploy-package-site.yml@main
    with: { project: harn-adventures }
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

The floors are each package's own, taken from a real build with room to spare:
`sohl`'s knowledgebase compiles ~1,500 pages and `thalorna`'s content tree
~2,500, so `1000` and `1200` catch a collapse without tripping on ordinary
editing. Raise a floor when a package grows; never raise one to make a red run
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

### Why a reusable workflow and not a composite action

A composite action is a step; this is a whole job — a runner, a checkout, a
Node and Hugo toolchain, a `concurrency` group and an environment. A composite
action cannot declare any of those, so every caller would have to restate them,
which is most of the hundred lines the duplication was made of. `uses:` at the
job level moves the entire job, which is the unit that was actually being
copied.

The `@main` reference is deliberate, matching the two composite actions: these
are org-internal and every caller wants the current one. A package that needs to
pin can reference a SHA.

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

### Why this is an Action and not a package

Each repository carried its own `utils/sync-labels.mjs`. They were 95% identical
and had drifted in all three, because copies do. Neither build toolchain was the
right home — labels are not content and not a Foundry package — and minting an
npm package to hold 130 lines of `fetch` calls would have added a release
pipeline to maintain. What the code actually is, is CI: it runs on a push, it
talks to the GitHub API, it needs a repository token. So it lives where that is
ordinary.

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
either, not even to format a finding; that contract belongs to
[`content-build`](https://github.com/HeroicLands/content-build), but it is four
fields joined by colons, and acquiring a build toolchain to write one line
would be the wrong trade.

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

### Why this is an Action

The same reason as the other two, arrived at from the opposite direction.
Every repository already had this check, as a 60-line block of `bash` and `gh`
embedded in a workflow — copied seven times, with the regex, the anchoring
rationale and the failure message duplicated in each. Nothing about it varies by
repository, so there was nothing for an input to capture; what there was, was
seven chances for the pattern to drift and no way to fix it once.

The repositories that also want the rule *before* a commit exists keep a local
`.githooks/commit-msg` carrying the same pattern. That one cannot move here — a
git hook runs on a developer's machine, from their checkout — so those two are
the pair to keep in sync, and the only pair.
