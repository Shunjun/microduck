#!/usr/bin/env python3
"""Reserve a merged PR's release version, or stamp that version into a build checkout."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess

CORE = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
TAG = re.compile(r"daemon-v" + CORE + r"\Z")
SEMVER = re.compile(CORE + r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\Z")
PACKAGE = re.compile(r"(?ms)^\[workspace\.package\][^\S\n]*\n(?P<body>.*?)(?=^\[|\Z)")
VERSION = re.compile(r"(?m)^(?P<prefix>\s*version\s*=\s*)[\"'](?P<version>[^\"'\n]+)[\"']")


def tag_version(tag):
    match = TAG.fullmatch(tag)
    return tuple(map(int, match.groups())) if match else None


def choose_version(branch, tags, workspace_version, sha):
    """tags maps stable or other tag names to their resolved commit SHA."""
    explicit = tag_version(branch)
    if explicit:
        version = explicit
    else:
        # Retrying the same merged commit must never consume another patch version.
        existing = [tag_version(tag) for tag, commit in tags.items()
                    if commit == sha and tag_version(tag) is not None]
        if existing:
            version = max(existing)
        else:
            stable = [v for tag in tags if (v := tag_version(tag)) is not None]
            match = SEMVER.fullmatch(workspace_version)
            if not stable and not match:
                raise ValueError("workspace.package.version is not semver")
            base = max(stable) if stable else tuple(map(int, match.groups()[:3]))
            version = (base[0], base[1], base[2] + 1)
    text = ".".join(map(str, version))
    tag = "daemon-v" + text
    if tag in tags and tags[tag] != sha:
        raise ValueError(f"{tag} already belongs to another commit; refusing to move it")
    return text, tag


def reserve(branch, sha, workspace_version, read_tags, create_tag):
    for _ in range(8):
        tags = read_tags()
        version, tag = choose_version(branch, tags, workspace_version, sha)
        if tag in tags:
            return version, tag
        try:
            create_tag(tag, sha)
            return version, tag
        except subprocess.CalledProcessError:
            # Ref creation is atomic. A concurrent PR can win the same patch number;
            # retry only when a ref really appeared, never mask auth/network failures.
            updated = read_tags()
            if tag not in updated:
                raise
            if updated[tag] == sha:
                return version, tag
            if tag_version(branch):
                raise ValueError(f"{tag} was reserved by another commit")
    raise RuntimeError("could not reserve a version after concurrent tag updates")


def package_version(text):
    package = PACKAGE.search(text)
    match = VERSION.search(package.group("body")) if package else None
    if not match:
        raise ValueError("expected a quoted version in [workspace.package]")
    return match.group("version")


def stamp(text, version):
    match = SEMVER.fullmatch(version)
    if not match or any(part.isdigit() and len(part) > 1 and part.startswith("0")
                        for part in (match.group(4) or "").split(".")):
        raise ValueError("invalid release semver")
    package_version(text)  # Validate before changing any content.
    package = PACKAGE.search(text)
    body = VERSION.sub(lambda m: m.group("prefix") + json.dumps(version),
                       package.group("body"), count=1)
    return text[:package.start("body")] + body + text[package.end("body"):]


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    plan = sub.add_parser("reserve")
    plan.add_argument("--branch", required=True)
    plan.add_argument("--sha", required=True)
    plan.add_argument("--repo", required=True)
    plan.add_argument("--output", type=Path, required=True)
    build = sub.add_parser("stamp")
    build.add_argument("--version", required=True)
    args = parser.parse_args()
    cargo = Path("Cargo.toml")
    if args.operation == "stamp":
        cargo.write_text(stamp(cargo.read_text(), args.version))
        return
    if not re.fullmatch(r"[0-9a-f]{40}", args.sha) or run("git", "rev-parse", "HEAD") != args.sha:
        raise ValueError("checkout must be the exact trusted merged commit")

    def read_tags():
        subprocess.run(["git", "fetch", "--tags", "origin"], check=True)
        tags = run("git", "tag", "--list", "daemon-v*").splitlines()
        return {tag: run("git", "rev-parse", tag + "^{commit}")
                for tag in tags if tag_version(tag) is not None}

    def create_tag(tag, sha):
        subprocess.run(["gh", "api", "--method", "POST", f"repos/{args.repo}/git/refs",
                        "-f", f"ref=refs/tags/{tag}", "-f", f"sha={sha}"],
                       check=True, stdout=subprocess.DEVNULL)

    version, tag = reserve(args.branch, args.sha, package_version(cargo.read_text()),
                           read_tags, create_tag)
    with args.output.open("a") as output:
        output.write(f"version={version}\ntag={tag}\n")
    print(f"{args.branch} -> {tag} at {args.sha}")


if __name__ == "__main__":
    main()
