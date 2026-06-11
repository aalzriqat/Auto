import sys, json
from graphify.detect import detect_incremental
from pathlib import Path

result = detect_incremental(Path('.'))
new_total = result.get('new_total', 0)
deleted = list(result.get('deleted_files', []))

Path('graphify-out/.graphify_incremental.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')

if new_total == 0 and not deleted:
    print('No files changed since last run. Nothing to update.')
else:
    if deleted:
        print(f'{len(deleted)} deleted file(s) to prune.')
    if new_total > 0:
        print(f'{new_total} new/changed file(s) to re-extract.')
    new_files = result.get('new_files', {})
    for ftype, files in new_files.items():
        if files:
            print(f'  [{ftype}] ({len(files)} files)')
            for f in files[:10]:
                print(f'    {f}')
            if len(files) > 10:
                print(f'    ... and {len(files)-10} more')
    total_files = result.get('total_files', 0)
    total_words = result.get('total_words', 0)
    print(f'Total corpus: {total_files} files, {total_words} words')
