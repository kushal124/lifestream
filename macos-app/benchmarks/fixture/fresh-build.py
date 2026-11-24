"""Isolated fresh marker variant; preserve existing fixture files and layout."""
import json
from pathlib import Path
root = Path(__file__).parent
old, new = 'VARIEDPHASE', 'FRESHSCREEN'
assert len(old) == len(new) == 11

def replace(text):
    return text.replace(old, new).replace(old.lower(), new.lower())

page = (root/'varied-autoplay.html').read_text()
manifest = (root/'varied-manifest.json').read_text()
fresh_page, fresh_manifest = replace(page), replace(manifest)
# Unlike the original page, do not expose a scored marker before its timed event.
assert fresh_page.count('render(states[0]);') == 1
fresh_page = fresh_page.replace('render(states[0]);',
    """render({mode:'transient',lines:['READYFORCAPTURE501']});
// Neutral-only motion produces fresh capture witnesses; first render removes it.
const pulse=document.createElement('div');pulse.style.cssText='position:absolute;left:900px;top:480px;width:24px;height:24px;background:#456';el('scene').append(pulse);
pulse.animate([{transform:'translateX(0)'},{transform:'translateX(60px)'}],{duration:1700,iterations:Infinity,direction:'alternate'});""")
parsed = json.loads(fresh_manifest)
assert len(parsed['scenarios']) == 20
assert all(s['marker'].startswith(new) for s in parsed['scenarios'].values())
assert old not in fresh_page and old.lower() not in fresh_manifest
(root/'fresh-autoplay.html').write_text(fresh_page)
(root/'fresh-manifest.json').write_text(fresh_manifest)
