'use strict';

// Independently ported device83 FLOAT ONLINE branch. No native library is loaded.
// Source landmarks: MT_CalcAtmTrsmit 0xfd48, MT_BBtemp2Objtemp 0x1337c.
const f = Math.fround;
const EPS = 2 ** -23;
const K = f(273.15);
const slopes = [-.075,-.066667,-.048,-.04,-.020667,-.0106,-.0064,-.003267,-.00148,-.00073].map(f);
const intercepts = [1,.9983332753181458,.989,.981,.9423332810401917,.892,.85,.7873333096504211,.698,.623].map(f);
const boundaries = [.2,.5,1,2,5,10,20,50,100,200].map(f);
function calcTransmission({ambientC, humidityFraction, distanceMeters, particleSize=.03, visibility=10000}, model) {
  const [waterScale, gasScale, distanceOffset] = model.map(f);
  const t = f(ambientC), rh = f(humidityFraction), particles = f(particleSize), vis = f(visibility);
  const distance = f(f(distanceMeters) + f(distanceOffset * f(-.001)));
  const signedWater = f(distance * waterScale);
  const positive = signedWater > EPS;
  const water = positive ? signedWater : f(-signedWater);
  const gas = Math.min(f((positive ? 1 : -1) * f(distance * gasScale)), 200);
  const t2 = f(t*t), t3 = f(t2*t), t4 = f(t3*t);
  let polynomial = f(f(t*f(.341154545545578)) + f(4.7773213386535645));
  polynomial = f(polynomial + f(t2*f(.009551350958645344)));
  polynomial = f(polynomial + f(t3*f(.0001643152063479647)));
  polynomial = f(polynomial + f(t4*f(.0000024755597678449703)));
  const waterDistance = f(Math.exp(f(particles*f(-.0654))) * water);
  const wet = f(Math.exp(f(f(f(polynomial*rh)*waterDistance)*f(-.015912804752588272))));
  let index = boundaries.findIndex(b => gas <= b);
  if (index < 0) index = 9;
  const gasDistance = f(Math.exp(f(particles*f(-.19))) * gas);
  const dry = f(intercepts[index] + f(slopes[index]*gasDistance));
  const exponent = vis < 6 ? f(Math.pow(vis, .3333333432674408)*.5849999785423279)
    : vis > 80 ? 1.600000023841858 : 1.2999999523162842;
  const haze = f(Math.exp(Math.pow(.056944601237773895, exponent)*f(f(-3.91)/vis)*water));
  let tau = f(f(dry*wet)*haze);
  if (!Number.isFinite(tau) || tau < EPS || tau > 1) return {status:-305,tau:null};
  if (!positive) tau = f(1 + f(f(1-tau)*1.5));
  return {status:0,tau};
}
function encodeSdkDistance(distanceMeters) {
  // Java FloatConverter.floatToUIntd3 encodes UI metres as float32 Q13.
  // MicroTA 0x9c60c..0x9c628 decodes Q13 directly into point+28; it does
  // NOT multiply by1000. MT_Process_OL 0x70ac..0x70d8 applies .001 internally.
  const q13 = Math.trunc(f(f(distanceMeters) * 8192));
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0 || q13 < 1 || q13 > 0xffffffff) throw new Error('Distance exceeds native positive Q13 bounds');
  const decoded = f(f(q13) / 8192);
  const pointDistance = f(f(decoded * 10) / 10);
  return { q13, pointDistance, atmosphericDistance: f(pointDistance * f(.001)) };
}
function normalizeSdkEnvironment(options={}) {
  const {ambientC=20,reflectedC=20,humidityPercent=60,distanceMeters=1,emissivity=.97}=options;
  const milli=value=>{
    const integer=Math.round(value*1000);
    if (!Number.isFinite(value)||integer< -2147483648||integer>2147483647) throw new Error('Environmental setting exceeds native milli-unit bounds');
    return f(f(integer)*f(.001));
  };
  if (![reflectedC,distanceMeters,emissivity].every(Number.isFinite)) throw new Error('Invalid environmental settings');
  return {...options,ambientC:milli(ambientC),humidityPercent:Math.round(humidityPercent*1000)===100000?100:milli(humidityPercent),
    distanceMeters:encodeSdkDistance(distanceMeters).atmosphericDistance,reflectedC:f(reflectedC),emissivity:f(emissivity)};
}
function prepareEnvironment(calibration, options={}) {
  if (!Buffer.isBuffer(calibration) || calibration.length !== 14336 || calibration.readUInt32LE(0)!==0x404
      || calibration.readUInt32LE(8)!==83 || calibration.readInt32LE(0x2b10)!==0) throw new Error('Unsupported environmental calibration branch');
  const {ambientC=20,reflectedC=20,humidityPercent=60,distanceMeters=1,emissivity=.97,range=0,lens=0}=options;
  if (![ambientC,reflectedC,humidityPercent,distanceMeters,emissivity].every(Number.isFinite)
      || ambientC<=-273.15 || reflectedC<=-273.15 || humidityPercent<0 || humidityPercent>100
      || distanceMeters<=0 || emissivity<f(.01) || emissivity>1) throw new Error('Invalid environmental settings');
  if (!Number.isInteger(range)||range<0||range>2||lens!==0) throw new Error('Unsupported atmospheric range or lens');
  const c=o=>{const v=calibration.readFloatLE(o);if(!Number.isFinite(v))throw new Error('Non-finite atmospheric coefficient');return v;};
  // These optional native branches require separate verification before use.
  if (c(0x3784)!==0 && c(0x3788)!==0) throw new Error('Unsupported spectral object-temperature conversion');
  if (c(0x3680+range*16)!==0 && c(0x3684+range*16)!==0) throw new Error('Unsupported custom atmospheric polynomial');
  const offset=lens*160+range*32;
  const model=[c(0x21ac+offset),c(0x21b0+offset),c(0x21b4+offset)];
  // Native default handle441=1, handle1a3=0: optional range0 lens correction.
  if (lens===0 && range<=2 && Math.abs(c(0x3758+range*16))>EPS) model[1]=1;
  const environment={ambientC:f(ambientC),reflectedC:f(reflectedC),humidityPercent:f(humidityPercent),
    distanceMeters:f(distanceMeters),emissivity:f(emissivity),range,lens};
  if (!Object.values(environment).every(Number.isFinite)) throw new Error('Environmental settings exceed float32 bounds');
  return {...environment,...calcTransmission({...environment,humidityFraction:f(f(humidityPercent)*f(.01))},model)};
}
function blackbodyToObject(blackbodyC, environment) {
  const {tau,emissivity,ambientC,reflectedC,status}=environment;
  if (status!==0 || !Number.isFinite(blackbodyC) || blackbodyC<=-273.15
      || ![tau,emissivity,ambientC,reflectedC].every(Number.isFinite) || tau<=0 || emissivity<=0 || emissivity>1) return {status:status||-19,celsius:null};
  const power4=x=>{const k=f(f(x)+K),square=f(k*k);return f(square*square);};
  const bb=power4(blackbodyC), ambient=power4(ambientC), reflected=power4(reflectedC);
  const effective=f(f(emissivity)*f(tau));
  let energy=f(f(bb*f(.97)) + f(ambient*f(.029999971389770508)));
  energy=f(energy-f(f(f(tau)-effective)*reflected));
  energy=f(energy-f(f(1-f(tau))*ambient));
  if (!Number.isFinite(energy)||energy<EPS) return {status:-19,celsius:null};
  const celsius=f(f(Math.sqrt(f(Math.sqrt(f(energy/effective)))))-K);
  return Number.isFinite(celsius)?{status:0,celsius}:{status:-19,celsius:null};
}
module.exports={prepareEnvironment,blackbodyToObject,calcTransmission,normalizeSdkEnvironment,encodeSdkDistance};
