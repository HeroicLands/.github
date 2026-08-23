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
