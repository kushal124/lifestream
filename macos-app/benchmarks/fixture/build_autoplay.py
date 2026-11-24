"""Generate an opt-in automatic sequence page without modifying the manual fixture."""
from pathlib import Path
root = Path(__file__).parent
manual = (root / 'index.html').read_text()
controls = '''<section id="automatic-controls" aria-label="Automatic sequence controls" style="position:fixed;bottom:0;left:0;right:0;z-index:3;background:#f7fafc;border-top:2px solid #8fa9bd;padding:8px 20px;display:flex;align-items:center;gap:14px;font:14px/1.3 system-ui">
<button id="automatic-start">Start five-minute sequence</button><button id="automatic-cancel" disabled>Cancel sequence</button>
<span id="automatic-status" role="status">Ready. Twenty-second lead-in, then four scenes of seventy-five seconds each.</span>
<button id="automatic-results-toggle" aria-expanded="false" aria-controls="automatic-results">Show timing results</button>
<div id="automatic-results" hidden style="position:absolute;bottom:100%;right:0;width:720px;max-height:360px;overflow:auto;background:white;border:2px solid #8fa9bd;padding:15px;color:#152333">
<label for="automatic-window">Scheduled window JSON</label><textarea id="automatic-window" readonly rows="2" style="display:block;width:100%;font:14px monospace">null</textarea>
<label for="automatic-events">Actual phase events JSON</label><textarea id="automatic-events" readonly rows="6" style="display:block;width:100%;font:14px monospace">[]</textarea>
<label for="automatic-result">Sequence result JSON</label><textarea id="automatic-result" readonly rows="4" style="display:block;width:100%;font:14px monospace">null</textarea>
<p>Hide this panel during recording. Actual phase times are written immediately after each scene renders its synchronous content.</p>
</div></section>'''
script = '''<script>
(() => {
  const startButton=document.getElementById('automatic-start');
  const cancelButton=document.getElementById('automatic-cancel');
  const status=document.getElementById('automatic-status');
  const windowOutput=document.getElementById('automatic-window');
  const eventsOutput=document.getElementById('automatic-events');
  const resultOutput=document.getElementById('automatic-result');
  const results=document.getElementById('automatic-results');
  const toggle=document.getElementById('automatic-results-toggle');
  const manualButtons=[...document.querySelectorAll('[data-phase],#next')];
  let generation=0, timers=[], running=false;
  function clearTimers(){timers.forEach(clearTimeout);timers=[];}
  function lockManual(value){manualButtons.forEach(button=>button.disabled=value);}
  function cancel(reason){
    if(!running)return;
    generation++;clearTimers();running=false;lockManual(false);
    startButton.disabled=false;cancelButton.disabled=true;
    const result=JSON.parse(resultOutput.value);
    result.status='cancelled';result.reason=reason;result.finishedAt=Date.now()/1000;
    resultOutput.value=JSON.stringify(result,null,2);
    status.textContent='Sequence cancelled. Timing results retained.';
  }
  cancelButton.addEventListener('click',()=>cancel('operator-cancelled'));
  toggle.addEventListener('click',()=>{
    results.hidden=!results.hidden;toggle.setAttribute('aria-expanded',String(!results.hidden));
    toggle.textContent=results.hidden?'Show timing results':'Hide timing results';
  });
  document.addEventListener('visibilitychange',()=>{
    if(running&&document.hidden)cancel('page-hidden');
  });
  startButton.addEventListener('click',()=>{
    if(running)return;
    clearTimers();const token=++generation;running=true;lockManual(true);
    startButton.disabled=true;cancelButton.disabled=false;
    results.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.textContent='Show timing results';
    const clickedAt=Date.now()/1000;
    const scheduledStart=clickedAt+20;
    const window={start:scheduledStart,end:scheduledStart+300};
    windowOutput.value=JSON.stringify(window);
    eventsOutput.value='[]';
    resultOutput.value=JSON.stringify({status:'running',clickedAt,leadInSeconds:20,phaseSeconds:75,plannedDurationSeconds:300},null,2);
    status.textContent='Sequence armed. Recording window begins after the twenty-second lead-in.';
    const order=['article','dense','canvas','mixed'];
    order.forEach((phase,index)=>{
      const planned=scheduledStart+75*index;
      timers.push(setTimeout(()=>{
        if(!running||token!==generation)return;
        if(document.hidden){cancel('page-hidden');return;}
        show(phase);
        // show() updates DOM and paints canvas synchronously. This timestamp is a
        // JS render-request witness; compositing/display presentation follows later.
        const at=Date.now()/1000;
        const events=JSON.parse(eventsOutput.value);
        events.push({at,phase,scheduledAt:planned,callbackLatenessSeconds:at-planned});
        eventsOutput.value=JSON.stringify(events,null,2);
        status.textContent='Automatic scene '+(index+1)+' of four. Timing results are available.';
      },Math.max(0,(planned-Date.now()/1000)*1000)));
    });
    timers.push(setTimeout(()=>{
      if(!running||token!==generation)return;
      running=false;clearTimers();lockManual(false);startButton.disabled=false;cancelButton.disabled=true;
      const result=JSON.parse(resultOutput.value);result.status='completed';result.finishedAt=Date.now()/1000;
      result.finishLatenessSeconds=result.finishedAt-window.end;result.actualPhaseEvents=JSON.parse(eventsOutput.value).length;
      resultOutput.value=JSON.stringify(result,null,2);
      status.textContent='Five-minute sequence complete. Show timing results to retrieve actual events.';
    },Math.max(0,(window.end-Date.now()/1000)*1000)));
  });
})();
</script>'''
# This new page reuses the exact scored body and manual scene renderer. The fixed
# control strip does not reflow the scene, and timing JSON is collapsed by default.
page = manual.replace('<title>Synthetic recorder lab</title>', '<title>Synthetic recorder lab — automatic sequence</title>')
page = page.replace('</html>', controls + script + '</html>')
(root / 'autoplay.html').write_text(page)
