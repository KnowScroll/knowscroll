#!/usr/bin/env python3
"""Snapshot one public source page's visible text for editorial quote verification (#131).

Usage: python3 scripts/substrate/snapshot_source.py <source-key> <https-url>

Writes artifacts/source-snapshots/<source-key>.txt (ignored) and prints the SHA-256 of that
normalized text. The substrate seed records the hash and retrieval day; verify-substrate.ts
checks every claim quote is an exact passage of this text. No credential, cookie or redirect to
a non-https origin is followed; the page is read once and never re-fetched implicitly.
"""
import hashlib
import html
import re
import sys
import unicodedata
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

SKIP = {"script", "style", "noscript", "svg", "template", "head"}
BLOCK = {"p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "br", "tr", "section", "article", "figcaption", "blockquote"}


class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in SKIP:
            self.skip += 1
        elif tag in BLOCK:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in SKIP and self.skip:
            self.skip -= 1
        elif tag in BLOCK:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def normalize(text: str) -> str:
    """Mirrors the one shared normalization (packages/core/src/semantic/source-text.ts): NFC, then
    collapse all whitespace (including no-break spaces) to single spaces. Typography is otherwise
    preserved exactly."""
    text = unicodedata.normalize("NFC", html.unescape(text))
    return re.sub(r"\s+", " ", text.replace(" ", " ")).strip()


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    key, url = sys.argv[1], sys.argv[2]
    if not re.fullmatch(r"[a-z][a-z0-9_.-]{2,79}", key):
        print("invalid source key", file=sys.stderr)
        return 2
    if not url.startswith("https://"):
        print("sources must be https", file=sys.stderr)
        return 2
    request = urllib.request.Request(url, headers={"User-Agent": "KnowScroll-editorial-verification/1 (+personal non-commercial)"})
    with urllib.request.urlopen(request, timeout=30) as response:
        final = response.geturl()
        if not final.startswith("https://"):
            print(f"refused non-https redirect: {final}", file=sys.stderr)
            return 1
        raw = response.read(4_000_000).decode(response.headers.get_content_charset() or "utf-8", errors="replace")
    parser = VisibleText()
    parser.feed(raw)
    text = normalize(" ".join(parser.parts))
    out = Path("artifacts/source-snapshots") / f"{key}.txt"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    print(f"{key}\t{digest}\t{len(text)} chars\t{final}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
