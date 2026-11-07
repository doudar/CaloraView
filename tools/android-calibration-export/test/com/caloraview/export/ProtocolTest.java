package com.caloraview.export;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class ProtocolTest {
    static void check(boolean ok,String message){if(!ok)throw new AssertionError(message);}
    interface Checked {void run() throws Exception;}
    static void rejects(Checked checked)throws Exception{try{checked.run();}catch(IOException expected){return;}throw new AssertionError("Expected input rejection");}
    static final class FakeUsb implements CalibrationProtocol.Transport {
        int selector,subcommand,fileType,phase,offset,lengthQueries;boolean announced;int selectionLength=2;
        byte[] factory={10,20,30,40,50,60};byte[] thermo=new byte[72];
        FakeUsb(){byte[] name="fixture-calibration".getBytes(StandardCharsets.UTF_8);System.arraycopy(name,0,thermo,0,name.length);thermo[64]=4;thermo[68]=11;thermo[69]=22;thermo[70]=33;thermo[71]=44;}
        public int control(int type,int request,int value,int index,byte[] bytes,int timeout)throws IOException{
            check(index==0x0a00 && timeout==5000,"Unexpected transport setup");int control=value>>>8;
            if(type==0x21){check(request==1 && CalibrationProtocol.isAllowedSet(control,bytes),"Unexpected mutation");if(control==5){check(bytes.length==selectionLength,"Selection did not honor GET_LEN");selector=bytes[0];subcommand=bytes[1];phase=0;offset=0;}else if(bytes.length==5){announced=true;}else{check(announced,"Missing length announcement");fileType=bytes[5];announced=false;}return bytes.length;}
            check(type==0xa1,"Unexpected direction");
            if(request==0x85){lengthQueries++;int size=control==5?selectionLength:control==4?4:control==6?1:control==1?16:selector==26&&subcommand==1?(announced?13:5):phase==0?5:selector==26?Math.min(4,factory.length-offset)+5:Math.min(507,thermo.length-offset)+5;bytes[0]=(byte)size;bytes[1]=(byte)(size>>>8);return 2;}
            check(request==0x81,"Unexpected read request");byte[] reply;
            if(control==4)reply=new byte[]{50,46,48,0};else if(control==6)reply=new byte[]{0};else if(control==1)reply="fixture-identity".getBytes(StandardCharsets.UTF_8);
            else if(phase++==0){int total=selector==26?factory.length:thermo.length;reply=new byte[]{1,(byte)total,0,0,0};}
            else{byte[] source=selector==26?factory:thermo;int count=Math.min(selector==26?4:507,source.length-offset);reply=new byte[count+5];reply[0]=2;reply[1]=(byte)phase;System.arraycopy(source,offset,reply,5,count);offset+=count;}
            check(reply.length<=bytes.length,"Host requested too few bytes");System.arraycopy(reply,0,bytes,0,reply.length);return reply.length;
        }
    }
    public static void main(String[] args)throws Exception {
        rejects(()->CalibrationProtocol.parseSize(new byte[4],100));rejects(()->CalibrationProtocol.parseSize(new byte[5],100));rejects(()->CalibrationProtocol.parseSize(new byte[]{1,-1,-1,-1,-1},100));
        rejects(()->CalibrationProtocol.chunkPayloadLength(new byte[512],10,0));rejects(()->CalibrationProtocol.chunkPayloadLength(new byte[5],10,0));rejects(()->CalibrationProtocol.chunkPayloadLength(new byte[6],10,10));
        check(CalibrationProtocol.chunkPayloadLength(new byte[8],510,507)==3,"Short final packet");
        check(!CalibrationProtocol.isAllowedSet(2,new byte[186]),"Shutter/settings must be blocked");check(!CalibrationProtocol.isAllowedSet(5,new byte[]{26,3,1,0}),"Upload selection must be blocked");check(!CalibrationProtocol.isAllowedSet(26,new byte[]{2,1,0,0,0,99,1,0,0,0,0,0,0}),"Unknown factory file must be blocked");
        FakeUsb usb=new FakeUsb();CalibrationProtocol.Bundle result=new CalibrationProtocol(usb,10,0,message->{}).readAll("fixture");
        check(result.complete,"Scripted complete export failed: "+result.outcomes);
        FakeUsb fourByteUsb=new FakeUsb();fourByteUsb.selectionLength=4;check(new CalibrationProtocol(fourByteUsb,10,0,message->{}).readAll("fixture").complete,"Four-byte command selection failed");
        FakeUsb badLengthUsb=new FakeUsb();badLengthUsb.selectionLength=3;check(!new CalibrationProtocol(badLengthUsb,10,0,message->{}).readAll("fixture").complete,"Invalid command selection length accepted");
        check(Arrays.equals(result.files.get("BPM.bin"),usb.factory),"Factory bytes changed");check(Arrays.equals(result.files.get("thermometry-calibration.bin"),new byte[]{11,22,33,44}),"Thermometry framing");check(usb.lengthQueries>=20,"Fresh GET_LEN missing");
        check(CalibrationProtocol.sha256(new byte[0]).equals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),"SHA256 mismatch");
        if(args.length==1){java.nio.file.Path fixture=java.nio.file.Paths.get(args[0]);java.nio.file.Files.createDirectories(fixture);for(java.util.Map.Entry<String,byte[]> file:result.files.entrySet())java.nio.file.Files.write(fixture.resolve(file.getKey()),file.getValue());System.out.println("Wrote synthetic export fixture: "+fixture);}
        System.out.println("Protocol tests passed: allowlist, malformed lengths, short final chunks, fresh GET_LEN, full scripted export and SHA256. No hardware accessed.");
    }
}
