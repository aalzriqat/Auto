import json
from pathlib import Path

# Check semantic cache properly
cache_dir = Path('graphify-out/cache')
cached_files = set()
if cache_dir.exists():
    cache_files_list = list(cache_dir.glob('*.json'))
    print(f'Cache JSON files: {len(cache_files_list)}')
    for f in cache_files_list[:5]:
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
            print(f'  {f.name}: keys={list(data.keys())[:5]}')
        except Exception as e:
            print(f'  {f.name}: ERROR {e}')
else:
    print('No cache directory found')

# Check what graphify cache actually stores
try:
    from graphify.cache import check_semantic_cache
    manifest = json.loads(Path('graphify-out/manifest.json').read_text(encoding='utf-8'))
    all_files = list(manifest.keys()) if isinstance(manifest, dict) else manifest
    print(f'\nRunning check_semantic_cache on {len(all_files)} manifest files...')
    cached_nodes, cached_edges, cached_hyper, uncached = check_semantic_cache(all_files)
    print(f'Cached: {len(cached_nodes)} nodes, {len(cached_edges)} edges')
    print(f'Uncached (need extraction): {len(uncached)} files')
    if uncached:
        print('First 10 uncached:')
        for f in uncached[:10]:
            print(f'  {f}')
except Exception as e:
    print(f'check_semantic_cache error: {e}')
    import traceback
    traceback.print_exc()
