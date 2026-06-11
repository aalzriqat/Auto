import json
from pathlib import Path

# Load manifest
manifest = json.loads(Path('graphify-out/manifest.json').read_text(encoding='utf-8'))

# Load graph nodes
graph = json.loads(Path('graphify-out/graph.json').read_text(encoding='utf-8'))
graph_sources = set()
for n in graph['nodes']:
    src = n.get('source_location') or n.get('data', {}).get('source_location', '')
    if src:
        graph_sources.add(src.replace('\\', '/'))

# Load semantic cache
cache_dir = Path('graphify-out/cache')
cached_files = set()
if cache_dir.exists():
    for f in cache_dir.glob('*.json'):
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
            src = data.get('source_file', '')
            if src:
                cached_files.add(src.replace('\\', '/'))
        except:
            pass

print(f'Manifest: {len(manifest)} files tracked')
print(f'Graph nodes: {len(graph["nodes"])}')
print(f'Graph sources (unique): {len(graph_sources)}')
print(f'Cache files: {len(cached_files)}')

# Find manifest files NOT in graph sources
missing_from_graph = []
for fpath in manifest:
    normalized = fpath.replace('\\', '/')
    # check if any node references this file
    found = any(normalized.endswith(gs) or gs.endswith(normalized.split('/')[-1]) for gs in graph_sources)
    if not found:
        missing_from_graph.append(fpath)

print(f'\nFiles in manifest but with NO node in graph: {len(missing_from_graph)}')
for f in missing_from_graph[:30]:
    print(f'  {f}')
if len(missing_from_graph) > 30:
    print(f'  ... and {len(missing_from_graph)-30} more')
