import { useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx";

// ── Fonts ──────────────────────────────────────────────
const fl=document.createElement('link'); fl.rel='stylesheet';
fl.href='https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Barlow+Condensed:wght@600;700;800&family=Inter:wght@400;500;600&display=swap';
document.head.appendChild(fl);

// ── Atlas Design tokens (brand colors from screenshot) ──
const C={
  bg:'#1a1a1a',
  surface:'#222222',
  surface2:'#2a2a2a',
  border:'#333333',
  border2:'#3d3d3d',
  // Atlas brand oranges
  orange:'#E8590C',       // primary orange
  orangeLight:'#FF6B1A',
  orangeDim:'#a03d06',
  orangeMuted:'#3d1a03',
  amber:'#F5A623',        // secondary amber/gold
  amberDim:'#b07318',
  amberMuted:'#3d2a06',
  // Status
  green:'#4CAF50',
  greenDim:'#2e7031',
  greenMuted:'#0f2e10',
  red:'#f44336',
  blue:'#4da6ff',
  text:'#f0f0f0',
  text2:'#b0b0b0',
  text3:'#666666',
};
const mono="'DM Mono',monospace";
const disp="'Barlow Condensed',sans-serif";
const sans="'Inter',sans-serif";

// ── Country map ────────────────────────────────────────
const CMAP={CL:'🇨🇱 Chile',MX:'🇲🇽 México',BR:'🇧🇷 Brasil',CO:'🇨🇴 Colombia',ES:'🇪🇸 España',UY:'🇺🇾 Uruguay',US:'🇺🇸 USA',PE:'🇵🇪 Perú',AR:'🇦🇷 Argentina'};
const cc=(co)=>String(co||'').substring(0,2).toUpperCase();
const country=(co)=>CMAP[cc(co)]||cc(co)||'??';

// ── Field resolver ─────────────────────────────────────
const FMAP={bc:'BC',businesscategory:'BC',business_category:'BC',
  costcenter:'COSTCENTER',cost_center:'COSTCENTER',cc:'COSTCENTER',
  account:'ACCOUNT',company:'COMPANY',source:'SOURCE',category:'CATEGORY',
  project:'PROJECT',intercompany:'INTERCOMPANY',ic:'INTERCOMPANY',
  description:'DESCRIPTION',desc:'DESCRIPTION',
  debit:'ENT_DEBIT',ent_debit:'ENT_DEBIT',credit:'ENT_CREDIT',ent_credit:'ENT_CREDIT',
  acc_debit:'ACC_DEBIT',acc_credit:'ACC_CREDIT',
  currency:'CURRENCY_CODE',ccy:'CURRENCY_CODE',ledger:'LEDGER',
  journal:'JOURNAL_NAME',journal_name:'JOURNAL_NAME',status:'STATUS'};
const resolveF=(f)=>FMAP[(f||'').toLowerCase().trim()]||f||'';

const rowVal=(row,f)=>{
  const col=resolveF(f);
  const v=row[col];
  if(col==='ACCOUNT'){const n=Number(v);return isNaN(n)?String(v||''):String(Math.round(n));}
  return String(v==null?'':v).trim();
};

const evalOp=(rv,op,cv)=>{
  const r=rv.toLowerCase(),c=(cv||'').toLowerCase().trim();
  const n=Number(rv),cn=Number(cv);
  switch((op||'').toLowerCase().replace(/\s+/g,'_')){
    case '=': case 'eq': case 'equals': case 'equals_to': return r===c;
    case '!=': case 'ne': case 'not_equals': case 'not_equals_to': return r!==c;
    case 'starts_with': return rv.startsWith(cv);
    case 'not_starts_with': return !rv.startsWith(cv);
    case 'starts_with_any': return cv.split(',').some(p=>rv.startsWith(p.trim()));
    case 'ends_with': return rv.endsWith(cv);
    case 'contains': return r.includes(c);
    case 'not_contains': return !r.includes(c);
    case 'is_empty': return !rv||rv===''||rv==='0'||rv==='00000'||rv==='000000'||rv==='zzzzz';
    case 'is_not_empty': return rv&&rv!==''&&rv!=='0'&&rv!=='00000'&&rv!=='000000'&&rv!=='zzzzz';
    case '>': return !isNaN(n)&&n>cn;
    case '<': return !isNaN(n)&&n<cn;
    case '>=': return !isNaN(n)&&n>=cn;
    case '<=': return !isNaN(n)&&n<=cn;
    case 'in': return cv.split(',').map(v=>v.trim().toLowerCase()).includes(r);
    case 'not_in': return !cv.split(',').map(v=>v.trim().toLowerCase()).includes(r);
    case 'always_fail': return false;
    default: return r===c;
  }
};

const evalChain=(row,conds)=>{
  if(!conds||!conds.length) return true;
  let res=evalOp(rowVal(row,conds[0].field),conds[0].op,conds[0].value||'');
  for(let i=1;i<conds.length;i++){
    const c=conds[i],nx=evalOp(rowVal(row,c.field),c.op,c.value||'');
    res=(c.logic||'AND').toUpperCase()==='OR'?res||nx:res&&nx;
  }
  return res;
};

// ── Built-in rules ────────────────────────────────────
const BUILTIN=[
  {id:'GR.01',cat:'Compliance',risk:'high',source:'builtin',
   desc:'CC obligatorio: BC=SGA/OPP/COM + cuenta 6xxx',
   conditions:[{field:'BC',op:'in',value:'SGA,OPP,COM'},{logic:'AND',field:'ACCOUNT',op:'starts_with',value:'6'}],
   validation:{field:'COSTCENTER',op:'!=',value:'000000'},
   errorMsg:'GR.01 Mandatory Cost Center for SGA OPP COM'},
  {id:'GR.02',cat:'Compliance',risk:'high',source:'builtin',
   desc:'BC=SGA/COM + cuenta 5xxx requiere CC',
   conditions:[{field:'BC',op:'in',value:'SGA,COM'},{logic:'AND',field:'ACCOUNT',op:'starts_with',value:'5'}],
   validation:{field:'COSTCENTER',op:'!=',value:'000000'},
   errorMsg:'GR.02 CC mandatory for SGA/COM expense accounts'},
  {id:'GR.03',cat:'Compliance',risk:'high',source:'builtin',
   desc:'Asientos manuales (Spreadsheet) requieren descripción',
   conditions:[{field:'SOURCE',op:'=',value:'Spreadsheet'}],
   validation:{field:'DESCRIPTION',op:'is_not_empty',value:''},
   errorMsg:'GR.03 Manual entry missing description'},
  {id:'GR.04',cat:'Compliance',risk:'medium',source:'builtin',
   desc:'BC=OPP/CON/DEV + cuenta 5xxx requiere Proyecto ≠ 00000',
   conditions:[{field:'BC',op:'in',value:'OPP,CON,DEV'},{logic:'AND',field:'ACCOUNT',op:'starts_with',value:'5'}],
   validation:{field:'PROJECT',op:'not_in',value:'00000,ZZZZZ'},
   errorMsg:'GR.04 Project required for OPP/CON/DEV expense'},
  {id:'GR.05',cat:'Compliance',risk:'medium',source:'builtin',
   desc:'Cuentas ingreso (4xxx) requieren CC ≠ 000000',
   conditions:[{field:'ACCOUNT',op:'starts_with',value:'4'}],
   validation:{field:'COSTCENTER',op:'!=',value:'000000'},
   errorMsg:'GR.05 CC required for revenue accounts (4xxx)'},
  {id:'GR.06',cat:'Compliance',risk:'medium',source:'builtin',
   desc:'Cuenta IC (117xxx) debe tener código Intercompañía',
   conditions:[{field:'ACCOUNT',op:'starts_with',value:'117'}],
   validation:{field:'INTERCOMPANY',op:'!=',value:'00000'},
   errorMsg:'GR.06 IC receivable must have Intercompany entity'},
  {id:'GR.07',cat:'Compliance',risk:'low',source:'builtin',
   desc:'BC=ZZZ solo en cuentas eliminación (9xxx)',
   conditions:[{field:'BC',op:'=',value:'ZZZ'}],
   validation:{field:'ACCOUNT',op:'starts_with',value:'9'},
   errorMsg:'GR.07 BC=ZZZ only valid for 9xxx elimination accounts'},
  {id:'CL.01',cat:'Cierre',risk:'high',source:'builtin',
   desc:'Asientos manuales: si débito=0 entonces crédito debe ser >0',
   conditions:[{field:'SOURCE',op:'=',value:'Spreadsheet'},{logic:'AND',field:'ENT_DEBIT',op:'=',value:'0'}],
   validation:{field:'ENT_CREDIT',op:'>',value:'0'},
   errorMsg:'CL.01 Manual entry with zero debit and zero credit'},
  {id:'CL.02',cat:'Cierre',risk:'medium',source:'builtin',
   desc:'Provisiones deben tener BC asignado (≠ 000)',
   conditions:[{field:'CATEGORY',op:'contains',value:'Provision'}],
   validation:{field:'BC',op:'!=',value:'000'},
   errorMsg:'CL.02 Provision entry must have BC ≠ 000'},
  {id:'CL.03',cat:'Cierre',risk:'high',source:'builtin',
   desc:'Asientos manuales >1M USD deben tener descripción',
   conditions:[{field:'SOURCE',op:'=',value:'Spreadsheet'},{logic:'AND',field:'ACC_DEBIT',op:'>',value:'1000000'}],
   validation:{field:'DESCRIPTION',op:'is_not_empty',value:''},
   errorMsg:'CL.03 High-value manual entry requires description'},
  {id:'CL.04',cat:'Cierre',risk:'medium',source:'builtin',
   desc:'Revaluaciones solo en cuentas BS (1xxx o 2xxx)',
   conditions:[{field:'CATEGORY',op:'=',value:'Revaluation'}],
   validation:{field:'ACCOUNT',op:'starts_with_any',value:'1,2'},
   errorMsg:'CL.04 Revaluation must hit BS accounts (1xxx or 2xxx)'},
  {id:'CL.05',cat:'Cierre',risk:'medium',source:'builtin',
   desc:'Ajustes (Adjustment) deben tener BC ≠ 000',
   conditions:[{field:'CATEGORY',op:'=',value:'Adjustment'}],
   validation:{field:'BC',op:'!=',value:'000'},
   errorMsg:'CL.05 Adjustment must have a BC category'},
  {id:'INT.01',cat:'Integridad',risk:'high',source:'builtin',
   desc:'ENT_DEBIT negativo — importe incorrecto',
   conditions:[{field:'ENT_DEBIT',op:'<',value:'0'}],
   validation:{field:'SOURCE',op:'=',value:'__NEVER__'},
   errorMsg:'INT.01 Negative debit amount detected'},
  {id:'INT.02',cat:'Integridad',risk:'high',source:'builtin',
   desc:'ENT_CREDIT negativo — importe incorrecto',
   conditions:[{field:'ENT_CREDIT',op:'<',value:'0'}],
   validation:{field:'SOURCE',op:'=',value:'__NEVER__'},
   errorMsg:'INT.02 Negative credit amount detected'},
  {id:'INT.03',cat:'Integridad',risk:'high',source:'builtin',
   desc:'Líneas sin ACCOUNTING_DATE',
   conditions:[{field:'ACCOUNTING_DATE',op:'is_empty',value:''}],
   validation:{field:'SOURCE',op:'=',value:'__NEVER__'},
   errorMsg:'INT.03 Missing accounting date'},
  {id:'INT.04',cat:'Integridad',risk:'medium',source:'builtin',
   desc:'BC=000 en cuentas gasto (6xxx) — falta categorización',
   conditions:[{field:'BC',op:'=',value:'000'},{logic:'AND',field:'ACCOUNT',op:'starts_with',value:'6'}],
   validation:{field:'BC',op:'=',value:'__NEVER__'},
   errorMsg:'INT.04 Account 6xxx must have a BC != 000'},
];

// ── Run all rules, store ALL violations (not just sample) ─
const runRules=(rows,rules)=>{
  const codes=[...new Set(rows.map(r=>cc(r.COMPANY)).filter(Boolean))].sort();
  return rules.filter(r=>r.active!==false).map(rule=>{
    const matching=rows.filter(r=>evalChain(r,rule.conditions));
    const allViolations=matching.filter(r=>!evalOp(rowVal(r,rule.validation.field),rule.validation.op,rule.validation.value||''));
    // Compute total amount of violations (debit+credit)
    const totalAmt=allViolations.reduce((s,r)=>{
      const d=parseFloat(r.ENT_DEBIT||r.ACC_DEBIT||0)||0;
      const cr=parseFloat(r.ENT_CREDIT||r.ACC_CREDIT||0)||0;
      return s+Math.max(d,cr);
    },0);
    const byCountry={};
    codes.forEach(c=>{
      const cm=matching.filter(r=>cc(r.COMPANY)===c);
      const cv=allViolations.filter(r=>cc(r.COMPANY)===c);
      const amt=cv.reduce((s,r)=>{
        const d=parseFloat(r.ENT_DEBIT||r.ACC_DEBIT||0)||0;
        const cr=parseFloat(r.ENT_CREDIT||r.ACC_CREDIT||0)||0;
        return s+Math.max(d,cr);
      },0);
      byCountry[c]={m:cm.length,v:cv.length,amt,pct:cm.length>0?Math.round(cv.length/cm.length*100):null};
    });
    const pct=matching.length>0?Math.round(allViolations.length/matching.length*100):0;
    return{...rule,matching:matching.length,violations:allViolations.length,pct,totalAmt,
      status:allViolations.length===0?'pass':pct<10?'warn':'fail',
      byCountry,allViolations};
  });
};

// ── Parse custom rules from Excel ────────────────────
const parseCustomRules=(excelRows)=>{
  return excelRows.filter(r=>r.RULE_ID||r.rule_id).map(r=>{
    const get=(k)=>String(r[k]||r[k?.toLowerCase()]||'').trim();
    const conditions=[];
    for(let i=1;i<=4;i++){
      const f=get(`IF_FIELD_${i}`)||get(`if_field_${i}`);
      const op=get(`IF_OP_${i}`)||get(`if_op_${i}`);
      const val=get(`IF_VALUE_${i}`)||get(`if_value_${i}`);
      const logic=get(`IF_LOGIC_${i}`)||get(`if_logic_${i}`)||'AND';
      if(f&&op) conditions.push(i===1?{field:resolveF(f),op,value:val}:{logic,field:resolveF(f),op,value:val});
    }
    return{
      id:get('RULE_ID')||get('rule_id'),
      cat:get('CATEGORY')||get('category')||'Custom',
      desc:get('DESCRIPTION')||get('description'),
      risk:(get('RISK')||get('risk')||'medium').toLowerCase(),
      source:'custom', active:true,
      conditions,
      validation:{field:resolveF(get('THEN_FIELD')||get('then_field')),
        op:get('THEN_OP')||get('then_op')||'!=',
        value:get('THEN_VALUE')||get('then_value')},
      errorMsg:get('ERROR_MSG')||get('error_msg'),
    };
  }).filter(r=>r.id&&r.conditions.length>0);
};

const downloadTemplate=()=>{
  const headers=['RULE_ID','CATEGORY','DESCRIPTION','RISK','IF_FIELD_1','IF_OP_1','IF_VALUE_1','IF_LOGIC_2','IF_FIELD_2','IF_OP_2','IF_VALUE_2','IF_LOGIC_3','IF_FIELD_3','IF_OP_3','IF_VALUE_3','THEN_FIELD','THEN_OP','THEN_VALUE','ERROR_MSG'];
  const sample=[
    ['GR.01','Compliance','Mandatory CC for SGA OPP COM accounts 6xxx','high','BC','in','SGA,OPP,COM','AND','ACCOUNT','starts_with','6','','','','','COSTCENTER','!=','000000','GR.01 CC mandatory'],
    ['GR.02','Compliance','Manual entries require description','high','SOURCE','=','Spreadsheet','','','','','','','','','DESCRIPTION','is_not_empty','','GR.02 Missing description'],
    ['GR.03','Cierre','Provisions must have BC','medium','CATEGORY','contains','Provision','','','','','','','','','BC','!=','000','GR.03 Provision needs BC'],
  ];
  const ws=XLSX.utils.aoa_to_sheet([headers,...sample]);
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'Rules');
  XLSX.writeFile(wb,'atlas_crossval_rules_template.xlsx');
};

// ── Export violations for a single rule ──────────────
const exportRuleViolations=(rule,period)=>{
  if(!rule.allViolations?.length) return;
  const keys=['COMPANY','BATCH_NAME','JOURNAL_NAME','ACCOUNT','BC','COSTCENTER','PROJECT','SOURCE','DESCRIPTION','ENT_DEBIT','ENT_CREDIT','ACC_DEBIT','ACC_CREDIT','CURRENCY_CODE','ACCOUNTING_DATE'];
  const rows=rule.allViolations.map(r=>{
    const obj={};
    keys.forEach(k=>obj[k]=r[k]||'');
    obj['ERROR_MSG']=rule.errorMsg||rule.id;
    return obj;
  });
  const ws=XLSX.utils.json_to_sheet(rows);
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'Violations');
  XLSX.writeFile(wb,`atlas_violations_${rule.id}_${period.replace('-','_')}.xlsx`);
};

// ── Export all violations for accounting manager ──────
const exportAllViolations=(results,period,countryFilter=null)=>{
  const rows=[];
  results.forEach(rule=>{
    if(!rule.allViolations?.length) return;
    rule.allViolations.forEach(r=>{
      if(countryFilter && cc(r.COMPANY)!==countryFilter) return;
      rows.push({
        RULE_ID:rule.id, CATEGORY:rule.cat, RISK:rule.risk.toUpperCase(),
        ERROR_MSG:rule.errorMsg||rule.id,
        COMPANY:r.COMPANY||'', BATCH_NAME:r.BATCH_NAME||'', JOURNAL_NAME:r.JOURNAL_NAME||'',
        ACCOUNT:r.ACCOUNT||'', BC:r.BC||'', COSTCENTER:r.COSTCENTER||'', PROJECT:r.PROJECT||'',
        SOURCE:r.SOURCE||'', DESCRIPTION:r.DESCRIPTION||'',
        ENT_DEBIT:r.ENT_DEBIT||'', ENT_CREDIT:r.ENT_CREDIT||'',
        ACC_DEBIT:r.ACC_DEBIT||'', ACC_CREDIT:r.ACC_CREDIT||'',
        CURRENCY_CODE:r.CURRENCY_CODE||'', ACCOUNTING_DATE:r.ACCOUNTING_DATE||'',
      });
    });
  });
  if(!rows.length){alert('Sin violaciones para exportar.');return;}
  const ws=XLSX.utils.json_to_sheet(rows);
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'All Violations');
  XLSX.writeFile(wb,`atlas_all_violations_${period.replace('-','_')}${countryFilter?'_'+countryFilter:''}.xlsx`);
};

// ── Helpers ────────────────────────────────────────────
const fmtAmt=(n)=>{
  if(!n||n===0) return '—';
  if(n>=1000000) return (n/1000000).toFixed(1)+'M';
  if(n>=1000) return (n/1000).toFixed(0)+'K';
  return n.toFixed(0);
};

const ST={
  pass:{bg:'rgba(76,175,80,0.08)',bord:'rgba(76,175,80,0.3)',col:'#4CAF50',lbl:'✓ PASS'},
  warn:{bg:'rgba(245,166,35,0.10)',bord:'rgba(245,166,35,0.35)',col:'#F5A623',lbl:'⚠ WARN'},
  fail:{bg:'rgba(244,67,54,0.10)',bord:'rgba(244,67,54,0.35)',col:'#f44336',lbl:'✕ FAIL'},
  info:{bg:'rgba(77,166,255,0.08)',bord:'rgba(77,166,255,0.3)',col:'#4da6ff',lbl:'ℹ INFO'},
};
const RC={high:C.red,medium:C.amber,low:C.green};

const cellColor=(v,m)=>{
  if(m===0||v===null) return{bg:'rgba(255,255,255,0.02)',col:C.text3,txt:'—'};
  if(v===0) return{bg:'rgba(76,175,80,0.12)',col:'#4CAF50',txt:'✓'};
  const pct=m>0?v/m:0;
  if(pct<0.05) return{bg:'rgba(245,166,35,0.18)',col:'#F5A623',txt:v};
  return{bg:'rgba(244,67,54,0.18)',col:'#f44336',txt:v};
};

const OPS=['=','!=','starts_with','not_starts_with','starts_with_any','contains','not_contains','is_empty','is_not_empty','>','<','>=','<=','in','not_in'];
const FIELDS=['BC','ACCOUNT','COSTCENTER','COMPANY','SOURCE','CATEGORY','PROJECT','INTERCOMPANY','DESCRIPTION','ENT_DEBIT','ENT_CREDIT','ACC_DEBIT','ACC_CREDIT','CURRENCY_CODE','LEDGER','JOURNAL_NAME','STATUS'];

// ── Main Component ──────────────────────────────────────
export default function AtlasComplianceV4(){
  const [step,setStep]=useState(0);
  const [rawRows,setRawRows]=useState([]);
  const [fileInfo,setFileInfo]=useState(null);
  const [rules,setRules]=useState(BUILTIN.map(r=>({...r,active:true})));
  const [results,setResults]=useState(null);
  const [countryCodes,setCountryCodes]=useState([]);
  const [resTab,setResTab]=useState('rule');
  const [filterCat,setFilterCat]=useState('all');
  const [aiText,setAiText]=useState('');
  const [aiLoading,setAiLoading]=useState(false);
  const [loading,setLoading]=useState(false);
  const [loadMsg,setLoadMsg]=useState('');
  const [dragGl,setDragGl]=useState(false);
  const [dragRules,setDragRules]=useState(false);
  const [period,setPeriod]=useState('Apr-2026');
  const [reviewer,setReviewer]=useState('');
  const [showAddRule,setShowAddRule]=useState(false);
  const [newRule,setNewRule]=useState({id:'',cat:'Compliance',desc:'',risk:'high',
    conditions:[{field:'BC',op:'=',value:''}],validation:{field:'COSTCENTER',op:'!=',value:'000000'},errorMsg:''});
  // drill-down state: which rule is expanded
  const [expandedRule,setExpandedRule]=useState(null);
  // heatmap view: 'count' | 'amount' | 'pct'
  const [heatMode,setHeatMode]=useState('count');
  const glRef=useRef(), rulesRef=useRef();

  // ── Shared styles ─────────────────────────────────
  const card={background:C.surface,border:`1px solid ${C.border2}`,borderRadius:10,padding:'18px 22px'};
  const inp={background:C.surface2,border:`1px solid ${C.border2}`,color:C.text,fontFamily:mono,fontSize:12,padding:'7px 11px',borderRadius:6,outline:'none'};
  const btn=(p=false,sm=false)=>({display:'inline-flex',alignItems:'center',gap:6,
    padding:sm?'5px 12px':'9px 18px',borderRadius:6,fontFamily:mono,fontSize:sm?10:12,
    cursor:'pointer',letterSpacing:'0.04em',transition:'all 0.15s',
    border:`1px solid ${p?C.orangeDim:C.border2}`,
    background:p?C.orangeMuted:C.surface,
    color:p?C.orange:C.text2});
  const btnOrange={display:'inline-flex',alignItems:'center',gap:6,padding:'10px 22px',
    borderRadius:6,fontFamily:mono,fontSize:13,cursor:'pointer',letterSpacing:'0.05em',
    border:'none',background:`linear-gradient(135deg,${C.orange},${C.orangeLight})`,
    color:'#fff',fontWeight:600};

  // ── Parse GL Excel ────────────────────────────────
  const parseGL=useCallback((file)=>{
    setLoading(true); setLoadMsg('Leyendo Excel...');
    const reader=new FileReader();
    reader.onload=e=>{
      try{
        const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array',raw:true});
        const ws=wb.Sheets[wb.SheetNames[0]];
        setLoadMsg('Convirtiendo filas...');
        const rows=XLSX.utils.sheet_to_json(ws,{defval:''});
        const cos=[...new Set(rows.map(r=>cc(r.COMPANY||r.company||'')).filter(Boolean))].sort();
        setRawRows(rows); setCountryCodes(cos);
        setFileInfo({name:file.name,rows:rows.length,sheet:wb.SheetNames[0]});
        setLoading(false); setStep(1);
      }catch(e){setLoading(false);alert('Error: '+e.message);}
    };
    reader.readAsArrayBuffer(file);
  },[]);

  const parseRulesFile=useCallback((file)=>{
    const reader=new FileReader();
    reader.onload=e=>{
      const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array'});
      const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});
      const custom=parseCustomRules(rows);
      if(custom.length===0){alert('No se encontraron reglas válidas.');return;}
      setRules(prev=>[...prev.filter(r=>r.source!=='custom'),...custom.map(r=>({...r,active:true}))]);
      alert(`✓ ${custom.length} reglas personalizadas cargadas`);
    };
    reader.readAsArrayBuffer(file);
  },[]);

  const runValidation=()=>{
    setLoading(true); setLoadMsg('Ejecutando '+rules.filter(r=>r.active!==false).length+' reglas...');
    setTimeout(()=>{
      const res=runRules(rawRows,rules);
      setResults(res); setLoading(false); setStep(2);
    },50);
  };

  const addRule=()=>{
    if(!newRule.id||!newRule.desc){alert('Completa ID y descripción');return;}
    setRules(prev=>[...prev,{...newRule,source:'custom',active:true}]);
    setNewRule({id:'',cat:'Compliance',desc:'',risk:'high',
      conditions:[{field:'BC',op:'=',value:''}],validation:{field:'COSTCENTER',op:'!=',value:'000000'},errorMsg:''});
    setShowAddRule(false);
  };

  const callAI=async()=>{
    if(!results) return; setAiLoading(true); setAiText('');
    const top=results.filter(r=>r.status==='fail'||r.status==='warn').slice(0,10);
    const byCountry=countryCodes.map(c=>{
      const fails=results.filter(r=>r.byCountry[c]?.v>0);
      const totalLines=results.reduce((s,r)=>s+(r.byCountry[c]?.m||0),0);
      const violLines=results.reduce((s,r)=>s+(r.byCountry[c]?.v||0),0);
      const compliancePct=totalLines>0?Math.round((1-violLines/totalLines)*100):100;
      return `${CMAP[c]||c}: ${compliancePct}% compliance, ${fails.length} reglas con violaciones`;
    }).join(' | ');
    const summary=top.map(r=>`[${r.status.toUpperCase()}] ${r.id} — ${r.desc}: ${r.violations} violaciones de ${r.matching} (${r.pct}%), Monto: ${fmtAmt(r.totalAmt)}`).join('\n');
    const prompt=`Eres Controller de Atlas Renewable Energy. Analiza los resultados de cross-validation del GL Mayor — ${period}.

RESUMEN POR PAÍS: ${byCountry}

REGLAS CON PROBLEMAS:
${summary}

Total reglas ejecutadas: ${results.length} | PASS: ${results.filter(r=>r.status==='pass').length} | WARN: ${results.filter(r=>r.status==='warn').length} | FAIL: ${results.filter(r=>r.status==='fail').length}

Genera reporte ejecutivo en español con:
1. RESUMEN EJECUTIVO (estado por país, compliance score)
2. HALLAZGOS CRÍTICOS (top 4 con cifras exactas y montos)
3. ANÁLISIS POR PAÍS (¿qué país tiene mayor riesgo y por qué?)
4. ACCIONES INMEDIATAS (5 acciones concretas, asignadas por rol al Accounting Manager)
5. RECOMENDACIÓN DE SIGN-OFF (¿proceder al cierre o hay bloqueos?)`;
    try{
      const res=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1400,messages:[{role:'user',content:prompt}]})});
      const data=await res.json();
      setAiText(data.content?.map(b=>b.text||'').join('')||'Sin respuesta.');
    }catch{setAiText('Error de conexión con la API.');}
    setAiLoading(false);
  };

  const exportCSV=()=>{
    if(!results) return;
    const h='ID,Categoria,Descripcion,Riesgo,Estado,Matching,Violaciones,Pct,Monto_Violaciones,'+countryCodes.join(',')+'\n';
    const r=results.map(r=>`"${r.id}","${r.cat}","${r.desc}","${r.risk}","${r.status}",${r.matching},${r.violations},${r.pct}%,${r.totalAmt?.toFixed(0)||0},${countryCodes.map(c=>r.byCountry[c]?.v??0).join(',')}`).join('\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([h+r],{type:'text/csv'}));
    a.download=`atlas_xval_${period.replace('-','_')}.csv`; a.click();
  };

  const stats=results?{pass:results.filter(r=>r.status==='pass').length,warn:results.filter(r=>r.status==='warn').length,fail:results.filter(r=>r.status==='fail').length,total:results.length}:null;
  const allCats=results?['all',...new Set(results.map(r=>r.cat))]:[];
  const filteredRes=results?.filter(r=>filterCat==='all'||r.cat===filterCat)||[];

  // Compute global compliance score
  const globalCompliance=results?()=>{
    const totalLines=results.reduce((s,r)=>s+r.matching,0);
    const violLines=results.reduce((s,r)=>s+r.violations,0);
    return totalLines>0?Math.round((1-violLines/totalLines)*100):100;
  }():null;

  // Per-country compliance
  const countryCompliance=(c)=>{
    if(!results) return null;
    const totalLines=results.reduce((s,r)=>s+(r.byCountry[c]?.m||0),0);
    const violLines=results.reduce((s,r)=>s+(r.byCountry[c]?.v||0),0);
    return totalLines>0?Math.round((1-violLines/totalLines)*100):100;
  };

  const BG={minHeight:'100vh',background:C.bg,color:C.text,fontFamily:sans,
    backgroundImage:`radial-gradient(circle at 20% 20%, rgba(232,89,12,0.04) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(245,166,35,0.03) 0%, transparent 50%)`};

  return(
  <div style={BG}>
    <style>{`
      *{box-sizing:border-box}
      select,input,textarea,button{font-family:inherit}
      ::-webkit-scrollbar{width:5px;height:5px}
      ::-webkit-scrollbar-track{background:#1a1a1a}
      ::-webkit-scrollbar-thumb{background:#444;border-radius:3px}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
      @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
      @keyframes spin{to{transform:rotate(360deg)}}
      .rule-row:hover{background:rgba(232,89,12,0.04)!important}
      .expand-btn:hover{color:#E8590C!important}
      .hm-cell:hover{filter:brightness(1.2);cursor:pointer}
    `}</style>

    {/* ── HEADER ── */}
    <div style={{background:'#111',borderBottom:`2px solid ${C.orange}`,marginBottom:0}}>
      <div style={{maxWidth:1340,margin:'0 auto',padding:'0 20px',display:'flex',alignItems:'stretch',justifyContent:'space-between',gap:12,flexWrap:'wrap'}}>
        {/* Logo area */}
        <div style={{display:'flex',alignItems:'center',gap:14,padding:'14px 0'}}>
          <div style={{width:44,height:44,background:`linear-gradient(135deg,${C.orange},${C.amber})`,borderRadius:8,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,flexShrink:0}}>⚡</div>
          <div>
            <div style={{fontFamily:disp,fontSize:18,fontWeight:800,letterSpacing:'0.1em',textTransform:'uppercase',background:`linear-gradient(90deg,${C.orange},${C.amber})`,WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent'}}>Atlas Renewable Energy</div>
            <div style={{fontFamily:mono,fontSize:10,color:C.text3,letterSpacing:'0.05em'}}>GL Cross-Validation Engine · v4.0 · Oracle ERP · By Country</div>
          </div>
        </div>
        {/* Right controls */}
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',padding:'10px 0'}}>
          {fileInfo&&(
            <span style={{fontFamily:mono,fontSize:10,color:C.text3,background:C.surface2,border:`1px solid ${C.border2}`,padding:'4px 10px',borderRadius:5}}>
              📁 {fileInfo.name} · {fileInfo.rows?.toLocaleString()} filas
            </span>
          )}
          {results&&(
            <div style={{background:`linear-gradient(135deg,${C.orangeMuted},${C.amberMuted})`,border:`1px solid ${C.orangeDim}`,borderRadius:8,padding:'5px 14px',display:'flex',flexDirection:'column',alignItems:'center'}}>
              <div style={{fontFamily:mono,fontSize:9,color:C.amber,textTransform:'uppercase',letterSpacing:'0.1em'}}>Compliance Global</div>
              <div style={{fontFamily:disp,fontSize:22,fontWeight:800,color:globalCompliance()>=90?C.green:globalCompliance()>=70?C.amber:C.red,lineHeight:1}}>{globalCompliance()}%</div>
            </div>
          )}
          <select value={period} onChange={e=>setPeriod(e.target.value)} style={{...inp,padding:'5px 10px',width:'auto'}}>
            {['Apr-2026','Mar-2026','Feb-2026','Jan-2026','Q1-2026'].map(p=><option key={p}>{p}</option>)}
          </select>
          <input value={reviewer} onChange={e=>setReviewer(e.target.value)} placeholder="Revisor..." style={{...inp,width:130}}/>
        </div>
      </div>
    </div>

    <div style={{maxWidth:1340,margin:'0 auto',padding:'20px 20px 80px'}}>

      {/* ── STEPS ── */}
      <div style={{display:'flex',gap:3,marginBottom:20,overflowX:'auto'}}>
        {['① Cargar GL','② Reglas CV','③ Resultados','④ AI Report'].map((l,i)=>(
          <div key={i} onClick={()=>i<=step&&setStep(i)}
            style={{padding:'7px 16px',borderRadius:6,fontFamily:mono,fontSize:11,whiteSpace:'nowrap',cursor:i<=step?'pointer':'default',letterSpacing:'0.05em',
              background:i===step?C.orangeMuted:C.surface,
              border:`1px solid ${i===step?C.orangeDim:C.border2}`,
              color:i===step?C.orange:i<step?C.text2:C.text3,
              borderBottom:i===step?`2px solid ${C.orange}`:`1px solid ${C.border2}`}}>
            {l}{i<step&&' ✓'}
          </div>
        ))}
      </div>

      {loading&&(
        <div style={{...card,textAlign:'center',padding:'70px 40px',animation:'fadeUp 0.3s ease'}}>
          <div style={{width:36,height:36,borderRadius:'50%',border:`3px solid ${C.orangeDim}`,borderTopColor:C.orange,animation:'spin 0.8s linear infinite',margin:'0 auto 16px'}}></div>
          <div style={{fontFamily:disp,fontSize:22,fontWeight:700,marginBottom:6}}>{loadMsg}</div>
          <div style={{fontFamily:mono,fontSize:11,color:C.text3}}>Procesando mayor general Atlas RE...</div>
        </div>
      )}

      {/* ═══════════ STEP 0: UPLOAD ═══════════ */}
      {!loading&&step===0&&(
        <div style={{animation:'fadeUp 0.3s ease'}}>
          <div style={{fontFamily:disp,fontSize:24,fontWeight:800,marginBottom:20,letterSpacing:'0.05em'}}>Cargar GL Account Analysis <span style={{color:C.orange}}>(Oracle ERP)</span></div>
          <div onDragOver={e=>{e.preventDefault();setDragGl(true)}} onDragLeave={()=>setDragGl(false)}
            onDrop={e=>{e.preventDefault();setDragGl(false);const f=e.dataTransfer.files[0];if(f)parseGL(f);}}
            onClick={()=>glRef.current.click()}
            style={{border:`2px dashed ${dragGl?C.orange:C.border2}`,borderRadius:12,padding:'64px 40px',textAlign:'center',cursor:'pointer',
              background:dragGl?'rgba(232,89,12,0.06)':C.surface,transition:'all 0.2s',marginBottom:16,
              boxShadow:dragGl?`0 0 30px rgba(232,89,12,0.15)`:undefined}}>
            <div style={{fontSize:52,marginBottom:12}}>📊</div>
            <div style={{fontFamily:disp,fontSize:22,fontWeight:800,marginBottom:8}}>GL_Account_Analysis_*.xlsx</div>
            <div style={{fontFamily:mono,fontSize:11,color:C.text3,lineHeight:2}}>
              BATCH_NAME · JOURNAL_NAME · LEDGER · SOURCE · CATEGORY · PERIOD · ACCOUNTING_DATE<br/>
              COMPANY · BC · PROJECT · ACCOUNT · COSTCENTER · INTERCOMPANY · ENT_DEBIT · ENT_CREDIT · ACC_DEBIT · ACC_CREDIT · DESCRIPTION
            </div>
            <input ref={glRef} type="file" accept=".xlsx,.xls" style={{display:'none'}} onChange={e=>e.target.files[0]&&parseGL(e.target.files[0])}/>
          </div>
          <div style={{...card,display:'flex',alignItems:'center',gap:10,padding:'14px 18px',flexWrap:'wrap',borderLeft:`3px solid ${C.blue}`}}>
            <span style={{fontFamily:mono,fontSize:11,color:C.blue}}>🔒</span>
            <span style={{fontFamily:mono,fontSize:11,color:C.text3}}>El archivo se procesa 100% localmente. Los datos no salen de tu navegador.</span>
          </div>
        </div>
      )}

      {/* ═══════════ STEP 1: RULES ═══════════ */}
      {!loading&&step===1&&(
        <div style={{animation:'fadeUp 0.3s ease'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20,flexWrap:'wrap',gap:10}}>
            <div>
              <div style={{fontFamily:disp,fontSize:24,fontWeight:800}}>Cross-Validation Rules</div>
              <div style={{fontFamily:mono,fontSize:11,color:C.text3,marginTop:4}}>{rules.filter(r=>r.active!==false).length} reglas activas · {rules.filter(r=>r.source==='custom').length} personalizadas</div>
            </div>
            <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
              <button onClick={downloadTemplate} style={btn()}>⬇ Plantilla Excel</button>
              <button onClick={()=>rulesRef.current.click()} style={btn()}>📂 Cargar Reglas (.xlsx)</button>
              <button onClick={()=>setShowAddRule(v=>!v)} style={btn(true)}>+ Agregar Regla</button>
              <input ref={rulesRef} type="file" accept=".xlsx,.xls" style={{display:'none'}} onChange={e=>e.target.files[0]&&parseRulesFile(e.target.files[0])}/>
            </div>
          </div>

          <div onDragOver={e=>{e.preventDefault();setDragRules(true)}} onDragLeave={()=>setDragRules(false)}
            onDrop={e=>{e.preventDefault();setDragRules(false);const f=e.dataTransfer.files[0];if(f)parseRulesFile(f);}}
            style={{border:`1px dashed ${dragRules?C.orange:C.border2}`,borderRadius:8,padding:'14px 20px',marginBottom:16,background:dragRules?'rgba(232,89,12,0.05)':C.surface2,cursor:'pointer',transition:'all 0.2s'}}
            onClick={()=>rulesRef.current.click()}>
            <div style={{fontFamily:mono,fontSize:11,color:C.text3,textAlign:'center'}}>
              📋 Arrastra aquí tu Excel de reglas personalizadas · <span style={{color:C.orange}}>⬇ Descarga la plantilla primero</span>
            </div>
          </div>

          {showAddRule&&(
            <div style={{...card,marginBottom:16,border:`1px solid ${C.orangeDim}`,boxShadow:`0 0 20px rgba(232,89,12,0.08)`}}>
              <div style={{fontFamily:disp,fontSize:16,fontWeight:800,marginBottom:14,color:C.orange}}>➕ Nueva Regla de Validación</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:10,marginBottom:12}}>
                {[['ID (ej: GR.08)','id'],['Descripción','desc'],['Categoría','cat'],['Riesgo','risk']].map(([lbl,k])=>(
                  <div key={k}>
                    <div style={{fontFamily:mono,fontSize:10,color:C.text3,marginBottom:4,textTransform:'uppercase',letterSpacing:'0.1em'}}>{lbl}</div>
                    {k==='risk'?(
                      <select value={newRule.risk} onChange={e=>setNewRule(r=>({...r,risk:e.target.value}))} style={{...inp,width:'100%'}}>
                        <option value="high">HIGH</option><option value="medium">MEDIUM</option><option value="low">LOW</option>
                      </select>
                    ):(
                      <input value={newRule[k]} onChange={e=>setNewRule(r=>({...r,[k]:e.target.value}))} style={{...inp,width:'100%'}}/>
                    )}
                  </div>
                ))}
              </div>
              <div style={{fontFamily:mono,fontSize:10,color:C.text3,marginBottom:8,textTransform:'uppercase',letterSpacing:'0.1em'}}>Condiciones IF (encadenadas con AND/OR)</div>
              {newRule.conditions.map((cond,i)=>(
                <div key={i} style={{display:'flex',gap:6,marginBottom:6,alignItems:'center'}}>
                  {i>0&&<select value={cond.logic||'AND'} onChange={e=>{const c=[...newRule.conditions];c[i]={...c[i],logic:e.target.value};setNewRule(r=>({...r,conditions:c}));}} style={{...inp,width:60}}><option>AND</option><option>OR</option></select>}
                  <select value={cond.field} onChange={e=>{const c=[...newRule.conditions];c[i]={...c[i],field:e.target.value};setNewRule(r=>({...r,conditions:c}));}} style={{...inp,flex:1}}>{FIELDS.map(f=><option key={f}>{f}</option>)}</select>
                  <select value={cond.op} onChange={e=>{const c=[...newRule.conditions];c[i]={...c[i],op:e.target.value};setNewRule(r=>({...r,conditions:c}));}} style={{...inp,flex:1}}>{OPS.map(o=><option key={o}>{o}</option>)}</select>
                  <input value={cond.value} onChange={e=>{const c=[...newRule.conditions];c[i]={...c[i],value:e.target.value};setNewRule(r=>({...r,conditions:c}));}} placeholder="valor" style={{...inp,flex:1}}/>
                  {i>0&&<button onClick={()=>setNewRule(r=>({...r,conditions:r.conditions.filter((_,j)=>j!==i)}))} style={{...btn(),padding:'5px 10px',color:C.red}}>✕</button>}
                </div>
              ))}
              <button onClick={()=>setNewRule(r=>({...r,conditions:[...r.conditions,{logic:'AND',field:'BC',op:'=',value:''}]}))} style={{...btn(false,true),marginBottom:14}}>+ Agregar condición</button>
              <div style={{fontFamily:mono,fontSize:10,color:C.text3,marginBottom:8,textTransform:'uppercase',letterSpacing:'0.1em'}}>Validación THEN (debe ser verdadero)</div>
              <div style={{display:'flex',gap:6,marginBottom:14}}>
                <select value={newRule.validation.field} onChange={e=>setNewRule(r=>({...r,validation:{...r.validation,field:e.target.value}}))} style={{...inp,flex:1}}>{FIELDS.map(f=><option key={f}>{f}</option>)}</select>
                <select value={newRule.validation.op} onChange={e=>setNewRule(r=>({...r,validation:{...r.validation,op:e.target.value}}))} style={{...inp,flex:1}}>{OPS.map(o=><option key={o}>{o}</option>)}</select>
                <input value={newRule.validation.value} onChange={e=>setNewRule(r=>({...r,validation:{...r.validation,value:e.target.value}}))} placeholder="valor esperado" style={{...inp,flex:1}}/>
              </div>
              <div style={{display:'flex',gap:8}}>
                <button onClick={addRule} style={btn(true)}>💾 Guardar Regla</button>
                <button onClick={()=>setShowAddRule(false)} style={btn()}>Cancelar</button>
              </div>
            </div>
          )}

          <div style={{...card,padding:0,overflow:'hidden',marginBottom:20}}>
            <div style={{display:'grid',gridTemplateColumns:'20px 70px 80px 1fr auto 70px 90px',padding:'9px 18px',background:C.surface2,borderBottom:`1px solid ${C.border2}`,fontFamily:mono,fontSize:10,textTransform:'uppercase',letterSpacing:'0.1em',color:C.text3,gap:12,alignItems:'center'}}>
              <div></div><div>ID</div><div>Categoría</div><div>Descripción / IF → THEN</div><div>Fuente</div><div>Riesgo</div><div>Estado</div>
            </div>
            {rules.map((r,i)=>(
              <div key={r.id+i} className="rule-row" style={{display:'grid',gridTemplateColumns:'20px 70px 80px 1fr auto 70px 90px',padding:'11px 18px',borderBottom:`1px solid ${C.border}`,alignItems:'start',gap:12}}>
                <input type="checkbox" checked={r.active!==false} onChange={e=>setRules(prev=>prev.map((rr,j)=>j===i?{...rr,active:e.target.checked}:rr))} style={{marginTop:3,accentColor:C.orange}}/>
                <div style={{fontFamily:mono,fontSize:11,color:C.orange,fontWeight:500}}>{r.id}</div>
                <div style={{fontFamily:mono,fontSize:10,color:C.text3}}>{r.cat}</div>
                <div>
                  <div style={{fontSize:12,color:C.text,marginBottom:4}}>{r.desc}</div>
                  <div style={{fontFamily:mono,fontSize:10,color:C.text3,lineHeight:1.7}}>
                    IF: {r.conditions.map((c,j)=>`${j>0?c.logic+' ':''}${c.field} ${c.op} "${c.value}"`).join(' ')} → THEN: {r.validation.field} {r.validation.op} "{r.validation.value}"
                  </div>
                  {r.errorMsg&&<div style={{fontFamily:mono,fontSize:10,color:C.amber,marginTop:2}}>⚑ {r.errorMsg}</div>}
                </div>
                <div style={{fontFamily:mono,fontSize:10,padding:'2px 8px',borderRadius:4,background:r.source==='custom'?'rgba(77,166,255,0.1)':C.surface2,color:r.source==='custom'?C.blue:C.text3,border:`1px solid ${r.source==='custom'?'rgba(77,166,255,0.3)':C.border}`}}>{r.source==='custom'?'Custom':'Built-in'}</div>
                <div><span style={{fontFamily:mono,fontSize:10,color:RC[r.risk]||C.text3,background:`${RC[r.risk]}18`,padding:'3px 8px',borderRadius:4}}>{(r.risk||'').toUpperCase()}</span></div>
                <div style={{display:'flex',gap:6}}>
                  {r.source==='custom'&&<button onClick={()=>setRules(prev=>prev.filter((_,j)=>j!==i))} style={{...btn(false,true),color:C.red,borderColor:'rgba(244,67,54,0.2)',padding:'4px 8px'}}>✕</button>}
                </div>
              </div>
            ))}
          </div>

          <div style={{display:'flex',gap:10}}>
            <button onClick={runValidation} style={btnOrange}>🚀 Ejecutar {rules.filter(r=>r.active!==false).length} Reglas →</button>
            <button onClick={()=>setStep(0)} style={btn()}>← Volver</button>
          </div>
        </div>
      )}

      {/* ═══════════ STEP 2: RESULTS ═══════════ */}
      {!loading&&step===2&&results&&(
        <div style={{animation:'fadeUp 0.3s ease'}}>

          {/* KPI row */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:10,marginBottom:18}}>
            {[
              [C.green,'PASS',stats.pass,'reglas OK',null],
              [C.amber,'WARN',stats.warn,'revisar',null],
              [C.red,'FAIL',stats.fail,'críticas',null],
              [C.text2,'TOTAL',stats.total,'ejecutadas',null],
              [globalCompliance()>=90?C.green:globalCompliance()>=70?C.amber:C.red,'COMPLIANCE',globalCompliance()+'%','score global',true],
            ].map(([col,lbl,val,sub,big])=>(
              <div key={lbl} style={{...card,borderTop:`3px solid ${col}`,padding:'14px 18px'}}>
                <div style={{fontFamily:mono,fontSize:10,textTransform:'uppercase',letterSpacing:'0.1em',color:C.text3,marginBottom:4}}>{lbl}</div>
                <div style={{fontFamily:disp,fontSize:big?30:32,fontWeight:800,color:col,lineHeight:1}}>{val}</div>
                <div style={{fontFamily:mono,fontSize:10,color:C.text3,marginTop:3}}>{sub}</div>
              </div>
            ))}
          </div>

          {/* Action bar */}
          <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap',alignItems:'center'}}>
            <div style={{display:'flex',gap:3}}>
              {[['rule','📋 Por Regla'],['country','🗺 Heatmap por País']].map(([t,l])=>(
                <button key={t} onClick={()=>setResTab(t)} style={{...btn(resTab===t),fontSize:12,padding:'8px 18px'}}>{l}</button>
              ))}
            </div>
            <div style={{marginLeft:'auto',display:'flex',gap:6,flexWrap:'wrap'}}>
              <button onClick={exportCSV} style={btn(false,true)}>⬇ CSV Resumen</button>
              <button onClick={()=>exportAllViolations(results,period)} style={{...btn(false,true),color:C.amber,borderColor:C.amberDim}}>⬇ Exportar Todas las Violaciones</button>
              <button onClick={()=>{setStep(3);if(!aiText)callAI();}} style={{...btn(true,true),background:C.orangeMuted,borderColor:C.orangeDim,color:C.orange}}>🤖 AI Report →</button>
            </div>
          </div>

          {/* ── BY RULE ── */}
          {resTab==='rule'&&(
            <>
              <div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap',alignItems:'center'}}>
                <span style={{fontFamily:mono,fontSize:10,color:C.text3}}>Categoría:</span>
                {allCats.map(c=><button key={c} onClick={()=>setFilterCat(c)} style={{...btn(filterCat===c,true)}}>{c==='all'?'Todas':c}</button>)}
              </div>

              <div style={{...card,padding:0,overflow:'hidden'}}>
                <div style={{display:'grid',gridTemplateColumns:'65px 80px 1fr 100px 120px 80px 90px 36px',padding:'9px 18px',background:C.surface2,borderBottom:`1px solid ${C.border2}`,fontFamily:mono,fontSize:10,textTransform:'uppercase',letterSpacing:'0.1em',color:C.text3}}>
                  <div>ID</div><div>Cat.</div><div>Descripción</div><div>Matching</div><div>Violaciones / Monto</div><div>Riesgo</div><div>Estado</div><div></div>
                </div>

                {filteredRes.map((r,i)=>{
                  const st=ST[r.status]||ST.info;
                  const isExp=expandedRule===r.id;
                  return(
                    <div key={r.id}>
                      <div className="rule-row" style={{display:'grid',gridTemplateColumns:'65px 80px 1fr 100px 120px 80px 90px 36px',padding:'13px 18px',borderBottom:!isExp&&i<filteredRes.length-1?`1px solid ${C.border}`:'none',alignItems:'start',cursor:'default'}}>
                        <div style={{fontFamily:mono,fontSize:11,color:C.orange,fontWeight:500}}>{r.id}</div>
                        <div style={{fontFamily:mono,fontSize:10,color:C.text3,paddingTop:1}}>{r.cat}</div>
                        <div>
                          <div style={{fontSize:12,color:C.text,marginBottom:3}}>{r.desc}</div>
                          <div style={{fontFamily:mono,fontSize:10,color:C.text3}}>
                            IF: {r.conditions?.map((c,j)=>`${j>0?c.logic+' ':''}${c.field} ${c.op} "${c.value}"`).join(' ')} → THEN: {r.validation?.field} {r.validation?.op}
                          </div>
                          {r.allViolations?.length>0&&(
                            <div style={{fontFamily:mono,fontSize:10,color:C.amber,marginTop:3}}>
                              ⚑ Muestra: {[...new Set(r.allViolations.slice(0,3).map(v=>v.COMPANY||v.JOURNAL_NAME||'—'))].join(', ')}
                            </div>
                          )}
                        </div>
                        <div style={{fontFamily:mono,fontSize:12,color:C.text2}}>{(r.matching||0).toLocaleString()}</div>
                        <div>
                          <div style={{fontFamily:mono,fontSize:13,color:r.violations>0?C.red:C.green,fontWeight:600}}>
                            {r.violations||0} líneas{r.matching>0&&<span style={{color:C.text3,fontWeight:400}}> ({r.pct}%)</span>}
                          </div>
                          {r.totalAmt>0&&(
                            <div style={{fontFamily:mono,fontSize:11,color:C.amber,marginTop:2}}>
                              💰 {fmtAmt(r.totalAmt)} USD
                            </div>
                          )}
                        </div>
                        <div><span style={{fontFamily:mono,fontSize:10,color:RC[r.risk],background:`${RC[r.risk]}18`,padding:'3px 8px',borderRadius:4}}>{(r.risk||'').toUpperCase()}</span></div>
                        <div><span style={{background:st.bg,border:`1px solid ${st.bord}`,color:st.col,fontFamily:mono,fontSize:11,padding:'5px 10px',borderRadius:6}}>{st.lbl}</span></div>
                        {/* Expand button */}
                        <div style={{display:'flex',alignItems:'center',justifyContent:'center'}}>
                          {r.violations>0&&(
                            <button className="expand-btn" onClick={()=>setExpandedRule(isExp?null:r.id)}
                              style={{background:'none',border:`1px solid ${C.border2}`,color:isExp?C.orange:C.text3,borderRadius:6,width:28,height:28,cursor:'pointer',fontSize:14,display:'flex',alignItems:'center',justifyContent:'center',transition:'all 0.15s'}}>
                              {isExp?'▲':'▼'}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* ── DRILL-DOWN PANEL ── */}
                      {isExp&&r.allViolations?.length>0&&(
                        <div style={{background:'rgba(232,89,12,0.04)',borderTop:`1px solid ${C.orangeDim}`,borderBottom:`1px solid ${C.border}`,padding:'16px 22px',animation:'fadeUp 0.2s ease'}}>
                          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
                            <div>
                              <div style={{fontFamily:disp,fontSize:15,fontWeight:700,color:C.orange}}>{r.id} — Detalle de Violaciones</div>
                              <div style={{fontFamily:mono,fontSize:11,color:C.text3,marginTop:2}}>
                                {r.violations} líneas · Monto total: <span style={{color:C.amber}}>{r.totalAmt>0?fmtAmt(r.totalAmt)+' USD':'—'}</span>
                              </div>
                            </div>
                            <button onClick={()=>exportRuleViolations(r,period)}
                              style={{...btn(true,true),color:C.orange,borderColor:C.orangeDim}}>
                              ⬇ Exportar para Accounting Manager
                            </button>
                          </div>

                          <div style={{overflowX:'auto'}}>
                            <table style={{width:'100%',borderCollapse:'collapse',fontFamily:mono,fontSize:11}}>
                              <thead>
                                <tr style={{background:C.surface2}}>
                                  {['COMPANY','JOURNAL_NAME','ACCOUNT','BC','COSTCENTER','PROJECT','SOURCE','DESCRIPTION','ENT_DEBIT','ENT_CREDIT','CURRENCY_CODE','ACCOUNTING_DATE'].map(h=>(
                                    <th key={h} style={{padding:'6px 10px',textAlign:'left',color:C.text3,fontSize:9,textTransform:'uppercase',letterSpacing:'0.08em',whiteSpace:'nowrap',borderBottom:`1px solid ${C.border2}`}}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {r.allViolations.slice(0,50).map((v,vi)=>(
                                  <tr key={vi} style={{borderBottom:`1px solid ${C.border}`,background:vi%2===0?'transparent':'rgba(255,255,255,0.01)'}}>
                                    {['COMPANY','JOURNAL_NAME','ACCOUNT','BC','COSTCENTER','PROJECT','SOURCE','DESCRIPTION','ENT_DEBIT','ENT_CREDIT','CURRENCY_CODE','ACCOUNTING_DATE'].map(k=>(
                                      <td key={k} style={{padding:'5px 10px',color:
                                        k==='COMPANY'?C.orange:
                                        k==='ENT_DEBIT'||k==='ENT_CREDIT'?C.amber:
                                        k==='DESCRIPTION'&&(!v[k]||v[k]===''):C.red:
                                        C.text2,
                                        maxWidth:k==='DESCRIPTION'?200:undefined,
                                        overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                                        {String(v[k]||'—')}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {r.allViolations.length>50&&(
                              <div style={{textAlign:'center',padding:'8px',fontFamily:mono,fontSize:10,color:C.text3}}>
                                ... y {r.allViolations.length-50} líneas más. Exporta el Excel para ver todas.
                              </div>
                            )}
                          </div>

                          {/* Per-country breakdown for this rule */}
                          <div style={{marginTop:14,display:'flex',gap:8,flexWrap:'wrap'}}>
                            {countryCodes.filter(c=>r.byCountry[c]?.v>0).map(c=>(
                              <div key={c} style={{background:C.surface2,border:`1px solid ${C.border2}`,borderRadius:8,padding:'8px 14px',minWidth:110}}>
                                <div style={{fontFamily:mono,fontSize:10,color:C.text3,marginBottom:2}}>{CMAP[c]||c}</div>
                                <div style={{fontFamily:disp,fontSize:18,fontWeight:700,color:C.red,lineHeight:1}}>{r.byCountry[c].v}</div>
                                <div style={{fontFamily:mono,fontSize:10,color:C.text3}}>líneas · {r.byCountry[c].pct}%</div>
                                {r.byCountry[c].amt>0&&<div style={{fontFamily:mono,fontSize:10,color:C.amber,marginTop:2}}>{fmtAmt(r.byCountry[c].amt)}</div>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ── BY COUNTRY HEATMAP ── */}
          {resTab==='country'&&(
            <div style={{overflowX:'auto'}}>
              {/* Heatmap mode toggle */}
              <div style={{display:'flex',gap:8,marginBottom:14,alignItems:'center',flexWrap:'wrap'}}>
                <span style={{fontFamily:mono,fontSize:10,color:C.text3,marginRight:4}}>Modo:</span>
                {[['count','# Líneas'],['amount','💰 Monto'],['pct','% Violación']].map(([m,l])=>(
                  <button key={m} onClick={()=>setHeatMode(m)} style={{...btn(heatMode===m,true),fontSize:11}}>{l}</button>
                ))}
                <div style={{marginLeft:'auto',display:'flex',gap:6}}>
                  {countryCodes.map(c=>(
                    <button key={c} onClick={()=>exportAllViolations(results,period,c)}
                      style={{...btn(false,true),fontSize:10,color:C.amber,borderColor:C.amberDim}}>
                      ⬇ {CMAP[c]?.split(' ')[0]||c}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{fontFamily:disp,fontSize:18,fontWeight:700,marginBottom:14,letterSpacing:'0.05em'}}>
                Heatmap de Violaciones por País · <span style={{color:C.orange}}>{heatMode==='count'?'Cantidad de Líneas':heatMode==='amount'?'Monto USD':'% Tasa Violación'}</span>
              </div>

              {/* Per-country compliance score bar */}
              <div style={{display:'grid',gridTemplateColumns:`repeat(${countryCodes.length},1fr)`,gap:8,marginBottom:16}}>
                {countryCodes.map(c=>{
                  const pct=countryCompliance(c);
                  const col=pct>=90?C.green:pct>=70?C.amber:C.red;
                  return(
                    <div key={c} style={{background:C.surface,border:`1px solid ${C.border2}`,borderRadius:8,padding:'10px 14px',textAlign:'center'}}>
                      <div style={{fontSize:18,marginBottom:2}}>{CMAP[c]?.split(' ')[0]||c}</div>
                      <div style={{fontFamily:mono,fontSize:9,color:C.text3,marginBottom:6}}>{CMAP[c]?.split(' ')[1]||c}</div>
                      <div style={{background:C.surface2,borderRadius:4,height:6,marginBottom:6,overflow:'hidden'}}>
                        <div style={{width:pct+'%',height:'100%',background:`linear-gradient(90deg,${col},${col}aa)`,borderRadius:4,transition:'width 0.5s'}}></div>
                      </div>
                      <div style={{fontFamily:disp,fontSize:22,fontWeight:800,color:col,lineHeight:1}}>{pct}%</div>
                      <div style={{fontFamily:mono,fontSize:9,color:C.text3,marginTop:2}}>compliance</div>
                    </div>
                  );
                })}
              </div>

              {/* Heatmap table */}
              <div style={{...card,padding:0,overflow:'hidden',minWidth:700}}>
                {/* Header */}
                <div style={{display:'grid',gridTemplateColumns:`220px 80px repeat(${countryCodes.length},1fr)`,background:C.surface2,borderBottom:`1px solid ${C.border2}`,fontFamily:mono,fontSize:10,textTransform:'uppercase',letterSpacing:'0.08em',color:C.text3}}>
                  <div style={{padding:'10px 14px'}}>Regla</div>
                  <div style={{padding:'10px 6px',textAlign:'center'}}>Total</div>
                  {countryCodes.map(c=>(
                    <div key={c} style={{padding:'10px 6px',textAlign:'center',borderLeft:`1px solid ${C.border}`}}>
                      <div style={{fontSize:16}}>{CMAP[c]?.split(' ')[0]||c}</div>
                      <div style={{fontSize:9,marginTop:1}}>{c}</div>
                    </div>
                  ))}
                </div>

                {/* Categories */}
                {['Compliance','Cierre','Integridad'].map(cat=>{
                  const catRules=results.filter(r=>r.cat===cat);
                  if(!catRules.length) return null;

                  // Per-category compliance per country
                  const catCountryCompliance=(c)=>{
                    const totalLines=catRules.reduce((s,r)=>s+(r.byCountry[c]?.m||0),0);
                    const violLines=catRules.reduce((s,r)=>s+(r.byCountry[c]?.v||0),0);
                    return totalLines>0?Math.round((1-violLines/totalLines)*100):100;
                  };

                  return(
                    <div key={cat}>
                      {/* Category header */}
                      <div style={{background:'rgba(232,89,12,0.06)',padding:'7px 14px',fontFamily:mono,fontSize:10,color:C.orange,textTransform:'uppercase',letterSpacing:'0.12em',borderBottom:`1px solid ${C.border}`,borderTop:`1px solid ${C.border2}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                        <span>{cat} · {catRules.filter(r=>r.violations>0).length} de {catRules.length} con violaciones</span>
                        <div style={{display:'flex',gap:8'}}>
                          {countryCodes.map(c=>{
                            const pct=catCountryCompliance(c);
                            const col=pct>=90?C.green:pct>=70?C.amber:C.red;
                            return <span key={c} style={{fontFamily:mono,fontSize:9,color:col,marginLeft:8}}>{c} {pct}%</span>;
                          })}
                        </div>
                      </div>

                      {/* Rule rows */}
                      {catRules.map((r,i)=>(
                        <div key={r.id} style={{display:'grid',gridTemplateColumns:`220px 80px repeat(${countryCodes.length},1fr)`,borderBottom:i<catRules.length-1?`1px solid ${C.border}`:'none',alignItems:'stretch'}}>
                          <div style={{padding:'10px 14px',borderRight:`1px solid ${C.border}`}}>
                            <div style={{fontFamily:mono,fontSize:10,color:C.orange,marginBottom:2}}>{r.id}</div>
                            <div style={{fontSize:11,color:C.text2,lineHeight:1.3}}>{r.desc.substring(0,60)}{r.desc.length>60?'…':''}</div>
                          </div>
                          {/* Total column */}
                          <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',borderRight:`1px solid ${C.border}`,padding:'8px 4px',gap:2}}>
                            <span style={{fontFamily:mono,fontSize:12,color:r.violations>0?C.red:C.green,fontWeight:600}}>{r.violations||0}</span>
                            {r.totalAmt>0&&<span style={{fontFamily:mono,fontSize:9,color:C.amber}}>{fmtAmt(r.totalAmt)}</span>}
                          </div>
                          {/* Country cells */}
                          {countryCodes.map(c=>{
                            const d=r.byCountry[c]||{m:0,v:0,amt:0};
                            const cl=cellColor(d.v,d.m);
                            const displayVal=heatMode==='count'?cl.txt:
                              heatMode==='amount'?(d.v>0?fmtAmt(d.amt||0):'—'):
                              (d.v>0&&d.m>0?d.pct+'%':'—');
                            return(
                              <div key={c} className="hm-cell" style={{display:'flex',alignItems:'center',justifyContent:'center',background:cl.bg,borderLeft:`1px solid ${C.border}`,padding:'8px 4px'}}
                                onClick={()=>{setExpandedRule(null);setResTab('rule');setFilterCat('all');setTimeout(()=>setExpandedRule(r.id),50);}}>
                                <div style={{textAlign:'center'}}>
                                  <div style={{fontFamily:mono,fontSize:13,color:cl.col,fontWeight:600,lineHeight:1}}>{displayVal}</div>
                                  {d.m>0&&d.v>0&&heatMode==='count'&&<div style={{fontFamily:mono,fontSize:9,color:C.text3,marginTop:2}}>{d.pct}%</div>}
                                  {d.m>0&&d.v>0&&heatMode==='amount'&&<div style={{fontFamily:mono,fontSize:9,color:C.text3,marginTop:2}}>{d.v} lns</div>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ))}

                      {/* ── MODULE COMPLIANCE SUMMARY ROW ── */}
                      <div style={{display:'grid',gridTemplateColumns:`220px 80px repeat(${countryCodes.length},1fr)`,background:`linear-gradient(90deg,rgba(232,89,12,0.08),rgba(245,166,35,0.06))`,borderTop:`2px solid ${C.orangeDim}`,borderBottom:`1px solid ${C.border2}`}}>
                        <div style={{padding:'10px 14px',borderRight:`1px solid ${C.border}`}}>
                          <div style={{fontFamily:mono,fontSize:9,color:C.orange,textTransform:'uppercase',letterSpacing:'0.1em'}}>Compliance {cat}</div>
                          <div style={{fontFamily:disp,fontSize:13,fontWeight:700,color:C.text2,marginTop:2}}>Total módulo</div>
                        </div>
                        <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',borderRight:`1px solid ${C.border}`,padding:'8px 4px'}}>
                          {(()=>{
                            const tl=catRules.reduce((s,r)=>s+r.matching,0);
                            const vl=catRules.reduce((s,r)=>s+r.violations,0);
                            const pct=tl>0?Math.round((1-vl/tl)*100):100;
                            const col=pct>=90?C.green:pct>=70?C.amber:C.red;
                            return <>
                              <div style={{fontFamily:disp,fontSize:20,fontWeight:800,color:col,lineHeight:1}}>{pct}%</div>
                              <div style={{fontFamily:mono,fontSize:9,color:C.text3,marginTop:2}}>{vl} viol.</div>
                            </>;
                          })()}
                        </div>
                        {countryCodes.map(c=>{
                          const pct=catCountryCompliance(c);
                          const col=pct>=90?C.green:pct>=70?C.amber:C.red;
                          const totalViol=catRules.reduce((s,r)=>s+(r.byCountry[c]?.v||0),0);
                          const totalAmt=catRules.reduce((s,r)=>s+(r.byCountry[c]?.amt||0),0);
                          return(
                            <div key={c} style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',borderLeft:`1px solid ${C.border}`,padding:'8px 4px',background:pct>=90?'rgba(76,175,80,0.08)':pct>=70?'rgba(245,166,35,0.08)':'rgba(244,67,54,0.10)'}}>
                              <div style={{fontFamily:disp,fontSize:22,fontWeight:800,color:col,lineHeight:1}}>{pct}%</div>
                              <div style={{fontFamily:mono,fontSize:9,color:C.text3,marginTop:2}}>{totalViol} viol.</div>
                              {totalAmt>0&&<div style={{fontFamily:mono,fontSize:9,color:C.amber}}>{fmtAmt(totalAmt)}</div>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* Grand total row */}
                <div style={{display:'grid',gridTemplateColumns:`220px 80px repeat(${countryCodes.length},1fr)`,background:C.surface2,borderTop:`2px solid ${C.border2}`}}>
                  <div style={{padding:'12px 14px',fontFamily:mono,fontSize:10,color:C.text3,textTransform:'uppercase',letterSpacing:'0.1em'}}>
                    <div style={{color:C.amber,fontWeight:600,fontSize:11}}>COMPLIANCE TOTAL</div>
                    <div style={{marginTop:2,fontSize:9}}>Todas las reglas</div>
                  </div>
                  <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',borderRight:`1px solid ${C.border}`,padding:'8px 4px'}}>
                    <span style={{fontFamily:disp,fontSize:22,fontWeight:800,color:globalCompliance()>=90?C.green:globalCompliance()>=70?C.amber:C.red,lineHeight:1}}>{globalCompliance()}%</span>
                    <span style={{fontFamily:mono,fontSize:9,color:C.text3,marginTop:2}}>{results.reduce((s,r)=>s+r.violations,0)} viol.</span>
                  </div>
                  {countryCodes.map(c=>{
                    const pct=countryCompliance(c);
                    const col=pct>=90?C.green:pct>=70?C.amber:C.red;
                    const total=results.reduce((s,r)=>s+(r.byCountry[c]?.v||0),0);
                    const totalAmt=results.reduce((s,r)=>s+(r.byCountry[c]?.amt||0),0);
                    return(
                      <div key={c} style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',borderLeft:`1px solid ${C.border}`,padding:'10px 4px',background:pct>=90?'rgba(76,175,80,0.10)':pct>=70?'rgba(245,166,35,0.10)':'rgba(244,67,54,0.12)'}}>
                        <div style={{fontFamily:disp,fontSize:26,fontWeight:800,color:col,lineHeight:1}}>{pct}%</div>
                        <div style={{fontFamily:mono,fontSize:9,color:C.text3,marginTop:2}}>{total} viol.</div>
                        {totalAmt>0&&<div style={{fontFamily:mono,fontSize:9,color:C.amber,marginTop:1}}>{fmtAmt(totalAmt)}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{fontFamily:mono,fontSize:10,color:C.text3,marginTop:8}}>
                🟢 Sin violaciones · 🟡 &lt;5% tasa violación · 🔴 ≥5% tasa violación · — Sin filas coincidentes · Clic en celda → ver detalle de regla
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════ STEP 3: AI REPORT ═══════════ */}
      {!loading&&step===3&&(
        <div style={{animation:'fadeUp 0.3s ease'}}>
          <div style={{fontFamily:disp,fontSize:24,fontWeight:800,marginBottom:16,letterSpacing:'0.05em'}}>🤖 Reporte Ejecutivo — <span style={{color:C.orange}}>Análisis IA por País</span></div>
          {stats&&(
            <div style={{display:'flex',gap:8,marginBottom:18,flexWrap:'wrap'}}>
              {[[C.green,'✓ '+stats.pass+' PASS'],[C.amber,'⚠ '+stats.warn+' WARN'],[C.red,'✕ '+stats.fail+' FAIL']].map(([c,l])=>(
                <div key={l} style={{background:C.surface,border:`1px solid ${C.border2}`,borderRadius:6,padding:'7px 14px',fontFamily:mono,fontSize:12,color:c}}>{l}</div>
              ))}
              {results&&(
                <div style={{background:C.orangeMuted,border:`1px solid ${C.orangeDim}`,borderRadius:6,padding:'7px 14px',fontFamily:mono,fontSize:12,color:C.orange}}>
                  ⚡ {globalCompliance()}% Compliance Global
                </div>
              )}
              <div style={{background:C.surface,border:`1px solid ${C.border2}`,borderRadius:6,padding:'7px 14px',fontFamily:mono,fontSize:11,color:C.text3}}>
                {period} · {countryCodes.map(c=>CMAP[c]?.split(' ')[1]||c).join(', ')}
              </div>
            </div>
          )}
          <div style={{...card,marginBottom:20,minHeight:240,borderTop:`2px solid ${C.orange}`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14,flexWrap:'wrap',gap:8}}>
              <span style={{fontFamily:disp,fontSize:16,fontWeight:700}}>Análisis Claude — Cross-Validation por País</span>
              <button onClick={callAI} style={btn(true,true)}>{aiLoading?'⟳ Analizando...':'↺ Re-generar'}</button>
            </div>
            {aiLoading&&(
              <div style={{textAlign:'center',padding:'40px 0'}}>
                <div style={{width:30,height:30,borderRadius:'50%',border:`3px solid ${C.orangeDim}`,borderTopColor:C.orange,animation:'spin 0.8s linear infinite',margin:'0 auto 14px'}}></div>
                <div style={{fontFamily:mono,fontSize:11,color:C.text3}}>Procesando {results?.length} reglas × {countryCodes.length} países...</div>
              </div>
            )}
            {!aiLoading&&!aiText&&<div style={{textAlign:'center',padding:'50px 0'}}><button onClick={callAI} style={btnOrange}>Generar análisis con Claude</button></div>}
            {aiText&&<div style={{fontFamily:sans,fontSize:13,lineHeight:1.9,color:C.text2,background:C.surface2,borderRadius:8,padding:'18px 22px',border:`1px solid ${C.border2}`,whiteSpace:'pre-wrap'}}>{aiText}</div>}
          </div>
          <div style={{display:'flex',gap:8,justifyContent:'space-between',flexWrap:'wrap'}}>
            <button onClick={()=>setStep(2)} style={btn()}>← Resultados</button>
            <div style={{display:'flex',gap:8}}>
              <button onClick={exportCSV} style={btn()}>⬇ CSV</button>
              <button onClick={()=>exportAllViolations(results,period)} style={{...btn(),color:C.amber,borderColor:C.amberDim}}>⬇ Todas Violaciones</button>
              <button onClick={()=>window.print()} style={btn()}>🖨 Imprimir</button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{display:'flex',justifyContent:'space-between',fontFamily:mono,fontSize:10,color:C.text3,borderTop:`1px solid ${C.border}`,marginTop:40,paddingTop:12,flexWrap:'wrap',gap:6}}>
        <span>
          <span style={{display:'inline-block',width:7,height:7,borderRadius:'50%',background:C.orange,marginRight:6,animation:'pulse 2s infinite'}}></span>
          Atlas RE · GL Cross-Validation Engine v4.0 · Oracle ERP
        </span>
        <span>{new Date().toLocaleString('es-CL')}</span>
        <span>{period} · Revisor: {reviewer||'—'}</span>
      </div>
    </div>
  </div>
  );
}
