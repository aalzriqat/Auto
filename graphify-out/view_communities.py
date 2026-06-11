import sys, json
from graphify.build import build_from_json
from graphify.cluster import score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from pathlib import Path

extraction = json.loads(Path('graphify-out/.graphify_extract.json').read_text(encoding='utf-8'))
detection_path = Path('graphify-out/.graphify_detect.json')
if detection_path.exists():
    detection = json.loads(detection_path.read_text(encoding='utf-8'))
else:
    detection = {'total_files': 254, 'total_words': 0, 'files': {}}
analysis   = json.loads(Path('graphify-out/.graphify_analysis.json').read_text(encoding='utf-8'))

G = build_from_json(extraction)
communities = {int(k): v for k, v in analysis['communities'].items()}
cohesion = {int(k): v for k, v in analysis['cohesion'].items()}
tokens = {'input': extraction.get('input_tokens', 0), 'output': extraction.get('output_tokens', 0)}

# Read all communities to label them all
all_cids = sorted(communities.keys())
for cid in all_cids[20:]:
    members = communities[cid]
    lbs = []
    for nid in members[:4]:
        if G.has_node(nid):
            lbs.append(G.nodes[nid].get('label', nid))
    print(f'  {cid}: {lbs}')
