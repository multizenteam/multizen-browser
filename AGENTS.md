# Branch workflow

- Keep `main` release-ready. Promote changes to it through a pull request from this repository's `development` branch.
- Start each change from the latest `origin/development` on a branch named `feature/<short-description>`. Use this flow for fixes, documentation, and upstream integrations too.
- Open feature pull requests against `development`. Wait for branch-policy and fork compatibility checks before merging.
- Do not push commits directly to `main` or `development`. Use a merge commit for promotions to preserve shared ancestry. Tag releases on `main`.
