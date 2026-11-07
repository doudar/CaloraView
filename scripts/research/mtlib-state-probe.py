"""Offline float-online intermediate-state probe; vendor files stay local."""
import sys, pathlib, runpy, struct, json, argparse
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--calibration',required=True,type=pathlib.Path)
p.add_argument('--metadata',required=True,type=pathlib.Path)
p.add_argument('--out',required=True,type=pathlib.Path)
p.add_argument('--gray',type=int,default=9000)
a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[2]
sys.argv=['mtlib-oracle.py','--calculator','float-online','--library',str(root/'research/decompiled/resources/lib/arm64-v8a/libMTlib.so'),'--calibration',str(a.calibration),'--metadata',str(a.metadata),'--width','256','--height','192','--ambient','20','--reflected','20','--humidity','60','--distance','1','--emissivity','.97','--gray',str(a.gray)]
m=runpy.run_path(str(root/'scripts/research/mtlib-oracle.py'),run_name='oracle_module')
u=m['u']; alloc=m['alloc'];call=m['call'];rd=m['rd']
def checked(name,*v):
 r=call(name,*v)
 if r:raise RuntimeError((name,r))
ability=alloc(struct.pack('<4I',256,192,0,0));mt=alloc(48)
checked('MT_GetMemSize_OL',ability,mt)
for off in (0,24):u.mem_write(mt+off,struct.pack('<Q',alloc(m['u32'](mt+off+8))))
out=alloc(8);checked('MT_Create_OL',ability,mt,out);h=m['u64'](out)
checked('MT_SetCalibParam',h,alloc(m['calibration_bytes']))
for key,value in ((5,20000),(6,60000),(7,1000000),(13,0),(15,83),(29,0),(35,6)):
 checked('MT_SetConfig_OL',h,1,alloc(struct.pack('<ii',key,value)),8)
checked('MT_SetAddlParam',h,alloc(m['metadata_bytes']))
events=[]
def trace(uc,address,size,user):
 name=user
 regs=[u.reg_read(m['UC_ARM64_REG_X0']+i) for i in range(4)]
 fp=[struct.unpack('<f',struct.pack('<I',u.reg_read(m['UC_ARM64_REG_S0']+i)))[0] for i in range(4)]
 events.append({'function':name,'x':regs,'s':fp})
names=['MT_PreProcess_OL','MT_CalcRealRespnsCoeff_OL','MT_CalcBaseGray_OL','MT_SetAtmTrsmit','MT_CalcAtmTrsmit','MT_Gray2Temp','MT_ResponseEXPInv','MT_ResponsePWPInv','MT_BBtemp2Objtemp','MT_Objtemp2BBtemp','MT_CompensateZeroSet','MT_CompensateHEP_HIK','MT_CompensateHEP_HZSK','MT_CalRiseTemp']
for name in names:
 va=m['symbols'][name];u.hook_add(m['UC_HOOK_CODE'],trace,user_data=name,begin=va,end=va)
before=rd(h,0x600)
q=alloc(struct.pack('<4I4fi',0,a.gray,0,0,0,.97,20,1000,0));status=call('MT_Process_OL',h,0,q,1)
after=rd(h,0x600)
a.out.mkdir(parents=True,exist_ok=True)
(a.out/'before.bin').write_bytes(before);(a.out/'after.bin').write_bytes(after)
fields=[{'offset':hex(i),'u32':struct.unpack_from('<I',after,i)[0],'f32':struct.unpack_from('<f',after,i)[0]} for i in range(0,0x140,4)]
report={'researchOnly':True,'sceneAccuracyValidated':False,'status':status,'pointHex':rd(q,36).hex(),'events':events,'fields':fields}
(a.out/'report.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
