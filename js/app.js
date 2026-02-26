document.addEventListener("DOMContentLoaded", function(){

// ══════════════════════════════════════════════════════
// SUPABASE CONFIG
// ══════════════════════════════════════════════════════
var SUPA_URL = 'https://hnoljtabmqnqwhmtfoqy.supabase.co';
var SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhub2xqdGFibXFucXdobXRmb3F5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxMDIzMTQsImV4cCI6MjA4NzY3ODMxNH0.LQUe0VhAIHWwOWFQhfVrxYRGXp2iljtjAZz69vat9Mc';
var db = (SUPA_URL !== 'TU_SUPABASE_URL')
  ? window.supabase.createClient(SUPA_URL, SUPA_KEY)
  : null;

var _warnedNoDb = false;
function dbReady(){
  if(db) return true;
  if(!_warnedNoDb){ showToast('⚠ Configura Supabase en el código','er'); _warnedNoDb=true; }
  return false;
}

async function q(table, opts){
  var ref = db.from(table);
  if(opts && opts.select)  ref = ref.select(opts.select);
  if(opts && opts.eq)      for(var k in opts.eq) ref = ref.eq(k, opts.eq[k]);
  if(opts && opts.order)   ref = ref.order(opts.order, {ascending: opts.asc !== false});
  var {data, error} = await ref;
  if(error){ console.error(table, error); return []; }
  return data || [];
}

// ══════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════
var CU = null;       // 'admin' | 'alba' | 'sofia'
var pinTarget = null;
var pinBuf = '';
var taskFreq = 'unica';
var rewWho = 'alba';
var calY, calM, calSel = null;
var _curView = null;
var _calBuilding = false;
var _loading = false;

var today = new Date();
calY = today.getFullYear();
calM = today.getMonth();

var albaPoints  = 0;
var sofiaPoints = 0;
var pins = { admin:'1234', alba:'1111', sofia:'2222' };

var taskDefs = [];
var tasks    = [];
var rewards  = { alba:[], sofia:[] };
var hist     = [];
var pays     = [];

// ══════════════════════════════════════════════════════
// LOAD FROM SUPABASE
// ══════════════════════════════════════════════════════
async function loadAll(){
  if(!dbReady()) return;
  showLoading(true);
  try {
    // Config & PINs
    var cfg = await q('config', {eq:{id:'main'}});
    if(cfg[0]){
      pins = { admin: cfg[0].pin_admin, alba: cfg[0].pin_alba, sofia: cfg[0].pin_sofia };
      var ppeEl = g('cfg-ppe');
      if(ppeEl) ppeEl.value = cfg[0].pts_per_euro;
      var pa = g('cfg-pin-admin'), pb = g('cfg-pin-alba'), ps = g('cfg-pin-sofia');
      if(pa) pa.value = cfg[0].pin_admin;
      if(pb) pb.value = cfg[0].pin_alba;
      if(ps) ps.value = cfg[0].pin_sofia;
    }

    // Puntos
    var perfs = await q('perfiles');
    perfs.forEach(function(p){
      if(p.who==='alba')  albaPoints  = p.puntos;
      if(p.who==='sofia') sofiaPoints = p.puntos;
    });

    // Catálogo
    var defs = await q('task_defs', {order:'nombre', asc:true});
    taskDefs = defs.map(function(d){ return {id:d.id, e:d.emoji, n:d.nombre}; });

    // Tareas + completions de hoy
    var rawTasks = await q('tasks', {select:'*', eq:{activa:true}});
    var todayStr = fd(today);
    var rawComps = await q('completions', {select:'*', eq:{fecha:todayStr}});
    var compMap = {};
    rawComps.forEach(function(c){ compMap[c.task_id] = c; });

    tasks = rawTasks.map(function(t){
      var task = {
        id:t.id, e:t.emoji, n:t.nombre, who:t.quien, pts:t.puntos,
        freq:t.frecuencia, start:t.fecha_inicio, wd:t.dia_semana, c:{}
      };
      var c = compMap[t.id];
      if(c) task.c[todayStr] = {done:c.done, approved:c.approved, rejected:c.rejected};
      return task;
    });

    // Historial (último mes)
    var monthAgo = od(-30);
    var {data: rawHist} = await db.from('historial').select('*')
      .gte('fecha', monthAgo).order('fecha', {ascending:false});
    hist = (rawHist||[]).map(function(h){
      return {date:h.fecha, who:h.quien, n:h.tarea_nombre, e:h.emoji, pts:h.puntos, type:h.tipo};
    });

    // Pagos
    var {data: rawPays} = await db.from('pagos').select('*').order('fecha',{ascending:false});
    pays = (rawPays||[]).map(function(p){
      return {date:p.fecha, who:p.quien, pts:p.puntos, eur:parseFloat(p.euros)};
    });

    // Rewards
    var rawRew = await q('rewards', {order:'quien'});
    rewards = {alba:[], sofia:[]};
    rawRew.forEach(function(r){
      var obj = {id:r.id, e:r.emoji, n:r.nombre, pts:r.puntos};
      if(r.quien==='alba')  rewards.alba.push(obj);
      if(r.quien==='sofia') rewards.sofia.push(obj);
    });

  } catch(err){
    console.error('loadAll error', err);
    showToast('Error cargando datos','er');
  }
  showLoading(false);
  renderAll();
}

function showLoading(on){
  _loading = on;
  var el = g('loading-overlay');
  if(el) el.style.display = on ? 'flex' : 'none';
}

// ══════════════════════════════════════════════════════
// SAVE HELPERS
// ══════════════════════════════════════════════════════
async function saveCompletion(taskId, dateStr, data){
  if(!dbReady()) return;
  await db.from('completions').upsert({
    task_id: taskId, fecha: dateStr,
    done: !!data.done, approved: !!data.approved, rejected: !!data.rejected
  }, {onConflict: 'task_id,fecha'});
}

async function savePoints(){
  if(!dbReady()) return;
  await db.from('perfiles').upsert([
    {who:'alba',  puntos: albaPoints},
    {who:'sofia', puntos: sofiaPoints}
  ], {onConflict:'who'});
}

async function saveHistEntry(entry){
  if(!dbReady()) return;
  await db.from('historial').insert({
    fecha: entry.date, quien: entry.who, tarea_nombre: entry.n,
    emoji: entry.e, puntos: entry.pts, tipo: entry.type
  });
}

async function savePago(pago){
  if(!dbReady()) return;
  await db.from('pagos').insert({
    fecha: pago.date, quien: pago.who, puntos: pago.pts, euros: pago.eur
  });
}

async function saveConfig(){
  if(!dbReady()) return;
  var ppe = parseInt(g('cfg-ppe').value)||100;
  await db.from('config').update({
    pts_per_euro: ppe,
    pin_admin: pins.admin, pin_alba: pins.alba, pin_sofia: pins.sofia
  }).eq('id','main');
}

// FIX: rewards no se guardaban en Supabase en el original
async function saveReward(who, e, n, pts){
  if(!dbReady()) return null;
  var {data, error} = await db.from('rewards').insert({emoji:e, nombre:n, puntos:pts, quien:who}).select();
  if(error){ console.error('saveReward', error); return null; }
  return (data && data[0]) ? data[0].id : null;
}

async function deleteReward(id){
  if(!dbReady()) return;
  await db.from('rewards').delete().eq('id', id);
}

// FIX: catálogo de tareas no se guardaba en Supabase en el original
async function saveTaskDef(e, n){
  if(!dbReady()) return null;
  var {data, error} = await db.from('task_defs').insert({emoji:e, nombre:n}).select();
  if(error){ console.error('saveTaskDef', error); return null; }
  return (data && data[0]) ? data[0].id : null;
}

async function deleteTaskDef(id){
  if(!dbReady()) return;
  await db.from('task_defs').delete().eq('id', id);
}

// FIX: resetTask no limpiaba historial en Supabase en el original
async function deleteHistByTaskDate(taskName, dateStr){
  if(!dbReady()) return;
  await db.from('historial').delete().eq('fecha', dateStr).eq('tarea_nombre', taskName);
}

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════
function g(id){ return document.getElementById(id); }
function st(id,v){ var e=g(id); if(e) e.textContent=v; }
function fd(d){ return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }
function p2(n){ return String(n).padStart(2,'0'); }
function od(n){ var d=new Date(today); d.setDate(d.getDate()+n); return fd(d); }
function ppe(){ var e=g('cfg-ppe'); return parseInt(e&&e.value)||100; }
document.addEventListener('change',function(e){ if(e.target&&e.target.id==='cfg-ppe') saveConfig(); });

var FL  = {unica:'Única',diaria:'Diaria',semanal:'Semanal'};
var DOW = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
var MES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
var DIA = ['L','M','X','J','V','S','D'];

function parseDate(s){ var p=s.split('-'); return new Date(+p[0],+p[1]-1,+p[2]); }
function activeToday(t){
  var s=parseDate(t.start);
  var tm=new Date(today.getFullYear(),today.getMonth(),today.getDate());
  if(tm<s) return false;
  if(t.freq==='unica')   return fd(today)===t.start;
  if(t.freq==='diaria')  return true;
  if(t.freq==='semanal') return today.getDay()===parseInt(t.wd);
  return false;
}
function cmpToday(t){ return t.c[fd(today)]||{}; }
function isDone(t)     { return !!cmpToday(t).approved; }
function isRejected(t) { return !!cmpToday(t).rejected; }
function isPend(t)     { var c=cmpToday(t); return c.done&&!c.approved&&!c.rejected; }
function isMarked(t)   { return !!cmpToday(t).done || !!cmpToday(t).rejected; }

// ══════════════════════════════════════════════════════
// NAV
// ══════════════════════════════════════════════════════
var ANAV=[
  {id:'dashboard', l:'Dashboard',i:'⬡'},
  {id:'alba',      l:'Alba',     i:'◈'},
  {id:'sofia',     l:'Sofía',    i:'◈'},
  {id:'historial', l:'Historial',i:'◷'},
  {id:'config',    l:'Config',   i:'◎'}
];
var HNAV=[
  {id:'hija-inicio', l:'Inicio', i:'⬡'},
  {id:'hija-tareas', l:'Tareas', i:'✓'},
  {id:'hija-metas',  l:'Metas',  i:'🎯'}
];

function buildNav(list){
  var dn=g('desknav'), bn=g('mobnav');
  var dt='<div class="nav-tabs">',bt='';
  list.forEach(function(v){
    dt+='<button class="ntab" data-nav="'+v.id+'">'+v.l+'</button>';
    bt+='<button class="bn" data-nav="'+v.id+'"><span class="bni">'+v.i+'</span>'+v.l+'</button>';
  });
  dt+='</div>';
  dn.innerHTML=dt; bn.innerHTML=bt;
  document.querySelectorAll('[data-nav]').forEach(function(el){
    el.addEventListener('click',function(){ gotoView(el.getAttribute('data-nav')); });
  });
}
function markNav(id){
  document.querySelectorAll('[data-nav]').forEach(function(el){
    el.classList.toggle('active',el.getAttribute('data-nav')===id);
  });
}
function gotoView(id){
  _curView=id;
  document.querySelectorAll('.view').forEach(function(v){ v.classList.remove('active'); });
  var el=g('view-'+id); if(el) el.classList.add('active');
  markNav(id);
  window.scrollTo(0,0);
  renderAll();
}

// ══════════════════════════════════════════════════════
// LOGIN / PIN
// ══════════════════════════════════════════════════════
function showOnly(id){
  g('login-screen').classList.toggle('hidden',id!=='login-screen');
  g('pin-screen').classList.toggle('hidden',id!=='pin-screen');
  g('app').style.display=id==='app'?'block':'none';
}

g('lc-admin').addEventListener('click',function(){ openPin('admin'); });
g('lc-alba').addEventListener('click',function(){  openPin('alba');  });
g('lc-sofia').addEventListener('click',function(){ openPin('sofia'); });
g('pk-del').addEventListener('click',pinDel);
g('pin-back').addEventListener('click',function(){
  showOnly('login-screen'); pinBuf=''; updateDots(); g('pin-err').textContent='';
});
g('logout-btn').addEventListener('click',function(){ CU=null; showOnly('login-screen'); });
document.querySelectorAll('.pk[data-d]').forEach(function(btn){
  btn.addEventListener('click',function(){ pinPress(btn.getAttribute('data-d')); });
});

function openPin(who){
  pinTarget=who; pinBuf=''; updateDots(); g('pin-err').textContent='';
  var names={admin:'Administrador',alba:'Alba',sofia:'Sofía'};
  g('pin-who-lbl').textContent=names[who].toUpperCase();
  showOnly('pin-screen');
}
function pinPress(d){
  if(pinBuf.length>=4) return;
  pinBuf+=d; updateDots();
  // Vibración háptica en móvil
  if(navigator.vibrate) navigator.vibrate(10);
  if(pinBuf.length===4){
    setTimeout(function(){
      if(pinBuf===pins[pinTarget]){
        CU=pinTarget; pinBuf=''; updateDots();
        showOnly('app'); enterApp();
      } else {
        if(navigator.vibrate) navigator.vibrate([50,30,50]);
        g('pin-err').textContent='PIN incorrecto';
        var dots=g('pin-dots');
        dots.classList.add('shake');
        setTimeout(function(){ pinBuf=''; updateDots(); dots.classList.remove('shake'); g('pin-err').textContent=''; },600);
      }
    },80);
  }
}
function pinDel(){ pinBuf=pinBuf.slice(0,-1); updateDots(); }
function updateDots(){ for(var i=0;i<4;i++) g('pd'+i).classList.toggle('on',i<pinBuf.length); }

function enterApp(){
  var b=g('who-badge');
  if(CU==='admin'){
    b.textContent='Admin'; b.className='who-badge admin';
    buildNav(ANAV); gotoView('dashboard');
  } else {
    var nm=CU==='alba'?'Alba':'Sofía';
    b.textContent=nm; b.className='who-badge '+CU;
    buildNav(HNAV); gotoView('hija-inicio');
  }
  loadAll();
}

// ══════════════════════════════════════════════════════
// TASK CARD HTML
// ══════════════════════════════════════════════════════
function taskCard(t, mode){
  var c=cmpToday(t), done=!!c.done, ok=!!c.approved, rej=!!c.rejected;

  // FIX: comprobación unificada de who — el original mezclaba 'Sofia' y 'Sofía'
  var wc, wl;
  if(t.who==='Alba')       { wc='twa'; wl='Alba'; }
  else if(t.who==='Sofía') { wc='tws'; wl='Sofía'; }
  else                     { wc='twb'; wl='Alba + Sofía'; }

  var right='';
  if(mode==='dash'||mode==='adm'){
    if(ok){
      right='<span class="badge badge-ok">✓ OK</span>'
           +'<button class="resetbtn" data-reset="'+t.id+'" title="Rehabilitar">↺</button>';
    } else if(rej){
      right='<span class="badge badge-rej">✗ Rechazada</span>'
           +'<button class="resetbtn" data-reset="'+t.id+'" title="Rehabilitar">↺</button>';
    } else if(done){
      right='<button class="aprbtn" data-apr="'+t.id+'">✓ Aprobar</button>'
           +'<button class="rejbtn" data-rej="'+t.id+'">✗ Rechazar</button>';
    } else {
      right='<span class="badge badge-up">Pendiente</span>';
      // Botón de desactivar visible solo en las pestañas individuales (adm)
      if(mode==='adm'){
        right+='<button class="delbtn" data-deact="'+t.id+'" title="Desactivar tarea">✕</button>';
      }
    }
  } else {
    // FIX: clases corregidas — el original usaba 'tchk-pend','tchk-ok','tchk-rej'
    // pero el CSS define '.tchk.pending', '.tchk.done-ok', '.tchk.rejected'
    var chkCls=rej?'tchk rejected':ok?'tchk done-ok':done?'tchk pending':'tchk';
    var chkTxt=rej?'✗':ok?'✓':done?'…':'';
    right='<div class="'+chkCls+'" data-chk="'+t.id+'">'+chkTxt+'</div>';
  }

  var who2=(mode==='dash')?'<span class="'+wc+'">'+wl+'</span>':'';
  var dow=(t.freq==='semanal')?'<span style="color:var(--dim)">'+DOW[t.wd]+'</span>':'';
  var cardCls='tcard'+(ok?' done':rej?' rejected':'');
  return '<div class="'+cardCls+'">'
    +'<div class="tico">'+t.e+'</div>'
    +'<div class="tinfo"><div class="tnm">'+t.n+'</div>'
    +'<div class="tmeta">'+who2+'<span class="tfreq">'+FL[t.freq]+'</span>'+dow+'</div></div>'
    +'<div class="tpts">+'+t.pts+'</div>'
    +right+'</div>';
}

function rewHtml(who){
  var pts=who==='alba'?albaPoints:sofiaPoints;
  var list=rewards[who],bc=who==='alba'?'ab':'sb';
  if(!list.length) return '<div class="empty"><span class="emo">🎯</span><p>Sin objetivos todavía</p></div>';
  return list.map(function(r){
    var pct=Math.min(100,pts/r.pts*100);
    var tick=pts>=r.pts?' <span style="color:var(--green)">✓</span>':'';
    return '<div class="prog-item">'
      +'<div class="prog-row"><div class="prog-name">'+r.e+' '+r.n+tick+'</div><div class="prog-pts">'+pts+' / '+r.pts+'</div></div>'
      +'<div class="prog-bg"><div class="prog-bar '+bc+'" style="width:'+pct+'%"></div></div>'
      +'</div>';
  }).join('');
}

// ══════════════════════════════════════════════════════
// RENDER ALL
// ══════════════════════════════════════════════════════
function renderAll(){
  var p=ppe();
  var allT  =tasks.filter(activeToday);
  var albaT =allT.filter(function(t){ return t.who==='Alba'||t.who==='Ambas'; });
  var sofiaT=allT.filter(function(t){ return t.who==='Sofía'||t.who==='Ambas'; });
  var nDone =allT.filter(isDone).length;
  var totalPts=albaPoints+sofiaPoints;

  // Stats
  st('st-total',allT.length); st('st-done',nDone);
  st('st-pts',totalPts); st('st-money','€'+(totalPts/p).toFixed(0));

  // Dashboard task list
  var td=g('tlist-dash');
  if(td) td.innerHTML=allT.length
    ?allT.map(function(t){ return taskCard(t,'dash'); }).join('')
    :'<div class="empty"><span class="emo">📋</span><p>Sin tareas para hoy</p></div>';

  // Upcoming periodic
  var up=g('tlist-upcoming');
  if(up){
    var ups=tasks.filter(function(t){ return t.freq!=='unica'&&!activeToday(t); });
    up.innerHTML=ups.length
      ?ups.map(function(t){
          var uwc=t.who==='Alba'?'twa':t.who==='Sofía'?'tws':'twb';
          var uwl=t.who==='Ambas'?'Ambas':t.who;
          var dow=t.freq==='semanal'?'<span style="color:var(--muted)">cada '+DOW[t.wd]+'</span>':'';
          return '<div class="tcard"><div class="tico">'+t.e+'</div>'
            +'<div class="tinfo"><div class="tnm">'+t.n+'</div>'
            +'<div class="tmeta"><span class="'+uwc+'">'+uwl+'</span><span class="tfreq">'+FL[t.freq]+'</span>'+dow+'</div></div>'
            +'<div class="tpts">+'+t.pts+'</div><span class="badge badge-up">Programada</span></div>';
        }).join('')
      :'<div style="font-size:.8rem;color:var(--muted);padding:6px 0 14px">Sin tareas periódicas adicionales</div>';
  }

  // Profile cards
  var mx=Math.max(albaPoints,sofiaPoints,300);
  st('da-pts',albaPoints+' pts');
  var ab=g('da-bar'); if(ab) ab.style.width=Math.min(100,albaPoints/mx*100)+'%';
  st('da-money','€'+(albaPoints/p).toFixed(2));
  st('ds-pts',sofiaPoints+' pts');
  var sb=g('ds-bar'); if(sb) sb.style.width=Math.min(100,sofiaPoints/mx*100)+'%';
  st('ds-money','€'+(sofiaPoints/p).toFixed(2));

  // FIX: renombrado de 'db' a 'dbadge' para no hacer shadow del cliente Supabase
  var nPend=allT.filter(isPend).length;
  var dbadge=g('dash-badge');
  if(dbadge){ dbadge.style.display=nPend?'':'none'; if(nPend) dbadge.textContent=nPend+' por aprobar'; }

  // Alba admin tab
  st('va-pts',albaPoints); st('va-money','€'+(albaPoints/p).toFixed(2));
  var ta=g('tlist-alba');
  if(ta) ta.innerHTML=albaT.length
    ?albaT.map(function(t){ return taskCard(t,'adm'); }).join('')
    :'<div class="empty"><span class="emo">🎉</span><p>Sin tareas hoy</p></div>';
  var vab=g('va-badge');
  if(vab){ var na=albaT.filter(function(t){return !isMarked(t);}).length; vab.style.display=na?'':'none'; if(na) vab.textContent=na+' pendiente'+(na>1?'s':''); }
  var ra=g('rew-alba'); if(ra) ra.innerHTML=rewHtml('alba');

  // Sofía admin tab
  st('vs-pts',sofiaPoints); st('vs-money','€'+(sofiaPoints/p).toFixed(2));
  var ts=g('tlist-sofia');
  if(ts) ts.innerHTML=sofiaT.length
    ?sofiaT.map(function(t){ return taskCard(t,'adm'); }).join('')
    :'<div class="empty"><span class="emo">🎉</span><p>Sin tareas hoy</p></div>';
  var vsb=g('vs-badge');
  if(vsb){ var ns=sofiaT.filter(function(t){return !isMarked(t);}).length; vsb.style.display=ns?'':'none'; if(ns) vsb.textContent=ns+' pendiente'+(ns>1?'s':''); }
  var rs=g('rew-sofia'); if(rs) rs.innerHTML=rewHtml('sofia');

  // Hija views
  if(CU==='alba'||CU==='sofia'){
    var isA=CU==='alba', hName=isA?'Alba':'Sofía';
    var hPts=isA?albaPoints:sofiaPoints, hT=isA?albaT:sofiaT;
    var hh=g('hija-hdr');
    if(hh) hh.className='hdr '+(isA?'at':'st');
    st('hija-name',hName); st('hija-pts',hPts);
    st('hija-money','€'+(hPts/p).toFixed(2));
    var hp=hT.filter(function(t){return !isMarked(t);}).length;
    var hc=hT.filter(isDone).length;
    st('hija-pend',hp); st('hija-done',hc);
    var hhtml=hT.length
      ?hT.map(function(t){ return taskCard(t,'hija'); }).join('')
      :'<div class="empty"><span class="emo">🎉</span><p>¡Todo listo por hoy!</p></div>';
    var ht1=g('tlist-hija1'),ht2=g('tlist-hija2');
    if(ht1) ht1.innerHTML=hhtml;
    if(ht2) ht2.innerHTML=hhtml;
    var hr=g('hija-rewards'); if(hr) hr.innerHTML=rewHtml(CU);
  }

  // Today label
  var mnames=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  st('today-lbl',DOW[today.getDay()]+' · '+today.getDate()+' '+mnames[today.getMonth()]+' '+today.getFullYear());

  renderCfgTasks();
  renderPays();
  if(_curView==='historial'&&!_calBuilding) buildCal();
}

// ══════════════════════════════════════════════════════
// EVENT DELEGATION
// ══════════════════════════════════════════════════════
document.addEventListener('click',function(e){
  var apr=e.target.closest('[data-apr]');
  if(apr){ approveTask(apr.getAttribute('data-apr')); return; }
  var rej=e.target.closest('[data-rej]');
  if(rej){ rejectTask(rej.getAttribute('data-rej')); return; }
  var rst=e.target.closest('[data-reset]');
  if(rst){ resetTask(rst.getAttribute('data-reset')); return; }
  var chk=e.target.closest('[data-chk]');
  if(chk){ markDone(chk.getAttribute('data-chk')); return; }
  // Desactivar tarea (nuevo)
  var deact=e.target.closest('[data-deact]');
  if(deact){ deactivateTask(deact.getAttribute('data-deact')); return; }
  // Profile card → nav
  var pc=e.target.closest('#pcard-alba');
  if(pc){ gotoView('alba'); return; }
  var ps=e.target.closest('#pcard-sofia');
  if(ps){ gotoView('sofia'); return; }
});

// ══════════════════════════════════════════════════════
// TASK ACTIONS
// ══════════════════════════════════════════════════════
function markDone(rawId){
  var t=tasks.find(function(x){ return x.id==rawId; });
  if(!t||isMarked(t)) return;
  var ds=fd(today);
  if(!t.c[ds]) t.c[ds]={};
  t.c[ds].done=true;
  saveCompletion(t.id, ds, t.c[ds]);
  showToast('Tarea marcada — esperando aprobación ⏳','tl');
  renderAll();
}

function approveTask(rawId){
  var t=tasks.find(function(x){ return x.id==rawId; });
  if(!t){ showToast('Tarea no encontrada','er'); return; }
  var ds=fd(today);
  if(!t.c[ds]) t.c[ds]={done:true};
  if(t.c[ds].approved){ showToast('Ya estaba aprobada','am'); return; }
  t.c[ds].done=true;
  t.c[ds].approved=true;
  var msg=[];
  if(t.who==='Alba'||t.who==='Ambas'){
    albaPoints+=t.pts;
    var ha={date:ds,who:'Alba',n:t.n,e:t.e,pts:t.pts,type:'done'};
    hist.push(ha); saveHistEntry(ha);
    msg.push('Alba +'+t.pts);
  }
  if(t.who==='Sofía'||t.who==='Ambas'){
    sofiaPoints+=t.pts;
    var hs={date:ds,who:'Sofía',n:t.n,e:t.e,pts:t.pts,type:'done'};
    hist.push(hs); saveHistEntry(hs);
    msg.push('Sofía +'+t.pts);
  }
  saveCompletion(t.id, ds, t.c[ds]);
  savePoints();
  showToast(msg.join(' · ')+' pts ✓','gn');
  renderAll();
}

function rejectTask(rawId){
  var t=tasks.find(function(x){ return String(x.id)===String(rawId); });
  if(!t) return;
  var ds=fd(today);
  if(!t.c[ds]) t.c[ds]={};
  if(t.c[ds].approved) return;
  t.c[ds].rejected=true; t.c[ds].done=false;
  // FIX: guardado inmediato — el original filtraba hist después y podía duplicar
  if(t.who==='Alba'||t.who==='Ambas'){
    var ha={date:ds,who:'Alba',n:t.n,e:t.e,pts:0,type:'missed'};
    hist.push(ha); saveHistEntry(ha);
  }
  if(t.who==='Sofía'||t.who==='Ambas'){
    var hs={date:ds,who:'Sofía',n:t.n,e:t.e,pts:0,type:'missed'};
    hist.push(hs); saveHistEntry(hs);
  }
  saveCompletion(t.id, ds, t.c[ds]);
  showToast('Tarea rechazada','er');
  renderAll();
}

function resetTask(rawId){
  var t=tasks.find(function(x){ return String(x.id)===String(rawId); });
  if(!t) return;
  var ds=fd(today);
  var c=t.c[ds]||{};
  var needsHistClean=false;
  if(c.approved){
    if(t.who==='Alba'||t.who==='Ambas') albaPoints=Math.max(0,albaPoints-t.pts);
    if(t.who==='Sofía'||t.who==='Ambas') sofiaPoints=Math.max(0,sofiaPoints-t.pts);
    hist=hist.filter(function(h){ return !(h.date===ds&&h.n===t.n&&h.type==='done'); });
    savePoints();
    needsHistClean=true;
  }
  if(c.rejected){
    hist=hist.filter(function(h){ return !(h.date===ds&&h.n===t.n&&h.type==='missed'); });
    needsHistClean=true;
  }
  // FIX: el original nunca limpiaba el historial de Supabase al rehabilitar
  if(needsHistClean) deleteHistByTaskDate(t.n, ds);
  t.c[ds]={};
  saveCompletion(t.id, ds, {done:false, approved:false, rejected:false});
  showToast('Tarea rehabilitada — pendiente de revisión','am');
  renderAll();
}

// NUEVO: desactivar tarea desde las pestañas de admin
async function deactivateTask(rawId){
  var t=tasks.find(function(x){ return String(x.id)===String(rawId); });
  if(!t) return;
  if(dbReady()){
    await db.from('tasks').update({activa:false}).eq('id', t.id);
  }
  tasks=tasks.filter(function(x){ return String(x.id)!==String(rawId); });
  showToast('Tarea desactivada','am');
  renderAll();
}

// ══════════════════════════════════════════════════════
// PROPINA
// ══════════════════════════════════════════════════════
g('pa-btn').addEventListener('click',function(){ payPropina('alba'); });
g('ps-btn').addEventListener('click',function(){ payPropina('sofia'); });

function payPropina(who){
  var inp=g(who==='alba'?'pa-input':'ps-input');
  var pts=parseInt(inp.value)||0;
  if(pts<=0){ showToast('Introduce los puntos a canjear','er'); return; }
  var cur=who==='alba'?albaPoints:sofiaPoints;
  if(pts>cur){ showToast('Puntos insuficientes','er'); return; }
  var eur=pts/ppe(), nm=who==='alba'?'Alba':'Sofía';
  if(who==='alba') albaPoints-=pts; else sofiaPoints-=pts;
  var pago={date:fd(today),who:nm,pts:pts,eur:eur};
  pays.push(pago);
  var hentry={date:fd(today),who:nm,n:'Propina pagada',e:'💶',pts:pts,type:'payment'};
  hist.push(hentry);
  savePoints();
  savePago(pago);
  saveHistEntry(hentry);
  inp.value=''; g(who==='alba'?'pa-eur':'ps-eur').textContent='';
  showToast('💶 '+pts+' pts → €'+eur.toFixed(2)+' pagados a '+nm,'am');
  renderAll();
}

document.addEventListener('input',function(e){
  if(e.target.id==='pa-input'||e.target.id==='ps-input'){
    var who=e.target.id==='pa-input'?'alba':'sofia';
    var v=parseInt(e.target.value)||0;
    var el=g(who==='alba'?'pa-eur':'ps-eur');
    if(el) el.textContent=v>0?'→ €'+(v/ppe()).toFixed(2):'';
  }
});

// ══════════════════════════════════════════════════════
// TASK MODAL
// ══════════════════════════════════════════════════════
g('btn-new-task').addEventListener('click',function(){
  var s=g('mt-sel');
  s.innerHTML='<option value="">— Selecciona —</option>'+taskDefs.map(function(t){
    return '<option value="'+t.id+'">'+t.e+' '+t.n+'</option>';
  }).join('');
  taskFreq='unica';
  document.querySelectorAll('.fqopt').forEach(function(el){
    el.classList.toggle('on',el.getAttribute('data-fq')==='unica');
  });
  g('mt-date').value=fd(today);
  g('mt-wd-grp').classList.add('hidden');
  g('mt-date-lbl').textContent='Fecha';
  g('modal-task').classList.add('open');
});

g('freq-row').addEventListener('click',function(e){
  var opt=e.target.closest('.fqopt'); if(!opt) return;
  document.querySelectorAll('.fqopt').forEach(function(el){ el.classList.remove('on'); });
  opt.classList.add('on');
  taskFreq=opt.getAttribute('data-fq');
  g('mt-wd-grp').classList.toggle('hidden',taskFreq!=='semanal');
  g('mt-date-lbl').textContent=taskFreq==='unica'?'Fecha':'Fecha de inicio';
});

g('mt-submit').addEventListener('click',function(){
  var defId=g('mt-sel').value;
  if(!defId){ showToast('Selecciona una tarea del catálogo','er'); return; }
  var def=taskDefs.find(function(x){ return String(x.id)===String(defId); });
  if(!def){ showToast('Tarea no válida','er'); return; }
  var pts=parseInt(g('mt-pts').value)||20;
  var who=g('mt-who').value;
  var start=g('mt-date').value||fd(today);
  var wd=taskFreq==='semanal'?parseInt(g('mt-wd').value):null;
  if(dbReady()){
    db.from('tasks').insert({
      emoji:def.e, nombre:def.n, quien:who, puntos:pts,
      frecuencia:taskFreq, fecha_inicio:start,
      dia_semana: taskFreq==='semanal'?wd:null, activa:true
    }).select().then(function(res){
      if(res.data&&res.data[0]){
        tasks.push({id:res.data[0].id,e:def.e,n:def.n,who:who,pts:pts,freq:taskFreq,start:start,wd:wd,c:{}});
      }
      closeModal('task');
      showToast('"'+def.n+'" creada para '+who,'tl');
      renderAll();
    });
  } else {
    tasks.push({id:'t'+Date.now(),e:def.e,n:def.n,who:who,pts:pts,freq:taskFreq,start:start,wd:wd,c:{}});
    closeModal('task');
    showToast('"'+def.n+'" creada para '+who,'tl');
    renderAll();
  }
});

// ══════════════════════════════════════════════════════
// REWARD MODAL — con persistencia en Supabase (nuevo)
// ══════════════════════════════════════════════════════
document.addEventListener('click',function(e){
  var btn=e.target.closest('[data-openrew]'); if(!btn) return;
  rewWho=btn.getAttribute('data-openrew');
  g('mr-title').textContent='// OBJETIVOS — '+(rewWho==='alba'?'ALBA':'SOFÍA');
  renderRewList();
  g('modal-reward').classList.add('open');
});

function renderRewList(){
  var el=g('mr-list');
  el.innerHTML=rewards[rewWho].length
    ?rewards[rewWho].map(function(r){
        return '<div class="rei"><span style="font-size:1rem;flex-shrink:0">'+r.e+'</span>'
          +'<div class="rei-info"><div class="rei-nm">'+r.n+'</div><div class="rei-pts">'+r.pts+' pts</div></div>'
          +'<button class="delbtn" data-delr="'+r.id+'">✕</button></div>';
      }).join('')
    :'<div style="font-size:.79rem;color:var(--muted);padding:4px 0">Sin objetivos aún</div>';
  el.querySelectorAll('[data-delr]').forEach(function(btn){
    btn.addEventListener('click',function(){
      var rid=btn.getAttribute('data-delr');
      deleteReward(rid); // FIX: persiste el borrado en Supabase
      rewards[rewWho]=rewards[rewWho].filter(function(r){ return String(r.id)!==String(rid); });
      renderRewList();
      renderAll();
      showToast('Objetivo eliminado','am');
    });
  });
}

g('mr-add').addEventListener('click', async function(){
  var e=g('mr-emoji').value.trim()||'🎯';
  var n=g('mr-name').value.trim();
  var p=parseInt(g('mr-pts').value)||100;
  if(!n){ showToast('Escribe un nombre para el objetivo','er'); return; }
  // FIX: persiste en Supabase y usa el ID real devuelto
  var newId = await saveReward(rewWho, e, n, p);
  var id = newId || ('r'+Date.now());
  rewards[rewWho].push({id:id, e:e, n:n, pts:p});
  g('mr-emoji').value=''; g('mr-name').value=''; g('mr-pts').value='';
  renderRewList();
  renderAll();
  showToast('Objetivo añadido ✓','gn');
});
g('mr-close').addEventListener('click',function(){ closeModal('reward'); });

// ══════════════════════════════════════════════════════
// CONFIG — con persistencia en Supabase (nuevo)
// ══════════════════════════════════════════════════════
function renderCfgTasks(){
  var el=g('cfg-tasks'); if(!el) return;
  el.innerHTML=taskDefs.map(function(t){
    return '<div class="cfgrow"><span style="font-size:1rem">'+t.e+'</span>'
      +'<span style="flex:1;font-size:.82rem;font-weight:600;margin:0 8px">'+t.n+'</span>'
      +'<button class="delbtn" data-deltd="'+t.id+'">✕</button></div>';
  }).join('');
  el.querySelectorAll('[data-deltd]').forEach(function(btn){
    btn.addEventListener('click',function(){
      var tid=btn.getAttribute('data-deltd');
      deleteTaskDef(tid); // FIX: persiste el borrado en Supabase
      taskDefs=taskDefs.filter(function(t){ return String(t.id)!==String(tid); });
      renderCfgTasks();
      showToast('Tarea eliminada del catálogo','am');
    });
  });
}

g('cfg-add-task').addEventListener('click', async function(){
  var e=g('cfg-emoji').value.trim()||'📋';
  var n=g('cfg-tname').value.trim();
  if(!n){ showToast('Escribe el nombre de la tarea','er'); return; }
  // FIX: persiste en Supabase y usa el ID real devuelto
  var newId = await saveTaskDef(e, n);
  var id = newId || ('td'+Date.now());
  taskDefs.push({id:id, e:e, n:n});
  g('cfg-emoji').value=''; g('cfg-tname').value='';
  renderCfgTasks();
  showToast('Tarea añadida al catálogo ✓','tl');
});

// PIN visibility toggles
function setupPinVis(visId,inpId){
  g(visId).addEventListener('click',function(){
    var inp=g(inpId);
    if(inp.type==='password'){ inp.type='text'; this.textContent='🙈'; }
    else{ inp.type='password'; this.textContent='👁'; }
  });
}
setupPinVis('vis-admin','cfg-pin-admin');
setupPinVis('vis-alba', 'cfg-pin-alba');
setupPinVis('vis-sofia','cfg-pin-sofia');

g('save-pins-btn').addEventListener('click',function(){
  var pa=g('cfg-pin-admin').value.trim();
  var pb=g('cfg-pin-alba').value.trim();
  var pc=g('cfg-pin-sofia').value.trim();
  var re=/^\d{4}$/;
  if(!re.test(pa)||!re.test(pb)||!re.test(pc)){
    showToast('Cada PIN debe tener exactamente 4 números','er'); return;
  }
  pins.admin=pa; pins.alba=pb; pins.sofia=pc;
  saveConfig();
  showToast('PINs guardados ✓','gn');
});

// ══════════════════════════════════════════════════════
// CALENDAR
// ══════════════════════════════════════════════════════
g('cal-prev').addEventListener('click',function(){
  calM--; if(calM<0){calM=11;calY--;} calSel=null;
  var d=g('cal-detail'); if(d) d.innerHTML='';
  buildCal();
});
g('cal-next').addEventListener('click',function(){
  calM++; if(calM>11){calM=0;calY++;} calSel=null;
  var d=g('cal-detail'); if(d) d.innerHTML='';
  buildCal();
});

function buildCal(){
  if(_calBuilding) return;
  _calBuilding=true;

  var lbl=g('cal-month-lbl'); if(!lbl){ _calBuilding=false; return; }
  lbl.textContent=MES[calM]+' '+calY;
  var grid=g('cal-grid'); if(!grid){ _calBuilding=false; return; }

  while(grid.firstChild) grid.removeChild(grid.firstChild);

  DIA.forEach(function(d){
    var el=document.createElement('div');
    el.className='cal-dow'; el.textContent=d; grid.appendChild(el);
  });

  var first=new Date(calY,calM,1);
  var startDow=(first.getDay()+6)%7;
  var dim=new Date(calY,calM+1,0).getDate();
  var prevDim=new Date(calY,calM,0).getDate();
  var todayStr=fd(today);

  for(var i=startDow-1;i>=0;i--){
    var el=document.createElement('div');
    el.className='cal-day other'; el.textContent=String(prevDim-i); grid.appendChild(el);
  }

  for(var day=1;day<=dim;day++){
    var ds=calY+'-'+p2(calM+1)+'-'+p2(day);
    var el=document.createElement('div');
    var cls='cal-day';
    if(ds===todayStr) cls+=' today';
    if(ds===calSel)   cls+=' sel';
    if(ds>todayStr)   cls+=' other';
    el.className=cls;

    var dh=hist.filter(function(h){ return h.date===ds; });
    var dp=pays.filter(function(pp){ return pp.date===ds; });
    if(dh.length||dp.length){
      var dotsEl=document.createElement('div'); dotsEl.className='cdots';
      if(dh.some(function(h){ return h.who==='Alba'&&h.type==='done'; })){
        var dd=document.createElement('div'); dd.className='cdot da'; dotsEl.appendChild(dd);
      }
      if(dh.some(function(h){ return h.who==='Sofía'&&h.type==='done'; })){
        var dd=document.createElement('div'); dd.className='cdot ds'; dotsEl.appendChild(dd);
      }
      if(dh.some(function(h){ return h.type==='missed'; })){
        var dd=document.createElement('div'); dd.className='cdot dm'; dotsEl.appendChild(dd);
      }
      if(dp.length){
        var dd=document.createElement('div'); dd.className='cdot dp'; dotsEl.appendChild(dd);
      }
      el.appendChild(dotsEl);
    }
    el.appendChild(document.createTextNode(String(day)));

    (function(dateStr){
      el.addEventListener('click',function(){
        if(dateStr>todayStr) return;
        calSel=dateStr; buildCal(); showDayDetail(dateStr);
      });
    })(ds);

    grid.appendChild(el);
  }

  var total=startDow+dim, rem=total%7===0?0:7-(total%7);
  for(var j=1;j<=rem;j++){
    var el=document.createElement('div');
    el.className='cal-day other'; el.textContent=String(j); grid.appendChild(el);
  }

  _calBuilding=false;
  if(calSel) showDayDetail(calSel);
}

function showDayDetail(ds){
  var det=g('cal-detail'); if(!det) return;
  var dh=hist.filter(function(h){ return h.date===ds; });
  var dp=pays.filter(function(pp){ return pp.date===ds; });
  if(!dh.length&&!dp.length){
    det.innerHTML='<div class="cal-detail"><div class="cal-dtitle">'+ds+'</div>'
      +'<div style="font-size:.79rem;color:var(--muted)">Sin actividad este día</div></div>';
    return;
  }
  var rows=dh.map(function(h){
    var wc=h.who==='Alba'?'twa':'tws';
    var badge=h.type==='done'
      ?'<span class="tpts">+'+h.pts+'</span>'
      :'<span class="badge" style="background:var(--redL);color:var(--red);border:1px solid rgba(192,57,43,.2)">No hecha</span>';
    return '<div class="cal-ev"><span>'+h.e+'</span>'
      +'<div class="cal-evname">'+h.n+'</div>'
      +'<span class="'+wc+'" style="font-size:.66rem;font-weight:700">'+h.who+'</span>'
      +badge+'</div>';
  }).join('');
  var prows=dp.map(function(pp){
    return '<div class="cal-ev"><span>💶</span>'
      +'<div class="cal-evname">Propina pagada</div>'
      +'<span style="font-size:.66rem;font-weight:700;color:var(--amber)">'+pp.who+'</span>'
      +'<span class="tpts" style="color:var(--green);background:var(--greenL);border:1px solid rgba(10,138,95,.2)">€'+pp.eur.toFixed(2)+'</span></div>';
  }).join('');
  det.innerHTML='<div class="cal-detail"><div class="cal-dtitle">'+ds+'</div>'+rows+prows+'</div>';
}

function renderPays(){
  var el=g('pays-list'); if(!el) return;
  if(!pays.length){ el.innerHTML='<div class="empty"><span class="emo">💶</span><p>Aún no hay pagos registrados</p></div>'; return; }
  el.innerHTML=pays.slice().reverse().map(function(pp){
    var wc=pp.who==='Alba'?'twa':'tws';
    return '<div class="tcard" style="margin-bottom:6px">'
      +'<div class="tico">💶</div>'
      +'<div class="tinfo"><div class="tnm">Propina — '+pp.who+'</div>'
      +'<div class="tmeta '+wc+'">'+pp.date+'</div></div>'
      +'<div style="font-family:\'Space Mono\',monospace;font-size:.75rem;color:var(--amber);font-weight:700">-'+pp.pts+' pts</div>'
      +'<span class="tpts" style="color:var(--green);background:var(--greenL);border:1px solid rgba(10,138,95,.2)">€'+pp.eur.toFixed(2)+'</span></div>';
  }).join('');
}

// ══════════════════════════════════════════════════════
// MODALS
// ══════════════════════════════════════════════════════
function closeModal(type){ g('modal-'+type).classList.remove('open'); renderAll(); }
document.querySelectorAll('.mov').forEach(function(ov){
  ov.addEventListener('click',function(e){ if(e.target===ov){ ov.classList.remove('open'); renderAll(); } });
});

// ══════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════
var toastT;
function showToast(msg,cls){
  var t=g('toast'); if(!t) return;
  t.textContent=msg; t.className='toast show'+(cls?' '+cls:'');
  clearTimeout(toastT); toastT=setTimeout(function(){ t.classList.remove('show'); },3000);
}

// ══════════════════════════════════════════════════════
// BOOT — loadAll() se llama tras login exitoso (enterApp)
// ══════════════════════════════════════════════════════
});
