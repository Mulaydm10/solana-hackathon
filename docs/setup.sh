#!/usr/bin/env bash
# Runtime for the `run` job and for workers. Design-owned; CI executes the copy on the BASE branch, never the PR's.
# Runner is ubuntu-latest (python3, node preinstalled; BASE_SHA is set).
#
# Two stacks on purpose: Python exists only for the bus canary (tests/canary), TypeScript/Node is
# the project. Removing the Python half breaks the canary and with it every future workflow change.

# Python - canary only. Read the manifest from BASE to keep the reviewed trust path.
if [ -n "${BASE_SHA:-}" ]; then git show "$BASE_SHA:requirements-dev.txt" > /tmp/requirements-dev.txt
else cp requirements-dev.txt /tmp/requirements-dev.txt; fi
python3 -m pip install -q -r /tmp/requirements-dev.txt

# Node - one install per lane directory that has a manifest. A lane with no package.json yet is
# skipped, not an error: lanes acquire theirs in their first PR.
#
# KNOWN GAP (team mode): unlike requirements-dev.txt these manifests are read from the PR head, not
# BASE. A PR can introduce the dependency it is judged with. Accepted knowingly: repo is public but
# only write collaborators (Mulaydm10, vedant059) can open lane PRs (forks are rejected by CI) and
# the human reviews before merge. Pinning to BASE would make every lane's first PR red.
for lane in core chain surface web mcp agents; do
  if [ -f "$lane/package.json" ]; then
    if [ -f "$lane/package-lock.json" ]; then npm ci --prefix "$lane" --no-audit --no-fund
    else npm install --prefix "$lane" --no-audit --no-fund; fi
  fi
done
