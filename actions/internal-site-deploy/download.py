# SPDX-License-Identifier: GPL-3.0-or-later
"""Download a same-run artifact with bounded archive and extraction sizes."""
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ORIGIN = "https://git.pupluppy.org"
ARCHIVE_LIMIT = 512 * 1024 * 1024
EXPANDED_LIMIT = 2 * 1024 * 1024 * 1024
FILE_LIMIT = 256 * 1024 * 1024
ENTRY_LIMIT = 100000


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def open_response(url, token, opener):
    for _ in range(3):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc != "git.pupluppy.org":
            raise ValueError("artifact URL leaves the trusted forge")
        request = urllib.request.Request(url, headers={"Authorization": "token " + token})
        try:
            return opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            if error.code not in (301, 302, 303, 307, 308):
                raise ValueError("artifact request failed") from None
            url = urllib.parse.urljoin(url, error.headers.get("Location", ""))
            error.close()
    raise ValueError("artifact redirect limit exceeded")


def bounded_copy(source, target, limit):
    count = 0
    while chunk := source.read(min(1024 * 1024, limit - count + 1)):
        count += len(chunk)
        if count > limit:
            raise ValueError("artifact size limit exceeded")
        target.write(chunk)
    return count


def extract(archive, destination):
    if Path(archive).stat().st_size > ARCHIVE_LIMIT:
        raise ValueError("artifact archive size limit exceeded")
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if len(entries) > ENTRY_LIMIT or sum(e.file_size for e in entries) > EXPANDED_LIMIT:
            raise ValueError("artifact expanded size limit exceeded")
        names = set()
        for entry in entries:
            name = entry.filename.rstrip("/")
            mode = entry.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if (not re.fullmatch(r"[A-Za-z0-9_./-]+", name) or len(name) > 1024
                    or any(part in ("", ".", "..") for part in name.split("/"))
                    or name in names or entry.flag_bits & 1
                    or entry.file_size > FILE_LIMIT
                    or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                    or kind not in (0, stat.S_IFREG, stat.S_IFDIR)
                    or ((kind == stat.S_IFDIR) != entry.is_dir() and kind != 0)
                    or mode & 0o7000):
                raise ValueError("artifact ZIP entry rejected")
            names.add(name)
        destination = Path(destination)
        destination.mkdir(mode=0o700)
        try:
            for entry in entries:
                target = destination / entry.filename
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(entry) as content, target.open("xb") as output:
                    if bounded_copy(content, output, entry.file_size) != entry.file_size:
                        raise ValueError("artifact ZIP entry size mismatch")
        except BaseException:
            shutil.rmtree(destination)
            raise


def download(repository, run_id, artifact_id, name, token, destination, opener=None):
    if (not re.fullmatch(r"HeroicLands/[A-Za-z0-9_.-]+", repository)
            or repository.split("/")[1] in (".", "..")
            or not re.fullmatch(r"[1-9][0-9]*", run_id)
            or not re.fullmatch(r"[1-9][0-9]*", artifact_id)
            or not name or len(name) > 255 or not token):
        raise ValueError("trusted artifact context and GITEA_TOKEN are required")
    opener = opener or urllib.request.build_opener(NoRedirect())
    api = f"{ORIGIN}/api/v1/repos/{repository}/actions/artifacts"
    with open_response(f"{api}/{artifact_id}", token, opener) as response:
        body = response.read(4 * 1024 * 1024 + 1)
    if len(body) > 4 * 1024 * 1024:
        raise ValueError("artifact metadata exceeds limit")
    artifact = json.loads(body)
    if (artifact.get("name") != name
            or artifact.get("workflow_run", {}).get("id") != int(run_id)
            or artifact.get("id") != int(artifact_id)):
        raise ValueError("artifact identity rejected")
    if (artifact.get("expired") is not False or type(artifact.get("id")) is not int
            or artifact["id"] <= 0 or type(artifact.get("size_in_bytes")) is not int
            or not 0 < artifact["size_in_bytes"] <= ARCHIVE_LIMIT):
        raise ValueError("artifact metadata rejected")
    with tempfile.TemporaryDirectory(prefix="preview-download-") as temp:
        archive = Path(temp) / "artifact.zip"
        with open_response(f"{api}/{artifact['id']}/zip", token, opener) as response:
            with archive.open("xb") as output:
                count = bounded_copy(response, output, ARCHIVE_LIMIT)
        if count != artifact["size_in_bytes"]:
            raise ValueError("artifact archive size mismatch")
        extract(archive, destination)


if __name__ == "__main__":
    try:
        download(os.environ.get("SOURCE_REPOSITORY", ""), os.environ.get("RUN_ID", ""),
                 os.environ.get("ARTIFACT_ID", ""), os.environ.get("ARTIFACT_NAME", ""),
                 os.environ.get("GITEA_TOKEN", ""),
                 sys.argv[1] if len(sys.argv) == 2 else "publication")
    except Exception:
        print("download.py:1:1: error: bounded artifact download rejected", file=sys.stderr)
        sys.exit(1)
