"""Every module the Windows client loads must ship in both release bundles."""
import ast
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
IMPORT = re.compile(r"""(?:from|import)\s*['"](\./[^'"]+)['"]""")


def closure(entry):
    seen, todo = set(), [ROOT / entry]
    while todo:
        path = todo.pop()
        rel = path.relative_to(ROOT).as_posix()
        if rel in seen:
            continue
        seen.add(rel)
        if path.suffix == '.mjs':
            todo.extend((path.parent / spec).resolve() for spec in IMPORT.findall(path.read_text(encoding='utf-8')))
    return seen


def listed(script, name):
    tree = ast.parse((ROOT / script).read_text(encoding='utf-8'))
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(getattr(t, 'id', None) == name for t in node.targets):
            return {n.value for n in ast.walk(node.value) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
    raise AssertionError(f'{name} not found in {script}')


class BundleCompleteness(unittest.TestCase):
    def test_client_module_closure_is_packaged(self):
        needed = closure('bridge/start.mjs') | closure('bridge/client.mjs') | closure('bridge/bootstrap.mjs')
        for script, name in (('scripts/package-free.py', 'files'), ('scripts/package-user-chrome.py', 'BRIDGE_FILES')):
            with self.subTest(script=script):
                self.assertFalse(needed - listed(script, name), f'missing from {script}')
                self.assertIn('LICENSE', listed(script, name))


if __name__ == '__main__':
    unittest.main()
