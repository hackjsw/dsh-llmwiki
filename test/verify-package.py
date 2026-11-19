import hashlib
import json
import pathlib
import sys
import tarfile

project = pathlib.Path(__file__).resolve().parent.parent
version = json.loads((project / 'package.json').read_text(encoding='utf-8'))['version']
archive = project / f'dsh-llm-wiki-{version}.tgz'
problems = []
checked = 0
with tarfile.open(archive, 'r:gz') as package:
    for entry in package.getmembers():
        if not entry.isfile() or not entry.name.startswith('package/'):
            problems.append('unsupported:' + entry.name)
            continue
        relative = pathlib.PurePosixPath(entry.name).relative_to('package')
        if '..' in relative.parts:
            problems.append('unsafe:' + entry.name)
            continue
        source = project.joinpath(*relative.parts)
        packed = package.extractfile(entry).read()
        if not source.is_file():
            problems.append('missing:' + str(relative))
        elif str(relative) == 'package.json':
            if json.loads(source.read_text(encoding='utf-8')) != json.loads(packed.decode('utf-8')):
                problems.append('mismatch:' + str(relative))
        elif hashlib.sha256(source.read_bytes()).digest() != hashlib.sha256(packed).digest():
            problems.append('mismatch:' + str(relative))
        checked += 1
print(json.dumps({'checked': checked, 'problems': problems}, ensure_ascii=False))
if problems or checked == 0:
    sys.exit(1)
