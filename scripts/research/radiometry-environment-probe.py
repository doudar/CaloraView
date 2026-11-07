"""Offline differential inputs for the device83 atmosphere and T^4 branch. No hardware."""
import sys,pathlib,runpy,struct,json,argparse,hashlib,itertools
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--library',required=True,type=pathlib.Path);p.add_argument('--calibration',required=True,type=pathlib.Path)
p.add_argument('--metadata',required=True,type=pathlib.Path);p.add_argument('--out',required=True,type=pathlib.Path)
p.add_argument('--synthetic',action='store_true',help='Replace only atmosphere and spectral fields with synthetic test coefficients')
a=p.parse_args();root=pathlib.Path(__file__).resolve().parents[2]
sys.argv=['mtlib-oracle.py','--calculator','float-online','--library',str(a.library),'--calibration',str(a.calibration),'--metadata',str(a.metadata),'--width','256','--height','192','--ambient','20','--reflected','20','--humidity','60','--distance','1','--emissivity','.97','--gray','9447']
m=runpy.run_path(str(root/'scripts/research/mtlib-oracle.py'),run_name='oracle_module');u=m['u'];alloc=m['alloc'];call=m['call'];rd=m['rd']
def f(x):return struct.unpack('<f',struct.pack('<f',x))[0]
def putf(address,value):u.mem_write(address,struct.pack('<f',value))
def rf(address):return struct.unpack('<f',rd(address,4))[0]
def setf(index,value):u.reg_write(m['UC_ARM64_REG_S0']+index,struct.unpack('<I',struct.pack('<f',value))[0])
cal=m['calibration_bytes']
if a.synthetic:
 cal=bytearray(cal)
 for index,model in enumerate(((1,1,0),(.5,20,2),(2,100,-3))):
  struct.pack_into('<3f',cal,0x21ac+index*32,*model)
  struct.pack_into('<3f',cal,0x3680+index*16,0,0,0)
  struct.pack_into('<f',cal,0x3758+index*16,0)
 struct.pack_into('<2f',cal,0x3784,0,0)
 cal=bytes(cal)
calptr=alloc(cal);h=alloc(0x600);u.mem_write(h+0x140,struct.pack('<Q',calptr));u.mem_write(h+0x498,b'\x01');u.mem_write(h+0x441,b'\x01');u.mem_write(h+3,b'\x06')
point=alloc(36);atm=alloc(36);out=alloc(4);cases=[]
for range_index,ambient,rh,distance in itertools.product((0,1,2),(-10,20,45),(0,60,100),(.05,1,10)):
 env={'ambientC':ambient,'humidityPercent':rh,'distanceMeters':distance,'range':range_index}
 u.mem_write(h+0xf9,bytes([range_index]))
 u.mem_write(atm,struct.pack('<9f',ambient,f(f(rh)*f(.01)),distance,.03,10000,0,0,0,0));putf(h+0xd0,ambient)
 status=call('MT_SetAtmTrsmit',h,atm);tau=rf(atm+20) if status==0 else None
 for emissivity,reflected,bb in itertools.product((.1,.97,1),(-10,20,40),(-40,20,53.37890625,150)):
  result={'environment':{**env,'emissivity':emissivity,'reflectedC':reflected},'blackbodyC':bb,'transmissionStatus':status,'tau':tau}
  if status==0:
   putf(point+20,emissivity);putf(point+24,reflected);setf(0,bb);setf(1,tau)
   s=call('MT_BBtemp2Objtemp',out,h,point);result.update(status=s,celsius=rf(out) if s==0 else None)
  cases.append(result)
report={'researchOnly':True,'syntheticAtmosphere':a.synthetic,'sceneAccuracyValidated':False,'librarySha256':hashlib.sha256(a.library.read_bytes()).hexdigest(),'calibrationSha256':hashlib.sha256(cal).hexdigest(),'cases':cases}
a.out.parent.mkdir(parents=True,exist_ok=True);a.out.write_text(json.dumps(report,indent=2));print(json.dumps({'cases':len(cases),'output':str(a.out)}))
