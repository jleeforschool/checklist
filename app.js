"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const IDS = Array.from({length:27}, (_, i) => `s${String(i+1).padStart(2,'0')}`);
  const SCHEMA = 'classroom-checklist-v1';
  const CLIENT = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const emptyDoc = () => ({schema:SCHEMA, cells:{}});
  let doc = emptyDoc(), scope = 'offline', config = null, pending = false, localRevision = 0;
  let lastClock = 0, busy = false, authBlocked = false, failures = 0, timer = null, saveTimer = null, generation = 0;
  let lastSync = '', syncText = '', settingsBase = null, toastTimer = null;
  const rows = new Map();
  function warn(message) { $('warning').textContent = message; $('warning').hidden = !message; }
  function localDate() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  $('date').value = localDate();
  let day = $('date').value;
  function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s+'T00:00:00Z')) && new Date(s+'T00:00:00Z').toISOString().slice(0,10) === s; }
  function validateCell(k, v) {
    if (/^student\|s(?:0[1-9]|1[0-9]|2[0-7])\|roleName$/.test(k)) return typeof v === 'string' && v.length <= 60;
    const task = k.match(/^task\|(\d{4}-\d{2}-\d{2})\|(legacy|a[a-z0-9-]+)\|title$/);
    if (task) return validDate(task[1]) && typeof v === 'string' && v.trim().length > 0 && v.length <= 80;
    const rating = k.match(/^day\|(\d{4}-\d{2}-\d{2})\|s(?:0[1-9]|1[0-9]|2[0-7])\|roleRating$/);
    if (rating) return validDate(rating[1]) && ['', 'great', 'normal', 'effort', 'rest'].includes(v);
    const submission = k.match(/^day\|(\d{4}-\d{2}-\d{2})\|s(?:0[1-9]|1[0-9]|2[0-7])\|homework_a[a-z0-9-]+$/);
    if (submission) return validDate(submission[1]) && typeof v === 'boolean';
    if (/^student\|s(?:0[1-9]|1[0-9]|2[0-7])\|name$/.test(k)) return typeof v === 'string' && v.trim().length > 0 && v.length <= 40;
    if (/^student\|s(?:0[1-9]|1[0-9]|2[0-7])\|number$/.test(k)) return Number.isInteger(v) && v >= 1 && v <= 999;
    if (/^student\|s(?:0[1-9]|1[0-9]|2[0-7])\|milk$/.test(k)) return typeof v === 'boolean';
    if (k === 'config|customEnabled') return typeof v === 'boolean';
    if (k === 'config|customName') return typeof v === 'string' && v.length <= 30;
    const m = k.match(/^day\|(\d{4}-\d{2}-\d{2})\|s(?:0[1-9]|1[0-9]|2[0-7])\|(milk|homework|role|custom|note)$/);
    return !!m && validDate(m[1]) && (m[2] === 'note' ? typeof v === 'string' && v.length <= 500 : typeof v === 'boolean');
  }
  function validated(raw, allowEmpty = false) {
    if (allowEmpty && raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) return emptyDoc();
    if (!raw || raw.schema !== SCHEMA || !raw.cells || typeof raw.cells !== 'object' || Array.isArray(raw.cells)) throw new Error('지원하지 않는 Bin 데이터입니다. 빈 객체 {} 또는 이 앱의 데이터 전용 Bin을 사용하세요.');
    const out = emptyDoc();
    for (const [key, cell] of Object.entries(raw.cells)) {
      if (!cell || !Number.isSafeInteger(cell.t) || cell.t < 0 || typeof cell.c !== 'string' || cell.c.length > 100 || !validateCell(key, cell.v)) throw new Error('데이터 형식 검증에 실패했습니다. 안전을 위해 저장을 중단합니다.');
      out.cells[key] = {v:cell.v, t:cell.t, c:cell.c};
    }
    return out;
  }
  function compare(a,b) {
    if (!a) return -1;
    if (!b) return 1;
    if (a.t !== b.t) return a.t > b.t ? 1 : -1;
    if (a.c !== b.c) return a.c > b.c ? 1 : -1;
    const av=JSON.stringify(a.v), bv=JSON.stringify(b.v);
    return av === bv ? 0 : av > bv ? 1 : -1;
  }
  function merge(a,b) {
    const out = {schema:SCHEMA, cells:{...a.cells}};
    for (const [k,v] of Object.entries(b.cells)) if (!out.cells[k] || compare(v,out.cells[k]) > 0) out.cells[k] = v;
    return out;
  }
  function same(a,b) { const ks=Object.keys(a.cells); return ks.length===Object.keys(b.cells).length && ks.every(k => b.cells[k] && compare(a.cells[k],b.cells[k])===0); }
  function observeClock() { for (const cell of Object.values(doc.cells)) lastClock=Math.max(lastClock,cell.t); }
  function value(key,fallback) { return doc.cells[key]?.v ?? fallback; }
  const skey = (id,k) => `student|${id}|${k}`;
  const dkey = (id,k) => `day|${day}|${id}|${k}`;
  function student(id) { const n=IDS.indexOf(id)+1; return {id,number:value(skey(id,'number'),n),name:value(skey(id,'name'),`${n}번 학생`),milk:value(skey(id,'milk'),false)}; }
  const customOn = () => value('config|customEnabled',false);
  const customTitle = () => value('config|customName','추가 항목') || '추가 항목';
  const RATINGS = [['','미평가'],['great','◎ 잘함'],['normal','○ 보통'],['effort','☆ 노력요함'],['rest','△ 쉼']];
  const taskKey = id => `task|${day}|${id}|title`;
  const taskCol = id => id === 'legacy' ? 'homework' : `homework_${id}`;
  function tasks() {
    const prefix = `task|${day}|`;
    const ids = Object.keys(doc.cells).filter(k => k.startsWith(prefix) && k.endsWith('|title')).map(k => k.split('|')[2]);
    return ['legacy', ...ids.filter(id => id !== 'legacy').sort()].map(id => ({id, title:value(taskKey(id), '과제 1 (기존 숙제)')}));
  }
  const checked = (id,col) => col === 'role' ? !!value(dkey(id,'roleRating'),'') : value(dkey(id,col),false) === true;
  function changeTask(id) {
    const next = prompt('과제명을 입력하세요. (최대 80자)', value(taskKey(id),'과제 1 (기존 숙제)'));
    if (next === null) return;
    if (!next.trim() || next.trim().length > 80) { alert('과제명은 1~80자로 입력하세요.'); return; }
    writeBatch([[taskKey(id),next.trim()]]);
  }
  let taskSignature = '';
  function renderTasks() {
    const list = tasks(), signature = JSON.stringify([day,list]);
    if (signature === taskSignature) return;
    taskSignature = signature;
    $('taskList').replaceChildren();
    for (const task of list) {
      const button = document.createElement('button'); button.type='button';
      button.textContent = `${task.title} · 이름 수정`;
      button.addEventListener('click',()=>changeTask(task.id)); $('taskList').append(button);
    }
    for (const [id,r] of rows) {
      r.homework.replaceChildren(); r.taskChecks = new Map();
      for (const task of list) {
        const label=document.createElement('label'), box=document.createElement('input'), text=document.createElement('span');
        box.type='checkbox'; text.textContent=task.title; label.append(box,text);r.homework.append(label);
        box.addEventListener('change',()=>editCheck(id,taskCol(task.id),box.checked));
        r.taskChecks.set(task.id,box);
      }
    }
  }

  function storageKey() { return `classroom-v1:${scope}`; }
  function persist() {
    try { localStorage.setItem(storageKey(),JSON.stringify({doc,pending,revision:localRevision})); }
    catch (e) { warn('브라우저 임시 저장에 실패했습니다. 저장 공간 또는 개인정보 보호 설정을 확인하고 백업을 다운로드하세요. 이 탭을 닫으면 미동기화 기록을 잃을 수 있습니다.'); }
  }
  function loadScope(next) {
    scope=next; doc=emptyDoc(); pending=false; localRevision=0;
    try {
      const raw=localStorage.getItem(storageKey());
      if (raw) { const saved=JSON.parse(raw); doc=validated(saved.doc); pending=!!saved.pending; localRevision=Number(saved.revision)||0; }
    } catch(e) { warn('로컬 데이터를 읽지 못했습니다. 원본 저장소를 덮어쓰지 않도록 이 탭에서 편집하기 전에 브라우저 저장소를 확인하세요.'); }
    observeClock();
  }
  function writeBatch(changes) {
    const real=changes.filter(([k,v]) => !Object.is(value(k,undefined),v));
    if (!real.length) return;
    const t=Math.max(Date.now(),lastClock+1); lastClock=t;
    for (const [k,v] of real) { if (!validateCell(k,v)) throw new Error('잘못된 입력입니다.'); doc.cells[k]={v,t,c:CLIENT}; }
    pending=true; localRevision++; persist(); render(); updateStatus();
    clearTimeout(saveTimer); saveTimer=setTimeout(() => sync(),750);
  }
  function completion(col) {
    const students=IDS.map(student).filter(s=>col!=='milk'||s.milk);
    if (col === 'homework') return {done:students.reduce((n,s)=>n+tasks().filter(t=>checked(s.id,taskCol(t.id))).length,0),total:students.length*tasks().length};
    return {done:students.filter(s=>checked(s.id,col)).length,total:students.length};
  }
  function totals() {
    const cols=['milk','homework','role',...(customOn()?['custom']:[])];
    return cols.reduce((r,col)=>{const c=completion(col);r.done+=c.done;r.total+=c.total;return r;},{done:0,total:0});
  }
  function allDone() { const t=totals(); return t.total>0 && t.done===t.total; }
  function celebrate(text) {
    $('celebration').textContent=text; clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>$('celebration').textContent='',3000);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    $('confetti').replaceChildren();
    for(let i=0;i<55;i++) {
      const el=document.createElement('i');el.className='confetti-piece';
      // Web Animations avoids inline styles under the page's strict CSP.
      $('confetti').append(el);
      if (el.animate) el.animate([{transform:`translate(${Math.random()*100}vw,-20px) rotate(0deg)`},{transform:`translate(${Math.random()*100}vw,110vh) rotate(${360+Math.random()*720}deg)`}],{duration:1400+Math.random()*1000,delay:Math.random()*250,fill:'forwards'}).finished.then(()=>el.remove()).catch(()=>el.remove());
      else setTimeout(()=>el.remove(),1900);
    }
  }
  function editCheck(id,col,next) {
    const before=allDone(); const columnBefore=completion(col);
    writeBatch([[dkey(id,col),next]]);
    const columnAfter=completion(col);
    if ((!before && allDone()) || (columnBefore.done<columnBefore.total && columnAfter.done===columnAfter.total)) celebrate(allDone()?'오늘의 모든 항목을 완료했어요!':'이 항목을 모두 완료했어요!');
  }
  function createRows() {
    for (const id of IDS) {
      const tr=document.createElement('tr'), num=document.createElement('td'), name=document.createElement('td');tr.append(num,name);
      const checks={},cells={};
      function checkCell(col) {
        const td=document.createElement('td'),label=document.createElement('label'),box=document.createElement('input');
        td.className='checkcell';box.type='checkbox';label.append(box);td.append(label);tr.append(td);
        box.addEventListener('change',()=>editCheck(id,col,box.checked));checks[col]=box;cells[col]=td;
      }
      checkCell('milk');
      const homework=document.createElement('td');homework.className='taskchecks';tr.append(homework);
      const roleCell=document.createElement('td'),roleName=document.createElement('input'),rating=document.createElement('select'),legacy=document.createElement('small');
      roleCell.className='rolecell';roleName.type='text';roleName.maxLength=60;roleName.placeholder='역할명 입력';
      roleName.addEventListener('input',()=>writeBatch([[skey(id,'roleName'),roleName.value]]));
      for(const [val,label] of RATINGS){const option=document.createElement('option');option.value=val;option.textContent=label;rating.append(option);}
      rating.addEventListener('change',()=>writeBatch([[dkey(id,'roleRating'),rating.value]]));
      legacy.textContent='이전 버전에서 완료 체크한 기록이 있습니다.';
      roleCell.append(roleName,rating,legacy);tr.append(roleCell);checkCell('custom');
      const td=document.createElement('td'),note=document.createElement('input');note.type='text';note.className='note';note.maxLength=500;note.placeholder='특이사항을 기록하세요';
      note.addEventListener('input',()=>writeBatch([[dkey(id,'note'),note.value]]));td.append(note);tr.append(td);
      $('students').append(tr);rows.set(id,{tr,num,name,checks,cells,note,homework,roleName,rating,legacy,taskChecks:new Map()});
    }
  }
  function render() {
    renderTasks();
    const custom=customOn(),title=customTitle(),query=$('search').value.trim().toLocaleLowerCase(),only=$('incomplete').checked;
    let count=0;
    const sorted=IDS.map(student).sort((a,b)=>a.number-b.number||a.id.localeCompare(b.id));
    for(const s of sorted) {
      const r=rows.get(s.id);r.num.textContent=s.number;r.name.textContent=s.name;r.cells.custom.hidden=!custom;r.checks.milk.disabled=!s.milk;
      for(const col of ['milk','custom']) {
        r.checks[col].checked=col==='milk'&&!s.milk?false:checked(s.id,col);
        r.checks[col].setAttribute('aria-label',`${s.number}번 ${s.name} ${col==='milk'?'우유 급식':title}`);
      }
      for(const task of tasks()) {
        const box=r.taskChecks.get(task.id);box.checked=checked(s.id,taskCol(task.id));box.setAttribute('aria-label',`${s.number}번 ${s.name} ${task.title} 제출`);
      }
      if(document.activeElement!==r.roleName)r.roleName.value=value(skey(s.id,'roleName'),'');
      r.roleName.setAttribute('aria-label',`${s.name} 역할명`);
      r.rating.value=value(dkey(s.id,'roleRating'),'');r.rating.setAttribute('aria-label',`${s.name} 역할 평가`);
      r.legacy.hidden=!(value(dkey(s.id,'role'),false) && !r.rating.value);
      if(document.activeElement!==r.note)r.note.value=value(dkey(s.id,'note'),'');r.note.setAttribute('aria-label',`${s.name} 비고`);
      const done=(!s.milk||checked(s.id,'milk'))&&tasks().every(t=>checked(s.id,taskCol(t.id)))&&checked(s.id,'role')&&(!custom||checked(s.id,'custom'));
      const match=!query||s.name.toLocaleLowerCase().includes(query)||String(s.number).includes(query.replace(/번\s*$/,''));
      r.tr.hidden=!match||(only&&done);r.tr.classList.toggle('complete',done);if(!r.tr.hidden)count++;
    }
    sorted.forEach((s,i)=>{const tr=rows.get(s.id).tr;if($('students').children[i]!==tr)$('students').insertBefore(tr,$('students').children[i]||null);});
    $('customHead').hidden=!custom;$('headCustom').textContent=title;$('visibleCount').textContent=`${count}명 표시`;$('empty').hidden=count!==0;
    for(const col of ['milk','homework','role']) {
      const c=completion(col);$(col+'Count').textContent=`${c.done} / ${c.total}`;
      $(col+'Pct').textContent=c.total?`${Math.round(c.done/c.total*100)}% ${col==='role'?'평가 입력':'완료'}`:'대상자가 없습니다.';
      if(col==='milk'){$('milkLabel').textContent=`우유 급식 · ${c.total}명`;$('headMilk').textContent=`우유 급식 (${c.total}명)`;}
    }
    for(const button of document.querySelectorAll('[data-column]')){const c=completion(button.dataset.column);button.disabled=c.total===0;button.setAttribute('aria-label',`${button.textContent}: 모든 대상자 체크 또는 해제`);}
    const t=totals(),pct=t.total?Math.round(t.done/t.total*100):0;$('totalPct').textContent=pct+'%';$('progress').value=pct;$('totalCount').textContent=`${t.done} / ${t.total}개 기록 완료`;
  }
  function updateStatus() {
    let text;
    if(!config) text=`로컬 모드 · ${pending?'이 기기에 저장됨':'기본 명렬 준비됨'} · 클라우드에 연결하면 기기 간 동기화됩니다.`;
    else if(authBlocked) text='연결 중단 · 인증/권한 또는 데이터 형식을 확인한 뒤 다시 연결하세요.';
    else if(busy) text='클라우드 동기화 중 · 편집은 계속할 수 있습니다.';
    else if(syncText) text=syncText;
    else text=`${pending?'클라우드 반영 대기':'클라우드 확인 완료'}${lastSync?' · '+lastSync:''} · ${config.poll}초 간격 확인`;
    $('status').textContent=text;$('syncNow').disabled=!config||busy||authBlocked;
  }
  async function api(cfg,method,body) {
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);
    try {
      const headers={'X-Access-Key':cfg.key};if(method==='PUT'){headers['Content-Type']='application/json';headers['X-Bin-Versioning']='false';}
      const response=await fetch(`https://api.jsonbin.io/v3/b/${cfg.bin}${method==='GET'?'/latest?meta=false':''}`,{method,headers,body:body?JSON.stringify(body):undefined,signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error'});
      if(!response.ok) {
        let detail='';try{const data=await response.json();if(typeof data.message==='string')detail=data.message;}catch(_){}
        const e=new Error(`JSONbin ${method} 오류 (HTTP ${response.status})${detail?': '+detail:''}`);e.status=response.status;throw e;
      }
      const raw=await response.json();
      return method==='GET'?validated(raw,true):raw;
    } finally {clearTimeout(timeout);}
  }
  function planNext() {
    clearTimeout(timer);if(!config||authBlocked)return;
    const ms=Math.min(300000,config.poll*1000*Math.pow(2,Math.min(failures,6)));
    timer=setTimeout(()=>{if(!document.hidden)sync();else planNext();},ms);
  }
  async function sync() {
    if(!config||busy||authBlocked)return;
    if(!navigator.onLine){syncText='오프라인 · 이 기기에 저장하고 연결 복구 후 재시도합니다.';updateStatus();planNext();return;}
    busy=true;syncText='';updateStatus();const gen=generation,cfg={...config};
    try {
      const remote=await api(cfg,'GET');if(gen!==generation)return;
      doc=merge(remote,doc);observeClock();persist();render();
      if(!same(doc,remote)) {
        pending=true;persist();const snapshot=merge(emptyDoc(),doc);
        await api(cfg,'PUT',snapshot);if(gen!==generation)return;
        // Verification also merges edits made while the request was in flight.
        const confirmed=await api(cfg,'GET');if(gen!==generation)return;
        doc=merge(confirmed,doc);pending=!same(doc,confirmed);
      } else pending=false;
      failures=0;lastSync=new Date().toLocaleTimeString('ko-KR');syncText='';persist();render();
    } catch(e) {
      if(gen!==generation)return;
      failures++;
      if([400,401,403,404].includes(e.status)||(!e.status && e.name!=='AbortError' && /데이터|Bin/.test(e.message))) {
        authBlocked=true;
        syncText='';
        $('cloudError').textContent=e.message;
        warn($('cloudError').textContent);
      } else syncText=e.status===429?'요청 한도에 도달했습니다. 조회 간격을 늘리세요. 자동 재시도 간격을 늘렸습니다.':`통신 실패${e.name==='AbortError'?' (10초 시간 초과)':''} · 이 기기의 기록을 유지하며 자동 재시도합니다.`;
    } finally {
      if(gen===generation){busy=false;updateStatus();planNext();}
    }
  }
  document.querySelectorAll('[data-column]').forEach(button=>button.addEventListener('click',()=>{
    const col=button.dataset.column;if(col==='custom'&&!customOn())return;
    const c=completion(col);if(!c.total)return;
    const next=c.done!==c.total;writeBatch(IDS.map(student).filter(s=>col!=='milk'||s.milk).map(s=>[dkey(s.id,col),next]));
    if(next)celebrate(allDone()?'오늘의 모든 항목을 완료했어요!':'이 항목을 모두 완료했어요!');
  }));
  $('addTask').addEventListener('click',()=>changeTask('a'+CLIENT+'-'+Date.now().toString(36)));
  $('date').addEventListener('change',()=>{if(validDate($('date').value)){day=$('date').value;render();}else $('date').value=day;});
  $('search').addEventListener('input',render);$('incomplete').addEventListener('change',render);
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
  function settingsSnapshot() {return {students:IDS.map(student),customEnabled:customOn(),customName:customTitle()};}
  $('settingsOpen').addEventListener('click',()=>{
    settingsBase=settingsSnapshot();$('milkNumbers').value=settingsBase.students.filter(s=>s.milk).map(s=>s.number).join(', ');
    $('customEnabled').checked=settingsBase.customEnabled;$('customName').value=settingsBase.customName;$('settingsError').textContent='';$('rosterEditor').replaceChildren();
    for(const s of settingsBase.students){const row=document.createElement('div');row.className='rosterrow';
      const n=document.createElement('input');n.type='number';n.min=1;n.max=999;n.step=1;n.required=true;n.value=s.number;n.id=`edit-number-${s.id}`;n.setAttribute('aria-label',`${s.name} 번호`);
      const name=document.createElement('input');name.type='text';name.required=true;name.maxLength=40;name.value=s.name;name.id=`edit-name-${s.id}`;name.setAttribute('aria-label',`내부 학생 ${IDS.indexOf(s.id)+1} 이름`);
      row.append(n,name);$('rosterEditor').append(row);
    }
    $('settingsDialog').showModal();
  });
  $('settingsForm').addEventListener('submit',event=>{
    event.preventDefault();const edited=IDS.map(id=>({id,number:Number($(`edit-number-${id}`).value),name:$(`edit-name-${id}`).value.trim()}));
    if(edited.some(s=>!Number.isInteger(s.number)||s.number<1||s.number>999||!s.name)){ $('settingsError').textContent='번호는 1~999의 정수, 이름은 공백이 아닌 값으로 입력하세요.';return; }
    if(new Set(edited.map(s=>s.number)).size!==27){$('settingsError').textContent='학생 번호는 서로 달라야 합니다.';return;}
    const raw=$('milkNumbers').value.trim();const tokens=raw?raw.split(',').map(s=>s.trim()):[];
    if(tokens.some(t=>!/^\d+$/.test(t)||!edited.some(s=>s.number===Number(t)))){$('settingsError').textContent='우유 대상은 명렬에 있는 번호만 콤마로 구분해 입력하세요.';return;}
    const milk=new Set(tokens.map(Number)), customName=$('customName').value.trim();
    if($('customEnabled').checked&&!customName){$('settingsError').textContent='추가 항목 이름을 입력하세요.';return;}
    const changes=[];
    for(const s of edited){const base=settingsBase.students.find(x=>x.id===s.id);for(const prop of ['name','number'])if(s[prop]!==base[prop])changes.push([skey(s.id,prop),s[prop]]);
      if(milk.has(s.number)!==base.milk)changes.push([skey(s.id,'milk'),milk.has(s.number)]);
    }
    if($('customEnabled').checked!==settingsBase.customEnabled)changes.push(['config|customEnabled',$('customEnabled').checked]);
    if(customName!==settingsBase.customName)changes.push(['config|customName',customName]);
    // Reject an unsafe number collision if another device changed the roster while this dialog was open.
    const resulting=IDS.map(id=>changes.find(([k])=>k===skey(id,'number'))?.[1]??student(id).number);
    if(new Set(resulting).size!==27){$('settingsError').textContent='다른 기기의 변경과 번호가 중복됩니다. 창을 닫고 다시 열어 확인하세요.';return;}
    writeBatch(changes);$('settingsDialog').close();
  });
  $('cloudOpen').addEventListener('click',()=>{
    $('binId').value=config?.bin||(/^[a-f0-9]{24}$/i.test(scope)?scope:'');$('accessKey').value=config?.key||'';$('pollSeconds').value=String(config?.poll||15);$('mergeOffline').checked=false;
    $('cloudDialog').showModal();
  });
  function sessionSave(remember) {
    try {if(remember&&config)sessionStorage.setItem('classroom-connection',JSON.stringify(config));else sessionStorage.removeItem('classroom-connection');}
    catch(e){warn('탭 저장소를 사용할 수 없어 키를 기억하지 못합니다. 새로고침 후 다시 연결하세요.');}
  }
  $('cloudForm').addEventListener('submit',e=>{
    e.preventDefault();const bin=$('binId').value.trim().toLowerCase(),key=$('accessKey').value.trim();
    if(!/^[a-f0-9]{24}$/.test(bin)||!key){$('cloudError').textContent='올바른 Bin ID와 Access Key를 입력하세요.';return;}
    const offline=scope==='offline'?doc:null,include=$('mergeOffline').checked;
    if(include&&scope!=='offline'){$('cloudError').textContent='로컬 기록을 병합하려면 먼저 연결을 해제한 뒤 로컬 모드에서 연결하세요.';return;}
    persist();generation++;busy=false;clearTimeout(timer);clearTimeout(saveTimer);authBlocked=false;failures=0;syncText='';lastSync='';
    if(scope!==bin)loadScope(bin);
    if(include&&offline){doc=merge(doc,offline);pending=true;observeClock();}
    config={bin,key,poll:Number($('pollSeconds').value)};sessionSave($('remember').checked);$('accessKey').value='';$('cloudError').textContent='';
    warn('');persist();render();$('cloudDialog').close();sync();
  });
  $('disconnect').addEventListener('click',()=>{
    persist();generation++;busy=false;clearTimeout(timer);clearTimeout(saveTimer);config=null;authBlocked=false;syncText='';lastSync='';sessionSave(false);$('remember').checked=false;$('accessKey').value='';
    loadScope('offline');render();updateStatus();$('cloudDialog').close();
  });
  $('syncNow').addEventListener('click',()=>{clearTimeout(timer);sync();});
  $('export').addEventListener('click',()=>{
    const backup={app:SCHEMA,exportedAt:new Date().toISOString(),scope,pending,doc};
    const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`학급체크리스트_백업_${localDate()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
  });
  window.addEventListener('online',()=>{failures=0;syncText='';sync();});
  window.addEventListener('offline',()=>{syncText='오프라인 · 기록은 이 기기에 저장됩니다.';updateStatus();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync();});
  window.addEventListener('storage',event=>{
    if(event.key!==storageKey()||!event.newValue)return;
    try {const saved=JSON.parse(event.newValue),incoming=validated(saved.doc),merged=merge(doc,incoming);if(!same(merged,doc)){doc=merged;pending=true;observeClock();render();updateStatus();clearTimeout(saveTimer);saveTimer=setTimeout(sync,750);}}
    catch(e){warn('다른 탭의 저장 데이터를 읽지 못했습니다. 백업 후 데이터를 확인하세요.');}
  });
  window.addEventListener('beforeunload',e=>{if(config&&pending){e.preventDefault();e.returnValue='';}});
  // Render defaults immediately. No network request is on the initial render path.
  createRows();loadScope('offline');render();updateStatus();
  try {
    const saved=sessionStorage.getItem('classroom-connection');
    if(saved){const candidate=JSON.parse(saved);if(/^[a-f0-9]{24}$/i.test(candidate.bin)&&typeof candidate.key==='string'&&candidate.key&&[5,15,30,60].includes(candidate.poll)){config=candidate;loadScope(config.bin);$('remember').checked=true;render();updateStatus();setTimeout(sync,0);}}
  }catch(e){warn('이전 연결 정보를 읽지 못했습니다. 클라우드 연결 창에서 다시 입력하세요.');}
})();
