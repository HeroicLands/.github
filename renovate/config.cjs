// SPDX-License-Identifier: GPL-3.0-or-later
//
// Global configuration for the scheduled Renovate run. The shared preset is
// merged in here so the run needs no per-repository file; a repository may
// still carry its own `renovate.json` extending `local>HeroicLands/.github`.
//
// Environment: RENOVATE_TOKEN, and RENOVATE_GITHUB_COM_TOKEN when present.
const preset = require("../default.json");

const { $schema, description, ...settings } = preset;

module.exports = {
  ...settings,
  platform: "gitea",
  endpoint: "https://git.pupluppy.org/api/v1/",
  gitAuthor: "renovate <renovate@heroiclands.org>",
  autodiscover: true,
  autodiscoverFilter: ["HeroicLands/*"],
  onboarding: false,
  requireConfig: "optional",
  persistRepoData: false,
};
