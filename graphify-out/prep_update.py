import json
from pathlib import Path

r = json.loads(Path('graphify-out/.graphify_incremental.json').read_text(encoding='utf-8'))

# For the update, we treat the 69 uncached files as the "changed" files
from graphify.cache import check_semantic_cache
manifest = json.loads(Path('graphify-out/manifest.json').read_text(encoding='utf-8'))
all_files = list(manifest.keys()) if isinstance(manifest, dict) else manifest
_, _, _, uncached = check_semantic_cache(all_files)

print(f'Files needing semantic extraction: {len(uncached)}')

# Build a synthetic new_files dict grouped by type
code_exts = {'.ts','.tsx','.js','.jsx','.mjs','.cjs','.mts','.cts','.py','.go','.rs','.java','.cpp','.c','.rb','.swift','.kt','.cs'}
doc_exts = {'.md','.txt','.yaml','.yml','.json','.toml'}

new_files = {'code': [], 'document': []}
for f in uncached:
    ext = Path(f).suffix.lower()
    if ext in code_exts:
        new_files['code'].append(f)
    else:
        new_files['document'].append(f)

print(f'  code: {len(new_files["code"])} files')
print(f'  document: {len(new_files["document"])} files')

# Populate .graphify_detect.json with these as the changed files
detect_data = {
    'files': new_files,
    'all_files': r.get('files', {}),
    'total_files': len(uncached),
    'total_words': r.get('total_words', 0),
    'skipped_sensitive': r.get('skipped_sensitive', []),
    'needs_graph': True,
}
Path('graphify-out/.graphify_detect.json').write_text(json.dumps(detect_data, ensure_ascii=False), encoding='utf-8')
print('Written .graphify_detect.json')

# Write uncached file list
Path('graphify-out/.graphify_uncached.txt').write_text('\n'.join(uncached), encoding='utf-8')
print('Written .graphify_uncached.txt')
