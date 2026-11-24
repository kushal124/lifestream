"""Generate separate deterministic movement fixture; no recorded observations."""
import json
import re
from pathlib import Path
root = Path(__file__).parent
states = []
for cycle in range(5):
    for mode, duration in [('scroll',18), ('transient',6), ('canvas',18), ('overlap',18)]:
        index = len(states)
        marker = f'VARIEDPHASE{index:03d}'
        lines = [marker, f'Synthetic batch {cycle + 1} receipt {7100 + index}',
                 f'Ledger balance {2300 + index} units', f'Verification code ZETA{8100 + index}']
        states.append(dict(phase=f'{mode}{cycle}', mode=mode, duration=duration, lines=lines, marker=marker))
scenarios = {}
for state in states:
    lines = state['lines']
    occurrences = re.findall(r'[^\W_]+', ' '.join(lines))
    scenarios[state['phase']] = dict(marker=state['marker'], visibleLines=lines,
        scenarioContentTokens=sorted(set(w.lower() for w in occurrences)),
        expectedTokenOccurrences=occurrences,
        requiredNumericIdentifierOccurrences=[w for w in occurrences if any(c.isdigit() for c in w)],
        expectedPhrases=lines, forbiddenOCRTokens=['OMEGA999', 'THETA888'])
(root/'varied-manifest.json').write_text(json.dumps(dict(version=2, scenarios=scenarios), indent=2)+'\n')
page = '''<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic motion recorder lab</title>
<style>body{margin:0;background:#eef3f7;color:#162736;font:24px system-ui}header{padding:18px 32px;background:white}main{margin:28px 40px;width:1100px;height:580px;position:relative;background:white;border:2px solid #789;overflow:hidden}p{margin:28px}button{font:18px system-ui;padding:8px}footer{position:fixed;bottom:0;background:white;padding:12px;width:100%;font:16px system-ui}#result{position:fixed;bottom:65px;right:10px;z-index:5;background:white;padding:15px}textarea{display:block;width:760px}canvas{width:1100px;height:580px}#scroll{height:580px;overflow:hidden}.sheet{height:580px;box-sizing:border-box;padding:25px}.panel{position:absolute;left:45px;top:35px;background:#fff;border:3px solid #456;padding:20px;width:870px;height:400px}.back{left:120px;top:100px;background:#cedce5}#notice{border:5px solid #a65;background:#fff7e6;margin:40px;padding:25px}</style>
<header>Synthetic motion recorder lab</header><main id="scene"></main>
<footer><button id="start">Start five-minute motion sequence</button> <button id="cancel" disabled>Cancel</button> <button id="toggle">Show timing results</button> <span id="status">Ready</span></footer>
<section id="result" hidden><label>Scheduled window JSON<textarea id="window" readonly></textarea></label><label>Actual events JSON<textarea id="events" rows="10" readonly>[]</textarea></label><label>Run result JSON<textarea id="outcome" readonly></textarea></label></section>
<script>
const states=STATES;
const el=id=>document.getElementById(id);let generation=0,timers=[],running=false;
function render(s){
 const scene=el('scene');scene.replaceChildren();
 if(s.mode==='canvas'){
  const c=document.createElement('canvas');c.width=2200;c.height=1160;scene.append(c);
  const ctx=c.getContext('2d');ctx.scale(2,2);ctx.fillStyle='white';ctx.fillRect(0,0,1100,580);ctx.fillStyle='#162736';ctx.font='30px monospace';s.lines.forEach((line,i)=>ctx.fillText(line,45,90+i*95));
 }else{
  const content=document.createElement('div');s.lines.forEach(line=>{const p=document.createElement('p');p.textContent=line;content.append(p)});
  if(s.mode==='scroll'){
   const sc=document.createElement('div');sc.id='scroll';const blank=document.createElement('div');blank.className='sheet';blank.textContent='Offscreen archive OMEGA999';content.className='sheet';sc.append(blank,content);scene.append(sc);sc.scrollTop=580;
  }else if(s.mode==='overlap'){
   const back=document.createElement('div');back.className='panel back';back.textContent='Covered archive THETA888';content.className='panel';scene.append(back,content);
  }else{content.id='notice';scene.append(content)}
 }
}
function stop(reason){if(!running)return;running=false;generation++;timers.forEach(clearTimeout);timers=[];el('start').disabled=false;el('cancel').disabled=true;el('status').textContent=reason;el('outcome').value=JSON.stringify({status:reason,finishedAt:Date.now()/1000});}
el('cancel').onclick=()=>stop('cancelled');document.addEventListener('visibilitychange',()=>{if(document.hidden)stop('page-hidden')});
el('toggle').onclick=()=>{el('result').hidden=!el('result').hidden};
el('start').onclick=()=>{
 if(running)return;running=true;const token=++generation;el('start').disabled=true;el('cancel').disabled=false;el('result').hidden=true;
 const start=Date.now()/1000+20;el('window').value=JSON.stringify({start,end:start+300});el('events').value='[]';el('outcome').value=JSON.stringify({status:'running',leadInSeconds:20});el('status').textContent='Armed';
 let offset=0;
 for(const state of states){const planned=start+offset;offset+=state.duration;
  timers.push(setTimeout(()=>{if(!running||token!==generation)return;if(document.hidden){stop('page-hidden');return}render(state);const at=Date.now()/1000;const events=JSON.parse(el('events').value);events.push({at,phase:state.phase,scheduledAt:planned,callbackLatenessSeconds:at-planned});el('events').value=JSON.stringify(events);el('status').textContent='Running';},Math.max(0,(planned-Date.now()/1000)*1000)));
 }
 timers.push(setTimeout(()=>stop('completed'),Math.max(0,(start+300-Date.now()/1000)*1000)));
};
render(states[0]);
</script></html>'''.replace('STATES',json.dumps(states))
(root/'varied-autoplay.html').write_text(page)
