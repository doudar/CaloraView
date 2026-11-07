"""Synthetic, stdlib-only regression tests for the offline SDMP extractor.

Run with Python 3: python scripts/research/test_sdmp_fixture.py
No APK, vendor library, camera, or copied media is required.
"""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest


EXTRACTOR = Path(__file__).with_name('extract-sdmp-fixture.py')


def ifd(entries):
    """Build the small observed IFD layout using synthetic field values."""
    header = bytearray(struct.pack('<H', len(entries)))
    extra = bytearray()
    payload_start = 2 + 12 * len(entries)
    widths = {1: 1, 3: 2, 4: 4, 7: 1}
    for tag, typ, raw in entries:
        count = len(raw) // widths[typ]
        value = raw.ljust(4, b'\0') if len(raw) <= 4 else struct.pack('<I', payload_start + len(extra))
        header.extend(struct.pack('<HHI', tag, typ, count) + value)
        if len(raw) > 4:
            extra.extend(raw)
    return bytes(header + extra)


def segment(marker, block, offset, payload):
    header = bytearray(16)
    header[:4] = b'SDMP'
    struct.pack_into('<H', header, 6, block)
    struct.pack_into('<I', header, 12, offset)
    raw = bytes(header) + payload
    return bytes((255, marker)) + struct.pack('>H', len(raw) + 2) + raw


def fixture(calibration_size=0x3800, image_size=12, duplicate=False):
    calibration = bytearray(0x3800)
    struct.pack_into('<II', calibration, 0, 0x404, calibration_size)
    image = bytes(range(image_size))
    metadata = bytes(range(8))
    entries = [(0, 3, image), (1, 3, metadata),
               (2, 4, struct.pack('<I', 2)), (3, 4, struct.pack('<I', 3))]
    if duplicate:
        entries.append((2, 4, struct.pack('<I', 2)))
    return bytes(calibration), image, metadata, ifd([(0x207, 7, calibration)]), ifd(entries)


class ExtractorTests(unittest.TestCase):
    def invoke(self, jpeg, succeeds):
        test_root = EXTRACTOR.parents[2] / 'test-output'
        test_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='synthetic-sdmp-', dir=test_root) as folder:
            root = Path(folder)
            source = root / 'synthetic.jpg'
            output = root / 'extract'
            source.write_bytes(jpeg)
            proc = subprocess.run([sys.executable, str(EXTRACTOR), str(source), '--out-dir', str(output)],
                                  capture_output=True, text=True, timeout=10)
            if not succeeds:
                self.assertNotEqual(proc.returncode, 0)
                self.assertFalse(output.exists(), 'Rejected input must not create partial extracts')
                return proc.stderr
            self.assertEqual(proc.returncode, 0, proc.stderr)
            manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
            self.assertEqual(json.loads(proc.stdout), manifest)
            self.assertTrue(manifest['researchOnly'])
            self.assertEqual(manifest['sourceSha256'], hashlib.sha256(jpeg).hexdigest())
            return manifest, {name: (output / name).read_bytes() for name in manifest['files']}

    def test_reassembles_out_of_order_continuations_and_hashes_exact_planes(self):
        calibration, image, metadata, cal_ifd, planes = fixture()
        cut = 50
        jpeg = (b'\xff\xd8' + segment(0xe2, 2, 0, cal_ifd)
                + segment(0xe3, 5, cut, planes[cut:])
                + segment(0xe3, 5, 0, planes[:cut]) + b'\xff\xd9')
        manifest, files = self.invoke(jpeg, True)
        self.assertEqual((manifest['width'], manifest['height']), (2, 3))
        expected = {'calibration.bin': calibration, 'image.bin': image, 'metadata.bin': metadata}
        self.assertEqual(files, expected)
        for name, raw in expected.items():
            self.assertEqual(manifest['files'][name], {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})

    def test_rejects_continuation_gaps_and_overlap(self):
        _, _, _, cal_ifd, planes = fixture()
        for offset in (49, 51):
            with self.subTest(offset=offset):
                jpeg = (b'\xff\xd8' + segment(0xe2, 2, 0, cal_ifd)
                        + segment(0xe3, 5, 0, planes[:50])
                        + segment(0xe3, 5, offset, planes[50:]) + b'\xff\xd9')
                self.assertIn('Missing or overlapping', self.invoke(jpeg, False))

    def test_rejects_duplicate_tags(self):
        _, _, _, cal_ifd, planes = fixture(duplicate=True)
        jpeg = b'\xff\xd8' + segment(0xe2, 2, 0, cal_ifd) + segment(0xe3, 5, 0, planes) + b'\xff\xd9'
        self.assertIn('Duplicate IFD tag', self.invoke(jpeg, False))

    def test_rejects_external_value_inside_directory_or_outside_payload(self):
        _, _, _, cal_ifd, planes = fixture()
        for offset in (2, 0xffffffff):
            with self.subTest(offset=offset):
                malformed = bytearray(cal_ifd)
                struct.pack_into('<I', malformed, 10, offset)
                jpeg = b'\xff\xd8' + segment(0xe2, 2, 0, malformed) + segment(0xe3, 5, 0, planes) + b'\xff\xd9'
                self.assertIn('IFD value out of bounds', self.invoke(jpeg, False))

    def test_rejects_calibration_header_and_plane_length_mismatch(self):
        for options, error in (({'calibration_size': 0x3801}, 'Unexpected calibration length'),
                               ({'image_size': 10}, 'Plane length mismatch')):
            with self.subTest(options=options):
                _, _, _, cal_ifd, planes = fixture(**options)
                jpeg = b'\xff\xd8' + segment(0xe2, 2, 0, cal_ifd) + segment(0xe3, 5, 0, planes) + b'\xff\xd9'
                self.assertIn(error, self.invoke(jpeg, False))

    def test_rejects_truncated_segment(self):
        self.assertIn('Invalid marker size', self.invoke(b'\xff\xd8\xff\xe2\x00\x10SDMP', False))


if __name__ == '__main__':
    unittest.main()
