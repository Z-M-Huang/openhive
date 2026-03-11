#!/usr/bin/env python3
"""
RSS/Atom parser using stdlib only.
Reads RSS/Atom XML from file or stdin, outputs JSON.
"""

import argparse
import json
import sys
import os
import re
from datetime import datetime
from xml.etree import ElementTree as ET
from typing import Any


# Security limits
MAX_INPUT_SIZE = 1 * 1024 * 1024  # 1MB


def sanitize_string(s: str | None, max_len: int = 10000) -> str:
    """Sanitize string, limit length, handle None."""
    if s is None:
        return ""
    # Strip leading/trailing whitespace
    s = s.strip()
    # Limit length to prevent huge outputs
    if len(s) > max_len:
        s = s[:max_len] + "..."
    return s


def parse_datetime(date_str: str | None) -> str | None:
    """Try to parse common date formats, return ISO string or None."""
    if not date_str:
        return None

    # Common RSS/Atom date formats
    formats = [
        "%a, %d %b %Y %H:%M:%S %z",  # RFC 822 (e.g., "Mon, 01 Jan 2024 12:00:00 +0000")
        "%a, %d %b %Y %H:%M:%S GMT",  # RFC 822 with GMT
        "%Y-%m-%dT%H:%M:%S%z",        # ISO 8601
        "%Y-%m-%dT%H:%M:%S",          # ISO 8601 without timezone
        "%Y-%m-%d",                   # Date only
    ]

    date_str = date_str.strip()

    # Remove timezone abbreviations Python doesn't understand
    date_str = re.sub(r'\s+UTC$', ' +0000', date_str)
    date_str = re.sub(r'\s+EST$', ' -0500', date_str)
    date_str = re.sub(r'\s+EDT$', ' -0400', date_str)
    date_str = re.sub(r'\s+PST$', ' -0800', date_str)
    date_str = re.sub(r'\s+PDT$', ' -0700', date_str)

    for fmt in formats:
        try:
            dt = datetime.strptime(date_str, fmt)
            return dt.isoformat()
        except ValueError:
            continue

    # Return original if we can't parse it
    return date_str


def parse_element_text(elem: ET.Element, tag: str, namespaces: dict | None = None) -> str:
    """Extract text from element, handling namespaces."""
    if namespaces:
        # Try with namespace prefix
        for prefix, uri in namespaces.items():
            ns_elem = elem.find(f".//{{{uri}}}{tag}")
            if ns_elem is not None and ns_elem.text:
                return sanitize_string(ns_elem.text)
    # Try without namespace
    plain_elem = elem.find(f".//{tag}")
    if plain_elem is not None and plain_elem.text:
        return sanitize_string(plain_elem.text)
    return ""


def parse_entry(entry: ET.Element, namespaces: dict | None = None) -> dict[str, Any]:
    """Parse a single entry/item from RSS or Atom."""
    item: dict[str, Any] = {
        "title": "",
        "link": "",
        "description": "",
        "pubDate": None
    }

    # Title - try multiple common elements
    item["title"] = parse_element_text(entry, "title", namespaces)
    if not item["title"]:
        item["title"] = parse_element_text(entry, "name", namespaces)  # For Atom author

    # Link - RSS has <link>, Atom has multiple <link> with rel
    link_elem = entry.find(".//link")
    if link_elem is not None:
        href = link_elem.get("href") or (link_elem.text if link_elem.text else "")
        item["link"] = sanitize_string(href)
    if not item["link"]:
        # Try Atom self link
        for link in entry.findall(".//{http://www.w3.org/2005/Atom}link"):
            rel = link.get("rel", "alternate")
            if rel == "alternate" or rel is None:
                item["link"] = sanitize_string(link.get("href", ""))
                break

    # Description/summary - try multiple elements
    item["description"] = parse_element_text(entry, "description", namespaces)
    if not item["description"]:
        item["description"] = parse_element_text(entry, "summary", namespaces)
    if not item["description"]:
        item["description"] = parse_element_text(entry, "content", namespaces)

    # PubDate - try multiple date elements
    pub_date = parse_element_text(entry, "pubDate", namespaces)
    if not pub_date:
        pub_date = parse_element_text(entry, "updated", namespaces)
    if not pub_date:
        pub_date = parse_element_text(entry, "published", namespaces)
    if not pub_date:
        pub_date = parse_element_text(entry, "dc:date", namespaces)

    item["pubDate"] = parse_datetime(pub_date)

    return item


def detect_namespaces(root: ET.Element) -> dict[str, str] | None:
    """Detect namespaces used in the XML."""
    # Check for Atom namespace
    if root.tag.startswith("{") and "atom" in root.tag.lower():
        return None

    # Check for xmlns declarations
    ns = {}
    for attr, value in root.attrib.items():
        if attr.startswith("xmlns:"):
            prefix = attr.split(":")[1]
            ns[prefix] = value.replace("http://www.w3.org/2005/Atom", "atom")

    return ns if ns else None


def parse_rss(root: ET.Element) -> list[dict[str, Any]]:
    """Parse RSS feed."""
    channels = root.findall(".//channel")
    items: list[dict[str, Any]] = []

    namespaces = detect_namespaces(root)

    for channel in channels:
        # RSS 1.0 uses <item>, RSS 2.0 uses <item>
        for item_elem in channel.findall("item"):
            items.append(parse_entry(item_elem, namespaces))

        # Also check for items directly under channel (RSS 2.0)
        for item_elem in channel.findall(".//item"):
            items.append(parse_entry(item_elem, namespaces))

    return items


def parse_atom(root: ET.Element) -> list[dict[str, Any]]:
    """Parse Atom feed."""
    namespaces = {"atom": "http://www.w3.org/2005/Atom"}

    items: list[dict[str, Any]] = []

    # Atom entries
    for entry in root.findall(".//{http://www.w3.org/2005/Atom}entry"):
        items.append(parse_entry(entry, namespaces))

    return items


def check_security_constraints(xml_content: str) -> None:
    """Check for potentially dangerous XML constructs."""
    # Check for DOCTYPE (XXE risk)
    if "<!DOCTYPE" in xml_content.upper():
        raise ValueError("Input contains DOCTYPE declaration which is not allowed")

    # Check for ENTITY (XXE risk)
    if "<!ENTITY" in xml_content.upper():
        raise ValueError("Input contains ENTITY declaration which is not allowed")

    # Limit input size
    if len(xml_content) > MAX_INPUT_SIZE:
        raise ValueError(f"Input size exceeds maximum of {MAX_INPUT_SIZE} bytes")


def parse_rss_feed(xml_content: str, limit: int | None = None) -> list[dict[str, Any]]:
    """Parse RSS/Atom XML content."""
    check_security_constraints(xml_content)

    # Parse with iterparse for memory efficiency
    # First, get the root element to determine feed type
    root = ET.fromstring(xml_content)

    items: list[dict[str, Any]]

    root_tag = root.tag.lower()

    if "rss" in root_tag:
        items = parse_rss(root)
    elif "feed" in root_tag or "atom" in root_tag:
        items = parse_atom(root)
    elif "rdf:rdf" in root_tag or "rdf" in root_tag:
        # RDF (RSS 1.0)
        items = parse_rss(root)
    else:
        # Try RSS by default
        items = parse_rss(root)

    # Apply limit if specified
    if limit is not None and limit > 0:
        items = items[:limit]

    return items


def main():
    parser = argparse.ArgumentParser(
        description="Parse RSS/Atom feeds and output JSON"
    )
    parser.add_argument(
        "file",
        nargs="?",
        default="-",
        help="RSS/Atom XML file (default: stdin)"
    )
    parser.add_argument(
        "--limit", "-n",
        type=int,
        default=None,
        help="Maximum number of items to output"
    )

    args = parser.parse_args()

    # Read input
    if args.file == "-":
        # Read from stdin
        if sys.stdin.isatty():
            print("Error: No input provided. Pass file or use pipe.", file=sys.stderr)
            sys.exit(1)
        xml_content = sys.stdin.read()
    else:
        # Check file exists
        if not os.path.isfile(args.file):
            print(f"Error: File not found: {args.file}", file=sys.stderr)
            sys.exit(1)
        with open(args.file, "r", encoding="utf-8") as f:
            xml_content = f.read()

    # Parse and output
    try:
        items = parse_rss_feed(xml_content, args.limit)
        print(json.dumps(items, indent=2, ensure_ascii=False))
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except ET.ParseError as e:
        print(f"Error: Invalid XML: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()