"""Retain complete pinned structural groups and their schema dependency closure."""
from pathlib import Path
import argparse
import gzip
import hashlib
import json
import posixpath
import subprocess
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("upstream_checkout", type=Path)
repo = parser.parse_args().upstream_checkout.resolve()
revision = "7bc3365c652a322f3d762021b3879eb92dae7e30"
destination = Path(__file__).resolve().parents[1] / "test/fixtures/w3c-structures"
destination.mkdir(parents=True, exist_ok=True)
namespace = {"t": "http://www.w3.org/XML/2004/xml-schema-test-suite/"}
href = "{http://www.w3.org/1999/xlink}href"
xsd = "{http://www.w3.org/2001/XMLSchema}"
# Fixed before engine execution; retain every test in each named group.
selection = {
    "msMeta/Schema_w3c.xml": [
        "schC2", "schC3", "schC4", "schC5", "schD10",
        "schF1", "schF2", "schF3", "schF4", "schF5", "schF6", "schG1",
    ],
    "msMeta/IdentityConstraint_w3c.xml": [
        "idA002", "idZ005", "idZ006", "idZ007", "idZ008", "idZ010", "idZ012",
    ],
}

def original(path):
    return subprocess.check_output(["git", "-C", str(repo), "show", revision + ":" + path])

def metadata(path, data):
    return {
        "path": path, "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "gitBlob": hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest(),
    }

sources = {}
def retain(path):
    if path not in sources:
        data = original(path)
        target = destination / "upstream" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        sources[path] = metadata(path, data)
    return sources[path]

def dependencies(path, seen):
    if path in seen:
        return
    seen.add(path)
    retain(path)
    document = ET.fromstring(original(path))
    for child in document:
        if child.tag in [xsd + "include", xsd + "import", xsd + "redefine"]:
            location = child.get("schemaLocation")
            if location:
                if ":" in location:
                    raise ValueError("Selection requires an explicit external URI policy: " + location)
                dependencies(posixpath.normpath(posixpath.join(posixpath.dirname(path), location)), seen)

groups, metadatas = [], []
for path, names in selection.items():
    data = original(path)
    compressed = gzip.compress(data, compresslevel=9, mtime=0)
    stored = Path(path).name + ".gz"
    (destination / stored).write_bytes(compressed)
    metadatas.append({**metadata(path, data), "storedAs": stored,
                      "compressedSha256": hashlib.sha256(compressed).hexdigest()})
    document = ET.fromstring(data)
    for name in names:
        group = next(item for item in document if item.get("name") == name)
        tests, closure = [], set()
        for item in group:
            kind = item.tag.split("}")[-1]
            if kind not in ["schemaTest", "instanceTest"]:
                continue
            documents = item.findall("t:" + ("schemaDocument" if kind == "schemaTest" else "instanceDocument"), namespace)
            paths = [posixpath.normpath(posixpath.join(posixpath.dirname(path), node.get(href))) for node in documents]
            expected = [dict(node.attrib) for node in item.findall("t:expected", namespace)]
            tests.append({"name": item.get("name"), "kind": kind, "expected": expected,
                          "status": dict(item.find("t:current", namespace).attrib),
                          "sources": [retain(value) for value in paths]})
            if kind == "schemaTest":
                for value in paths:
                    dependencies(value, closure)
        groups.append({"group": name, "metadataPath": path, "tests": tests,
                       "resources": [sources[value] for value in sorted(closure)]})

manifest = {
    "formatVersion": 1, "upstream": "https://github.com/w3c/xsdtests", "revision": revision,
    "scope": "Finite XSD 1.0 composition, identity and invalid-schema groups; not full W3C conformance.",
    "selectionPolicy": "Named complete groups fixed before engine execution; all original expectations and recursive local schema dependencies retained.",
    "copyright": retain("00COPYRIGHT"), "metadata": metadatas, "groups": groups,
}
(destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf8")
print(len(groups), "groups", sum(len(group["tests"]) for group in groups), "tests", len(sources), "original files")
