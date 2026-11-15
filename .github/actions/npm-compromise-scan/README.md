# npm compromise scan

This action checks resolved npm versions before a build installs packages. It downloads the Cobenian compromised-package list as data and prints its SHA-256 and the number of npm entries in the job log. Only bare npm entries and entries explicitly marked as npm participate in the comparison. [Upstream list](https://github.com/Cobenian/shai-hulud-detect/blob/main/compromised-packages.txt)

After checking out the revision to be built, add this step ahead of dependency installation. Pin the action to a reviewed commit when adopting or upgrading it.

~~~yaml
- name: Check locked npm versions
  uses: phillmac/PixivBatchDownloader/.github/actions/npm-compromise-scan@302b9abd4987790d9b6c0122ab7d2b1b911bdfea
  with:
    required-locks: |
      package-lock.json
~~~

List each expected lockfile on its own line. The scanner also discovers tracked npm lockfiles and shrinkwraps throughout the checkout. It handles lockfile versions 1 through 3, scoped packages, aliases, nested dependencies and workspace records. Use the optional `directory` input for a checkout in a subdirectory. Use `extra-packages` to check exact `name@version` pairs installed separately by CI.

Exit status 0 means no listed version matched. Status 1 identifies a match. Invalid inputs, missing locks and feed retrieval failures fail the job. A clean result covers known package versions in the feed. Workflow edits, changes to install scripts and malicious content in an unlisted release require separate inspection.

Run the regression fixtures with `python3 -I -m unittest discover -s .github/actions/npm-compromise-scan -p 'test_*.py'`.
