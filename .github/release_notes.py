"""Release notes for a version tag, cut from the README's Updates section.

Usage: python3 .github/release_notes.py v0.2.2 [--allow-missing]

Prints the notes to stdout and, on GitHub Actions, writes `latest=true|false`
to $GITHUB_OUTPUT. Fails when the tag does not match the version in
pyproject.toml AT THE TAGGED COMMIT, or when README.md (as checked out) has
no `### <version>` section -- unless --allow-missing, which stands in a short
line for versions that predate the changelog.
"""
import os
import re
import subprocess
import sys


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=False)


def fail(message):
    print("release_notes: " + message, file=sys.stderr)
    sys.exit(1)


def version_at(tag):
    shown = git("show", "%s:pyproject.toml" % tag)
    if shown.returncode:
        fail("cannot read pyproject.toml at %s: %s" % (tag, shown.stderr.strip()))
    match = re.search(r'^version\s*=\s*"([^"]+)"', shown.stdout, re.MULTILINE)
    if not match:
        fail("no version line in pyproject.toml at %s" % tag)
    return match.group(1)


def readme_section(version):
    with open("README.md", encoding="utf-8") as f:
        lines = f.read().splitlines()
    head = re.compile(r"^###\s+%s(\s|$)" % re.escape(version))
    for i, line in enumerate(lines):
        if head.match(line):
            body = []
            for rest in lines[i + 1:]:
                if re.match(r"^#{1,3}\s", rest):
                    break
                body.append(rest)
            dated = re.search(r"\(([^)]+)\)", line)
            return "\n".join(body).strip(), dated.group(1) if dated else None
    return None, None


def repo_url():
    repo = os.environ.get("GITHUB_REPOSITORY")
    if repo:
        return "https://github.com/" + repo
    url = git("remote", "get-url", "origin").stdout.strip()
    return re.sub(r"\.git$", "", url)


def main():
    args = [a.strip() for a in sys.argv[1:] if a.strip() and not a.strip().startswith("--")]
    allow_missing = "--allow-missing" in sys.argv[1:]
    if len(args) != 1:
        fail("usage: release_notes.py v<version> [--allow-missing] (got %r)" % (sys.argv[1:],))
    tag = args[0] if args[0].startswith("v") else "v" + args[0]
    if git("rev-parse", "--verify", "--quiet", "refs/tags/" + tag).returncode:
        fail("tag %s does not exist" % tag)

    version = version_at(tag)
    if tag != "v" + version:
        fail("tag %s does not match pyproject.toml version %s at that commit" % (tag, version))

    body, dated = readme_section(version)
    if body is None:
        if not allow_missing:
            fail("README.md has no '### %s' section; write the changelog first" % version)
        body = "No changelog was written for this version."

    url = repo_url()
    previous = git("describe", "--tags", "--abbrev=0", "--match", "v*", tag + "^")
    if previous.returncode == 0:
        link = "**Full Changelog**: %s/compare/%s...%s" % (url, previous.stdout.strip(), tag)
    else:
        link = "**Source**: %s/tree/%s" % (url, tag)

    notes = "### Changes\n\n" + body + "\n\n"
    if dated:
        notes += "Released %s.\n\n" % dated
    notes += link + "\n"
    sys.stdout.write(notes)

    newest = git("tag", "-l", "v*", "--sort=-v:refname").stdout.split()
    latest = "true" if newest and newest[0] == tag else "false"
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("tag=%s\nlatest=%s\n" % (tag, latest))
    else:
        print("release_notes: latest=%s" % latest, file=sys.stderr)


if __name__ == "__main__":
    main()
