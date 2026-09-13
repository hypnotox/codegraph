"""Extract language tables from Robot Framework source without importing it.

Usage: python3 scripts/update-robot-languages.py /path/to/robotframework
"""
import ast
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
source = root / 'src/robot/conf/languages.py'
classes = {}
for node in ast.parse(source.read_text()).body:
    if isinstance(node, ast.ClassDef) and any(isinstance(b, ast.Name) and b.id == 'Language' for b in node.bases):
        values = {}
        for item in node.body:
            if isinstance(item, ast.Assign) and isinstance(item.targets[0], ast.Name):
                try:
                    values[item.targets[0].id] = ast.literal_eval(item.value)
                except (ValueError, TypeError):
                    pass
        classes[node.name] = values
english = classes['En']
languages = {}
for name, fields in classes.items():
    code = name.lower() if len(name) <= 2 else name[:2].lower() + '-' + name[2:].upper()
    languages[code.lower()] = {
        'headers': {v: english[k] for k, v in fields.items() if k.endswith('_header') and v},
        'settings': {v: english[k] for k, v in fields.items() if k.endswith('_setting') and v},
        'prefixes': [v for k, values in fields.items() if k.endswith('_prefixes') for v in values],
    }
result = {'source': 'https://github.com/robotframework/robotframework',
          'revision': subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip(),
          'license': 'Apache-2.0; Copyright 2008-2015 Nokia Networks, 2016- Robot Framework Foundation',
          'languages': languages}
pathlib.Path('src/extraction/robot-languages.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
