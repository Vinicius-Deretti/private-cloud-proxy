"""Exercise the distributed JS client from an extracted Windows bundle."""
import pathlib
import os
import shutil
import sys
import subprocess
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]

@unittest.skipUnless(shutil.which('node') and (ROOT / 'node_modules/ws').is_dir(), 'Node and installed dependencies required')
class PackageTests(unittest.TestCase):
    def test_extracted_client_loads_without_repository_dependencies(self):
        with tempfile.TemporaryDirectory(prefix='proxy-package-') as directory:
            root = pathlib.Path(directory)
            archive = root / 'client.zip'
            subprocess.run([sys.executable, str(ROOT / 'scripts/package-free.py'), '--output', str(archive)], check=True, capture_output=True)
            with zipfile.ZipFile(archive) as bundle:
                bundle.extractall(root / 'extracted')
            subprocess.run(['node', 'bridge/bootstrap.mjs'], cwd=root / 'extracted', env={**os.environ, 'npm_config_offline':'true', 'npm_config_cache':str(root/'empty-cache')}, check=True, capture_output=True, text=True)
            result = subprocess.run(['node', '--input-type=module', '-e', "await import('./bridge/client.mjs'); console.log('loaded')"], cwd=root / 'extracted', check=True, capture_output=True, text=True)
            self.assertEqual(result.stdout.strip(), 'loaded')
