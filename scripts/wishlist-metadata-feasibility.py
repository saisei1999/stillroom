"""PER-67 offline experiment. Reads fixture HTML only and cannot fetch URLs."""

import argparse
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit


class Metadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta = {}
        self.links = []
        self.json_ld = []
        self.script = None

    def handle_starttag(self, tag, pairs):
        attrs = dict(pairs)
        if tag == "meta" and attrs.get("property") and attrs.get("content"):
            self.meta.setdefault(attrs["property"], attrs["content"])
        if tag == "link" and "icon" in (attrs.get("rel") or "").lower().split():
            self.links.append(attrs.get("href"))
        if tag == "script" and attrs.get("type") == "application/ld+json":
            self.script = ""

    def handle_data(self, text):
        if self.script is not None:
            self.script += text

    def handle_endtag(self, tag):
        if tag == "script" and self.script is not None:
            try:
                self.json_ld.append(json.loads(self.script, parse_float=str))
            except (ValueError, RecursionError):
                pass
            self.script = None


def objects(value):
    return [node for node in (value if isinstance(value, list) else [value]) if isinstance(node, dict)]


def schema_type(node, name):
    types = node.get("@type")
    return any(
        value in (name, "https://schema.org/" + name, "http://schema.org/" + name)
        for value in (types if isinstance(types, list) else [types])
    )


def candidates(values):
    for node in objects(values):
        yield from candidates(node.get("@graph"))
        if schema_type(node, "ProductGroup"):
            yield from candidates(node.get("hasVariant"))
        if schema_type(node, "Product"):
            yield node


def https_url(value, base):
    if not isinstance(value, str) or not value or re.search(r"[\s\\]", value):
        return None
    try:
        absolute = urljoin(base, value)
        url = urlsplit(absolute)
        return absolute if url.scheme == "https" and url.hostname and not url.username and not url.password else None
    except ValueError:
        return None


def money(amount, currency):
    if isinstance(amount, (str, int)) and re.fullmatch(r"\d{1,18}(?:\.\d{1,6})?", str(amount)):
        if isinstance(currency, str) and re.fullmatch(r"[A-Z]{3}", currency):
            return {"amount": str(amount), "currency": currency}
    return None


def days(value):
    if not isinstance(value, dict) or value.get("unitCode") != "DAY":
        return None
    low, high = value.get("minValue"), value.get("maxValue")
    if type(low) is int and type(high) is int and 0 <= low <= high <= 365:
        return low, high
    return None


def shipping(offer, country, postal):
    if not country:
        return {}
    matches = []
    for detail in objects(offer.get("shippingDetails")):
        regions = objects(detail.get("shippingDestination"))
        if detail.get("doesNotShip") is True:
            # A narrower exclusion can override a country-wide quote. Missing postal
            # information leaves applicability unknown, so withhold the quote.
            if any(
                region.get("addressCountry") == country
                and (not postal or "postalCode" not in region or region["postalCode"] == postal)
                for region in regions
            ):
                return {}
            continue
        # Limit the proof to flat, unconditional rates and a known region. Other rules
        # may attach order thresholds, time cutoffs, or dimensional pricing.
        if detail.keys() - {"@type", "shippingDestination", "shippingRate", "deliveryTime", "doesNotShip"}:
            continue
        if any(
            region.keys() <= {"@type", "addressCountry", "postalCode"}
            and region.get("addressCountry") == country
            and ("postalCode" not in region or (postal and region["postalCode"] == postal))
            for region in regions
        ):
            matches.append(detail)
    if len(matches) != 1:
        return {}
    detail = matches[0]
    rate = detail.get("shippingRate")
    result = {}
    if isinstance(rate, dict) and rate.keys() <= {"@type", "value", "currency"}:
        cost = money(rate.get("value"), rate.get("currency"))
        if cost:
            result["shipping"] = cost
    delivery = detail.get("deliveryTime")
    if isinstance(delivery, dict) and delivery.keys() <= {"@type", "handlingTime", "transitTime"}:
        handling, transit = days(delivery.get("handlingTime")), days(delivery.get("transitTime"))
        if handling and transit:
            result["deliveryDays"] = [handling[0] + transit[0], handling[1] + transit[1]]
    return result


def extract(html, url, country=None, postal=None):
    page = Metadata()
    page.feed(html)
    result = {}
    product_matches = []
    for product in candidates(page.json_ld):
        offers = objects(product.get("offers"))
        matching = [
            offer for offer in offers
            if https_url(offer.get("url"), url) == url
            or (not offer.get("url") and https_url(product.get("url"), url) == url)
        ]
        if matching or https_url(product.get("url"), url) == url:
            product_matches.append((product, matching))

    if len(product_matches) == 1:
        product, offers = product_matches[0]
        if isinstance(product.get("name"), str):
            result["title"] = product["name"]
        images = product.get("image")
        for entry in images if isinstance(images, list) else [images]:
            image = https_url(entry.get("url") if isinstance(entry, dict) else entry, url)
            if image:
                result["image"] = image
                break
        if len(offers) == 1 and schema_type(offers[0], "Offer") and not schema_type(offers[0], "AggregateOffer"):
            offer = offers[0]
            price = money(offer.get("price"), offer.get("priceCurrency"))
            if price:
                result["price"] = price
                result.update(shipping(offer, country, postal))

    if page.meta.get("og:type") == "product" and https_url(page.meta.get("og:url"), url) == url:
        if page.meta.get("og:title"):
            result.setdefault("title", page.meta["og:title"])
        image = https_url(page.meta.get("og:image"), url)
        if image:
            result.setdefault("image", image)
    for link in page.links:
        icon = https_url(link, url)
        if icon and urlsplit(icon).netloc == urlsplit(url).netloc:
            result["icon"] = icon
            break
    return result


def markup(node):
    return '<script type="application/ld+json">' + json.dumps(node) + '</script>'


def verify():
    dawn = "https://shopify-fixture.example/products/mug"
    purple = "https://woo-fixture.example/product/scarf/"
    preview = "https://independent-fixture.example/product/lamp"

    def product(url, name, amount):
        return {"@type": "Product", "url": url, "name": name, "image": "/image.png",
                "offers": {"@type": "Offer", "url": url, "price": amount, "priceCurrency": "CAD"}}

    red, blue = product(dawn + "?variant=1", "Red mug", "20.00"), product(dawn + "?variant=2", "Blue mug", "25.00")
    variant_html = markup({"@type": "ProductGroup", "hasVariant": [red, blue]})
    simple = product(purple, "Scarf", "45.00")
    aggregate = {**simple, "offers": {"@type": "AggregateOffer", "lowPrice": "30", "highPrice": "60", "priceCurrency": "CAD"}}
    partial = f'<meta property="og:type" content="product"><meta property="og:url" content="{preview}">' \
              '<meta property="og:title" content="Lamp"><meta property="og:image" content="/lamp.png">' \
              '<link rel="icon" href="/favicon.png">'
    simple["offers"]["shippingDetails"] = {
        "shippingDestination": {"addressCountry": "CA", "postalCode": "A1A 1A1"},
        "shippingRate": {"value": 0, "currency": "CAD"},
        "deliveryTime": {"handlingTime": {"minValue": 1, "maxValue": 2, "unitCode": "DAY"},
                         "transitTime": {"minValue": 2, "maxValue": 5, "unitCode": "DAY"}},
    }
    countrywide = {**simple["offers"]["shippingDetails"], "shippingDestination": {"addressCountry": "CA"},
                   "shippingRate": {"value": 3, "currency": "CAD"}}
    exclusion = {"shippingDestination": {"addressCountry": "CA", "postalCode": "A1A 1A1"}, "doesNotShip": True}
    restricted = markup({**simple, "offers": {**simple["offers"], "shippingDetails": [countrywide, exclusion]}})

    cases = [
        ("exact offer", extract(markup({"@graph": [simple]}), purple),
         {"title": "Scarf", "image": "https://woo-fixture.example/image.png", "price": money("45.00", "CAD")}),
        ("selected first variant", extract(variant_html, red["url"]).get("price"), money("20.00", "CAD")),
        ("selected second variant", extract(variant_html, blue["url"]).get("price"), money("25.00", "CAD")),
        ("parent with variant prices", extract(variant_html, dawn), {}),
        ("aggregate range", extract(markup(aggregate), purple).get("price"), None),
        ("partial metadata and icon", extract(partial, preview),
         {"title": "Lamp", "image": "https://independent-fixture.example/lamp.png",
          "icon": "https://independent-fixture.example/favicon.png"}),
        ("matched destination", extract(markup(simple), purple, "CA", "A1A 1A1").get("shipping"), money("0", "CAD")),
        ("relative delivery window", extract(markup(simple), purple, "CA", "A1A 1A1").get("deliveryDays"), [3, 7]),
        ("wrong postcode", extract(markup(simple), purple, "CA", "B2B 2B2").get("shipping"), None),
        ("wrong country", extract(markup(simple), purple, "US", "A1A 1A1").get("shipping"), None),
        ("postal exclusion overrides rate and delivery", extract(restricted, purple, "CA", "A1A 1A1"),
         {"title": "Scarf", "image": "https://woo-fixture.example/image.png", "price": money("45.00", "CAD")}),
        ("unexcluded postal code", extract(restricted, purple, "CA", "B2B 2B2").get("shipping"), money("3", "CAD")),
        ("unknown postal code with a regional exclusion", extract(restricted, purple, "CA").get("shipping"), None),
        ("blocked or empty response", extract("<title>Access denied</title>", dawn), {}),
        ("unsafe image URL", extract(partial.replace("/lamp.png", "javascript:alert(1)"), preview).get("image"), None),
        ("ambiguous listing", extract(markup([simple, simple]), purple).get("price"), None),
    ]
    for label, actual, expected in cases:
        if actual != expected:
            raise AssertionError(f"{label}: got {actual!r}, expected {expected!r}")
        print(f"PASS {label}")
    print(f"{len(cases)} offline cases passed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--html", type=Path, help="Replay a locally saved product page")
    parser.add_argument("--url", help="The original product URL")
    options = parser.parse_args()
    if options.html is None and options.url is None:
        verify()
    elif options.html is None or not options.url or https_url(options.url, "") != options.url:
        parser.error("Replay requires --html and the original absolute HTTPS --url.")
    else:
        with options.html.open("rb") as source:
            data = source.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            parser.error("The HTML snapshot exceeds 1 MiB.")
        print(json.dumps(extract(data.decode("utf-8", errors="replace"), options.url), indent=2))
