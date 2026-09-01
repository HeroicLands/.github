# Security Policy

This is the HeroicLands organisation's default security policy. It applies to
every repository in the organisation that does not publish one of its own.

## Reporting a vulnerability

**Report privately, never as a public issue.** Use the **Report a
vulnerability** button on this repository's own **Security** tab
(Security → Advisories → Report a vulnerability). It opens a draft advisory
visible only to you and the maintainers.

If that button is not there, the repository has private reporting turned off —
which is a fault in the repository, not in your report. Do not fall back to a
public issue. Say that you have a security report, without describing it, in
any of the ordinary channels the repository lists, and you will be given a
private route.

You will get an acknowledgement, a fix developed inside the private advisory,
and credit on publication if you want it.

## What is in scope

Every HeroicLands repository publishes something people install, build against,
or read:

- **Foundry systems and modules** — code that runs in a player's browser
  against their world data.
- **The build toolchain** — it executes during every consuming package's build,
  so a finding there reaches every package that depends on it. Report anything
  affecting it as urgent.
- **Sites and themes** — chiefly what the templates *emit*: author-supplied text
  rendered unescaped, values interpolated into `href`/`src`/`style` or inline
  event handlers, and external resources pulled into a rendered page.
- **Shared Actions and workflows** — they run with repository credentials in
  every repository that calls them.

If a repository has narrower or broader scope than this, it says so in its own
`SECURITY.md`, which replaces this file entirely.

## Supported versions

`main` receives fixes. Published packages are fixed forward — a fix reaches a
consumer when it takes the new version, so pinned dependants are protected only
once they move their pin.

## Why this file is here and not in every repository

The policy is the organisation's, and only the scope paragraph ever differed
between repositories. Four repositories had no policy at all
([#14](https://github.com/HeroicLands/.github/issues/14)) — not because anyone
decided they needed none, but because a per-repository file is one more thing to
remember when a repository is created. A default is remembered by construction.

**A repository that publishes its own `SECURITY.md` keeps it whole.** GitHub
does not merge the two; the local file wins outright. So a repository with a
genuinely different scope should publish one, and one with nothing to add should
publish nothing and inherit this.

Note the limit of the mechanism: this file is rendered for many repositories, so
it can name none of them. That is why it says "this repository's Security tab"
rather than linking an address — and it is the same reason the **issue-chooser
`config.yml` is deliberately not defaulted here**. Its advisory link is a
literal URL with no templating, so one default would point every repository's
reporter at a single repository. That is precisely the bug that started this.
