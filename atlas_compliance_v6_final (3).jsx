import { useState, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";

// ── Fonts ──────────────────────────────────────────────
const fl=document.createElement('link');fl.rel='stylesheet';
fl.href='https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800&family=Barlow:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap';
document.head.appendChild(fl);

// ── Atlas Brand ────────────────────────────────────────
const A={orange:'#E8520A',orangeHov:'#C94508',amber:'#F5900A',amberL:'#FFA833',
  dark:'#1C1C1C',dark2:'#2C2C2C',dark3:'#3A3A3A',dark4:'#505050',
  white:'#FFFFFF',off:'#F7F6F4',light:'#EEECE9',light2:'#E4E1DC',
  pass:'#1A7A3C',passL:'#E8F7EE',passB:'#A3D9B8',
  warn:'#D97706',warnL:'#FEF3C7',warnB:'#FCD34D',
  fail:'#CC2A2A',failL:'#FEE8E8',failB:'#FCA5A5',
  info:'#1D4ED8',infoL:'#EFF6FF',infoB:'#BFDBFE',
  t1:'#1C1C1C',t2:'#4A4A4A',t3:'#7A7A7A',t4:'#AAAAAA'};
const mono="'DM Mono',monospace",body="'Barlow',sans-serif",cond="'Barlow Condensed',sans-serif";

// ── Country helpers ────────────────────────────────────
const CMAP={CL:{flag:'🇨🇱',name:'Chile',short:'CHL'},MX:{flag:'🇲🇽',name:'México',short:'MEX'},
  BR:{flag:'🇧🇷',name:'Brasil',short:'BRA'},CO:{flag:'🇨🇴',name:'Colombia',short:'COL'},
  ES:{flag:'🇪🇸',name:'España',short:'ESP'},UY:{flag:'🇺🇾',name:'Uruguay',short:'URY'},
  US:{flag:'🇺🇸',name:'USA',short:'USA'}};
const cc=co=>String(co||'').substring(0,2).toUpperCase();
const ci=co=>{const k=cc(co);return CMAP[k]||{flag:'🌐',name:k||'?',short:k};};

// ── Formatters ─────────────────────────────────────────
const fmtUSD=n=>{if(!n&&n!==0)return'—';const a=Math.abs(n);const sign=n<0?'-':'';return sign+'$'+(a>=1e6?(a/1e6).toFixed(1)+'M':a>=1e3?(a/1e3).toFixed(0)+'K':Math.round(a).toLocaleString('en-US'));};
const fmtFull=n=>{if(n==null)return'—';const a=Math.abs(n);const sign=n<0?'-':'';return sign+'$'+Math.round(a).toLocaleString('en-US');};

// ── WD+6 Closing Calendar 2026 ─────────────────────────
const CLOSE_CALENDAR={
  1:{month:'Jan',eom:'2026-01-31',close:'2026-02-10'},
  2:{month:'Feb',eom:'2026-02-28',close:'2026-03-09'},
  3:{month:'Mar',eom:'2026-03-31',close:'2026-04-10'},
  4:{month:'Apr',eom:'2026-04-30',close:'2026-05-11'},
  5:{month:'May',eom:'2026-05-31',close:'2026-06-08'},
  6:{month:'Jun',eom:'2026-06-30',close:'2026-07-09'},
  7:{month:'Jul',eom:'2026-07-31',close:'2026-08-10'},
  8:{month:'Aug',eom:'2026-08-31',close:'2026-09-09'},
  9:{month:'Sep',eom:'2026-09-30',close:'2026-10-09'},
  10:{month:'Oct',eom:'2026-10-31',close:'2026-11-10'},
  11:{month:'Nov',eom:'2026-11-30',close:'2026-12-09'},
  12:{month:'Dec',eom:'2026-12-31',close:'2027-01-11'},
};
const getPeriodMonth=period=>{const m={Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};const p=String(period||'');for(const[k,v]of Object.entries(m)){if(p.startsWith(k)||p.includes('-'+v+'-')||p.includes('0'+v+'-')||p.includes(k))return v;}return 4;};

// ── Excel serial date → ISO string (46112 → "2026-04-01") ──────────
// Excel stores dates as days since Jan 1 1900 (with off-by-2 quirk)
const excelDateToISO=(v)=>{
  if(v==null||v==='')return'';
  const n=Number(v);
  // Serial number range: 40000–60000 covers ~2009–2064
  if(!isNaN(n)&&n>40000&&n<70000){
    const ms=(n-25569)*86400*1000; // 25569 = days from 1900-01-01 to 1970-01-01
    const d=new Date(ms);
    if(!isNaN(d.getTime()))return d.toISOString().substring(0,10);
  }
  return String(v).trim();
};

// Parse any date value (serial, ISO string, DD/MM/YYYY) → Date object
const parseAnyDate=(v)=>{
  if(!v&&v!==0)return null;
  const n=Number(v);
  if(!isNaN(n)&&n>40000&&n<70000){
    return new Date((n-25569)*86400*1000);
  }
  const s=String(v).trim();
  // DD/MM/YYYY
  const m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(m)return new Date(+m[3],+m[2]-1,+m[1]);
  const d=new Date(s);
  return isNaN(d.getTime())?null:d;
};

// ── Row value getter — normalizes numeric zeros to canonical zero strings ──
const acctNum=v=>{const n=Number(v);return isNaN(n)?0:Math.round(n);};

// Canonical "empty" values per field — Excel can store these as 0 (integer) or string
const FIELD_ZERO={COSTCENTER:'000000',INTERCOMPANY:'00000',PROJECT:'00000',BC:'000'};
const EMPTY_ALIASES=['','0','00000','000000','zzzzz','non-ic','none'];
const DATE_FIELDS=['ACCOUNTING_DATE','CREATION_DATE'];

const rv=(row,f)=>{
  const v=row[f];
  if(f==='ACCOUNT'){const n=Number(v);return isNaN(n)?String(v||''):String(Math.round(n));}
  // Date fields: convert Excel serial to ISO
  if(DATE_FIELDS.includes(f))return excelDateToISO(v);
  const s=String(v==null?'':v).trim();
  // Normalize numeric zero stored by XLSX as integer 0 → canonical zero string for the field
  if((s==='0'||s==='')&&FIELD_ZERO[f])return FIELD_ZERO[f];
  return s;
};

// ── Rule condition evaluator ───────────────────────────
// conditionGroups: array of {field, checks:[{op,lo,hi,val}], logic:'AND'|'OR'}
// All groups AND'd together. Within a group: any check OR'd.
const evalGroup=(row,group)=>{
  const fieldVal=rv(row,group.field);
  const numVal=acctNum(fieldVal);
  return group.checks.some(chk=>{
    switch(chk.op){
      case 'between':
        if(group.field==='ACCOUNT') return numVal>=chk.lo&&numVal<=chk.hi;
        return fieldVal>=chk.lo&&fieldVal<=chk.hi; // string compare for company codes
      case 'eq': return fieldVal.toLowerCase()===String(chk.val).toLowerCase();
      case 'ne': return fieldVal.toLowerCase()!==String(chk.val).toLowerCase();
      // For ne checks against zero values, also treat all aliases as equal
      // e.g. ne val:'000000' should fail for '0','000000',''
      case 'neZero': {
        const aliases=EMPTY_ALIASES.concat(Object.values(FIELD_ZERO).map(v=>v.toLowerCase()));
        return !aliases.includes(fieldVal.toLowerCase());
      }
      case 'starts': return fieldVal.startsWith(String(chk.val));
      case 'contains': return fieldVal.toLowerCase().includes(String(chk.val).toLowerCase());
      case 'notContains': return !fieldVal.toLowerCase().includes(String(chk.val).toLowerCase());
      case 'gt': return numVal>Number(chk.val);
      case 'lt': return numVal<Number(chk.val);
      case 'ltAbs': return Math.abs(Number(fieldVal))<Number(chk.val);
      case 'empty': return EMPTY_ALIASES.includes(fieldVal.toLowerCase());
      case 'notEmpty': return !EMPTY_ALIASES.includes(fieldVal.toLowerCase());
      case 'in': return String(chk.val).split(',').map(v=>v.trim().toLowerCase()).includes(fieldVal.toLowerCase());
      case 'notIn': return !String(chk.val).split(',').map(v=>v.trim().toLowerCase()).includes(fieldVal.toLowerCase());
      case 'gte': return numVal>=Number(chk.val);
      case 'lte': return numVal<=Number(chk.val);
      case 'absGt': return Math.abs(numVal)>Number(chk.val);
      default: return false;
    }
  });
};
const evalCondGroups=(row,groups)=>groups.every(g=>evalGroup(row,g));
const evalValidation=(row,val)=>evalGroup(row,{field:val.field,checks:[{op:val.op,...val}]});

// ── SECTION 1: Real CV Rules from Excel ───────────────
// All 19 rules parsed from Cross_Validation_rules_.xlsx
const CV_RULES=[
  {id:'GR.01',module:'CV Rules',risk:'high',desc:'Mandatory Cost Center for SGA/OPP/COM — Accounts 6xxx (All companies)',
   conditionGroups:[
     {field:'COMPANY',checks:[{op:'between',lo:'BR001',hi:'BR999'},{op:'between',lo:'CL000',hi:'CL999'},{op:'between',lo:'CO000',hi:'CO999'},{op:'between',lo:'ES000',hi:'ES999'},{op:'between',lo:'MX000',hi:'MX999'},{op:'between',lo:'US000',hi:'US999'},{op:'between',lo:'UY000',hi:'UY999'}]},
     {field:'BC',checks:[{op:'eq',val:'SGA'},{op:'eq',val:'OPP'},{op:'eq',val:'COM'}]},
     {field:'ACCOUNT',checks:[{op:'between',lo:600000000,hi:699999999}]},
   ],
   validation:{field:'COSTCENTER',op:'notEmpty',val:''},
   errorMsg:'GR.01 Mandatory Cost Center for SGA OPP COM'},
  {id:'GR.01-1',module:'CV Rules',risk:'high',desc:'Mandatory Cost Center for SGA/OPP/COM — Accounts 5xxx',
   conditionGroups:[
     {field:'BC',checks:[{op:'eq',val:'SGA'},{op:'eq',val:'OPP'},{op:'eq',val:'COM'}]},
     {field:'ACCOUNT',checks:[{op:'starts',val:'5'}]},
   ],
   validation:{field:'COSTCENTER',op:'notEmpty',val:''},
   errorMsg:'GR.01-1 Mandatory CC for SGA OPP COM Cuentas 5'},
  {id:'GR.02-1',module:'CV Rules',risk:'high',desc:'Mandatory Business Category — Accounts 400M–741M',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'between',lo:400000000,hi:741099999}]}],
   validation:{field:'BC',op:'notEmpty',val:''},
   errorMsg:'GR.02-1 Mandatory Business Category for Accounts'},
  {id:'GR.02-2',module:'CV Rules',risk:'high',desc:'Mandatory Business Category — Accounts 741M–800M',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'between',lo:741200000,hi:799999999}]}],
   validation:{field:'BC',op:'notEmpty',val:''},
   errorMsg:'GR.02-2 Mandatory Business Category for Accounts'},
  {id:'GR.03',module:'CV Rules',risk:'high',desc:'Mandatory Intercompany Company Code — IC Accounts',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'eq',val:'411204007'},{op:'eq',val:'411300001'},{op:'eq',val:'411300002'},{op:'eq',val:'511104004'},{op:'eq',val:'511200002'},{op:'eq',val:'511200003'},{op:'eq',val:'611100012'},{op:'eq',val:'611100014'},{op:'eq',val:'611100015'}]}],
   validation:{field:'INTERCOMPANY',op:'notEmpty',val:''},
   errorMsg:'GR.03 Mandatory Company for Intercompany Accounts'},
  {id:'GR.04',module:'CV Rules',risk:'high',desc:'Revenue Accounts (4xxx) Restricted to OPP/COM',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'between',lo:400000000,hi:499999999}]}],
   validation:{field:'BC',op:'eq',val:'OPP'},
   errorMsg:'GR.04 Revenue Accounts Restricted to OPP COM'},
  {id:'GR.05',module:'CV Rules',risk:'high',desc:'Cost Accounts (5xxx) Restricted to OPP/COM/SR5',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'between',lo:500000000,hi:599999999}]}],
   validation:{field:'BC',op:'eq',val:'OPP'},
   errorMsg:'GR.05 Cost Account Restricted to OPP COM + SR5'},
  {id:'GR.06-1',module:'CV Rules',risk:'medium',desc:'Expense Accounts 6113-6120 Restricted to SGA/OPP/COM',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'starts',val:'6113'},{op:'starts',val:'6114'},{op:'starts',val:'6115'},{op:'starts',val:'6116'},{op:'starts',val:'6117'},{op:'starts',val:'6118'},{op:'starts',val:'6119'},{op:'starts',val:'6120'}]}],
   validation:{field:'BC',op:'eq',val:'OPP'},
   errorMsg:'GR.06-1 Expense Accounts Restricted to SGA-OPP-COM'},
  {id:'GR.06-2',module:'CV Rules',risk:'medium',desc:'Expense Accounts 6211 Restricted to CON/DEV',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'starts',val:'6211'}]}],
   validation:{field:'BC',op:'eq',val:'CON'},
   errorMsg:'GR.06-2 Expense Accounts 6211 Restricted to CON-DEV'},
  {id:'GR.07',module:'CV Rules',risk:'medium',desc:'Other Cost Accounts (7xxx) Not Allowed in BC=ZZZ',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'between',lo:700000000,hi:799999999}]}],
   validation:{field:'BC',op:'ne',val:'ZZZ'},
   errorMsg:'GR.07 Other Costs Accounts Not Allowed in ZZZ'},
  {id:'GR.08-1',module:'CV Rules',risk:'medium',desc:'BC DEV/CON with 4-6xxx Accounts: Project Required',
   conditionGroups:[{field:'BC',checks:[{op:'eq',val:'CON'},{op:'eq',val:'DEV'}]},{field:'ACCOUNT',checks:[{op:'between',lo:400000000,hi:699999999}]}],
   validation:{field:'PROJECT',op:'notEmpty',val:''},
   errorMsg:'GR.08-1 Only BC DEV Y CON Must be Project'},
  {id:'GR.08-2',module:'CV Rules',risk:'medium',desc:'BC DEV/CON: Project must not contain SGA',
   conditionGroups:[{field:'BC',checks:[{op:'eq',val:'CON'},{op:'eq',val:'DEV'}]},{field:'ACCOUNT',checks:[{op:'between',lo:400000000,hi:699999999}]}],
   validation:{field:'PROJECT',op:'notContains',val:'SGA'},
   errorMsg:'GR.08-2 Only BC DEV y CON Must be Project <> SGA'},
  {id:'GR.09',module:'CV Rules',risk:'medium',desc:'Finance Cost Center Accounts (Solo CC Finanzas)',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'eq',val:'611800001'},{op:'eq',val:'611800099'},{op:'eq',val:'721100007'},{op:'eq',val:'761100001'}]}],
   validation:{field:'COSTCENTER',op:'between',lo:'CC001C',hi:'CC006L'},
   errorMsg:'GR.09 Cuentas Solo aceptan CC Finanzas'},
  {id:'ER.1.1',module:'CV Rules',risk:'medium',desc:'BC=OPP: Mandatory Local Cost Center (contains L)',
   conditionGroups:[{field:'BC',checks:[{op:'eq',val:'OPP'}]}],
   validation:{field:'COSTCENTER',op:'contains',val:'L'},
   errorMsg:'ER.1.1 Mandatory Local Cost Center for Business Category OPP'},
  {id:'ER.1.2',module:'CV Rules',risk:'medium',desc:'CC220C/CC220L: Mandatory BC=COM',
   conditionGroups:[{field:'COSTCENTER',checks:[{op:'eq',val:'CC220C'},{op:'eq',val:'CC220L'}]}],
   validation:{field:'BC',op:'eq',val:'COM'},
   errorMsg:'ER.1.2 Mandatory Business Category COM for Cost Center 220C 220L'},
  {id:'ER.5.1',module:'CV Rules',risk:'low',desc:'Account 511100014 Only Allowed in SGA',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'eq',val:'511100014'}]}],
   validation:{field:'BC',op:'eq',val:'SGA'},
   errorMsg:'ER.5.1 Cost Accounts Allowed in SGA'},
  {id:'ER.5.2',module:'CV Rules',risk:'low',desc:'Account 511100012 Only Allowed in CON',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'eq',val:'511100012'}]}],
   validation:{field:'BC',op:'eq',val:'CON'},
   errorMsg:'ER.5.2 Cost Accounts Allowed in CON'},
  {id:'ER.6.1',module:'CV Rules',risk:'medium',desc:'Accounts 6211xxx Restricted to CON/DEV',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'starts',val:'6211'}]}],
   validation:{field:'BC',op:'eq',val:'CON'},
   errorMsg:'ER.6.1 Expense Accounts Restricted to CON DEV'},
  {id:'ER.6.2',module:'CV Rules',risk:'medium',desc:'Accounts 611300000-612099999 (OPP Set) in SGA/OPP/COM',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'between',lo:611300000,hi:612099999}]}],
   validation:{field:'BC',op:'eq',val:'SGA'},
   errorMsg:'ER.6.2 OPP Expense Accounts Set allows in SGA-OPP-COM'},
];

// ── SECTION 2: Compliance Best Practices (15 reglas de Controller) ──
// Reglas estructurales de control interno — riesgos de clasificación,
// manipulación de resultados y errores de posting. Independientes del timing.
const COMPLIANCE_RULES=[

  // ── RIESGO ALTO: Manipulación de P&L ─────────────────────────────
  {id:'CP.01',module:'Compliance',risk:'high',
   desc:'Asientos manuales en cuentas de INGRESO (4xxx) — riesgo de manipulación de revenue',
   insight:'Revenue nunca debe registrarse vía Spreadsheet. Oracle Revenue debe generarse desde Order Management o Billing.',
   conditionGroups:[{field:'SOURCE',checks:[{op:'eq',val:'Spreadsheet'}]},{field:'ACCOUNT',checks:[{op:'between',lo:400000000,hi:499999999}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CP.01 Manual revenue entry — earnings manipulation risk, requires CFO dual approval'},

  {id:'CP.02',module:'Compliance',risk:'high',
   desc:'CATEGORY=Adjustment en cuentas de ingreso (4xxx) — manipulación de resultados reportados',
   insight:'Los ajustes en revenue son la forma más común de manipulación de resultados. Todo ajuste >$0 en 4xxx es material.',
   conditionGroups:[{field:'CATEGORY',checks:[{op:'eq',val:'Adjustment'}]},{field:'ACCOUNT',checks:[{op:'between',lo:400000000,hi:499999999}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CP.02 Revenue adjustment — requires board-level approval and external auditor notification'},

  {id:'CP.03',module:'Compliance',risk:'high',
   desc:'Asientos manuales en cuentas de ACTIVO FIJO (1xxx) — riesgo CAPEX vs OPEX y fraude',
   insight:'Las adiciones de activos deben venir de Projects o Fixed Assets module, no de Spreadsheet. Manual = riesgo de capitalizar gastos.',
   conditionGroups:[{field:'SOURCE',checks:[{op:'eq',val:'Spreadsheet'}]},{field:'ACCOUNT',checks:[{op:'between',lo:100000000,hi:199999999}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CP.03 Manual fixed asset entry — verify CAPEX authorization and asset register update'},

  {id:'CP.04',module:'Compliance',risk:'high',
   desc:'Asientos manuales en cuentas de PATRIMONIO (3xxx) — requiere aprobación de directorio',
   insight:'Cualquier movimiento en equity fuera de procesos de cierre anual o emisión de capital es una señal de alerta crítica.',
   conditionGroups:[{field:'SOURCE',checks:[{op:'eq',val:'Spreadsheet'}]},{field:'ACCOUNT',checks:[{op:'between',lo:300000000,hi:399999999}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CP.04 Manual equity entry — board resolution and auditor disclosure required'},

  {id:'CP.05',module:'Compliance',risk:'high',
   desc:'Asientos manuales ACC_DEBIT >$1M USD — muy alto valor sin proceso de doble aprobación',
   insight:'>$1M manual = 99% de probabilidad de impacto material en estados financieros. Control: dual sign-off obligatorio.',
   conditionGroups:[{field:'SOURCE',checks:[{op:'eq',val:'Spreadsheet'}]},{field:'ACC_DEBIT',checks:[{op:'gt',val:'1000000'}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CP.05 Manual entry >$1M USD — mandatory CFO + Controller dual authorization'},

  // ── RIESGO ALTO: Intercompañía incompleta ─────────────────────────
  {id:'CP.06',module:'Compliance',risk:'high',
   desc:'Cuenta IC receivable (411xxx) sin código de entidad intercompañía — eliminación incompleta',
   insight:'Sin IC entity en 411xxx el proceso de eliminación en consolidación falla, generando activos fantasma en el consolidado.',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'between',lo:411000000,hi:411999999}]}],
   validation:{field:'INTERCOMPANY',op:'notEmpty',val:''},
   errorMsg:'CP.06 IC receivable without intercompany entity — consolidation elimination will fail'},

  {id:'CP.07',module:'Compliance',risk:'high',
   desc:'Cuenta IC cost/payable (511xxx) sin código de entidad intercompañía — eliminación incompleta',
   insight:'El espejo de la CP.06. Sin IC en ambos lados, los costos intercompañía quedan duplicados en el consolidado.',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'between',lo:511000000,hi:511999999}]}],
   validation:{field:'INTERCOMPANY',op:'notEmpty',val:''},
   errorMsg:'CP.07 IC cost account without intercompany entity — P&L duplication risk in consolidation'},

  // ── RIESGO MEDIO: Clasificación incorrecta ────────────────────────
  {id:'CP.08',module:'Compliance',risk:'medium',
   desc:'Cuentas de COSTO (5xxx) clasificadas como BC=SGA — debería ser OPP/COM/CON/DEV',
   insight:'Costos directos de proyecto (5xxx) en SGA distorsionan el margen operativo por proyecto y el análisis de rentabilidad.',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'between',lo:500000000,hi:599999999}]},{field:'BC',checks:[{op:'eq',val:'SGA'}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CP.08 Direct cost (5xxx) classified as SGA — impacts project margin and segment reporting'},

  {id:'CP.09',module:'Compliance',risk:'medium',
   desc:'Ingresos (4xxx) con BC fuera de OPP/COM — clasificación incorrecta de revenue',
   insight:'Revenue en Atlas debe ser 100% OPP o COM. Cualquier otro BC indica error de estructura o posting incorrecto.',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'between',lo:400000000,hi:499999999}]}],
   validation:{field:'BC',op:'in',val:'OPP,COM'},
   errorMsg:'CP.09 Revenue account with BC outside OPP/COM — segment revenue reporting impacted'},

  {id:'CP.10',module:'Compliance',risk:'medium',
   desc:'BC=CON/DEV en cuentas 5xxx-6xxx sin código de Proyecto asignado — CAPEX sin tracking',
   insight:'Todo gasto de construcción/desarrollo debe tener un Project para el WIP (Work In Progress) y capitalización correcta.',
   conditionGroups:[{field:'BC',checks:[{op:'eq',val:'CON'},{op:'eq',val:'DEV'}]},{field:'ACCOUNT',checks:[{op:'between',lo:500000000,hi:699999999}]}],
   validation:{field:'PROJECT',op:'notEmpty',val:''},
   errorMsg:'CP.10 CON/DEV expense without project code — WIP capitalization tracking incomplete'},

  {id:'CP.11',module:'Compliance',risk:'medium',
   desc:'Gastos 6xxx con BC=OPP y COSTCENTER=000000 — violación regla ER.1.1 (CC local obligatorio)',
   insight:'Gastos operativos OPP sin CC local no pueden asignarse a plantas/proyectos específicos para el P&L por activo.',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'between',lo:600000000,hi:699999999}]},{field:'BC',checks:[{op:'eq',val:'OPP'}]},{field:'COSTCENTER',checks:[{op:'eq',val:'000000'}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CP.11 OPP expense without local CC — plant-level P&L allocation impossible'},

  {id:'CP.12',module:'Compliance',risk:'medium',
   desc:'Asientos manuales en cuentas de PASIVO (2xxx) — riesgo de ajuste de deuda o provisiones ocultas',
   insight:'Pasivos manuales frecuentes indican: deuda no documentada, provisions ocultas o errores en treasury. Todo debe venir de módulos AP/Debt.',
   conditionGroups:[{field:'SOURCE',checks:[{op:'eq',val:'Spreadsheet'}]},{field:'ACCOUNT',checks:[{op:'between',lo:200000000,hi:299999999}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CP.12 Manual liability entry — verify against AP subledger and debt schedule'},

  {id:'CP.13',module:'Compliance',risk:'medium',
   desc:'Asientos manuales en cuentas de DEPRECIACIÓN (168xxx-169xxx) — debe ser automático',
   insight:'La depreciación es un proceso batch del Fixed Assets module. Si llega por Spreadsheet es un ajuste manual que requiere justificación actuarial.',
   conditionGroups:[{field:'SOURCE',checks:[{op:'eq',val:'Spreadsheet'}]},{field:'ACCOUNT',checks:[{op:'between',lo:168000000,hi:169999999}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CP.13 Manual depreciation — verify FA module calculation and useful life assumption'},

  {id:'CP.14',module:'Compliance',risk:'medium',
   desc:'CATEGORY=Revaluation con SOURCE=Spreadsheet — revaluación FX debe ser automática',
   insight:'Las revaluaciones de moneda extranjera manuales son un vector clásico de manipulación de diferencias de cambio y posiciones FX.',
   conditionGroups:[{field:'CATEGORY',checks:[{op:'eq',val:'Revaluation'}]},{field:'SOURCE',checks:[{op:'eq',val:'Spreadsheet'}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CP.14 Manual FX revaluation — must be generated by GL Revaluation program, not Spreadsheet'},

  {id:'CP.15',module:'Compliance',risk:'low',
   desc:'Provisiones (CATEGORY contains Provision) contabilizadas en cuentas de ingreso (4xxx)',
   insight:'Una provisión que afecta revenue en lugar de un gasto/pasivo es una señal de que se está reduciendo revenue en vez de reconocer un gasto correctamente.',
   conditionGroups:[{field:'CATEGORY',checks:[{op:'contains',val:'Provision'}]},{field:'ACCOUNT',checks:[{op:'between',lo:400000000,hi:499999999}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CP.15 Provision posted to revenue account — must post to expense (5xxx/6xxx) and liability (2xxx)'},
];

// ── SECTION 3: Period Close Rules (15 reglas de cierre) ──
// Riesgos específicos del proceso de cierre: timing, materialidad,
// accruals, IC, balance y concentración. Complementan las reglas de Compliance.
const CLOSE_RULES=[

  // ── TIMING: Deadline WD+6 ─────────────────────────────────────────
  {id:'CL.01',module:'Period Close',risk:'high',
   desc:'Asientos manuales registrados DESPUÉS del deadline WD+6 — violación del calendar de cierre',
   insight:'Cada asiento tardío requiere justificación formal. >3 asientos tardíos indican falla de proceso en la entidad.',
   conditionGroups:[{field:'SOURCE',checks:[{op:'eq',val:'Spreadsheet'}]}],
   validation:{field:'CREATION_DATE',op:'notEmpty',val:''},
   isDynamic:true,dynamicKey:'lateEntry',
   errorMsg:'CL.01 Manual entry after EOM+6 deadline — exception form and Controller approval required'},

  {id:'CL.02',module:'Period Close',risk:'high',
   desc:'Concentración de asientos manuales en ÚLTIMOS 3 DÍAS del período — ventana de riesgo de cierre',
   insight:'>50% del volumen manual en D-3 a D0 indica carga de trabajo desordenada y revisiones insuficientes. Objectivo: distribución uniforme.',
   conditionGroups:[{field:'SOURCE',checks:[{op:'eq',val:'Spreadsheet'}]}],
   validation:{field:'ACCOUNTING_DATE',op:'notEmpty',val:''},
   isDynamic:true,dynamicKey:'lastDaysEntry',
   errorMsg:'CL.02 Entry in last 3 days of period — verify adequate review and approval'},

  {id:'CL.03',module:'Period Close',risk:'high',
   desc:'Asientos manuales en fin de semana (Sáb/Dom) — control de autorización especial',
   insight:'Asientos de fin de semana sin protocolo son un red flag en auditoría interna y SOX. Requieren evidencia de aprobación fuera de horario.',
   conditionGroups:[{field:'SOURCE',checks:[{op:'eq',val:'Spreadsheet'}]}],
   validation:{field:'ACCOUNTING_DATE',op:'notEmpty',val:''},
   isDynamic:true,dynamicKey:'weekendEntry',
   errorMsg:'CL.03 Weekend manual entry — out-of-hours authorization evidence required'},

  // ── ACCRUALS Y PROVISIONES ────────────────────────────────────────
  {id:'CL.04',module:'Period Close',risk:'high',
   desc:'Accruals (CATEGORY=Accrual) en cuentas de INGRESO (4xxx) — riesgo crítico de revenue recognition',
   insight:'Un accrual en revenue es la forma más sofisticada de adelantar ingresos. IFRS 15: revenue solo cuando se satisface la obligación de desempeño.',
   conditionGroups:[{field:'CATEGORY',checks:[{op:'eq',val:'Accrual'}]},{field:'ACCOUNT',checks:[{op:'between',lo:400000000,hi:499999999}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CL.04 Revenue accrual — IFRS 15 compliance risk, requires specific performance obligation evidence'},

  {id:'CL.05',module:'Period Close',risk:'high',
   desc:'Provisiones >$500K USD (ACC_DEBIT) sin Business Category — provisión material sin clasificar',
   insight:'Una provisión sin BC no puede asignarse a segmento, proyecto o entidad en el reporte de gestión. >$500K es siempre material.',
   conditionGroups:[{field:'CATEGORY',checks:[{op:'contains',val:'Provision'}]},{field:'ACC_DEBIT',checks:[{op:'gt',val:'500000'}]},{field:'BC',checks:[{op:'eq',val:'000'}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CL.05 Material provision >$500K without BC — management reporting and segment disclosure impacted'},

  {id:'CL.06',module:'Period Close',risk:'high',
   desc:'Accruals de alto valor >$200K USD — requieren soporte de cálculo y aprobación del Controller',
   insight:'Los accruals más frecuentes en renovables: O&M, intereses de proyecto, deuda PF. >$200K necesita tabla de amortización o contrato de soporte.',
   conditionGroups:[{field:'CATEGORY',checks:[{op:'eq',val:'Accrual'}]},{field:'ACC_DEBIT',checks:[{op:'gt',val:'200000'}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CL.06 Large accrual >$200K — attach calculation schedule: interest table, O&M invoice, or contract'},

  // ── INTERCOMPAÑÍA AL CIERRE ───────────────────────────────────────
  {id:'CL.07',module:'Period Close',risk:'high',
   desc:'Código INTERCOMPANY asignado en cuenta de gasto (6xxx) — routing incorrecto de transacción IC',
   insight:'Un IC entity en cuenta de gasto indica que la transacción fue ruteada al libro equivocado. El consolidado mostrará descuadres y duplicados.',
   conditionGroups:[{field:'INTERCOMPANY',checks:[{op:'notEmpty',val:''}]},{field:'ACCOUNT',checks:[{op:'between',lo:600000000,hi:699999999}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CL.07 IC entity code in expense account (6xxx) — likely wrong account; verify IC routing table'},

  {id:'CL.08',module:'Period Close',risk:'medium',
   desc:'Balance global ACC: saldo neto != $0 USD — el mayor no esta cuadrado en dolares',
   insight:'Un mayor descuadrado en moneda de reporte indica error de conversión FX, asiento faltante o carga incompleta del período.',
   conditionGroups:[{field:'ACC_DEBIT',checks:[{op:'gt',val:'0'}]}],
   validation:{field:'ACC_DEBIT',op:'notEmpty',val:''},
   isGlobal:true,globalKey:'accBalance',
   errorMsg:'CL.08 Global ACC out of balance (USD) — verify FX conversion and period-end journal completeness'},

  // ── AJUSTES DE CIERRE DE ALTO RIESGO ─────────────────────────────
  {id:'CL.09',module:'Period Close',risk:'medium',
   desc:'Ajustes manuales >$100K en cuentas de BALANCE (1xxx/2xxx) — BS adjustment sin proceso formal',
   insight:'Balance sheet adjustments grandes manuales son señal de conciliaciones pendientes o errores no corregidos por módulos fuente.',
   conditionGroups:[{field:'SOURCE',checks:[{op:'eq',val:'Spreadsheet'}]},{field:'ACCOUNT',checks:[{op:'between',lo:100000000,hi:299999999}]},{field:'ACC_DEBIT',checks:[{op:'gt',val:'100000'}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CL.09 Manual BS adjustment >$100K — reconcile against subledger before sign-off'},

  {id:'CL.10',module:'Period Close',risk:'medium',
   desc:'CATEGORY=Adjustment en cuentas de COSTOS (5xxx) al cierre — reclasificación de costos de proyecto',
   insight:'Ajustes en costos directos cambian márgenes por proyecto. Frecuente en renovables para reasignar O&M entre plantas.',
   conditionGroups:[{field:'CATEGORY',checks:[{op:'eq',val:'Adjustment'}]},{field:'ACCOUNT',checks:[{op:'between',lo:500000000,hi:599999999}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CL.10 Cost adjustment (5xxx) — verify project reallocation has operations management approval'},

  {id:'CL.11',module:'Period Close',risk:'medium',
   desc:'Revaluaciones FX manuales (SOURCE=Spreadsheet) — debe ser proceso automático de GL',
   insight:'La revaluación manual crea riesgo de: tasas incorrectas, doble revaluación, o manipulación de diferencias de cambio.',
   conditionGroups:[{field:'CATEGORY',checks:[{op:'eq',val:'Revaluation'}]},{field:'SOURCE',checks:[{op:'eq',val:'Spreadsheet'}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CL.11 Manual FX revaluation — run GL Revaluation program; verify exchange rates match treasury rates'},

  {id:'CL.12',module:'Period Close',risk:'medium',
   desc:'Provisiones (CATEGORY=Provision) con ACC_DEBIT negativo — dirección de posting incorrecta',
   insight:'Una provisión que debita negativo (= crédito neto en gasto) puede estar revirtiendo una provisión anterior sin documentar.',
   conditionGroups:[{field:'CATEGORY',checks:[{op:'contains',val:'Provision'}]},{field:'ACC_DEBIT',checks:[{op:'lt',val:'0'}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CL.12 Provision with negative ACC_DEBIT — verify if this is a provision reversal; check prior period'},

  {id:'CL.13',module:'Period Close',risk:'medium',
   desc:'Asientos de apertura/cierre en cuentas 9xxx (eliminación) sin BC=ZZZ',
   insight:'Las entradas de eliminación intercompañía deben tener siempre BC=ZZZ. Sin este flag, no se eliminan en el proceso de consolidación.',
   conditionGroups:[{field:'ACCOUNT',checks:[{op:'starts',val:'9'}]}],
   validation:{field:'BC',op:'eq',val:'ZZZ'},
   errorMsg:'CL.13 Elimination account (9xxx) without BC=ZZZ — consolidation elimination process will miss this entry'},

  {id:'CL.14',module:'Period Close',risk:'low',
   desc:'Accruals con ACC_CREDIT negativo — posible reversión de accrual sin documentar',
   insight:'Un accrual con crédito negativo es técnicamente un cargo, lo que sugiere reversión de período anterior sin categoría adecuada.',
   conditionGroups:[{field:'CATEGORY',checks:[{op:'eq',val:'Accrual'}]},{field:'ACC_CREDIT',checks:[{op:'lt',val:'0'}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CL.14 Accrual with negative ACC_CREDIT — verify this is not an undocumented prior-period reversal'},

  {id:'CL.15',module:'Period Close',risk:'low',
   desc:'Importes ACC negativos (ACC_DEBIT<0 o ACC_CREDIT<0) — error de conversión FX o posting incorrecto',
   insight:'Montos negativos en columnas ACC indican: error de conversión de moneda, tasa FX negativa, o asiento revertido incorrectamente.',
   conditionGroups:[{field:'ACC_DEBIT',checks:[{op:'lt',val:'0'},{op:'lt',val:'-1'}]}],
   validation:{field:'SOURCE',op:'eq',val:'__NEVER__'},
   errorMsg:'CL.15 Negative ACC_DEBIT — FX conversion error or incorrect reversal posting'},
];

// ── Run engine for ONE section's rules ─────────────────
const runSection=(rows,rules,closeDate)=>{
  const codes=[...new Set(rows.map(r=>cc(r.COMPANY)).filter(Boolean))].sort();
  return rules.map(rule=>{
    let matching, violations;

    if(rule.isDynamic&&rule.dynamicKey==='lateEntry'&&closeDate){
      const cd=new Date(closeDate);
      matching=rows.filter(r=>{const s=String(r.SOURCE||'');return s.toLowerCase().includes('spreadsheet')||s.toLowerCase().includes('manual');});
      violations=matching.filter(r=>{const d=parseAnyDate(r.CREATION_DATE||r.ACCOUNTING_DATE);return d&&d>cd;});
    } else if(rule.isDynamic&&rule.dynamicKey==='lastDaysEntry'){
      // Flag manual entries in last 3 calendar days of the month
      const eomMatch=closeDate?String(closeDate).substring(0,7):String(new Date().toISOString()).substring(0,7);
      const eomDate=new Date(eomMatch+'-28'); // approximate EOM
      // Adjust to real EOM
      const lastDay=new Date(new Date(eomDate.getFullYear(),eomDate.getMonth()+1,0));
      const riskStart=new Date(lastDay);riskStart.setDate(lastDay.getDate()-2);
      matching=rows.filter(r=>evalCondGroups(r,rule.conditionGroups));
      violations=matching.filter(r=>{
        const d=parseAnyDate(r.ACCOUNTING_DATE);
        if(!d)return false;
        return d>=riskStart&&d<=lastDay;
      });
    } else if(rule.isDynamic&&rule.dynamicKey==='weekendEntry'){
      matching=rows.filter(r=>evalCondGroups(r,rule.conditionGroups));
      violations=matching.filter(r=>{const d=parseAnyDate(r.ACCOUNTING_DATE);if(!d)return false;const day=d.getDay();return day===0||day===6;});
    } else if(rule.isGlobal&&rule.globalKey==='accBalance'){
      const tD=rows.reduce((s,r)=>s+Math.abs(Number(r.ACC_DEBIT||0)),0);
      const tC=rows.reduce((s,r)=>s+Math.abs(Number(r.ACC_CREDIT||0)),0);
      const diff=Math.abs(tD-tC);
      matching=rows.slice(0,1); // synthetic
      violations=diff>100?rows.slice(0,1):[];
    } else {
      // General evaluator — supports all ops including 'in', 'notIn'
      matching=rows.filter(r=>evalCondGroups(r,rule.conditionGroups));
      violations=matching.filter(r=>{
        const v=rule.validation;
        if(!v||!v.field)return false;
        const chk=v.op==='in'||v.op==='notIn'?{op:v.op,val:String(v.val||v.value||'')}:{op:v.op,...v};
        return !evalGroup(r,{field:v.field,checks:[chk]});
      });
    }

    // USD net balance: ACC_DEBIT - ACC_CREDIT (saldo neto)
    const netAmt=r=>Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0);
    const amtUSD=violations.reduce((s,r)=>s+netAmt(r),0);
    const byCountry={};
    codes.forEach(c=>{
      const cm=matching.filter(r=>cc(r.COMPANY)===c);
      const cv=violations.filter(r=>cc(r.COMPANY)===c);
      const amt=cv.reduce((s,r)=>s+netAmt(r),0);
      byCountry[c]={m:cm.length,v:cv.length,amt,pct:cm.length>0?Math.round(cv.length/cm.length*100):null};
    });
    const pct=matching.length>0?Math.round(violations.length/matching.length*100):0;
    return{...rule,matching:matching.length,violations:violations.length,amtUSD,pct,
      status:violations.length===0?'pass':pct<5?'warn':'fail',byCountry,_violations:violations};
  });
};

const getViolations=(rawRows,rule,countryCode,closeDate)=>{
  const tempResult=runSection(countryCode==='ALL'?rawRows:rawRows.filter(r=>cc(r.COMPANY)===countryCode),[rule],closeDate);
  return tempResult[0]?._violations||[];
};

// ── Score helpers ──────────────────────────────────────
const sectionScore=(sectionResults,code)=>{
  const key=code==='ALL'?'all':'country';
  const tM=sectionResults.reduce((s,r)=>s+(code==='ALL'?r.matching:(r.byCountry[code]?.m||0)),0);
  const tV=sectionResults.reduce((s,r)=>s+(code==='ALL'?r.violations:(r.byCountry[code]?.v||0)),0);
  const tA=sectionResults.reduce((s,r)=>s+(code==='ALL'?r.amtUSD:(r.byCountry[code]?.amt||0)),0);
  return tM===0?null:{pct:Math.round((tM-tV)/tM*100),violations:tV,matching:tM,amtUSD:tA};
};
const scoreBadge=pct=>{
  if(pct===null)return{bg:A.light,col:A.t4,bord:A.light2,txt:'—'};
  if(pct>=95)return{bg:A.passL,col:A.pass,bord:A.passB,txt:pct+'%'};
  if(pct>=80)return{bg:A.warnL,col:A.warn,bord:A.warnB,txt:pct+'%'};
  return{bg:A.failL,col:A.fail,bord:A.failB,txt:pct+'%'};
};
const cellStyle=(v,m,amt)=>{
  if(m===0||v===null)return{bg:A.light,col:A.t4,txt:'—',amtTxt:'',click:false};
  if(v===0)return{bg:A.passL,col:A.pass,txt:'✓',amtTxt:'',click:false};
  const p=v/m;
  return p<0.05?{bg:A.warnL,col:A.warn,txt:String(v),amtTxt:fmtUSD(amt),click:true}
    :{bg:A.failL,col:A.fail,txt:String(v),amtTxt:fmtUSD(amt),click:true};
};
const ST={pass:{bg:A.passL,bord:A.passB,col:A.pass,lbl:'✓ PASS'},warn:{bg:A.warnL,bord:A.warnB,col:A.warn,lbl:'⚠ WARN'},fail:{bg:A.failL,bord:A.failB,col:A.fail,lbl:'✕ FAIL'}};
const RC={high:A.fail,medium:A.warn,low:A.pass};
const PAGE=25;

// ── Export functions ───────────────────────────────────
const exportViolations=(rows,ruleId,countryCode,errorMsg)=>{
  if(!rows.length){alert('Sin violaciones para exportar');return;}
  const COLS=['JOURNAL_NAME','SOURCE','CATEGORY','COMPANY','BC','ACCOUNT','COSTCENTER','PROJECT','INTERCOMPANY','ACC_DEBIT','ACC_CREDIT','ENT_DEBIT','ENT_CREDIT','CURRENCY_CODE','DESCRIPTION','ACCOUNTING_DATE','CREATION_DATE'];
  const data=rows.map(r=>{const net=Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0);const o={'RULE_ID':ruleId,'ERROR_MSG':errorMsg,'NET_BALANCE_USD':Math.round(net)};COLS.forEach(c=>{o[c]=r[c]??'';});return o;});
  const ws=XLSX.utils.json_to_sheet(data);
  XLSX.writeFile(XLSX.utils.book_append_sheet(XLSX.utils.book_new(),ws,'Violations'),`ATLAS_${ruleId}_${countryCode}_${new Date().toISOString().substring(0,10)}.xlsx`);
};
const exportManagerReport=(rawRows,allResults,ccodes,period)=>{
  const wb=XLSX.utils.book_new();
  const SECTIONS=[{key:'CV Rules',label:'CV Rules'},{key:'Compliance',label:'Compliance'},{key:'Period Close',label:'Period Close'}];
  // Summary
  const sum=[['ATLAS RENEWABLE ENERGY — GL Cross-Validation Report',period,'','','USD Amounts (ACC_DEBIT/ACC_CREDIT)'],[''],
    ['Section','Rule ID','Description','Risk','Matching','Violations','Viol%','Amount USD','Status'],
    ...allResults.map(r=>[r.module,r.id,r.desc,r.risk,r.matching,r.violations,r.pct+'%',Math.round(r.amtUSD||0),r.status.toUpperCase()])];
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(sum),'Summary');
  // Score by country
  const scoreRows=[['Country','Section','Score%','Violations','Amount USD']];
  ccodes.forEach(code=>{
    const{flag,name}=ci(code);
    SECTIONS.forEach(sec=>{
      const secRes=allResults.filter(r=>r.module===sec.key);
      const sc=sectionScore(secRes,code);
      if(sc)scoreRows.push([`${flag} ${name}`,sec.key,sc.pct+'%',sc.violations,Math.round(sc.amtUSD)]);
    });
  });
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(scoreRows),'Scores by Country');
  // Per-country violation sheets
  ccodes.forEach(code=>{
    const{flag,name}=ci(code);
    const sheetRows=[['ATLAS RE',`${flag} ${name}`,period,'','ACC_DEBIT/ACC_CREDIT = USD'],
      ['Section','Rule ID','Error Message','Journal','Source','Company','BC','Account','CC','Project','IC','ACC Debit','ACC Credit','Description','Date']];
    allResults.forEach(rule=>{
      (rule._violations||[]).filter(r=>code==='ALL'||cc(r.COMPANY)===code).forEach(row=>{
        sheetRows.push([rule.module,rule.id,rule.errorMsg,row.JOURNAL_NAME||'',row.SOURCE||'',row.COMPANY||'',row.BC||'',rv(row,'ACCOUNT'),row.COSTCENTER||'',row.PROJECT||'',row.INTERCOMPANY||'',row.ACC_DEBIT||0,row.ACC_CREDIT||0,row.DESCRIPTION||'',row.ACCOUNTING_DATE||'']);
      });
    });
    if(sheetRows.length>2)XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(sheetRows),code.substring(0,31));
  });
  XLSX.writeFile(wb,`ATLAS_Manager_Report_${period.replace(/[^a-zA-Z0-9]/g,'_')}.xlsx`);
};

// ══════════════════════════════════════════════════════
// HEATMAP COMPONENT (reused in 3 sections)
// ══════════════════════════════════════════════════════
function Heatmap({sectionResults,ccodes,onCellClick,sectionLabel}){
  if(!sectionResults?.length)return <div style={{padding:'40px',textAlign:'center',color:A.t3,fontFamily:mono,fontSize:12}}>Carga un archivo GL para ver resultados.</div>;
  const globalSc=sectionScore(sectionResults,'ALL');
  return(
    <div style={{overflowX:'auto'}}>
      <div style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,overflow:'hidden',minWidth:650,boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
        {/* Header */}
        <div style={{display:'grid',gridTemplateColumns:`240px 100px repeat(${ccodes.length},1fr)`,background:A.dark,fontFamily:cond,fontSize:11,fontWeight:700,letterSpacing:'0.08em',color:'rgba(255,255,255,.55)',textTransform:'uppercase'}}>
          <div style={{padding:'12px 16px'}}>Regla / Descripción</div>
          <div style={{padding:'12px 6px',textAlign:'center',borderLeft:`1px solid rgba(255,255,255,.08)`}}>Total (USD)</div>
          {ccodes.map(c=>{const{flag,short}=ci(c);return(
            <div key={c} style={{padding:'10px 4px',textAlign:'center',borderLeft:`1px solid rgba(255,255,255,.08)`}}>
              <div style={{fontSize:18}}>{flag}</div><div style={{fontSize:9,marginTop:1}}>{short}</div>
            </div>
          );})}
        </div>
        {/* Rule rows */}
        {sectionResults.map((r,i)=>(
          <div key={r.id} style={{display:'grid',gridTemplateColumns:`240px 100px repeat(${ccodes.length},1fr)`,borderBottom:`1px solid ${A.light}`,background:A.white}}>
            <div style={{padding:'10px 16px',borderRight:`1px solid ${A.light}`}}>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:2}}>
                <span style={{fontFamily:mono,fontSize:10,fontWeight:700,color:A.orange}}>{r.id}</span>
                <span style={{fontSize:9,fontWeight:700,padding:'1px 5px',borderRadius:3,background:r.risk==='high'?A.failL:r.risk==='medium'?A.warnL:A.passL,color:RC[r.risk]}}>{r.risk?.toUpperCase()}</span>
              </div>
              <div style={{fontSize:11,color:A.t2,lineHeight:1.3}}>{r.desc.substring(0,70)}{r.desc.length>70?'…':''}</div>
              {r.insight&&<div style={{fontFamily:mono,fontSize:9,color:A.orange,marginTop:3,lineHeight:1.4,background:'rgba(232,82,10,0.05)',padding:'3px 6px',borderRadius:3}}>💡 {r.insight.substring(0,100)}{r.insight.length>100?'…':''}</div>}
            </div>
            {/* Global */}
            <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',borderRight:`1px solid ${A.light}`,padding:'6px 4px',cursor:r.violations>0?'pointer':'default',background:r.violations>0?A.failL:'transparent'}}
              onClick={()=>r.violations>0&&onCellClick(r,'ALL')}>
              <div style={{fontFamily:cond,fontSize:15,fontWeight:800,color:r.violations>0?A.fail:A.pass,lineHeight:1}}>{r.violations||'✓'}</div>
              {r.violations>0&&<div style={{fontFamily:mono,fontSize:9,color:A.fail,marginTop:1}}>{fmtUSD(r.amtUSD)}</div>}
              {r.violations>0&&<div style={{fontFamily:mono,fontSize:8,color:A.t4}}>{r.pct}%</div>}
            </div>
            {/* Per country */}
            {ccodes.map(c=>{const d=r.byCountry[c]||{m:0,v:0,amt:0};const cs=cellStyle(d.v,d.m,d.amt);return(
              <div key={c} onClick={()=>cs.click&&onCellClick(r,c)}
                style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',background:cs.bg,borderLeft:`1px solid ${A.light}`,padding:'6px 2px',minHeight:50,cursor:cs.click?'pointer':'default',transition:'filter .1s'}}>
                <div style={{fontFamily:cond,fontSize:15,fontWeight:800,color:cs.col,lineHeight:1}}>{cs.txt}</div>
                {cs.amtTxt&&<div style={{fontFamily:mono,fontSize:8,color:cs.col,opacity:.8,marginTop:1}}>{cs.amtTxt}</div>}
                {d.m>0&&d.v>0&&<div style={{fontFamily:mono,fontSize:8,color:cs.col,opacity:.55}}>{d.pct}%</div>}
              </div>
            );})}
          </div>
        ))}
        {/* Score row */}
        <div style={{display:'grid',gridTemplateColumns:`240px 100px repeat(${ccodes.length},1fr)`,background:A.dark,borderTop:`2px solid ${A.orange}`}}>
          <div style={{padding:'12px 16px',display:'flex',alignItems:'center',gap:8}}>
            <span style={{background:`linear-gradient(135deg,${A.orange},${A.amber})`,color:A.white,fontFamily:cond,fontWeight:800,fontSize:11,padding:'4px 10px',borderRadius:4,letterSpacing:'0.06em',textTransform:'uppercase'}}>🎯 {sectionLabel}</span>
          </div>
          {/* Global score */}
          <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',borderRight:`1px solid rgba(255,255,255,.08)`}}>
            {(()=>{const sb=scoreBadge(globalSc?.pct??null);return(<div style={{textAlign:'center'}}>
              <div style={{fontFamily:cond,fontSize:20,fontWeight:800,color:sb.col,lineHeight:1}}>{sb.txt}</div>
              {globalSc?.violations>0&&<div style={{fontFamily:mono,fontSize:8,color:'rgba(255,255,255,.3)',marginTop:1}}>{globalSc.violations} err · {fmtUSD(globalSc.amtUSD)}</div>}
            </div>);})()}
          </div>
          {ccodes.map(c=>{
            const sc=sectionScore(sectionResults,c);const sb=scoreBadge(sc?.pct??null);const{flag,name}=ci(c);
            return(<div key={c} style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',borderLeft:`1px solid rgba(255,255,255,.08)`,padding:'8px 4px',background:sc?.pct!=null?(sc.pct>=95?'rgba(26,122,60,.2)':sc.pct>=80?'rgba(217,119,6,.18)':'rgba(204,42,42,.22)'):'transparent'}}>
              <div style={{fontFamily:cond,fontSize:20,fontWeight:800,color:sb.col,lineHeight:1}}>{sb.txt}</div>
              <div style={{fontFamily:mono,fontSize:8,color:'rgba(255,255,255,.35)',marginTop:1}}>{flag} {name}</div>
              {sc?.violations>0&&<div style={{fontFamily:mono,fontSize:8,color:sb.col,opacity:.7,marginTop:1}}>{sc.violations} · {fmtUSD(sc.amtUSD)}</div>}
            </div>);
          })}
        </div>
      </div>
      <div style={{display:'flex',gap:14,fontSize:11,color:A.t3,marginTop:8,flexWrap:'wrap',alignItems:'center'}}>
        <span>🟢 0 violaciones</span><span>🟡 &lt;5% viol. rate</span><span>🔴 >=5% viol. rate</span>
        <span style={{color:A.orange,fontWeight:600}}>Clic en celda con error → detalle de líneas</span>
        <span>Número inferior = monto en <strong>USD (ACC_DEBIT/ACC_CREDIT)</strong></span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// DETAIL PANEL COMPONENT
// ══════════════════════════════════════════════════════
function DetailPanel({detail,onClose,onExport,showGood,onToggleGood}){
  if(!detail)return null;
  const {rule,countryCode,rows,compliantRows,page}=detail;
  const displayRows=showGood?(compliantRows||[]):rows;
  const totalVioUSD=rows.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);
  const totalGoodUSD=(compliantRows||[]).reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);
  const totalUSD=showGood?totalGoodUSD:totalVioUSD;

  const isZeroField=(val,field)=>{
    const s=String(val||'').trim();
    if(field==='COSTCENTER')return['0','000000',''].includes(s);
    if(field==='INTERCOMPANY')return['0','00000','','non-ic'].includes(s.toLowerCase());
    if(field==='BC')return['0','000',''].includes(s);
    if(field==='PROJECT')return['0','00000','zzzzz',''].includes(s.toLowerCase());
    return false;
  };

  const RowTable=({rowList,isGood})=>(
    <div style={{background:A.white,border:`1px solid ${A.light2}`,overflowX:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontFamily:mono,fontSize:11}}>
        <thead><tr style={{background:isGood?A.passL:A.light,borderBottom:`1px solid ${A.light2}`}}>
          {['#','COMPANY','JOURNAL','SOURCE','CATEGORY','BC','ACCOUNT','COSTCENTER','PROJECT','IC','ACC DEBIT','ACC CREDIT','SALDO NETO USD','CCY','FECHA'].map(h=>(
            <th key={h} style={{padding:'8px 10px',textAlign:'left',color:h==='SALDO NETO USD'?A.orange:isGood?A.pass:A.t3,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.06em',whiteSpace:'nowrap',fontSize:9,borderRight:`1px solid ${A.light2}`,background:h==='SALDO NETO USD'?'rgba(232,82,10,0.05)':''}}>{h}</th>
          ))}
        </tr></thead>
        <tbody>
          {rowList.slice(page*PAGE,(page+1)*PAGE).map((row,i)=>{
            const errCC=!isGood&&isZeroField(row.COSTCENTER,'COSTCENTER');
            const errIC=!isGood&&isZeroField(row.INTERCOMPANY,'INTERCOMPANY');
            const errBC=!isGood&&isZeroField(row.BC,'BC');
            const errProj=!isGood&&isZeroField(row.PROJECT,'PROJECT');
            const netRow=Number(row.ACC_DEBIT||0)-Number(row.ACC_CREDIT||0);
            const netColor=netRow>0?A.fail:netRow<0?A.info:A.t3;
            return(<tr key={i} style={{borderBottom:`1px solid ${A.light}`,background:isGood?(i%2===0?'#f0fdf4':'#ecfdf5'):(i%2===0?A.white:A.off)}}>
              <td style={{padding:'7px 10px',color:A.t4,fontSize:10,fontWeight:600,borderRight:`1px solid ${A.light}`}}>{page*PAGE+i+1}</td>
              {[
                [row.COMPANY,false,false],[row.JOURNAL_NAME,false,false],[row.SOURCE,false,false],[row.CATEGORY||'—',false,false],
                [row.BC,errBC,false],[rv(row,'ACCOUNT'),false,false],[rv(row,'COSTCENTER'),errCC,false],
                [rv(row,'PROJECT'),errProj,false],[rv(row,'INTERCOMPANY'),errIC,false],
                [Math.round(Number(row.ACC_DEBIT||0)).toLocaleString('en-US'),false,false],
                [Math.round(Number(row.ACC_CREDIT||0)).toLocaleString('en-US'),false,false],
                [fmtFull(netRow),false,true],
                [row.CURRENCY_CODE||'—',false,false],
                [excelDateToISO(row.ACCOUNTING_DATE)||'—',false,false],
              ].map(([val,isErr,isNet],j)=>(
                <td key={j} style={{padding:'7px 10px',color:isErr?A.fail:isNet?netColor:isGood?A.pass:A.t2,whiteSpace:'nowrap',maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',fontWeight:isErr||isNet?700:isGood?600:400,background:isErr?A.failL:isNet?'rgba(232,82,10,0.03)':isGood?'':'',borderRight:`1px solid ${A.light}`}}>
                  {isErr&&'⚑ '}{isGood&&isNet&&'✓ '}{String(val??'—')}
                </td>
              ))}
            </tr>);
          })}
        </tbody>
      </table>
    </div>
  );

  return(
    <div style={{marginTop:24,animation:'fadeUp .3s ease'}}>
      {/* Header */}
      <div style={{background:A.dark,borderRadius:'10px 10px 0 0',borderTop:`3px solid ${A.orange}`,padding:'16px 22px',display:'flex',alignItems:'flex-start',justifyContent:'space-between',flexWrap:'wrap',gap:10}}>
        <div>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6,flexWrap:'wrap'}}>
            <span style={{fontFamily:mono,fontSize:13,fontWeight:700,color:A.amberL}}>{rule.id}</span>
            {countryCode!=='ALL'&&<span style={{fontSize:20}}>{ci(countryCode).flag}</span>}
            <span style={{fontFamily:cond,fontSize:14,fontWeight:700,color:A.white}}>{countryCode==='ALL'?'Todos los países':ci(countryCode).name}</span>
            <span style={{background:A.failL,color:A.fail,fontWeight:700,fontSize:11,padding:'3px 10px',borderRadius:4}}>✕ {rows.length} violaciones · {fmtFull(totalVioUSD)}</span>
            <span style={{background:A.passL,color:A.pass,fontWeight:700,fontSize:11,padding:'3px 10px',borderRadius:4}}>✓ {(compliantRows||[]).length} correctos · {fmtFull(totalGoodUSD)}</span>
          </div>
          <div style={{fontSize:13,color:'rgba(255,255,255,.7)',marginBottom:3}}>{rule.desc}</div>
          <div style={{fontFamily:mono,fontSize:11,color:A.amberL}}>⚑ {rule.errorMsg}</div>
          {rule.insight&&<div style={{fontFamily:mono,fontSize:10,color:A.amberL,opacity:.7,marginTop:4}}>💡 {rule.insight}</div>}
        </div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
          <button onClick={onToggleGood} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'8px 16px',borderRadius:6,fontFamily:body,fontWeight:600,fontSize:12,cursor:'pointer',background:showGood?A.pass:'transparent',border:`1.5px solid ${showGood?A.pass:A.passB}`,color:showGood?A.white:A.pass}}>
            {showGood?'👁 Mostrando OK':'✓ Ver Correctos'}
          </button>
          <button onClick={onExport} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'8px 16px',borderRadius:6,fontFamily:body,fontWeight:600,fontSize:12,cursor:'pointer',background:A.orange,border:`1.5px solid ${A.orange}`,color:A.white}}>⬇ Exportar Errores</button>
          <button onClick={()=>onClose(null)} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'8px 14px',borderRadius:6,fontFamily:body,fontWeight:600,fontSize:12,cursor:'pointer',background:'transparent',border:`1.5px solid ${A.failB}`,color:A.failB}}>✕ Cerrar</button>
        </div>
      </div>
      {/* Toggle bar */}
      <div style={{background:showGood?A.passL:A.failL,border:`1px solid ${showGood?A.passB:A.failB}`,padding:'8px 20px',display:'flex',alignItems:'center',gap:12}}>
        <span style={{fontSize:12,fontWeight:700,color:showGood?A.pass:A.fail}}>{showGood?`✓ ${displayRows.length} líneas que CUMPLEN la regla ${rule.id}`:`✕ ${displayRows.length} líneas con VIOLACIÓN de la regla ${rule.id}`}</span>
        <span style={{fontSize:11,color:showGood?A.pass:A.fail,fontFamily:mono}}>Saldo neto USD: {fmtFull(totalUSD)}</span>
        {showGood&&<span style={{fontSize:11,color:A.t3}}>— Los campos resaltados en verde confirman cumplimiento</span>}
        {!showGood&&<span style={{fontSize:11,color:A.t3}}>— Los campos marcados con ⚑ son los que incumplen la regla</span>}
      </div>
      {/* Table */}
      <RowTable rowList={displayRows} isGood={showGood}/>
      {/* Pagination */}
      <div style={{background:A.light,border:`1px solid ${A.light2}`,borderRadius:'0 0 10px 10px',padding:'10px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:8}}>
        <span style={{fontSize:12,color:A.t3}}>Mostrando <strong>{page*PAGE+1}–{Math.min((page+1)*PAGE,displayRows.length)}</strong> de <strong style={{color:showGood?A.pass:A.fail}}>{displayRows.length}</strong> · Saldo neto: <strong style={{color:totalUSD>=0?A.fail:A.info}}>{fmtFull(totalUSD)}</strong></span>
        <div style={{display:'flex',gap:6}}>
          <button onClick={()=>onClose({...detail,page:Math.max(0,page-1)})} disabled={page===0} style={{padding:'5px 12px',borderRadius:6,fontFamily:mono,fontSize:11,background:A.white,border:`1px solid ${A.light2}`,color:A.t2,opacity:page===0?.4:1}}>← Prev</button>
          <span style={{fontFamily:mono,fontSize:11,color:A.t2,padding:'5px 12px',background:A.white,border:`1px solid ${A.light2}`,borderRadius:6}}>Pág {page+1}/{Math.ceil(displayRows.length/PAGE)||1}</span>
          <button onClick={()=>onClose({...detail,page:Math.min(Math.ceil(displayRows.length/PAGE)-1,page+1)})} disabled={(page+1)*PAGE>=displayRows.length} style={{padding:'5px 12px',borderRadius:6,fontFamily:mono,fontSize:11,background:A.white,border:`1px solid ${A.light2}`,color:A.t2,opacity:(page+1)*PAGE>=displayRows.length?.4:1}}>Next →</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// WD ANALYSIS COMPONENT
// ══════════════════════════════════════════════════════
const SOURCE_COLORS={'Payables':'#1D4ED8','Receivables':'#059669','Spreadsheet':A.orange,'Revaluation':'#7C3AED','WFN Cash':'#D97706','WFN Financing':'#DC2626','Manual':A.orange,'Other':'#6B7280'};
const srcColor=s=>SOURCE_COLORS[s]||SOURCE_COLORS.Other;

function WDAnalysis({rawRows,ccodes,period}){
  const [filterSource,setFilterSource]=useState('ALL');
  const [filterCountry,setFilterCountry]=useState('ALL');
  const [metric,setMetric]=useState('lines');

  if(!rawRows||!rawRows.length){
    return <div style={{padding:40,textAlign:'center',color:A.t3,fontFamily:mono}}>Carga un GL para ver el análisis WD.</div>;
  }

  // ── Working day offset from close date ────────────────
  // closeDate = WD+6. All dates are placed relative to it.
  // positive offset = before close (WD-N to WD+6), negative = after (WD+7, WD+8...)
  const mIdx=getPeriodMonth(period);
  const cal=CLOSE_CALENDAR[mIdx]||CLOSE_CALENDAR[4];
  const closeDate=new Date(cal.close);    // e.g. 2026-04-10

  const WD_CACHE={};
  const getWD=(dateVal)=>{
    if(!dateVal&&dateVal!==0)return null;
    const d=parseAnyDate(dateVal);
    if(!d||isNaN(d.getTime()))return null;
    const key=d.toISOString().substring(0,10);
    if(WD_CACHE[key]!==undefined)return WD_CACHE[key];
    // Count working days between d and closeDate
    const isAfter=d>closeDate;
    const start=isAfter?new Date(closeDate):new Date(d);
    const end=isAfter?new Date(d):new Date(closeDate);
    let wdays=0;
    const cur=new Date(start);
    while(cur<end){cur.setDate(cur.getDate()+1);if(cur.getDay()!==0&&cur.getDay()!==6)wdays++;}
    // closeDate = WD+6, so wd = 6 - wdays (before) or 6 + wdays (after)
    const wd=isAfter?6+wdays:6-wdays;
    WD_CACHE[key]=wd;
    return wd;
  };

  // ── Zone definitions ──────────────────────────────────
  // WD > 6        : LATE (red) - after deadline
  // WD 1 to 6     : CLOSE WINDOW (orange) - normal close activity
  // WD -3 to 0    : PRE-CLOSE (amber) - approaching deadline
  // WD < -3       : EARLY (green) - normal operations
  const wdZone=(wd)=>{
    if(wd===null)return'unknown';
    if(wd>6)return'late';
    if(wd>=1)return'close';
    if(wd>=-3)return'preclose';
    return'early';
  };
  const ZONE_STYLE={
    late:{bg:'rgba(204,42,42,0.15)',bord:A.fail,col:A.fail,label:'TARDÍO (post WD+6)'},
    close:{bg:'rgba(232,82,10,0.12)',bord:A.orange,col:A.orange,label:'Ventana Cierre (WD+1 a WD+6)'},
    preclose:{bg:'rgba(217,119,6,0.12)',bord:A.warn,col:A.warn,label:'Pre-Cierre (WD-3 a WD0)'},
    early:{bg:'rgba(26,122,60,0.10)',bord:A.pass,col:A.pass,label:'Operaciones Normales (<WD-3)'},
    unknown:{bg:A.light,bord:A.light2,col:A.t4,label:'Sin fecha'},
  };

  // ── Filter data ───────────────────────────────────────
  const sources=[...new Set(rawRows.map(r=>r.SOURCE||'Other').filter(Boolean))].sort();
  const base=filterSource==='ALL'?rawRows:rawRows.filter(r=>r.SOURCE===filterSource);
  const filtRows=filterCountry==='ALL'?base:base.filter(r=>cc(r.COMPANY)===filterCountry);

  // ── Build WD map ──────────────────────────────────────
  // wdMap: {wdNumber: {source: {lines, netUSD, journals:{}}}}
  const wdMap={};
  filtRows.forEach(r=>{
    const wd=getWD(r.CREATION_DATE||r.ACCOUNTING_DATE);
    if(wd===null)return;
    const src=r.SOURCE||'Other';
    if(!wdMap[wd])wdMap[wd]={};
    if(!wdMap[wd][src])wdMap[wd][src]={lines:0,netUSD:0,jset:{}};
    wdMap[wd][src].lines++;
    wdMap[wd][src].netUSD+=Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0);
    wdMap[wd][src].jset[r.JOURNAL_NAME||'']=1;
  });

  const wdNums=Object.keys(wdMap).map(Number).sort((a,b)=>a-b);
  const getVal=(wd,src)=>{
    const d=wdMap[wd]&&wdMap[wd][src];
    if(!d)return 0;
    if(metric==='lines')return d.lines;
    if(metric==='net_usd')return Math.abs(d.netUSD);
    return Object.keys(d.jset).length;
  };
  const getWDTotal=wd=>sources.reduce((s,src)=>s+getVal(wd,src),0);
  const grandTotal=wdNums.reduce((s,w)=>s+getWDTotal(w),0);
  const maxVal=Math.max.apply(null,wdNums.map(getWDTotal).concat([1]));

  // ── Zone aggregates ───────────────────────────────────
  const zoneData={late:{lines:0,netUSD:0,manual:0},close:{lines:0,netUSD:0,manual:0},preclose:{lines:0,netUSD:0,manual:0},early:{lines:0,netUSD:0,manual:0}};
  filtRows.forEach(r=>{
    const wd=getWD(r.CREATION_DATE||r.ACCOUNTING_DATE);
    if(wd===null)return;
    const z=wdZone(wd);
    if(!zoneData[z])return;
    zoneData[z].lines++;
    zoneData[z].netUSD+=Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0);
    if(r.SOURCE==='Spreadsheet')zoneData[z].manual++;
  });

  // ── Source totals ─────────────────────────────────────
  const srcTotals=sources.map(src=>{
    const srcRows=filtRows.filter(r=>r.SOURCE===src);
    const net=srcRows.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);
    const jcount=Object.keys(srcRows.reduce((a,r)=>{a[r.JOURNAL_NAME||'']=1;return a},{})).length;
    return{src,lines:srcRows.length,net,journals:jcount,pct:filtRows.length>0?Math.round(srcRows.length/filtRows.length*100):0};
  }).sort((a,b)=>b.lines-a.lines);

  // ── WD label & color for a bar ────────────────────────
  const wdLabel=(wd)=>wd>0?'WD+'+wd:(wd===0?'WD0':'WD'+wd);
  const wdBarColor=(wd)=>{
    const z=wdZone(wd);
    return{late:A.fail,close:A.orange,preclose:A.warn,early:A.pass,unknown:A.t4}[z];
  };

  const btnStyle=(active,col)=>({padding:'4px 10px',borderRadius:5,fontFamily:mono,fontSize:10,cursor:'pointer',
    background:active?(col||A.orange):A.light,border:`1px solid ${active?(col||A.orange):A.light2}`,color:active?A.white:A.t2});

  const ZoneCard=({zone,label,icon,col})=>{
    const d=zoneData[zone]||{lines:0,netUSD:0,manual:0};
    return(
      <div style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,padding:'14px 16px',borderLeft:`4px solid ${col}`,boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
        <div style={{fontFamily:mono,fontSize:10,textTransform:'uppercase',letterSpacing:'0.1em',color:A.t3,marginBottom:4}}>{icon} {label}</div>
        <div style={{fontFamily:cond,fontSize:26,fontWeight:800,color:col,lineHeight:1,marginBottom:3}}>{d.lines.toLocaleString()}</div>
        <div style={{fontSize:11,color:A.t3,marginBottom:4}}>Saldo neto: <strong style={{color:d.netUSD>0?A.fail:d.netUSD<0?A.info:A.t3}}>{fmtUSD(d.netUSD)}</strong></div>
        {d.manual>0&&<div style={{fontFamily:mono,fontSize:10,color:A.orange}}>✍️ {d.manual} manuales ({d.lines>0?Math.round(d.manual/d.lines*100):0}%)</div>}
      </div>
    );
  };

  return (
    <div style={{animation:'fadeUp .3s ease'}}>
      {/* Header */}
      <div style={{background:A.dark,border:`1px solid ${A.dark3}`,borderRadius:'8px 8px 0 0',padding:'12px 18px',display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:8}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span style={{background:A.amber,color:A.white,fontFamily:cond,fontWeight:800,fontSize:12,padding:'4px 10px',borderRadius:4,letterSpacing:'0.08em'}}>WD ANALYSIS</span>
          <span style={{fontFamily:cond,fontSize:13,color:'rgba(255,255,255,.7)'}}>Días laborales vs CLOSE={cal.close} (WD+6) · Eje X = CREATION_DATE en días laborales</span>
        </div>
        <div style={{fontFamily:mono,fontSize:11,color:A.amberL}}>
          EOM: {cal.eom} → WD+6 (Close): {cal.close}
        </div>
      </div>

      {/* Filters */}
      <div style={{background:A.white,border:`1px solid ${A.light2}`,borderTop:'none',padding:'10px 16px',display:'flex',gap:12,flexWrap:'wrap',alignItems:'center'}}>
        <div style={{display:'flex',gap:4,alignItems:'center'}}>
          <span style={{fontFamily:mono,fontSize:10,color:A.t3,marginRight:4}}>MÉTRICA:</span>
          {[['lines','Líneas'],['net_usd','Saldo USD'],['journals','Journals']].map(([k,l])=>(
            <button key={k} onClick={()=>setMetric(k)} style={btnStyle(metric===k,A.orange)}>{l}</button>
          ))}
        </div>
        <div style={{display:'flex',gap:4,alignItems:'center',flexWrap:'wrap'}}>
          <span style={{fontFamily:mono,fontSize:10,color:A.t3,marginRight:4}}>SOURCE:</span>
          {['ALL',...sources].map(s=>(
            <button key={s} onClick={()=>setFilterSource(s)} style={btnStyle(filterSource===s,srcColor(s))}>{s==='ALL'?'Todos':s}</button>
          ))}
        </div>
        <div style={{display:'flex',gap:4,alignItems:'center',flexWrap:'wrap'}}>
          <span style={{fontFamily:mono,fontSize:10,color:A.t3,marginRight:4}}>PAÍS:</span>
          {['ALL',...ccodes].map(c=>{
            const info=ci(c);
            return <button key={c} onClick={()=>setFilterCountry(c)} style={btnStyle(filterCountry===c,A.orange)}>{c==='ALL'?'Todos':info.flag+' '+info.short}</button>;
          })}
        </div>
      </div>

      {/* Zone KPI cards */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:12,margin:'14px 0'}}>
        <ZoneCard zone="late"     label="TARDÍOS — Post WD+6"          icon="🔴" col={A.fail}/>
        <ZoneCard zone="close"    label="Ventana Cierre WD+1 → WD+6"   icon="🟠" col={A.orange}/>
        <ZoneCard zone="preclose" label="Pre-Cierre WD-3 → WD0"        icon="🟡" col={A.warn}/>
        <ZoneCard zone="early"    label="Operaciones < WD-3"            icon="🟢" col={A.pass}/>
      </div>

      {/* WD Bar chart */}
      <div style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,overflow:'hidden',marginBottom:16,boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
        <div style={{background:A.dark,padding:'10px 16px',display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:8}}>
          <span style={{fontFamily:cond,fontSize:13,fontWeight:700,color:A.amberL}}>
            {'📊 '+(metric==='lines'?'Líneas':metric==='net_usd'?'Saldo USD':'Journals')+' por Día Laboral · Eje X = WD relativo a cierre'}
          </span>
          <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'center'}}>
            <span style={{fontFamily:mono,fontSize:10,color:A.fail}}>■ Tardío</span>
            <span style={{fontFamily:mono,fontSize:10,color:A.orange}}>■ Cierre</span>
            <span style={{fontFamily:mono,fontSize:10,color:A.warn}}>■ Pre-Cierre</span>
            <span style={{fontFamily:mono,fontSize:10,color:A.pass}}>■ Normal</span>
          </div>
        </div>
        {/* Zone background bands + bars */}
        <div style={{padding:'28px 16px 16px',overflowX:'auto'}}>
          <div style={{display:'flex',alignItems:'flex-end',gap:2,minWidth:Math.max(600,wdNums.length*36),height:200,position:'relative'}}>
            {wdNums.map(wd=>{
              const total=getWDTotal(wd);
              const zone=wdZone(wd);
              const barCol=wdBarColor(wd);
              const isPeak=wd===6||wd===5||wd===4; // close window peaks
              const isLate=wd>6;
              const isPreClose=wd>=-3&&wd<=0;
              const bgBand=isLate?'rgba(204,42,42,0.06)':isPeak?'rgba(232,82,10,0.06)':isPreClose?'rgba(217,119,6,0.06)':'transparent';
              const srcList=filterSource==='ALL'?sources:[filterSource];
              const segs=srcList.map(src=>{
                const v=getVal(wd,src);
                return{src,v,h:v>0?Math.max((v/maxVal)*160,2):0};
              }).filter(seg=>seg.v>0);

              return (
                <div key={wd} style={{display:'flex',flexDirection:'column',alignItems:'center',flex:1,minWidth:30,background:bgBand,borderRadius:4,padding:'0 1px'}}>
                  {total>0 && (
                    <div style={{fontFamily:mono,fontSize:7,color:barCol,marginBottom:2,whiteSpace:'nowrap',fontWeight:700}}>
                      {metric==='net_usd'?fmtUSD(total):total.toLocaleString()}
                    </div>
                  )}
                  <div style={{display:'flex',flexDirection:'column-reverse',alignItems:'stretch',width:'100%',height:160}}>
                    {segs.map(seg=>(
                      <div key={seg.src} style={{width:'100%',height:seg.h,background:barCol,opacity:.85,borderTop:'1px solid rgba(255,255,255,0.3)'}}/>
                    ))}
                  </div>
                  {/* WD label with zone indicator */}
                  <div style={{fontFamily:mono,fontSize:8,color:barCol,fontWeight:700,marginTop:3,textAlign:'center',lineHeight:1.2}}>
                    {wdLabel(wd)}
                  </div>
                  {wd===6&&<div style={{fontFamily:mono,fontSize:6,color:A.orange,marginTop:1}}>CLOSE</div>}
                  {wd===0&&<div style={{fontFamily:mono,fontSize:6,color:A.warn,marginTop:1}}>WD0</div>}
                  {wd===-3&&<div style={{fontFamily:mono,fontSize:6,color:A.warn,marginTop:1}}>PRE</div>}
                </div>
              );
            })}
          </div>
          {/* Zone bands legend */}
          <div style={{display:'flex',gap:6,marginTop:10,flexWrap:'wrap',alignItems:'center',borderTop:`1px solid ${A.light}`,paddingTop:8}}>
            {[['🔴 Tardío: WD > WD+6',A.fail],['🟠 Ventana cierre: WD+1 → WD+6',A.orange],['🟡 Pre-cierre: WD-3 → WD0',A.warn],['🟢 Normal: antes de WD-3',A.pass]].map(([lbl,col])=>(
              <span key={lbl} style={{fontFamily:mono,fontSize:9,color:col,background:col+'18',border:`1px solid ${col}44`,padding:'2px 8px',borderRadius:4}}>{lbl}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom tables */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:16}}>
        {/* Source concentration */}
        <div style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,overflow:'hidden',boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
          <div style={{background:A.dark,padding:'10px 16px',fontFamily:cond,fontSize:13,fontWeight:700,color:A.amberL}}>🔍 Concentración por SOURCE</div>
          <table style={{width:'100%',borderCollapse:'collapse',fontFamily:mono,fontSize:11}}>
            <thead>
              <tr style={{background:A.light}}>
                {['SOURCE','Líneas','%','Saldo USD','Journals','Acción'].map(h=>(
                  <th key={h} style={{padding:'8px 10px',textAlign:'left',fontSize:9,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.08em',color:A.t3,borderBottom:`1px solid ${A.light2}`,whiteSpace:'nowrap'}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {srcTotals.map((s,i)=>{
                const isHigh=s.pct>40, isMed=s.pct>20;
                const action=s.src==='Spreadsheet'?'⚠ Revisar automatización':s.src==='Payables'?'✓ AP automático':s.src==='Revaluation'?'✓ Verificar tasas':'✓ Estándar';
                return (
                  <tr key={s.src} style={{borderBottom:`1px solid ${A.light}`,background:i%2===0?A.white:A.off}}>
                    <td style={{padding:'8px 10px'}}>
                      <span style={{display:'inline-flex',alignItems:'center',gap:5}}>
                        <span style={{width:8,height:8,background:srcColor(s.src),borderRadius:'50%',display:'inline-block'}}/>
                        <strong style={{color:A.t1}}>{s.src}</strong>
                      </span>
                    </td>
                    <td style={{padding:'8px 10px',fontWeight:600}}>{s.lines.toLocaleString()}</td>
                    <td style={{padding:'8px 10px'}}>
                      <span style={{background:isHigh?A.failL:isMed?A.warnL:A.passL,color:isHigh?A.fail:isMed?A.warn:A.pass,fontWeight:700,padding:'2px 7px',borderRadius:4}}>{s.pct}%</span>
                    </td>
                    <td style={{padding:'8px 10px',color:s.net>0?A.fail:s.net<0?A.info:A.t3,fontWeight:600}}>{fmtUSD(s.net)}</td>
                    <td style={{padding:'8px 10px',color:A.t2}}>{s.journals}</td>
                    <td style={{padding:'8px 10px',fontSize:10,color:s.src==='Spreadsheet'?A.warn:A.t3}}>{action}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* WD distribution table + insights */}
        <div style={{display:'flex',flexDirection:'column',gap:12}}>
          {/* Top WD peaks */}
          <div style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,overflow:'hidden',boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
            <div style={{background:A.dark,padding:'10px 16px',fontFamily:cond,fontSize:13,fontWeight:700,color:A.amberL}}>⚡ Top WD por Volumen</div>
            <table style={{width:'100%',borderCollapse:'collapse',fontFamily:mono,fontSize:11}}>
              <thead>
                <tr style={{background:A.light}}>
                  {['WD','Zona','Líneas','% Total','Manual?'].map(h=>(
                    <th key={h} style={{padding:'7px 10px',textAlign:'left',fontSize:9,fontWeight:700,textTransform:'uppercase',color:A.t3,borderBottom:`1px solid ${A.light2}`}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {wdNums.map(w=>({wd:w,total:getWDTotal(w)})).sort((a,b)=>b.total-a.total).slice(0,8).map((pd,i)=>{
                  const dayPct=Math.round(pd.total/grandTotal*100);
                  const zone=wdZone(pd.wd);
                  const zs=ZONE_STYLE[zone];
                  const manLines=(wdMap[pd.wd]&&wdMap[pd.wd]['Spreadsheet'])?Object.values(wdMap[pd.wd]['Spreadsheet']).reduce((a,b)=>typeof b==='number'?a+b:a,0):0;
                  const manCount=(wdMap[pd.wd]&&wdMap[pd.wd]['Spreadsheet'])?wdMap[pd.wd]['Spreadsheet'].lines||0:0;
                  return (
                    <tr key={pd.wd} style={{borderBottom:`1px solid ${A.light}`,background:i%2===0?A.white:A.off}}>
                      <td style={{padding:'7px 10px',fontWeight:800,color:zs.col}}>{wdLabel(pd.wd)}</td>
                      <td style={{padding:'7px 10px'}}>
                        <span style={{fontSize:9,fontWeight:700,padding:'2px 6px',borderRadius:3,background:zs.bg,color:zs.col,border:`1px solid ${zs.bord}`}}>{zs.label.split(' ')[0]}</span>
                      </td>
                      <td style={{padding:'7px 10px',fontWeight:600}}>{pd.total.toLocaleString()}</td>
                      <td style={{padding:'7px 10px'}}>
                        <span style={{background:dayPct>20?A.failL:A.warnL,color:dayPct>20?A.fail:A.warn,fontWeight:700,padding:'2px 7px',borderRadius:4}}>{dayPct}%</span>
                      </td>
                      <td style={{padding:'7px 10px',fontSize:10,color:manCount>50?A.fail:A.pass,fontWeight:600}}>{manCount>0?manCount+' ✍️':'✓'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Optimization insights */}
          <div style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,padding:'14px 16px',boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
            <div style={{fontFamily:cond,fontSize:14,fontWeight:700,color:A.t1,marginBottom:10}}>💡 Insights de Optimización</div>
            {[
              zoneData.late.lines>0 ? {col:A.fail,txt:'🔴 '+zoneData.late.lines+' entradas después de WD+6 ('+cal.close+'). Requieren aprobación especial. Saldo: '+fmtUSD(zoneData.late.netUSD)+'.'} : null,
              zoneData.late.manual>0 ? {col:A.fail,txt:'✍️ '+zoneData.late.manual+' asientos MANUALES tardíos. Cada uno requiere formulario de excepción del Controller.'} : null,
              zoneData.close.manual>0 ? {col:A.warn,txt:'Ventana de cierre (WD+1 a WD+6): '+zoneData.close.manual+' manuales de '+zoneData.close.lines+' totales ('+Math.round(zoneData.close.manual/Math.max(zoneData.close.lines,1)*100)+'%). Objetivo: <20% manual en esta zona.'} : null,
              zoneData.preclose.lines>0 ? {col:A.warn,txt:'Pre-cierre (WD-3 a WD0): '+zoneData.preclose.lines+' entradas. Zona de mayor riesgo de errores por presión de tiempo.'} : null,
              {col:A.pass,txt:'Operaciones normales (<WD-3): '+zoneData.early.lines+' líneas ('+Math.round(zoneData.early.lines/Math.max(filtRows.length,1)*100)+'%). Nivel ideal: >70% del volumen aquí.'},
              (srcTotals.find(s=>s.src==='Payables')?.pct||0) > 50 ? {col:A.pass,txt:'Payables automático representa el mayor volumen. Mantener proceso. Meta: consolidar batches para reducir días pico.'} : null,
            ].filter(Boolean).map((ins,i)=>(
              <div key={i} style={{display:'flex',gap:8,padding:'6px 0',borderBottom:`1px solid ${A.light}`,alignItems:'flex-start'}}>
                <span style={{width:7,height:7,background:ins.col,borderRadius:'50%',display:'inline-block',marginTop:5,flexShrink:0}}/>
                <span style={{fontSize:12,color:A.t2,lineHeight:1.5}}>{ins.txt}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}


// ══════════════════════════════════════════════════════
// RULE MANAGER COMPONENT
// ══════════════════════════════════════════════════════
const FIELDS_LIST=['BC','ACCOUNT','COSTCENTER','COMPANY','SOURCE','CATEGORY','PROJECT','INTERCOMPANY','DESCRIPTION','ENT_DEBIT','ENT_CREDIT','ACC_DEBIT','ACC_CREDIT','JOURNAL_NAME'];
const OPS_LIST=['eq','ne','starts','contains','notContains','notEmpty','empty','gt','lt','gte','lte','in','notIn'];
const OPS_LABEL={eq:'= igual a',ne:'!= distinto de',starts:'empieza con',contains:'contiene',notContains:'no contiene',notEmpty:'no vacio',empty:'= vacío',gt:'> mayor que',lt:'< menor que',gte:'>= mayor/igual',lte:'<= menor/igual',in:'en lista (a,b,c)',notIn:'no en lista'};

function RuleManager({allRules,setAllRules,onRun}){
  const [editId,setEditId]=useState(null);
  const [search,setSearch]=useState('');
  const [showAdd,setShowAdd]=useState(false);
  const [newR,setNewR]=useState({id:'',module:'CV Rules',risk:'high',desc:'',insight:'',
    conditionGroups:[{field:'BC',checks:[{op:'eq',val:''}]}],
    validation:{field:'COSTCENTER',op:'notEmpty',val:''},errorMsg:''});

  const inpS={background:A.white,border:`1px solid ${A.light2}`,color:A.t1,fontFamily:mono,fontSize:11,padding:'4px 8px',borderRadius:4,outline:'none'};
  const selS={...inpS,cursor:'pointer'};

  const filtered=allRules.filter(r=>!search||(r.id+r.desc).toLowerCase().includes(search.toLowerCase()));

  const editCheck=(ruleId,gi,ci,key,val)=>setAllRules(prev=>prev.map(r=>{
    if(r.id!==ruleId)return r;
    const cg=r.conditionGroups.map((g,gj)=>gj!==gi?g:{...g,checks:g.checks.map((c,cj)=>cj!==ci?c:{...c,[key]:val})});
    return{...r,conditionGroups:cg};
  }));
  const editVal=(ruleId,key,val)=>setAllRules(prev=>prev.map(r=>r.id===ruleId?{...r,[key]:val}:r));
  const editValNested=(ruleId,parent,key,val)=>setAllRules(prev=>prev.map(r=>r.id===ruleId?{...r,[parent]:{...r[parent],[key]:val}}:r));
  const toggleActive=id=>setAllRules(prev=>prev.map(r=>r.id===id?{...r,active:!r.active}:r));
  const deleteRule=id=>{if(window.confirm('¿Eliminar regla '+id+'?'))setAllRules(prev=>prev.filter(r=>r.id!==id));};
  const addCheckToGroup=(gi)=>setNewR(r=>{const cg=r.conditionGroups.map((g,i)=>i!==gi?g:{...g,checks:[...g.checks,{op:'eq',val:''}]});return{...r,conditionGroups:cg};});
  const updNewCheck=(gi,ci,key,val)=>setNewR(r=>{const cg=r.conditionGroups.map((g,i)=>i!==gi?g:{...g,checks:g.checks.map((c,j)=>j!==ci?c:{...c,[key]:val})});return{...r,conditionGroups:cg};});

  const saveNew=()=>{
    if(!newR.id||!newR.desc){alert('Completa ID y descripción');return;}
    if(allRules.find(r=>r.id===newR.id)){alert('ID ya existe: '+newR.id);return;}
    setAllRules(prev=>[...prev,{...newR,active:true}]);
    setNewR({id:'',module:'CV Rules',risk:'high',desc:'',insight:'',conditionGroups:[{field:'BC',checks:[{op:'eq',val:''}]}],validation:{field:'COSTCENTER',op:'notEmpty',val:''},errorMsg:''});
    setShowAdd(false);
  };

  const RiskBadge=({risk})=>{
    const col=risk==='high'?A.fail:risk==='medium'?A.warn:A.pass;
    return <span style={{fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:3,background:col+'22',color:col}}>{(risk||'').toUpperCase()}</span>;
  };

  return (
    <div style={{animation:'fadeUp .3s ease'}}>
      <div style={{background:A.dark,border:`1px solid ${A.dark3}`,borderRadius:'8px 8px 0 0',padding:'12px 18px',display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:8}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span style={{background:'#7C3AED',color:A.white,fontFamily:cond,fontWeight:800,fontSize:12,padding:'4px 10px',borderRadius:4,letterSpacing:'0.08em'}}>⚙️ REGLAS</span>
          <span style={{fontFamily:cond,fontSize:13,color:'rgba(255,255,255,.7)'}}>Ver · Editar inline · Activar/Desactivar · Agregar — {allRules.filter(r=>r.active!==false).length}/{allRules.length} activas</span>
        </div>
        <div style={{display:'flex',gap:8}}>
          <button onClick={()=>setShowAdd(v=>!v)} style={{padding:'6px 14px',borderRadius:6,fontFamily:body,fontWeight:600,fontSize:12,cursor:'pointer',background:showAdd?'#7C3AED':'transparent',border:'1.5px solid #A78BFA',color:showAdd?A.white:'#A78BFA'}}>
            {showAdd?'✕ Cancelar':'+ Nueva Regla'}
          </button>
          <button onClick={onRun} style={{padding:'6px 14px',borderRadius:6,fontFamily:body,fontWeight:600,fontSize:12,cursor:'pointer',background:A.orange,border:`1.5px solid ${A.orange}`,color:A.white}}>
            🚀 Re-ejecutar Validaciones
          </button>
        </div>
      </div>

      {/* Search + info */}
      <div style={{background:A.white,border:`1px solid ${A.light2}`,borderTop:'none',padding:'10px 16px',display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar por ID o descripción..." style={{...inpS,width:260,padding:'6px 10px',fontSize:12}}/>
        <span style={{fontFamily:mono,fontSize:11,color:A.t3}}>{filtered.length} reglas mostradas</span>
        <span style={{fontFamily:mono,fontSize:11,color:A.t3,marginLeft:'auto'}}>✏️ Clic en Edit para modificar valores inline</span>
      </div>

      {/* Add new rule */}
      {showAdd && (
        <div style={{background:'#F5F3FF',border:'1.5px solid #7C3AED',borderTop:'none',padding:'16px 20px'}}>
          <div style={{fontFamily:cond,fontSize:15,fontWeight:700,color:'#7C3AED',marginBottom:12}}>Nueva Regla de Validación</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))',gap:10,marginBottom:12}}>
            {[['ID (ej: GR.10)','id'],['Descripción corta','desc'],['Error Message','errorMsg'],['Insight (opcional)','insight']].map(([lbl,k])=>(
              <div key={k}>
                <div style={{fontFamily:mono,fontSize:9,color:'#7C3AED',marginBottom:3,textTransform:'uppercase',letterSpacing:'0.1em'}}>{lbl}</div>
                <input value={newR[k]||''} onChange={e=>setNewR(r=>({...r,[k]:e.target.value}))} style={{...inpS,width:'100%'}}/>
              </div>
            ))}
            <div>
              <div style={{fontFamily:mono,fontSize:9,color:'#7C3AED',marginBottom:3,textTransform:'uppercase',letterSpacing:'0.1em'}}>Módulo</div>
              <select value={newR.module} onChange={e=>setNewR(r=>({...r,module:e.target.value}))} style={{...selS,width:'100%'}}>
                {['CV Rules','Compliance','Period Close'].map(m=><option key={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <div style={{fontFamily:mono,fontSize:9,color:'#7C3AED',marginBottom:3,textTransform:'uppercase',letterSpacing:'0.1em'}}>Riesgo</div>
              <select value={newR.risk} onChange={e=>setNewR(r=>({...r,risk:e.target.value}))} style={{...selS,width:'100%'}}>
                <option value="high">HIGH</option><option value="medium">MEDIUM</option><option value="low">LOW</option>
              </select>
            </div>
          </div>
          <div style={{fontFamily:mono,fontSize:9,color:A.t3,marginBottom:6,textTransform:'uppercase',letterSpacing:'0.1em'}}>Condiciones IF (campo ← todos los grupos AND, checks dentro OR)</div>
          {newR.conditionGroups.map((g,gi)=>(
            <div key={gi} style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:6,padding:'8px 12px',marginBottom:6}}>
              <div style={{display:'flex',gap:4,marginBottom:4,alignItems:'center'}}>
                <select value={g.field} onChange={e=>setNewR(r=>{const cg=r.conditionGroups.map((x,i)=>i!==gi?x:{...x,field:e.target.value});return{...r,conditionGroups:cg};})} style={{...selS,fontWeight:700,color:A.info}}>
                  {FIELDS_LIST.map(f=><option key={f}>{f}</option>)}
                </select>
                <span style={{fontFamily:mono,fontSize:9,color:A.t3}}>CAMPO {gi+1}</span>
              </div>
              {g.checks.map((chk,ci)=>(
                <div key={ci} style={{display:'flex',gap:4,marginBottom:4,alignItems:'center',paddingLeft:12}}>
                  {ci>0&&<span style={{fontFamily:mono,fontSize:9,color:A.orange,width:24}}>OR</span>}
                  <select value={chk.op} onChange={e=>updNewCheck(gi,ci,'op',e.target.value)} style={{...selS,fontSize:10}}>
                    {OPS_LIST.map(o=><option key={o} value={o}>{OPS_LABEL[o]||o}</option>)}
                  </select>
                  <input value={chk.val||''} onChange={e=>updNewCheck(gi,ci,'val',e.target.value)} placeholder="valor" style={{...inpS,flex:1,fontSize:10}}/>
                  {ci>0&&<button onClick={()=>setNewR(r=>{const cg=r.conditionGroups.map((x,i)=>i!==gi?x:{...x,checks:x.checks.filter((_,j)=>j!==ci)});return{...r,conditionGroups:cg};})} style={{fontFamily:mono,fontSize:11,background:'none',border:'none',color:A.fail,cursor:'pointer'}}>✕</button>}
                </div>
              ))}
              <button onClick={()=>addCheckToGroup(gi)} style={{fontFamily:mono,fontSize:9,background:A.light,border:`1px solid ${A.light2}`,borderRadius:4,padding:'3px 8px',cursor:'pointer',color:A.t2,marginLeft:12}}>+ OR valor</button>
            </div>
          ))}
          <button onClick={()=>setNewR(r=>({...r,conditionGroups:[...r.conditionGroups,{field:'BC',checks:[{op:'eq',val:''}]}]}))} style={{fontFamily:mono,fontSize:10,background:A.light,border:`1px solid ${A.light2}`,borderRadius:4,padding:'4px 10px',cursor:'pointer',color:A.t2,marginBottom:12}}>+ AND campo</button>
          <div style={{fontFamily:mono,fontSize:9,color:A.t3,marginBottom:6,textTransform:'uppercase',letterSpacing:'0.1em'}}>Validación THEN (la condición que debe cumplirse para pasar)</div>
          <div style={{display:'flex',gap:8,marginBottom:14,flexWrap:'wrap'}}>
            <select value={newR.validation.field} onChange={e=>setNewR(r=>({...r,validation:{...r.validation,field:e.target.value}}))} style={{...selS,fontWeight:700,color:A.info}}>{FIELDS_LIST.map(f=><option key={f}>{f}</option>)}</select>
            <select value={newR.validation.op} onChange={e=>setNewR(r=>({...r,validation:{...r.validation,op:e.target.value}}))} style={selS}>{OPS_LIST.map(o=><option key={o} value={o}>{OPS_LABEL[o]||o}</option>)}</select>
            <input value={newR.validation.val||''} onChange={e=>setNewR(r=>({...r,validation:{...r.validation,val:e.target.value}}))} placeholder="valor esperado" style={{...inpS,width:150}}/>
          </div>
          <div style={{display:'flex',gap:8}}>
            <button onClick={saveNew} style={{padding:'8px 18px',borderRadius:6,fontFamily:body,fontWeight:600,fontSize:12,cursor:'pointer',background:'#7C3AED',border:'1.5px solid #7C3AED',color:A.white}}>💾 Guardar Regla</button>
            <button onClick={()=>setShowAdd(false)} style={{padding:'8px 14px',borderRadius:6,fontFamily:body,fontWeight:600,fontSize:12,cursor:'pointer',background:A.white,border:`1.5px solid ${A.light2}`,color:A.t2}}>Cancelar</button>
          </div>
        </div>
      )}

      {/* Rules table */}
      <div style={{background:A.white,border:`1px solid ${A.light2}`,borderTop:'none',borderRadius:'0 0 10px 10px',overflow:'hidden'}}>
        <div style={{display:'grid',gridTemplateColumns:'28px 70px 80px 1fr 200px 70px 80px',padding:'9px 14px',background:A.light,borderBottom:`1px solid ${A.light2}`,fontFamily:mono,fontSize:9,textTransform:'uppercase',letterSpacing:'0.1em',color:A.t3,gap:8,alignItems:'center'}}>
          <div/><div>ID</div><div>Módulo</div><div>Descripción + IF</div><div>THEN Validación</div><div>Riesgo</div><div>Acciones</div>
        </div>
        {filtered.map(rule=>{
          const isEditing=editId===rule.id;
          const inactive=rule.active===false;
          return (
            <div key={rule.id} style={{borderBottom:`1px solid ${A.light}`,background:isEditing?'#F5F3FF':inactive?'rgba(200,200,200,0.08)':A.white,opacity:inactive?0.6:1}}>
              <div style={{display:'grid',gridTemplateColumns:'28px 70px 80px 1fr 200px 70px 80px',padding:'10px 14px',alignItems:'start',gap:8}}>
                <input type="checkbox" checked={!inactive} onChange={()=>toggleActive(rule.id)} style={{marginTop:4,accentColor:A.orange}}/>
                <div style={{fontFamily:mono,fontSize:11,fontWeight:700,color:A.orange,paddingTop:3}}>{rule.id}</div>
                <div style={{fontFamily:mono,fontSize:10,color:A.t3,paddingTop:3}}>{rule.module}</div>
                {/* Description + conditions */}
                <div>
                  {isEditing ? (
                    <div>
                      <input value={rule.desc||''} onChange={e=>editVal(rule.id,'desc',e.target.value)} style={{...inpS,width:'100%',marginBottom:6,fontSize:12}}/>
                      {rule.conditionGroups.map((g,gi)=>(
                        <div key={gi} style={{background:A.off,borderRadius:5,padding:'6px 8px',marginBottom:4}}>
                          <div style={{fontFamily:mono,fontSize:9,color:A.t3,marginBottom:4}}>
                            CAMPO: <select value={g.field||'BC'} style={{...selS,fontSize:10,padding:'2px 4px'}} onChange={e=>{const cg=rule.conditionGroups.map((x,i)=>i!==gi?x:{...x,field:e.target.value});editVal(rule.id,'conditionGroups',cg);}}>
                              {FIELDS_LIST.map(f=><option key={f}>{f}</option>)}
                            </select>
                          </div>
                          {g.checks.map((chk,ci)=>(
                            <div key={ci} style={{display:'flex',gap:4,marginBottom:3,alignItems:'center',paddingLeft:8}}>
                              {ci>0&&<span style={{fontFamily:mono,fontSize:9,color:A.orange}}>OR</span>}
                              <select value={chk.op} style={{...selS,fontSize:10,padding:'2px 4px'}} onChange={e=>editCheck(rule.id,gi,ci,'op',e.target.value)}>
                                {OPS_LIST.map(o=><option key={o} value={o}>{OPS_LABEL[o]||o}</option>)}
                              </select>
                              <input value={chk.val||''} style={{...inpS,flex:1,fontSize:10,padding:'2px 6px'}} onChange={e=>editCheck(rule.id,gi,ci,'val',e.target.value)} placeholder="valor"/>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ):(
                    <div>
                      <div style={{fontSize:12,color:A.t1,fontWeight:500,marginBottom:4,lineHeight:1.3}}>{rule.desc}</div>
                      {rule.conditionGroups.map((g,gi)=>(
                        <div key={gi} style={{fontFamily:mono,fontSize:9,color:A.t3,marginTop:2,lineHeight:1.5}}>
                          {gi>0&&<span style={{color:A.orange}}>AND </span>}
                          <span style={{color:A.info}}>{g.field} </span>
                          {g.checks.map((chk,ci)=>(
                            <span key={ci}>{ci>0&&<span style={{color:A.orange}}> OR </span>}<span style={{color:A.t2}}>{OPS_LABEL[chk.op]||chk.op} <strong>"{chk.val||''}"</strong></span></span>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {/* Validation THEN */}
                <div>
                  {isEditing ? (
                    <div style={{display:'flex',flexDirection:'column',gap:4}}>
                      <select value={rule.validation.field||'COSTCENTER'} style={{...selS,fontSize:10,fontWeight:700,color:A.info}} onChange={e=>editValNested(rule.id,'validation','field',e.target.value)}>
                        {FIELDS_LIST.map(f=><option key={f}>{f}</option>)}
                      </select>
                      <select value={rule.validation.op||'notEmpty'} style={{...selS,fontSize:10}} onChange={e=>editValNested(rule.id,'validation','op',e.target.value)}>
                        {OPS_LIST.map(o=><option key={o} value={o}>{OPS_LABEL[o]||o}</option>)}
                      </select>
                      <input value={rule.validation.val||rule.validation.value||''} style={{...inpS,fontSize:10}} onChange={e=>editValNested(rule.id,'validation','val',e.target.value)} placeholder="valor esperado"/>
                      <input value={rule.errorMsg||''} style={{...inpS,fontSize:9}} onChange={e=>editVal(rule.id,'errorMsg',e.target.value)} placeholder="Error message"/>
                    </div>
                  ):(
                    <div style={{fontFamily:mono,fontSize:10,color:A.t2}}>
                      <span style={{color:A.info}}>{rule.validation.field} </span>
                      <span style={{color:A.orange}}>{OPS_LABEL[rule.validation.op]||rule.validation.op} </span>
                      <strong>"{rule.validation.val||rule.validation.value||''}"</strong>
                      <div style={{fontFamily:mono,fontSize:9,color:A.fail,marginTop:3}}>⚑ {String(rule.errorMsg||'').substring(0,55)}</div>
                    </div>
                  )}
                </div>
                <div style={{paddingTop:3}}><RiskBadge risk={rule.risk}/></div>
                <div style={{display:'flex',flexDirection:'column',gap:4,paddingTop:2}}>
                  <button onClick={()=>setEditId(isEditing?null:rule.id)} style={{padding:'4px 10px',borderRadius:5,fontFamily:mono,fontSize:10,cursor:'pointer',background:isEditing?'#7C3AED':A.light,border:`1px solid ${isEditing?'#7C3AED':A.light2}`,color:isEditing?A.white:A.t2}}>
                    {isEditing?'✓ Guardar':'✏️ Editar'}
                  </button>
                  <button onClick={()=>toggleActive(rule.id)} style={{padding:'4px 10px',borderRadius:5,fontFamily:mono,fontSize:10,cursor:'pointer',background:inactive?A.passL:A.failL,border:`1px solid ${inactive?A.passB:A.failB}`,color:inactive?A.pass:A.fail}}>
                    {inactive?'✓ Activar':'⊘ Desact.'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ComplianceInsights({rawRows,cpResults,ccodes}){
  if(!rawRows?.length||!cpResults)return null;

  // Compute insights from raw data
  const manuals=rawRows.filter(r=>String(r.SOURCE||'').toLowerCase().includes('spreadsheet'));
  const totalLines=rawRows.length;
  const manualPct=totalLines>0?Math.round(manuals.length/totalLines*100):0;

  // Manual entries net balance
  const manualNet=manuals.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);

  // Missing descriptions in manual
  const missingDesc=manuals.filter(r=>!r.DESCRIPTION||!String(r.DESCRIPTION).trim());
  const missingDescNet=missingDesc.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);

  // High-value manuals >50K net
  const highValue=manuals.filter(r=>Math.abs(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0))>50000);
  const highValueNet=highValue.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);

  // Accounts 6xxx with BC=000
  const bc000=rawRows.filter(r=>String(r.BC||'')==='000'&&String(rv(r,'ACCOUNT')).startsWith('6'));
  const bc000Net=bc000.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);

  // Negative ACC (incorrect postings)
  const negDeb=rawRows.filter(r=>Number(r.ACC_DEBIT||0)<0);
  const negCred=rawRows.filter(r=>Number(r.ACC_CREDIT||0)<0);

  // BC distribution for categorization health
  const bcMap={};
  rawRows.forEach(r=>{const b=String(r.BC||'000');bcMap[b]=(bcMap[b]||0)+1;});
  const bcUncat=bcMap['000']||0;
  const bcUncatPct=totalLines>0?Math.round(bcUncat/totalLines*100):0;

  // Provisions without BC
  const provNoBc=rawRows.filter(r=>String(r.CATEGORY||'').toLowerCase().includes('provision')&&String(r.BC||'')==='000');
  const provNoBcNet=provNoBc.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);

  // Overall compliance violations heatmap score
  const totalViol=cpResults.reduce((s,r)=>s+r.violations,0);
  const totalMatch=cpResults.reduce((s,r)=>s+r.matching,0);
  const globalScore=totalMatch>0?Math.round((totalMatch-totalViol)/totalMatch*100):null;

  const insightCard=(icon,label,value,sub,color,action,risk)=>(
    <div style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,padding:'16px 18px',borderLeft:`4px solid ${color}`,boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:8}}>
        <div style={{fontFamily:mono,fontSize:10,textTransform:'uppercase',letterSpacing:'0.1em',color:A.t3}}>{icon} {label}</div>
        <span style={{fontFamily:mono,fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:3,background:risk==='high'?A.failL:risk==='medium'?A.warnL:A.passL,color:risk==='high'?A.fail:risk==='medium'?A.warn:A.pass}}>{risk?.toUpperCase()}</span>
      </div>
      <div style={{fontFamily:cond,fontSize:26,fontWeight:800,color,lineHeight:1,marginBottom:4}}>{value}</div>
      <div style={{fontSize:11,color:A.t3,marginBottom:8,lineHeight:1.4}}>{sub}</div>
      <div style={{fontSize:11,color:color,fontWeight:600,background:`${color}10`,border:`1px solid ${color}30`,borderRadius:5,padding:'6px 10px',lineHeight:1.4}}>💡 {action}</div>
    </div>
  );

  return(
    <div style={{marginBottom:20}}>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
        <div style={{fontFamily:cond,fontSize:16,fontWeight:700,color:A.t1}}>📊 Risk Insights — Compliance</div>
        {globalScore!==null&&<span style={{fontFamily:mono,fontSize:12,fontWeight:700,padding:'4px 12px',borderRadius:6,background:globalScore>=95?A.passL:globalScore>=80?A.warnL:A.failL,color:globalScore>=95?A.pass:globalScore>=80?A.warn:A.fail,border:`1px solid ${globalScore>=95?A.passB:globalScore>=80?A.warnB:A.failB}`}}>Score global: {globalScore}%</span>}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:12,marginBottom:16}}>
        {insightCard('📝','Asientos Manuales / Total',`${manualPct}%`,`${manuals.length.toLocaleString()} de ${totalLines.toLocaleString()} líneas · Saldo neto: ${fmtUSD(manualNet)}`,manualPct>15?A.fail:manualPct>5?A.warn:A.pass,'Revisar concentración: >15% manual indica riesgo de control.',manualPct>15?'high':manualPct>5?'medium':'low')}
        {insightCard('⚑','Sin Descripción (Manual)',missingDesc.length>0?fmtUSD(missingDescNet):'✓ OK',`${missingDesc.length} asientos manuales sin texto · ${totalMatch>0?Math.round(missingDesc.length/manuals.length*100):'0'}% del total manual`,missingDesc.length>0?A.fail:A.pass,missingDesc.length>0?`Gestionar con Accounting Manager: ${missingDesc.length} JEs pendientes de documentar.`:'Todos los manuales tienen descripción.',missingDesc.length>0?'high':'low')}
        {insightCard('💰','Alto Valor >$50K (Manual)',highValue.length>0?String(highValue.length)+' JEs':'✓ Ninguno',`Saldo neto: ${fmtUSD(highValueNet)} · Requieren aprobación nivel 2`,highValue.length>5?A.fail:highValue.length>0?A.warn:A.pass,highValue.length>0?`Verificar sign-off de Controller en ${highValue.length} asientos de alto valor.`:'Sin asientos manuales de alto valor.',highValue.length>5?'high':'medium')}
        {insightCard('🏷️','Cuentas 6xxx Sin BC',bc000.length>0?String(bc000.length)+' líneas':'✓ OK',`Sin categorización (BC=000) · Saldo neto: ${fmtUSD(bc000Net)}`,bc000.length>0?A.fail:A.pass,bc000.length>0?`Reclasificar ${bc000.length} líneas: impacta reportes por Business Category.`:'Toda la cartera de gastos tiene BC asignado.',bc000.length>0?'high':'low')}
        {insightCard('📉','Importes Negativos ACC',negDeb.length+negCred.length>0?String(negDeb.length+negCred.length)+' líneas':'✓ OK',`Déb neg: ${negDeb.length} · Cred neg: ${negCred.length} · Posibles reversiones incorrectas`,negDeb.length+negCred.length>0?A.fail:A.pass,negDeb.length+negCred.length>0?`Revisar urgente: importes negativos indican error de carga o reversión incorrecta.`:'Sin importes negativos en ACC.',negDeb.length+negCred.length>0?'high':'low')}
        {insightCard('📦','Provisiones Sin BC',provNoBc.length>0?String(provNoBc.length)+' provisiones':'✓ OK',`Saldo neto: ${fmtUSD(provNoBcNet)} · Impacta reporting por BC`,provNoBc.length>0?A.warn:A.pass,provNoBc.length>0?`Asignar BC a ${provNoBc.length} provisiones antes del sign-off de cierre.`:'Todas las provisiones tienen BC asignado.','medium')}
        {insightCard('📊','Categorización Global',`${100-bcUncatPct}%`,`${bcUncat.toLocaleString()} líneas con BC=000 de ${totalLines.toLocaleString()} · ${bcUncatPct}% sin categorizar`,bcUncatPct>20?A.fail:bcUncatPct>5?A.warn:A.pass,`Objetivo: 0% con BC=000 en cuentas P&L (4xxx–7xxx). ${bcUncatPct>5?'Priorizar limpieza antes del cierre.':'Nivel aceptable.'}.`,bcUncatPct>20?'high':bcUncatPct>5?'medium':'low')}
        {/* Per-country risk summary */}
        <div style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,padding:'16px 18px',borderLeft:`4px solid ${A.orange}`,boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
          <div style={{fontFamily:mono,fontSize:10,textTransform:'uppercase',letterSpacing:'0.1em',color:A.t3,marginBottom:10}}>🌎 Riesgo por País</div>
          {ccodes.map(c=>{
            const{flag,name}=ci(c);
            const sc=sectionScore(cpResults,c);
            if(!sc)return null;
            const sb=scoreBadge(sc.pct);
            return(<div key={c} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'5px 0',borderBottom:`1px solid ${A.light}`}}>
              <span style={{fontSize:12}}>{flag} <span style={{fontSize:12,color:A.t2}}>{name}</span></span>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{fontFamily:mono,fontSize:11,color:A.t3}}>{sc.violations} err</span>
                <span style={{fontFamily:mono,fontSize:11,color:sc.violations>0?A.fail:A.t3}}>{fmtUSD(sc.amtUSD)}</span>
                <span style={{fontFamily:cond,fontSize:13,fontWeight:800,color:sb.col,background:sb.bg,border:`1px solid ${sb.bord}`,padding:'2px 8px',borderRadius:4}}>{sb.txt}</span>
              </div>
            </div>);
          })}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// CLOSING CALENDAR + INSIGHTS COMPONENT
// ══════════════════════════════════════════════════════
function CloseCalendar({period,closeResults,rawRows,ccodes}){
  const today=new Date();
  const mIdx=getPeriodMonth(period);
  const cal=CLOSE_CALENDAR[mIdx]||CLOSE_CALENDAR[4];
  const closeDate=new Date(cal.close);
  const daysToClose=Math.ceil((closeDate-today)/(1000*60*60*24));
  const isLate=today>closeDate;
  const lateResult=closeResults?.find(r=>r.id==='CL.01');
  const balanceResult=closeResults?.find(r=>r.id==='CL.07');
  const weekendResult=closeResults?.find(r=>r.id==='CL.03');
  const statusColor=isLate?A.fail:daysToClose<=2?A.warn:A.pass;

  // ── Close-specific insights from raw data ──────────
  const manuals=rawRows?.filter(r=>String(r.SOURCE||'').toLowerCase().includes('spreadsheet'))||[];

  // Net balance of ALL manuals
  const manualNet=manuals.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);

  // Accruals
  const accruals=rawRows?.filter(r=>String(r.CATEGORY||'').toLowerCase().includes('accrual'))||[];
  const accrualsNet=accruals.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);

  // Provisions
  const provisions=rawRows?.filter(r=>String(r.CATEGORY||'').toLowerCase().includes('provision'))||[];
  const provisionsNet=provisions.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);

  // Global ACC net balance (should be ~0 for a balanced period)
  const globalAccNet=rawRows?.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0)||0;

  // IC net by country
  const icRows=rawRows?.filter(r=>String(r.INTERCOMPANY||'')!=='00000'&&String(r.INTERCOMPANY||'')!=='')||[];
  const icNet=icRows.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);

  // Entries in last 3 days before close (risk window)
  const riskWindowStart=new Date(closeDate);riskWindowStart.setDate(riskWindowStart.getDate()-3);
  const riskWindow=manuals.filter(r=>{const d=parseAnyDate(r.ACCOUNTING_DATE);return d&&d>=riskWindowStart&&d<=closeDate;});
  const riskWindowNet=riskWindow.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);

  // Late entries detail
  const lateEntries=lateResult?._violations||[];
  const lateNet=lateEntries.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);

  const insightCard=(icon,label,value,sub,color,action,risk,extra)=>(
    <div style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,padding:'16px 18px',borderLeft:`4px solid ${color}`,boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:8}}>
        <div style={{fontFamily:mono,fontSize:10,textTransform:'uppercase',letterSpacing:'0.1em',color:A.t3}}>{icon} {label}</div>
        <span style={{fontFamily:mono,fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:3,background:risk==='high'?A.failL:risk==='medium'?A.warnL:A.passL,color:risk==='high'?A.fail:risk==='medium'?A.warn:A.pass}}>{risk?.toUpperCase()}</span>
      </div>
      <div style={{fontFamily:cond,fontSize:24,fontWeight:800,color,lineHeight:1,marginBottom:4}}>{value}</div>
      <div style={{fontSize:11,color:A.t3,marginBottom:8,lineHeight:1.4}}>{sub}</div>
      {extra&&<div style={{fontFamily:mono,fontSize:11,color:A.t2,marginBottom:6}}>{extra}</div>}
      <div style={{fontSize:11,color:color,fontWeight:600,background:`${color}10`,border:`1px solid ${color}30`,borderRadius:5,padding:'6px 10px',lineHeight:1.4}}>💡 {action}</div>
    </div>
  );

  return(
    <div style={{marginBottom:20}}>
      {/* ── Timeline strip ── */}
      <div style={{background:A.dark2,border:`1px solid ${A.dark3}`,borderRadius:10,padding:'16px 22px',marginBottom:16}}>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))',gap:12}}>
          <div style={{background:isLate?'rgba(204,42,42,.15)':daysToClose<=2?'rgba(217,119,6,.15)':'rgba(26,122,60,.15)',border:`1px solid ${statusColor}44`,borderRadius:8,padding:'14px 16px'}}>
            <div style={{fontFamily:mono,fontSize:9,textTransform:'uppercase',letterSpacing:'0.12em',color:'rgba(255,255,255,.4)',marginBottom:4}}>Estado del Período</div>
            <div style={{fontFamily:cond,fontSize:14,fontWeight:800,color:statusColor}}>{isLate?'CIERRE VENCIDO':'PERÍODO ABIERTO'}</div>
            <div style={{fontFamily:cond,fontSize:28,fontWeight:800,color:statusColor,marginTop:2}}>{isLate?`+${Math.abs(daysToClose)}d`:`${daysToClose}d`}</div>
            <div style={{fontFamily:mono,fontSize:9,color:'rgba(255,255,255,.35)',marginTop:2}}>{isLate?'días post deadline WD+6':'días para deadline WD+6'}</div>
          </div>
          <div style={{background:'rgba(255,255,255,.04)',border:`1px solid rgba(255,255,255,.08)`,borderRadius:8,padding:'14px 16px'}}>
            <div style={{fontFamily:mono,fontSize:9,textTransform:'uppercase',letterSpacing:'0.12em',color:'rgba(255,255,255,.4)',marginBottom:4}}>EOM</div>
            <div style={{fontFamily:cond,fontSize:16,fontWeight:700,color:A.amberL}}>{cal.eom}</div>
            <div style={{fontFamily:mono,fontSize:10,color:'rgba(255,255,255,.35)',marginTop:4}}>Fin de mes fiscal</div>
          </div>
          <div style={{background:'rgba(255,255,255,.04)',border:`1px solid ${A.orange}44`,borderRadius:8,padding:'14px 16px'}}>
            <div style={{fontFamily:mono,fontSize:9,textTransform:'uppercase',letterSpacing:'0.12em',color:'rgba(255,255,255,.4)',marginBottom:4}}>WD+6 Deadline</div>
            <div style={{fontFamily:cond,fontSize:16,fontWeight:700,color:A.orange}}>{cal.close}</div>
            <div style={{fontFamily:mono,fontSize:10,color:'rgba(255,255,255,.35)',marginTop:4}}>Local close deadline</div>
          </div>
          <div style={{background:lateEntries.length>0?'rgba(204,42,42,.12)':'rgba(26,122,60,.1)',border:`1px solid ${lateEntries.length>0?A.failB:A.passB}`,borderRadius:8,padding:'14px 16px'}}>
            <div style={{fontFamily:mono,fontSize:9,textTransform:'uppercase',letterSpacing:'0.12em',color:'rgba(255,255,255,.4)',marginBottom:4}}>Tardíos Post WD+6</div>
            <div style={{fontFamily:cond,fontSize:28,fontWeight:800,color:lateEntries.length>0?A.fail:A.pass,lineHeight:1}}>{lateEntries.length}</div>
            <div style={{fontFamily:mono,fontSize:9,color:'rgba(255,255,255,.35)',marginTop:4}}>asientos manuales fuera de plazo</div>
            {lateNet!==0&&<div style={{fontFamily:mono,fontSize:10,color:A.fail,marginTop:2}}>{fmtUSD(lateNet)} neto USD</div>}
          </div>
          <div style={{background:Math.abs(globalAccNet)>1000?'rgba(204,42,42,.12)':'rgba(26,122,60,.1)',border:`1px solid ${Math.abs(globalAccNet)>1000?A.failB:A.passB}`,borderRadius:8,padding:'14px 16px'}}>
            <div style={{fontFamily:mono,fontSize:9,textTransform:'uppercase',letterSpacing:'0.12em',color:'rgba(255,255,255,.4)',marginBottom:4}}>Balance Global (USD)</div>
            <div style={{fontFamily:cond,fontSize:18,fontWeight:800,color:Math.abs(globalAccNet)>1000?A.fail:A.pass,lineHeight:1}}>{Math.abs(globalAccNet)<=1000?'✓ OK':fmtUSD(globalAccNet)}</div>
            <div style={{fontFamily:mono,fontSize:9,color:'rgba(255,255,255,.35)',marginTop:4}}>ACC_DEBIT - ACC_CREDIT neto</div>
          </div>
          <div style={{background:'rgba(255,255,255,.04)',border:`1px solid rgba(255,255,255,.08)`,borderRadius:8,padding:'14px 16px'}}>
            <div style={{fontFamily:mono,fontSize:9,textTransform:'uppercase',letterSpacing:'0.12em',color:'rgba(255,255,255,.4)',marginBottom:4}}>Saldo Neto Manual</div>
            <div style={{fontFamily:cond,fontSize:18,fontWeight:700,color:manualNet>0?A.fail:manualNet<0?A.info:A.pass,lineHeight:1}}>{fmtUSD(manualNet)}</div>
            <div style={{fontFamily:mono,fontSize:9,color:'rgba(255,255,255,.35)',marginTop:4}}>ACC_DEB - ACC_CRED · manuales</div>
          </div>
        </div>
      </div>

      {/* ── Insight cards ── */}
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
        <div style={{fontFamily:cond,fontSize:16,fontWeight:700,color:A.t1}}>🔒 Risk Insights — Cierre de Período</div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:12,marginBottom:20}}>
        {insightCard('⏰','Asientos Tardíos (Post WD+6)',lateEntries.length>0?String(lateEntries.length)+' JEs':'✓ Ninguno',`Saldo neto: ${fmtUSD(lateNet)} · Período: ${period}`,lateEntries.length>0?A.fail:A.pass,lateEntries.length>0?`Obtener aprobación especial del Controller para ${lateEntries.length} asientos. Documentar justificación.`:'Sin asientos fuera de plazo. Cierre en orden.',lateEntries.length>0?'high':'low')}
        {insightCard('⚡','Ventana de Riesgo (WD-3 a WD+6)',riskWindow.length>0?String(riskWindow.length)+' JEs':' 0 JEs',`Saldo neto: ${fmtUSD(riskWindowNet)} · Asientos próximos al deadline`,riskWindow.length>10?A.fail:riskWindow.length>3?A.warn:A.pass,riskWindow.length>0?`Alta concentración de asientos en últimos 3 días: revisar si son operativos o ajustes de cierre.`:'Distribución temporal adecuada.',riskWindow.length>10?'high':riskWindow.length>3?'medium':'low')}
        {insightCard('📋','Accruals del Período',accruals.length>0?String(accruals.length)+' líneas':'0',`Saldo neto: ${fmtUSD(accrualsNet)} · Verificar reversión automática`,accrualsNet!==0?A.warn:A.pass,`Confirmar que todos los accruals tienen fecha de reversión configurada. Saldo neto: ${fmtUSD(accrualsNet)}.`,Math.abs(accrualsNet)>100000?'high':'medium')}
        {insightCard('📦','Provisiones del Período',provisions.length>0?String(provisions.length)+' líneas':'0',`Saldo neto: ${fmtUSD(provisionsNet)} · Revisar soporte y aprobación`,Math.abs(provisionsNet)>500000?A.fail:Math.abs(provisionsNet)>100000?A.warn:A.pass,`Provisiones representan ${fmtUSD(provisionsNet)} neto. Verificar cálculo actuarial y aprobación del Controller.`,Math.abs(provisionsNet)>500000?'high':'medium')}
        {insightCard('🔗','Saldo Intercompañía Neto',Math.abs(icNet)>1000?fmtUSD(icNet):'✓ Cuadrado',`${icRows.length} líneas IC · Balance esperado: $0`,Math.abs(icNet)>1000?A.fail:A.pass,Math.abs(icNet)>1000?`Coordinar con contraparte IC para cuadrar ${fmtUSD(icNet)}. Bloqueo de cierre hasta resolver.`:'IC balanceado. Sin impacto en consolidado.',Math.abs(icNet)>1000?'high':'low')}
        {insightCard('📅','Asientos en Fin de Semana',weekendResult?.violations>0?String(weekendResult.violations)+' JEs':'✓ Ninguno',`Sábado/Domingo sin autorización especial`,weekendResult?.violations>5?A.fail:weekendResult?.violations>0?A.warn:A.pass,weekendResult?.violations>0?`Solicitar evidencia de aprobación para ${weekendResult.violations} asientos de fin de semana.`:'Sin asientos en fin de semana.',weekendResult?.violations>5?'high':'low')}
        {/* Per-country close risk */}
        <div style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,padding:'16px 18px',borderLeft:`4px solid ${A.orange}`,boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
          <div style={{fontFamily:mono,fontSize:10,textTransform:'uppercase',letterSpacing:'0.1em',color:A.t3,marginBottom:10}}>🌎 Saldo Neto por País (USD)</div>
          {ccodes.map(c=>{
            const{flag,name}=ci(c);
            const cRows=rawRows?.filter(r=>cc(r.COMPANY)===c)||[];
            const net=cRows.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);
            const manualC=cRows.filter(r=>String(r.SOURCE||'').toLowerCase().includes('spreadsheet'));
            const manualNetC=manualC.reduce((s,r)=>s+(Number(r.ACC_DEBIT||0)-Number(r.ACC_CREDIT||0)),0);
            const sc=sectionScore(closeResults,c);const sb=scoreBadge(sc?.pct??null);
            return(<div key={c} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'5px 0',borderBottom:`1px solid ${A.light}`}}>
              <span style={{fontSize:12}}>{flag} <span style={{fontSize:12,color:A.t2}}>{name}</span></span>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{fontFamily:mono,fontSize:10,color:A.t3}}>GL neto: {fmtUSD(net)}</span>
                <span style={{fontFamily:mono,fontSize:10,color:manualNetC!==0?A.warn:A.t3}}>Man: {fmtUSD(manualNetC)}</span>
                <span style={{fontFamily:cond,fontSize:12,fontWeight:800,color:sb.col,background:sb.bg,border:`1px solid ${sb.bord}`,padding:'2px 7px',borderRadius:4}}>{sb.txt}</span>
              </div>
            </div>);
          })}
        </div>
      </div>

      {/* ── Full close calendar 2026 ── */}
      <div style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,overflow:'hidden',boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
        <div style={{background:A.dark,padding:'10px 16px',fontFamily:cond,fontSize:13,fontWeight:700,color:A.amberL,letterSpacing:'0.08em',textTransform:'uppercase'}}>
          📅 Calendario de Cierre 2026 — EOM+6 (Local Close)
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))'}}>
          {Object.entries(CLOSE_CALENDAR).map(([m,c])=>{
            const isCurrent=parseInt(m)===mIdx;
            const isClosePast=new Date(c.close)<today;
            return(
              <div key={m} style={{padding:'12px 16px',border:`1px solid ${A.light}`,background:isCurrent?`rgba(232,82,10,.05)`:A.white,borderLeft:isCurrent?`3px solid ${A.orange}`:''}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
                  <span style={{fontFamily:cond,fontSize:16,fontWeight:800,color:isCurrent?A.orange:A.t1}}>{c.month}</span>
                  {isClosePast&&<span style={{fontFamily:mono,fontSize:9,background:A.passL,color:A.pass,padding:'2px 6px',borderRadius:3}}>CERRADO</span>}
                  {isCurrent&&!isClosePast&&<span style={{fontFamily:mono,fontSize:9,background:A.warnL,color:A.warn,padding:'2px 6px',borderRadius:3}}>ACTIVO</span>}
                </div>
                <div style={{fontFamily:mono,fontSize:11,color:A.t3}}>EOM: <span style={{color:A.t1}}>{c.eom}</span></div>
                <div style={{fontFamily:mono,fontSize:11,color:A.t3,marginTop:2}}>Close: <span style={{color:isClosePast?A.pass:A.orange,fontWeight:600}}>{c.close}</span></div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════
export default function AtlasApp(){
  const [step,setStep]=useState(0);
  const [rawRows,setRawRows]=useState([]);
  const [fileInfo,setFileInfo]=useState(null);
  const [ccodes,setCcodes]=useState([]);
  const [cvResults,setCvResults]=useState(null);
  const [cpResults,setCpResults]=useState(null);
  const [clResults,setClResults]=useState(null);
  const [allRuleSet,setAllRuleSet]=useState([...CV_RULES,...COMPLIANCE_RULES,...CLOSE_RULES].map(r=>({...r,active:true})));
  const [activeSection,setActiveSection]=useState('cv');
  const [detail,setDetail]=useState(null);
  const [detailShowGood,setDetailShowGood]=useState(false);
  const [aiText,setAiText]=useState('');
  const [aiLoading,setAiLoading]=useState(false);
  const [loading,setLoading]=useState(false);
  const [drag,setDrag]=useState(false);
  const [period,setPeriod]=useState('Apr-2026');
  const [reviewer,setReviewer]=useState('');
  const glRef=useRef(),detailRef=useRef();

  const inp={background:A.white,border:`1.5px solid ${A.light2}`,color:A.t1,fontFamily:body,fontSize:13,padding:'8px 12px',borderRadius:6,outline:'none'};
  const btn=(v='ghost',sm=false)=>{const base={display:'inline-flex',alignItems:'center',gap:6,padding:sm?'5px 12px':'9px 18px',borderRadius:6,fontFamily:body,fontWeight:600,fontSize:sm?11:13,cursor:'pointer',letterSpacing:'0.02em',transition:'all .15s'};
    if(v==='primary')return{...base,background:A.orange,border:`1.5px solid ${A.orange}`,color:A.white};
    if(v==='outline')return{...base,background:'transparent',border:`1.5px solid ${A.orange}`,color:A.orange};
    return{...base,background:A.white,border:`1.5px solid ${A.light2}`,color:A.t2};};

  const parseGL=useCallback((file)=>{
    setLoading(true);
    const reader=new FileReader();
    reader.onload=e=>{
      try{
        const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array',raw:true});
        const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});
        const cos=[...new Set(rows.map(r=>cc(r.COMPANY||'')).filter(Boolean))].sort();
        // ── Auto-detect period from PERIOD column or ACCOUNTING_DATE ──
        const MONTH_NAMES=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const periodCounts={};
        const sample=rows.slice(0,5000); // sample first 5000 rows for speed
        sample.forEach(r=>{
          // Priority 1: PERIOD column (e.g. "Apr-26" or "Apr-2026")
          const per=String(r.PERIOD||'').trim();
          if(per.length>=5&&per.includes('-')){
            const parts=per.split('-');
            if(parts[0].length===3){
              const yr=parts[1].length===2?'20'+parts[1]:parts[1];
              const key=parts[0]+'-'+yr;
              periodCounts[key]=(periodCounts[key]||0)+10; // weight higher
              return;
            }
          }
          // Priority 2: ACCOUNTING_DATE (may be serial or string)
          const d=parseAnyDate(r.ACCOUNTING_DATE);
          if(d&&!isNaN(d.getTime())){
            const key=MONTH_NAMES[d.getMonth()]+'-'+d.getFullYear();
            periodCounts[key]=(periodCounts[key]||0)+1;
          }
        });
        const detectedPeriod=Object.entries(periodCounts).sort((a,b)=>b[1]-a[1])[0]?.[0]||'Apr-2026';
        setRawRows(rows);setCcodes(cos);
        setFileInfo({name:file.name,rows:rows.length,detectedPeriod});
        setPeriod(detectedPeriod);
        setLoading(false);setStep(1);
      }catch(e){setLoading(false);alert('Error: '+e.message);}
    };
    reader.readAsArrayBuffer(file);
  },[]);

  const runAll=()=>{
    setLoading(true);
    setTimeout(()=>{
      const mIdx=getPeriodMonth(period);
      const cal=CLOSE_CALENDAR[mIdx]||CLOSE_CALENDAR[4];
      const active=allRuleSet.filter(r=>r.active!==false);
      setCvResults(runSection(rawRows,active.filter(r=>r.module==='CV Rules'),cal.close));
      setCpResults(runSection(rawRows,active.filter(r=>r.module==='Compliance'),cal.close));
      setClResults(runSection(rawRows,active.filter(r=>r.module==='Period Close'),cal.close));
      setLoading(false);setStep(2);
    },80);
  };

  const getCompliant=(rawRows,rule,countryCode,closeDate)=>{
    const rows=countryCode==='ALL'?rawRows:rawRows.filter(r=>cc(r.COMPANY)===countryCode);
    const tempResult=runSection(rows,[rule],closeDate);
    const vioSet=new Set((tempResult[0]?._violations||[]).map((_,i)=>i));
    const matching=rows.filter(r=>evalCondGroups(r,rule.conditionGroups));
    const violations=tempResult[0]?._violations||[];
    const violationKeys=new Set(violations.map(v=>JSON.stringify([v.JOURNAL_NAME,v.ACCOUNT,v.ACCOUNTING_DATE,v.ENT_DEBIT,v.ENT_CREDIT])));
    return matching.filter(r=>!violationKeys.has(JSON.stringify([r.JOURNAL_NAME,r.ACCOUNT,r.ACCOUNTING_DATE,r.ENT_DEBIT,r.ENT_CREDIT])));
  };

  const handleCellClick=(rule,countryCode)=>{
    const mIdx=getPeriodMonth(period);
    const cal=CLOSE_CALENDAR[mIdx]||CLOSE_CALENDAR[4];
    const violations=getViolations(rawRows,rule,countryCode,cal.close);
    const compliant=getCompliant(rawRows,rule,countryCode,cal.close);
    setDetail({rule,countryCode,rows:violations,compliantRows:compliant,page:0});
    setDetailShowGood(false);
    setTimeout(()=>detailRef.current?.scrollIntoView({behavior:'smooth',block:'start'}),80);
  };

  const callAI=async()=>{
    if(!cvResults||!cpResults||!clResults)return;
    setAiLoading(true);setAiText('');
    const all=[...cvResults,...cpResults,...clResults];
    const byCountry=ccodes.map(c=>{const{flag,name}=ci(c);
      const cvS=sectionScore(cvResults,c),cpS=sectionScore(cpResults,c),clS=sectionScore(clResults,c);
      return`${flag}${name}: CV=${cvS?.pct??'N/A'}%, Compliance=${cpS?.pct??'N/A'}%, Cierre=${clS?.pct??'N/A'}% (USD: ${fmtUSD((cvS?.amtUSD||0)+(cpS?.amtUSD||0)+(clS?.amtUSD||0))})`;
    }).join('\n');
    const fails=all.filter(r=>r.status!=='pass').slice(0,10).map(r=>`[${r.status.toUpperCase()}] ${r.id} (${r.module}): ${r.violations} violaciones, USD ${fmtUSD(r.amtUSD)}`).join('\n');
    const mIdx=getPeriodMonth(period);const cal=CLOSE_CALENDAR[mIdx]||CLOSE_CALENDAR[4];
    const today=new Date(),isLate=today>new Date(cal.close);
    const prompt=`Eres Controller de Atlas Renewable Energy (solar y eólica, multipaís: CL, MX, BR, CO, ES, UY). Período: ${period}. Deadline WD+6: ${cal.close} (${isLate?'VENCIDO':'VIGENTE'}).

SCORES POR PAÍS (3 secciones: CV Rules, Compliance, Cierre):
${byCountry}

REGLAS CON PROBLEMAS:
${fails}

Totales: CV Rules ${cvResults.filter(r=>r.status!=='pass').length} fail/warn | Compliance ${cpResults.filter(r=>r.status!=='pass').length} fail/warn | Cierre ${clResults.filter(r=>r.status!=='pass').length} fail/warn

Genera reporte ejecutivo en español para el CFO/Controller:
1. RESUMEN EJECUTIVO (3 líneas: estado general, país más crítico, monto USD en riesgo)
2. CV RULES: top 3 reglas con más violaciones y países afectados
3. COMPLIANCE: hallazgos críticos (montos USD)
4. CIERRE: estado vs deadline WD+6, riesgos de cierre
5. PLAN DE ACCIÓN (5 acciones concretas con responsable y plazo)
6. RECOMENDACIÓN SIGN-OFF: ¿proceder al cierre o hay bloqueos?
Sé preciso, usa cifras exactas.`;
    try{
      const res=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1400,messages:[{role:'user',content:prompt}]})});
      const data=await res.json();setAiText(data.content?.map(b=>b.text||'').join('')||'Sin respuesta.');
    }catch(e){setAiText('Error de conexión con Claude API.');}
    setAiLoading(false);
  };

  const allResults=[...(cvResults||[]),...(cpResults||[]),...(clResults||[])];
  const totalFail=allResults.filter(r=>r.status==='fail').length;
  const totalWarn=allResults.filter(r=>r.status==='warn').length;
  const totalPass=allResults.filter(r=>r.status==='pass').length;
  const totalUSD=allResults.reduce((s,r)=>s+(r.amtUSD||0),0);

  return(
  <div style={{minHeight:'100vh',background:A.off,fontFamily:body,color:A.t1}}>
    <style>{`*{box-sizing:border-box}select,input,textarea,button{font-family:inherit}
      ::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:${A.light}}::-webkit-scrollbar-thumb{background:${A.light2};border-radius:3px}
      @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}
    </style>

    {/* ── NAV ── */}
    <div style={{background:A.dark2,borderBottom:`3px solid ${A.orange}`,padding:'0 28px',display:'flex',alignItems:'center',justifyContent:'space-between',height:54,position:'sticky',top:0,zIndex:100}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <div style={{width:30,height:30,background:`linear-gradient(135deg,${A.orange},${A.amber})`,borderRadius:5,display:'flex',alignItems:'center',justifyContent:'center',fontFamily:cond,fontSize:14,fontWeight:800,color:'white'}}>A</div>
          <div>
            <div style={{fontFamily:cond,fontWeight:800,fontSize:13,letterSpacing:'0.08em',color:A.white,lineHeight:1}}>ATLAS</div>
            <div style={{fontFamily:cond,fontSize:8,letterSpacing:'0.2em',color:A.amberL,textTransform:'uppercase'}}>RENEWABLE ENERGY</div>
          </div>
        </div>
        <div style={{width:1,height:26,background:A.dark3}}/>
        <div style={{fontFamily:cond,fontSize:12,fontWeight:600,letterSpacing:'0.06em',color:'rgba(255,255,255,.6)',textTransform:'uppercase'}}>GL Compliance Engine v6.0</div>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        {fileInfo&&<span style={{fontFamily:mono,fontSize:10,color:'rgba(255,255,255,.4)',background:A.dark3,padding:'3px 9px',borderRadius:4}}>📁 {fileInfo.name} · {fileInfo.rows?.toLocaleString()} filas</span>}
        {fileInfo?.detectedPeriod&&<span style={{fontFamily:mono,fontSize:11,fontWeight:700,color:A.amberL,background:A.orange,padding:'3px 9px',borderRadius:4}}>📅 {fileInfo.detectedPeriod} (auto)</span>}
        <select value={period} onChange={e=>setPeriod(e.target.value)} style={{...inp,background:A.dark3,border:`1px solid ${A.dark4}`,color:A.white,padding:'4px 9px',fontSize:11}}>
          {['Jan-2026','Feb-2026','Mar-2026','Apr-2026','May-2026','Jun-2026','Jul-2026','Aug-2026','Sep-2026','Oct-2026','Nov-2026','Dec-2026'].map(p=><option key={p}>{p}</option>)}
        </select>
        <input value={reviewer} onChange={e=>setReviewer(e.target.value)} placeholder="Revisor..." style={{...inp,background:A.dark3,border:`1px solid ${A.dark4}`,color:A.white,width:120,fontSize:11}}/>
      </div>
    </div>

    {/* ── STEP TABS ── */}
    <div style={{background:A.dark,padding:'0 28px',display:'flex',gap:0,borderBottom:`1px solid rgba(255,255,255,.06)`}}>
      {['① Cargar GL','② Ejecutar','③ Resultados','④ AI Report'].map((l,i)=>(
        <button key={i} onClick={()=>i<=step&&setStep(i)} style={{padding:'11px 20px',fontFamily:cond,fontSize:12,fontWeight:600,letterSpacing:'0.06em',cursor:i<=step?'pointer':'default',border:'none',borderBottom:i===step?`3px solid ${A.orange}`:'3px solid transparent',background:'transparent',color:i===step?A.amberL:i<step?'rgba(255,255,255,.5)':'rgba(255,255,255,.22)',textTransform:'uppercase',marginBottom:i===step?-1:0}}>
          {l}{i<step?' ✓':''}
        </button>
      ))}
    </div>

    <div style={{maxWidth:1320,margin:'0 auto',padding:'24px 20px 80px'}}>

    {loading&&(
      <div style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:12,padding:'60px 40px',textAlign:'center',boxShadow:'0 4px 24px rgba(0,0,0,.06)'}}>
        <div style={{fontFamily:cond,fontSize:22,fontWeight:700,color:A.t1,marginBottom:6}}>Procesando GL Atlas RE...</div>
        <div style={{fontFamily:mono,fontSize:12,color:A.t3}}>Ejecutando {CV_RULES.length+COMPLIANCE_RULES.length+CLOSE_RULES.length} reglas sobre {rawRows.length?.toLocaleString()||'...'} líneas</div>
      </div>
    )}

    {/* ══ STEP 0: UPLOAD ══ */}
    {!loading&&step===0&&(
      <div style={{animation:'fadeUp .3s ease'}}>
        <h1 style={{fontFamily:cond,fontSize:30,fontWeight:800,color:A.t1,marginBottom:4}}>Cargar GL Account Analysis</h1>
        <p style={{color:A.t3,fontSize:14,marginBottom:20}}>Oracle ERP export · Todas las columnas deben incluir ACC_DEBIT y ACC_CREDIT (USD)</p>
        <div onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)}
          onDrop={e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files[0];if(f)parseGL(f);}}
          onClick={()=>glRef.current.click()}
          style={{border:`2px dashed ${drag?A.orange:A.light2}`,borderRadius:12,padding:'64px 40px',textAlign:'center',cursor:'pointer',background:drag?`rgba(232,82,10,.04)`:A.white,transition:'all .2s',marginBottom:16,boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
          <div style={{fontSize:52,marginBottom:12}}>📊</div>
          <div style={{fontFamily:cond,fontSize:22,fontWeight:800,color:A.t1,marginBottom:8}}>GL_Account_Analysis_*.xlsx</div>
          <div style={{fontFamily:mono,fontSize:10,color:A.t3,lineHeight:2,maxWidth:680,margin:'0 auto'}}>
            COMPANY · BC · PROJECT · ACCOUNT · COSTCENTER · INTERCOMPANY · SOURCE · CATEGORY<br/>
            <strong style={{color:A.orange}}>ACC_DEBIT · ACC_CREDIT</strong> (USD) · ENT_DEBIT · ENT_CREDIT · DESCRIPTION · ACCOUNTING_DATE · CREATION_DATE
          </div>
          <div style={{marginTop:20,display:'inline-flex',alignItems:'center',gap:8,background:A.orange,color:A.white,padding:'10px 24px',borderRadius:6,fontFamily:cond,fontWeight:700,fontSize:14,letterSpacing:'0.06em'}}>
            SELECCIONAR ARCHIVO
          </div>
          <input ref={glRef} type="file" accept=".xlsx,.xls" style={{display:'none'}} onChange={e=>e.target.files[0]&&parseGL(e.target.files[0])}/>
        </div>
        <div style={{background:A.infoL,border:`1px solid ${A.infoB}`,borderRadius:8,padding:'12px 18px',display:'flex',gap:10,alignItems:'center'}}>
          <span>🔒</span><span style={{fontSize:13,color:A.info}}>Procesado 100% localmente. Los datos no salen de tu navegador.</span>
        </div>
      </div>
    )}

    {/* ══ STEP 1: CONFIRM + RUN ══ */}
    {!loading&&step===1&&rawRows.length>0&&(
      <div style={{animation:'fadeUp .3s ease'}}>
        <h1 style={{fontFamily:cond,fontSize:28,fontWeight:800,marginBottom:4}}>Archivo cargado — Listo para validar</h1>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))',gap:12,marginBottom:20}}>
          {[[A.orange,'Total Filas',rawRows.length?.toLocaleString(),'del GL'],[A.amber,'Países',ccodes.length,'entidades'],[A.pass,'CV Rules',CV_RULES.length,'del Excel'],[A.info,'Compliance',COMPLIANCE_RULES.length,'best practices'],[A.warn,'Period Close',CLOSE_RULES.length,'cierre WD+6']].map(([col,lbl,val,sub])=>(
            <div key={lbl} style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,padding:'14px 16px',borderTop:`3px solid ${col}`,boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
              <div style={{fontFamily:mono,fontSize:10,textTransform:'uppercase',letterSpacing:'0.1em',color:A.t3,marginBottom:4}}>{lbl}</div>
              <div style={{fontFamily:cond,fontSize:28,fontWeight:800,color:col,lineHeight:1}}>{val}</div>
              <div style={{fontSize:11,color:A.t4,marginTop:4}}>{sub}</div>
            </div>
          ))}
        </div>
        <div style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,padding:'16px 20px',marginBottom:20,boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
          <div style={{fontFamily:cond,fontSize:14,fontWeight:700,marginBottom:10}}>Preview — Primeras 3 filas del GL</div>
          <div style={{overflowX:'auto'}}>
            <table style={{borderCollapse:'collapse',fontFamily:mono,fontSize:10,width:'100%'}}>
              <thead><tr style={{background:A.light}}>
                {['COMPANY','SOURCE','CATEGORY','BC','ACCOUNT','COSTCENTER','PROJECT','INTERCOMPANY','ACC_DEBIT','ACC_CREDIT','DESCRIPTION'].map(h=><th key={h} style={{padding:'6px 10px',textAlign:'left',color:A.t3,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.06em',whiteSpace:'nowrap',borderBottom:`1px solid ${A.light2}`,background:h.includes('ACC')?`rgba(232,82,10,.1)`:''}}>{h}</th>)}
              </tr></thead>
              <tbody>
                {rawRows.slice(0,3).map((row,i)=>(
                  <tr key={i} style={{borderBottom:`1px solid ${A.light}`}}>
                    {['COMPANY','SOURCE','CATEGORY','BC','ACCOUNT','COSTCENTER','PROJECT','INTERCOMPANY','ACC_DEBIT','ACC_CREDIT','DESCRIPTION'].map(col=>(
                      <td key={col} style={{padding:'7px 10px',color:A.t2,whiteSpace:'nowrap',fontWeight:col.includes('ACC')?600:400,color:col.includes('ACC')?A.orange:A.t2}}>{String(row[col]??'—').substring(0,30)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div style={{display:'flex',gap:10}}>
          <button onClick={runAll} style={{...btn('primary'),padding:'13px 34px',fontSize:15,fontFamily:cond,letterSpacing:'0.08em'}}>🚀 EJECUTAR {CV_RULES.length+COMPLIANCE_RULES.length+CLOSE_RULES.length} REGLAS →</button>
          <button onClick={()=>setStep(0)} style={btn()}>← Volver</button>
        </div>
      </div>
    )}

    {/* ══ STEP 2: RESULTS ══ */}
    {!loading&&step===2&&cvResults&&cpResults&&clResults&&(
      <div style={{animation:'fadeUp .3s ease'}}>
        {/* Global stats bar */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))',gap:10,marginBottom:18}}>
          {[[A.pass,'PASS',totalPass,'reglas OK'],[A.warn,'WARN',totalWarn,'revisar'],[A.fail,'FAIL',totalFail,'críticas'],[A.orange,'USD en Error',fmtUSD(totalUSD),'ACC_D+ACC_C']].map(([col,lbl,val,sub])=>(
            <div key={lbl} style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,padding:'14px 16px',borderTop:`3px solid ${col}`,boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
              <div style={{fontFamily:mono,fontSize:10,textTransform:'uppercase',letterSpacing:'0.1em',color:A.t3,marginBottom:3}}>{lbl}</div>
              <div style={{fontFamily:cond,fontSize:28,fontWeight:800,color:col,lineHeight:1}}>{val}</div>
              <div style={{fontSize:11,color:A.t4,marginTop:3}}>{sub}</div>
            </div>
          ))}
        </div>

        {/* Section tabs */}
        <div style={{display:'flex',gap:6,marginBottom:16,alignItems:'center',flexWrap:'wrap'}}>
          {[['cv',`📋 CV Rules (${allRuleSet.filter(r=>r.module==='CV Rules'&&r.active!==false).length})`],['cp',`🛡️ Compliance (${allRuleSet.filter(r=>r.module==='Compliance'&&r.active!==false).length})`],['cl',`🔒 Cierre (${allRuleSet.filter(r=>r.module==='Period Close'&&r.active!==false).length})`],['wd','📊 WD Analysis'],['rules','⚙️ Reglas']].map(([k,l])=>(
            <button key={k} onClick={()=>{setActiveSection(k);setDetail(null);}} style={{...btn(activeSection===k?'primary':'ghost'),padding:'9px 20px'}}>{l}</button>
          ))}
          <div style={{marginLeft:'auto',display:'flex',gap:8}}>
            <button onClick={()=>exportManagerReport(rawRows,allResults,ccodes,period)} style={btn('outline',true)}>📊 Manager Report</button>
            <button onClick={()=>{setStep(3);if(!aiText)callAI();}} style={btn('primary',true)}>🤖 AI Report</button>
          </div>
        </div>

        {/* SECTION: CV RULES */}
        {activeSection==='cv'&&(
          <div>
            <div style={{background:A.dark,border:`1px solid ${A.dark3}`,borderRadius:'8px 8px 0 0',padding:'12px 18px',display:'flex',alignItems:'center',gap:10}}>
              <span style={{background:A.orange,color:A.white,fontFamily:cond,fontWeight:800,fontSize:12,padding:'4px 10px',borderRadius:4,letterSpacing:'0.08em'}}>CV RULES</span>
              <span style={{fontFamily:cond,fontSize:13,color:'rgba(255,255,255,.7)'}}>Reglas del archivo Cross_Validation_rules.xlsx · {CV_RULES.length} reglas · Importes en USD (ACC_DEBIT/ACC_CREDIT)</span>
            </div>
            <Heatmap sectionResults={cvResults} ccodes={ccodes} onCellClick={handleCellClick} sectionLabel="CV Rules"/>
          </div>
        )}

        {/* SECTION: COMPLIANCE */}
        {activeSection==='cp'&&(
          <div>
            <div style={{background:A.dark,border:`1px solid ${A.dark3}`,borderRadius:'8px 8px 0 0',padding:'12px 18px',display:'flex',alignItems:'center',gap:10}}>
              <span style={{background:'#1D4ED8',color:A.white,fontFamily:cond,fontWeight:800,fontSize:12,padding:'4px 10px',borderRadius:4,letterSpacing:'0.08em'}}>COMPLIANCE</span>
              <span style={{fontFamily:cond,fontSize:13,color:'rgba(255,255,255,.7)'}}>Best practices contables · Descripción manual, importes negativos, BC sin asignar, importes redondos</span>
            </div>
            <ComplianceInsights rawRows={rawRows} cpResults={cpResults} ccodes={ccodes}/>
            <Heatmap sectionResults={cpResults} ccodes={ccodes} onCellClick={handleCellClick} sectionLabel="Compliance"/>
          </div>
        )}

        {/* SECTION: PERIOD CLOSE */}
        {activeSection==='cl'&&(
          <div>
            <div style={{background:A.dark,border:`1px solid ${A.dark3}`,borderRadius:'8px 8px 0 0',padding:'12px 18px',display:'flex',alignItems:'center',gap:10}}>
              <span style={{background:A.warn,color:A.white,fontFamily:cond,fontWeight:800,fontSize:12,padding:'4px 10px',borderRadius:4,letterSpacing:'0.08em'}}>PERIOD CLOSE</span>
              <span style={{fontFamily:cond,fontSize:13,color:'rgba(255,255,255,.7)'}}>WD+6 Calendar · Asientos tardíos · Balance ACC USD · Fines de semana</span>
            </div>
            <CloseCalendar period={period} closeResults={clResults} rawRows={rawRows} ccodes={ccodes}/>
            <Heatmap sectionResults={clResults} ccodes={ccodes} onCellClick={handleCellClick} sectionLabel="Period Close"/>
          </div>
        )}

        {/* SECTION: WD ANALYSIS */}
        {activeSection==='wd'&&rawRows.length>0&&(
          <WDAnalysis rawRows={rawRows} ccodes={ccodes} period={period}/>
        )}

        {/* SECTION: RULE MANAGER */}
        {activeSection==='rules'&&(
          <RuleManager allRules={allRuleSet} setAllRules={setAllRuleSet} onRun={()=>{setActiveSection('cv');runAll();}}/>
        )}

        {/* Detail panel — shows violations AND compliant rows */}
        {detail&&(
          <div ref={detailRef}>
            <DetailPanel detail={detail} showGood={detailShowGood}
              onToggleGood={()=>setDetailShowGood(v=>!v)}
              onClose={(d)=>{if(d&&d.page!==undefined)setDetail(d);else setDetail(null);}}
              onExport={()=>exportViolations(detail.rows,detail.rule.id,detail.countryCode,detail.rule.errorMsg)}/>
          </div>
        )}
      </div>
    )}

    {/* ══ STEP 3: AI REPORT ══ */}
    {!loading&&step===3&&(
      <div style={{animation:'fadeUp .3s ease'}}>
        <h1 style={{fontFamily:cond,fontSize:28,fontWeight:800,marginBottom:16}}>🤖 Reporte Ejecutivo — Análisis IA</h1>
        {/* Country scores */}
        {cvResults&&cpResults&&clResults&&(
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12,marginBottom:22}}>
            {ccodes.map(c=>{
              const{flag,name}=ci(c);
              const cvSc=sectionScore(cvResults,c),cpSc=sectionScore(cpResults,c),clSc=sectionScore(clResults,c);
              const overall=[cvSc?.pct,cpSc?.pct,clSc?.pct].filter(v=>v!=null);
              const avgPct=overall.length?Math.round(overall.reduce((a,b)=>a+b,0)/overall.length):null;
              const sb=scoreBadge(avgPct);
              const totalA=(cvSc?.amtUSD||0)+(cpSc?.amtUSD||0)+(clSc?.amtUSD||0);
              return(
                <div key={c} style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,padding:'14px 16px',borderTop:`3px solid ${sb.col}`,boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}><span style={{fontSize:20}}>{flag}</span><span style={{fontFamily:cond,fontWeight:700,fontSize:14,color:A.t2}}>{name}</span></div>
                  <div style={{fontFamily:cond,fontSize:30,fontWeight:800,color:sb.col,lineHeight:1}}>{sb.txt}</div>
                  <div style={{fontSize:10,color:A.t4,marginTop:4}}>score promedio</div>
                  {totalA>0&&<div style={{fontFamily:mono,fontSize:10,color:A.fail,marginTop:4,fontWeight:600}}>⚑ {fmtUSD(totalA)} USD</div>}
                  {[['CV',cvSc],['Comp',cpSc],['Close',clSc]].map(([lbl,sc])=>{const ssb=scoreBadge(sc?.pct??null);return sc?(
                    <div key={lbl} style={{display:'flex',justifyContent:'space-between',marginTop:4,padding:'3px 8px',background:ssb.bg,borderRadius:4,border:`1px solid ${ssb.bord}`}}>
                      <span style={{fontSize:10,color:A.t3,fontWeight:600}}>{lbl}</span>
                      <span style={{fontSize:10,color:ssb.col,fontWeight:700}}>{ssb.txt}</span>
                    </div>
                  ):null;})}
                </div>
              );
            })}
          </div>
        )}
        <div style={{background:A.white,border:`1px solid ${A.light2}`,borderRadius:10,padding:'20px 24px',marginBottom:20,boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
            <span style={{fontFamily:cond,fontSize:18,fontWeight:700}}>Análisis Narrativo — Claude AI</span>
            <button onClick={callAI} style={btn('ghost',true)}>{aiLoading?'⟳ Analizando...':'↺ Re-generar'}</button>
          </div>
          {aiLoading&&<div style={{textAlign:'center',padding:'40px 0',fontFamily:mono,fontSize:12,color:A.t3}}>⟳ Claude está analizando {CV_RULES.length+COMPLIANCE_RULES.length+CLOSE_RULES.length} reglas × {ccodes.length} países...</div>}
          {!aiLoading&&!aiText&&<div style={{textAlign:'center',padding:'50px 0'}}><button onClick={callAI} style={btn('primary')}>Generar Análisis con Claude</button></div>}
          {aiText&&<div style={{fontSize:14,lineHeight:1.85,color:A.t2,background:A.off,borderRadius:8,padding:'20px 22px',border:`1px solid ${A.light2}`,whiteSpace:'pre-wrap'}}>{aiText}</div>}
        </div>
        <div style={{display:'flex',gap:8,justifyContent:'space-between',flexWrap:'wrap'}}>
          <button onClick={()=>setStep(2)} style={btn()}>← Resultados</button>
          <div style={{display:'flex',gap:8}}>
            {allResults.length>0&&<button onClick={()=>exportManagerReport(rawRows,allResults,ccodes,period)} style={btn('outline')}>📊 Export Manager Report</button>}
            <button onClick={()=>window.print()} style={btn()}>🖨 Imprimir</button>
          </div>
        </div>
      </div>
    )}

    {/* Footer */}
    <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:A.t4,borderTop:`1px solid ${A.light2}`,marginTop:40,paddingTop:12,flexWrap:'wrap',gap:6}}>
      <span style={{display:'flex',alignItems:'center',gap:6}}><span style={{width:6,height:6,borderRadius:'50%',background:A.orange,display:'inline-block',animation:'pulse 2s infinite'}}/>Atlas RE · GL Compliance Engine v6.0 · ACC_DEBIT/ACC_CREDIT = USD</span>
      <span>{new Date().toLocaleString('es-CL')}</span><span>{period} · Revisor: {reviewer||'—'}</span>
    </div>
    </div>
  </div>
  );
}
