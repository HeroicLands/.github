# SPDX-License-Identifier: GPL-3.0-or-later
"""Artifact download and ZIP rejection fixtures; no network requests."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

spec = importlib.util.spec_from_file_location("download", Path(__file__).parents[1] / "actions/internal-site-deploy/download.py")
download = importlib.util.module_from_spec(spec)
spec.loader.exec_module(download)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def archive(self, entries):
        archive = self.root / "artifact.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
            for name, data in entries:
                output.writestr(name, data)
        return archive

    def test_regular_files(self):
        archive = self.archive([("publication.json", "{}"), ("site/thalorna/index.html", "<main>Page</main>")])
        download.extract(archive, self.root / "out")
        self.assertEqual((self.root / "out/site/thalorna/index.html").read_text(), "<main>Page</main>")

    def test_rejects_before_creating_destination(self):
        link = zipfile.ZipInfo("link")
        link.external_attr = 0o120777 << 16
        for entries in [ [("../escape", "data")], [("/escape", "data")],
                         [("safe", "first"), ("safe", "second")], [(link, "target")] ]:
            with self.subTest(entries=entries):
                with self.assertRaises(ValueError):
                    download.extract(self.archive(entries), self.root / "out")
                self.assertFalse((self.root / "out").exists())

    def test_size_bounds_before_extraction(self):
        archive = self.archive([("large", "x" * 1024)])
        for name, limit in [("ARCHIVE_LIMIT", 10), ("EXPANDED_LIMIT", 100), ("FILE_LIMIT", 100), ("ENTRY_LIMIT", 0)]:
            with self.subTest(name=name), patch.object(download, name, limit):
                with self.assertRaises(ValueError):
                    download.extract(archive, self.root / "out")
                self.assertFalse((self.root / "out").exists())
        with self.assertRaises(ValueError):
            download.bounded_copy(io.BytesIO(b"12345"), io.BytesIO(), 4)

    def test_download_binds_uploaded_id_run_name_and_size(self):
        payload = self.archive([("publication.json", "{}")]).read_bytes()
        artifact = {"name": "pages", "workflow_run": {"id": 42}, "id": 3,
                    "expired": False, "size_in_bytes": len(payload)}
        api = download.ORIGIN + "/api/v1/repos/HeroicLands/thalorna/actions/artifacts/3"
        class Opener:
            def __init__(self):
                self.calls = []
            def open(self, request, timeout):
                self.calls.append(request.full_url)
                if request.full_url == api:
                    return io.BytesIO(json.dumps(artifact).encode())
                if request.full_url == api + "/zip":
                    return io.BytesIO(payload)
                raise AssertionError("request leaves the exact repository artifact")
        opener = Opener()
        download.download("HeroicLands/thalorna", "42", "3", "pages", "fixture", self.root / "out", opener)
        self.assertEqual(opener.calls, [api, api + "/zip"])
        for change in [{"workflow_run": {"id": 43}}, {"id": 4}, {"name": "other"},
                       {"expired": True}, {"size_in_bytes": len(payload) - 1}]:
            with self.subTest(change=change), patch.dict(artifact, change):
                with self.assertRaises(ValueError):
                    download.download("HeroicLands/thalorna", "42", "3", "pages", "fixture", self.root / "bad", opener)
                self.assertFalse((self.root / "bad").exists())
        for artifact_id in ["", "0", "03", "../3", "3/zip"]:
            with self.subTest(artifact_id=artifact_id):
                with self.assertRaises(ValueError):
                    download.download("HeroicLands/thalorna", "42", artifact_id, "pages", "fixture", self.root / "bad", opener)

    def test_rerun_downloads_current_upload_with_same_run_and_name(self):
        old_payload = self.archive([("publication.json", "old attempt")]).read_bytes()
        current_payload = self.archive([("publication.json", "current attempt")]).read_bytes()
        artifacts = {
            3: {"name": "pages", "workflow_run": {"id": 42}, "id": 3,
                "expired": False, "size_in_bytes": len(old_payload)},
            4: {"name": "pages", "workflow_run": {"id": 42}, "id": 4,
                "expired": False, "size_in_bytes": len(current_payload)},
        }
        payloads = {3: old_payload, 4: current_payload}
        api = download.ORIGIN + "/api/v1/repos/HeroicLands/thalorna/actions/artifacts"
        class Opener:
            def __init__(self):
                self.calls = []
            def open(self, request, timeout):
                self.calls.append(request.full_url)
                if request.full_url == api:
                    return io.BytesIO(json.dumps({"artifacts": list(artifacts.values())}).encode())
                for artifact_id, artifact in artifacts.items():
                    if request.full_url == f"{api}/{artifact_id}":
                        return io.BytesIO(json.dumps(artifact).encode())
                    if request.full_url == f"{api}/{artifact_id}/zip":
                        return io.BytesIO(payloads[artifact_id])
                raise AssertionError("unexpected artifact request")
        opener = Opener()
        download.download("HeroicLands/thalorna", "42", "4", "pages", "fixture", self.root / "retry", opener)
        self.assertEqual(opener.calls, [api + "/4", api + "/4/zip"])
        self.assertEqual((self.root / "retry/publication.json").read_text(), "current attempt")

    def test_redirect_never_forwards_token_outside_forge(self):
        class Opener:
            calls = 0
            def open(self, request, timeout):
                self.calls += 1
                raise urllib.error.HTTPError(request.full_url, 302, "redirect", {"Location": "https://example.org/archive"}, io.BytesIO())
        opener = Opener()
        with self.assertRaisesRegex(ValueError, "trusted forge"):
            download.open_response(download.ORIGIN + "/archive", "fixture", opener)
        self.assertEqual(opener.calls, 1)


if __name__ == "__main__":
    unittest.main()
