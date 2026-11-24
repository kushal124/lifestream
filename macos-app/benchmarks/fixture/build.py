"""Generate entirely synthetic, deterministic recorder fixtures and token manifest."""
from pathlib import Path
import json,re
root=Path(__file__).parent
phases={
'article':{'marker':'PHASEALPHA101','title':'Readable article','lines':[
'ORBITAL101 A quiet observatory above the clouds',
'Harbor instruments measure light from distant stars. Each reading carries a timestamp and a confidence estimate.',
'CALIBRATE202 The amber sensor records forty seven samples while the violet sensor records sixty three samples.',
'Engineers compare the measurements before adjusting the lens. A stable reference makes small changes easier to notice.',
'ARCHIVE303 Store the original reading alongside every later interpretation. Keep uncertainty visible and preserve the source.',
'At dawn the laboratory publishes a short report. The team reviews clarity, completeness, timing, and storage.',
'CHECKPOINT404 The final checklist contains cedar quartz indigo maple velvet and cobalt.']},
'dense':{'marker':'PHASEBETA202','title':'Dense code and table','lines':[
'CODEBLOCK505 Deterministic sample processing',
'function summarize(samples) {',
'  const valid = samples.filter(item => item.score >= 42);',
'  return valid.map(item => ({ id: item.id, score: item.score * 2 }));',
'}',
'const result = summarize([{ id: "sampleA", score: 57 }]);',
'assert(result[0].score === 114);',
'TABLEBLOCK606 Region Count Delay Status',
'Northfield 128 12ms Ready',
'Southpoint 256 24ms Queued',
'Eastvale 512 36ms Verified',
'Westhaven 1024 48ms Complete',
'Centralis 2048 60ms Archived',
'REVIEW707 Compare exact values preserve repeated words repeated words and punctuation.']},
'canvas':{'marker':'PHASEGAMMA303','title':'Canvas pixels','lines':[
'CANVAS808 This sentence exists only in painted pixels.',
'RASTER909 Copper lanterns illuminate the synthetic studio.',
'PIXEL1010 Record seventeen circles and twenty nine squares.',
'GLYPH1111 The reading is 314159 and the label is violet.',
'VISIBLE1212 Every line belongs to the image, not the accessibility tree.',
'PROBE1313 Notice the tiny change from cedar to cedars.']},
'mixed':{'marker':'PHASEDELTA404','title':'Mixed panels and overlap','lines':[
'PANEL1414 Mission journal',
'An amber drone crosses a silent valley.',
'Altitude 840 meters. Battery 76 percent.',
'PANEL1515 Sensor notes',
'Wind northeast. Temperature 18 degrees.',
'Packet count 4096. Checksum verified.',
'OVERLAY1616 Review complete',
'Keep the original frame and label the observation.',
'CANVAS1717 Raster annotation below the panels.',
'FINAL1818 Quartz meadow saffron birch nickel.']}}
shared=['SYNTHETIC RECORDER LAB','Readable article','Dense code and table','Canvas pixels','Mixed panels and overlap','Next scenario']
manifest={'synthetic':True,'version':1,'viewport':{'recommendedWidth':1500,'recommendedHeight':900},'tokenRule':'Unicode alphanumeric runs lowercased; compare scenarioContentTokens separately from sharedChromeTokens. Browser chrome is excluded.','sharedChromeTokens':sorted(set(re.findall(r'[^\W_]+',' '.join(shared).lower()))),'scenarios':{}}
for key,phase in phases.items():
 manifest['scenarios'][key]={'marker':phase['marker'],'title':phase['title'],'visibleLines':phase['lines'],'scenarioContentTokens':sorted(set(re.findall(r'[^\W_]+',' '.join([phase['marker']]+phase['lines']).lower())))}
for key, phase in phases.items():
 entry=manifest['scenarios'][key]
 words=re.findall(r'[^\W_]+', ' '.join([phase['marker']]+phase['lines']))
 code_identifiers={'function','summarize','samples','const','valid','filter','item','score','return','map','id','result','assert'} if key=='dense' else set()
 entry['expectedTokenOccurrences']=words
 entry['requiredNumericIdentifierOccurrences']=[word for word in words if any(c.isdigit() for c in word) or (any(c.islower() for c in word) and any(c.isupper() for c in word[1:])) or word in code_identifiers]
 entry['expectedPhrases']=[phase['marker']]+phase['lines']
manifest['version']=2
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
html='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic recorder lab</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#edf1f4;color:#152333;font:20px/1.5 system-ui,sans-serif}header{padding:18px 32px;background:#172b40;color:white}header strong{font-size:19px;letter-spacing:1px}nav{display:flex;gap:9px;margin-top:12px;flex-wrap:wrap}button{font:600 16px system-ui;padding:10px 15px;border:2px solid #9ab2c8;border-radius:7px;background:white;color:#163049;cursor:pointer}button[aria-pressed=true]{background:#d6ecff;border-color:#62a7df}button:focus-visible{outline:4px solid #edbf32;outline-offset:2px}main{padding:20px 32px;max-width:1500px;margin:auto}.phase{font:700 20px ui-monospace,monospace;color:#425974;margin-bottom:10px}h1{font-size:28px;line-height:1.2;margin:0 0 15px}article{background:white;padding:22px 30px;border:1px solid #b9c9d5;border-radius:8px;max-width:1250px}p{margin:0 0 14px}.article p:first-child{font-size:25px;font-weight:700}.article p{max-width:1160px}.columns{display:grid;grid-template-columns:1.3fr 1fr;gap:20px}pre{background:#172b40;color:#f6f8fc;padding:22px;border-radius:8px;font:19px/1.75 ui-monospace,monospace;white-space:pre-wrap;margin:0}table{border-collapse:collapse;width:100%;background:white;font-size:20px}th,td{padding:13px;border:1px solid #a7bdcb;text-align:left}th{background:#d6e6f0}.note{margin-top:16px;background:#fff5d7;padding:16px;border:1px solid #c3ac6c}canvas{display:block;width:100%;height:430px;background:white;border:1px solid #a7bdcb}.panel{background:white;border:1px solid #adc0cd;padding:22px;border-radius:8px;height:175px}.panel p:first-child{font-weight:700}.overlay{position:relative;margin:-15px auto 18px;width:760px;background:#fff5d7;border:2px solid #ac8f40;border-radius:8px;padding:17px;box-shadow:0 8px 15px #10203018;z-index:1}.mixed canvas{height:150px}.mixed .columns{gap:25px}.dense h2{font-size:22px;margin:0 0 12px}#phaseCanvas{height:430px}@media(max-width:1000px){body{font-size:17px}.columns{gap:10px}pre{font-size:15px}td,th{padding:8px;font-size:16px}.overlay{width:75%}header,main{padding-left:20px;padding-right:20px}}
</style>
<header><strong>SYNTHETIC RECORDER LAB</strong><nav aria-label="Scenario"><button data-phase="article">Readable article</button><button data-phase="dense">Dense code and table</button><button data-phase="canvas">Canvas pixels</button><button data-phase="mixed">Mixed panels and overlap</button><button id="next">Next scenario</button></nav></header><main><div id="marker" class="phase"></div><h1 id="title"></h1><div id="stage"></div></main>
<script>
const phases=PHASES; const keys=Object.keys(phases);let current='article';
function element(tag,text,cls){const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e}
function paint(canvas,lines,font=24){const bounds=canvas.getBoundingClientRect();const ratio=window.devicePixelRatio||1;canvas.width=Math.round(bounds.width*ratio);canvas.height=Math.round(bounds.height*ratio);const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);ctx.fillStyle='#fff';ctx.fillRect(0,0,bounds.width,bounds.height);ctx.fillStyle='#152333';ctx.font=`${font}px system-ui`;lines.forEach((line,i)=>ctx.fillText(line,24,45+i*(font+28)))}
function show(key){current=key;const p=phases[key],stage=document.getElementById('stage');stage.replaceChildren();stage.className=key;document.getElementById('marker').textContent=p.marker;document.getElementById('title').textContent=p.title;document.querySelectorAll('[data-phase]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.phase===key)));location.hash=key;
if(key==='article'){const a=element('article');p.lines.forEach(line=>a.append(element('p',line)));stage.append(a)}
if(key==='dense'){const columns=element('div',null,'columns');const left=element('section');left.append(element('h2',p.lines[0]));left.append(element('pre',p.lines.slice(1,7).join('\\n')));const right=element('section');right.append(element('h2','TABLEBLOCK606'));const table=element('table');const header=element('tr');['Region','Count','Delay','Status'].forEach(t=>header.append(element('th',t)));table.append(header);p.lines.slice(8,13).forEach(line=>{const row=element('tr');line.split(' ').forEach(t=>row.append(element('td',t)));table.append(row)});right.append(table);columns.append(left,right);stage.append(columns,element('p',p.lines[13],'note'))}
if(key==='canvas'){const c=element('canvas');c.id='phaseCanvas';c.setAttribute('aria-label','Raster test surface');stage.append(c);paint(c,p.lines,23)}
if(key==='mixed'){const columns=element('div',null,'columns');for(const start of [0,3]){const panel=element('section',null,'panel');p.lines.slice(start,start+3).forEach(line=>panel.append(element('p',line)));columns.append(panel)}stage.append(columns);const overlay=element('aside',null,'overlay');p.lines.slice(6,8).forEach(line=>overlay.append(element('p',line)));stage.append(overlay);const c=element('canvas');c.setAttribute('aria-label','Raster annotation surface');stage.append(c);paint(c,p.lines.slice(8),23)}
}
document.querySelectorAll('[data-phase]').forEach(b=>b.addEventListener('click',()=>show(b.dataset.phase)));document.getElementById('next').addEventListener('click',()=>show(keys[(keys.indexOf(current)+1)%keys.length]));window.addEventListener('resize',()=>show(current));show(keys.includes(location.hash.slice(1))?location.hash.slice(1):'article');
</script></html>'''.replace('PHASES',json.dumps(phases))
(root/'index.html').write_text(html)
