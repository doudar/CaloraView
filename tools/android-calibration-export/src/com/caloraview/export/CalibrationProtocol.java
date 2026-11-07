package com.caloraview.export;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

/** APK-derived SK02 read transactions only; no arbitrary command entry point. */
public final class CalibrationProtocol {
    public interface Transport {
        int control(int requestType, int request, int value, int index, byte[] bytes, int timeoutMs) throws IOException;
    }
    public interface Progress { void update(String message); }
    private final Transport usb;
    private final int index;
    private final Progress progress;
    private final StringBuilder trace = new StringBuilder("direction\trequest\tselector\trequested\treturned\thex\n");
    private long deadline;
    public CalibrationProtocol(Transport usb, int unit, int intf, Progress progress) {
        if (unit != 10 || intf != 0) throw new IllegalArgumentException("Only verified SK02 unit10/interface0 is supported.");
        this.usb = usb; this.index = (unit << 8) | intf; this.progress = progress;
    }
    public static final class Bundle {
        public final LinkedHashMap<String, byte[]> files = new LinkedHashMap<>();
        public final LinkedHashMap<String, String> outcomes = new LinkedHashMap<>();
        public boolean complete;
        public boolean protocolVerified;
    }
    public Bundle readAll(String deviceIdentity) {
        deadline = System.nanoTime() + 90_000_000_000L;
        Bundle result = new Bundle();
        try {
            progress.update("Checking protocol version");
            int size = length(4);
            byte[] version = get(4, size);
            if (!Arrays.equals(version, new byte[] {50,46,48,0})) throw new IOException("Expected protocol 2.0.");
            result.protocolVerified=true;
            select(1,1);
            byte[] identity = get(1, length(1));
            if(identity.length == 0) throw new IOException("Empty device identity.");
            result.files.put("device-identity.bin", identity);
            int[] types = {4,11,14}; String[] names = {"BPM.bin","KMatrix.bin","KMatrix2.bin"};
            for(int i=0;i<types.length;i++) {
                try {
                    progress.update("Reading " + names[i]);
                    byte[] file=readFactory(types[i]);
                    result.files.put(names[i],file); result.outcomes.put(names[i],"complete");
                } catch(IOException error) { result.outcomes.put(names[i],error.getMessage()); }
            }
            try {
                progress.update("Reading thermometry calibration");
                byte[] body=readThermometry();
                result.files.put("thermometry-wire-body.bin",body);
                long fileSize=u32(body,64);
                if(fileSize==0 || fileSize!=body.length-68L) throw new IOException("Thermometry body has an inconsistent internal file length; complete wire body retained for review.");
                result.files.put("thermometry-calibration.bin",Arrays.copyOfRange(body,68,body.length));
                result.outcomes.put("thermometry-calibration.bin","complete; wire prefix0 assumed from UVC2, review against vendor format");
            } catch(IOException error) {result.outcomes.put("thermometry-calibration.bin",error.getMessage());}
            result.complete=result.files.containsKey("BPM.bin") && result.files.containsKey("KMatrix.bin") && result.files.containsKey("KMatrix2.bin") && result.files.containsKey("thermometry-calibration.bin");
        } catch(IOException error) {result.outcomes.put("session",error.getMessage());}
        result.files.put("transactions.tsv",trace.toString().getBytes(StandardCharsets.UTF_8));
        result.files.put("manifest.json",manifest(result,deviceIdentity).getBytes(StandardCharsets.UTF_8));
        return result;
    }
    private byte[] readFactory(int type) throws IOException {
        if(type!=4 && type!=11 && type!=14) throw new IOException("File type is not allowlisted.");
        select(26,1);
        if(length(26)!=5) throw new IOException("Unexpected source announcement length.");
        set(26,new byte[]{1,2,0,0,0});
        length(26); // Native chunked writer queries fresh GET_LEN but keeps its chosen transfer length.
        set(26,new byte[]{2,1,0,0,0,(byte)type,1,0,0,0,0,0,0});
        status(); select(26,2);
        byte[] first=get(26,length(26));
        long total=parseSize(first,type==4?16384:98304);
        ByteArrayOutputStream out=new ByteArrayOutputStream((int)total);
        for(int chunk=0;out.size()<total;chunk++) {
            if(chunk>=1024) throw new IOException("Too many file chunks.");
            byte[] packet=get(26,length(26));
            int count=chunkPayloadLength(packet,total,out.size());
            out.write(packet,5,count);
        }
        status(); return out.toByteArray();
    }
    private byte[] readThermometry() throws IOException {
        select(3,14);
        byte[] first=get(3,length(3));
        long total=parseSize(first,4*1024*1024);
        if(total<68) throw new IOException("Thermometry body is too short.");
        ByteArrayOutputStream out=new ByteArrayOutputStream((int)total);
        for(int chunk=0;out.size()<total;chunk++) {
            if(chunk>=8274) throw new IOException("Too many thermometry chunks.");
            int wanted=(int)Math.min(507,total-out.size());
            length(3); // Fresh vendor GET_LEN precedes every native chunked GET_CUR.
            byte[] packet=get(3,wanted+5);
            if(packet.length!=wanted+5) throw new IOException("Short thermometry transport chunk.");
            out.write(packet,5,wanted);
        }
        status(); return out.toByteArray();
    }
    private void status() throws IOException {
        if(length(6)!=1) throw new IOException("Unexpected command-status length.");
        byte[] bytes=get(6,1);
        if(bytes.length!=1 || bytes[0]!=0) throw new IOException("Camera command status: "+hex(bytes));
    }
    private int length(int selector) throws IOException {
        byte[] bytes=new byte[4];
        int actual=transfer(true,0x85,selector,bytes);
        if(actual!=2 && actual!=4) throw new IOException("GET_LEN must return two or four bytes.");
        long n=u32(bytes,0);
        if(n<1 || n>512) throw new IOException("Unexpected USB control length: "+n);
        return (int)n;
    }
    private byte[] get(int selector,int count) throws IOException {
        if(count<1 || count>512) throw new IOException("GET size outside the bounded packet capacity.");
        byte[] bytes=new byte[count]; int actual=transfer(true,0x81,selector,bytes);
        if(actual<1 || actual>count) throw new IOException("Empty or oversized USB read.");
        return Arrays.copyOf(bytes,actual);
    }
    private void select(int selector,int command) throws IOException {
        // Native SwitchCommand396458/3964a8 uses fresh GET_LEN as the write size.
        int count=length(5);
        if(count!=2 && count!=4)throw new IOException("Unexpected command-selection length: "+count);
        set(5,Arrays.copyOf(new byte[]{(byte)selector,(byte)command,1,0},count));
    }
    private void set(int selector,byte[] bytes) throws IOException {
        if(!isAllowedSet(selector,bytes)) throw new IOException("Unapproved USB write rejected.");
        if(transfer(false,1,selector,bytes)!=bytes.length) throw new IOException("Short USB query-selection write.");
    }
    public static boolean isAllowedSet(int selector,byte[] b) {
        if(b==null) return false;
        if(selector==5 && (b.length==2 || (b.length==4 && b[2]==1 && b[3]==0)))
            return (b[0]==1 && b[1]==1)||(b[0]==26&&(b[1]==1||b[1]==2))||(b[0]==3&&b[1]==14);
        if(selector!=26) return false;
        if(Arrays.equals(b,new byte[]{1,2,0,0,0})) return true;
        if(b.length!=13 || b[0]!=2 || b[1]!=1 || b[2]!=0 || b[3]!=0 || b[4]!=0 || b[6]!=1) return false;
        if(b[5]!=4 && b[5]!=11 && b[5]!=14) return false;
        for(int i=7;i<b.length;i++) if(b[i]!=0) return false;
        return true;
    }
    private int transfer(boolean incoming,int request,int selector,byte[] bytes) throws IOException {
        if(Thread.currentThread().isInterrupted() || System.nanoTime()>deadline) throw new IOException("Read cancelled or 90-second session deadline reached.");
        if(incoming && selector!=1 && selector!=3 && selector!=4 && selector!=6 && selector!=26 && !(selector==5 && request==0x85)) throw new IOException("Read selector is not allowlisted.");
        int actual=usb.control(incoming?0xa1:0x21,request,selector<<8,index,bytes,5000);
        byte[] recorded=incoming?Arrays.copyOf(bytes,Math.max(0,Math.min(bytes.length,actual))):bytes;
        trace.append(incoming?"IN":"OUT").append('\t').append(request).append('\t').append(selector).append('\t').append(bytes.length).append('\t').append(actual).append('\t').append(hex(recorded)).append('\n');
        if(actual<0) throw new IOException("USB transfer failed for selector "+selector+", request "+request+".");
        return actual;
    }
    public static long parseSize(byte[] packet,long capacity) throws IOException {
        if(packet==null || packet.length!=5) throw new IOException("Expected exactly five size bytes.");
        long total=u32(packet,1);
        if(total<1 || total>capacity) throw new IOException("Invalid announced file size: "+total);
        return total;
    }
    public static int chunkPayloadLength(byte[] packet,long total,long accumulated) throws IOException {
        if(packet==null || packet.length<=5 || packet.length>512 || total<=0 || accumulated<0 || accumulated>=total) throw new IOException("Invalid file chunk bounds.");
        int count=packet.length-5;
        if(count>total-accumulated) throw new IOException("File chunk exceeds announced size; padding is not assumed.");
        return count; // Native ignores header values. Preserve their raw bytes in transactions.tsv.
    }
    public static long u32(byte[] bytes,int offset) throws IOException {
        if(offset<0 || offset>bytes.length-4) throw new IOException("Truncated uint32.");
        return (bytes[offset]&255L)|((bytes[offset+1]&255L)<<8)|((bytes[offset+2]&255L)<<16)|((bytes[offset+3]&255L)<<24);
    }
    public static String hex(byte[] bytes) {StringBuilder s=new StringBuilder(); for(byte b:bytes)s.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return s.toString();}
    public static String sha256(byte[] bytes) {try{return hex(MessageDigest.getInstance("SHA-256").digest(bytes));}catch(Exception impossible){throw new IllegalStateException(impossible);}}
    private static String quote(String text) {return "\""+text.replace("\\","\\\\").replace("\"","\\\"").replace("\n","\\n").replace("\r","\\r").replace("\t","\\t")+"\"";}
    private static String manifest(Bundle bundle,String identity) {
        StringBuilder s=new StringBuilder("{\"format\":\"accuheat-calibration-export-v1\",\"createdUtc\":").append(quote(java.time.Instant.now().toString())).append(",\"device\":{\"vendorId\":14526,\"productId\":388,\"serial\":").append(quote(identity)).append(",\"model\":\"SK02\"},\"provenance\":{\"method\":\"Android UsbDeviceConnection.controlTransfer\",\"sourceApk\":\"AccuHeat_V1.1.1_Android.apk\"},\"protocolVersion\":").append(bundle.protocolVerified?"\"2.0\"":"null").append(",\"complete\":").append(bundle.complete).append(",\"files\":[");
        boolean first=true; for(Map.Entry<String,byte[]> e:bundle.files.entrySet()) {if(!first)s.append(',');first=false;s.append("{\"name\":").append(quote(e.getKey())).append(",\"bytes\":").append(e.getValue().length).append(",\"sha256\":").append(quote(sha256(e.getValue()))).append('}');}
        s.append("],\"outcomes\":{");first=true;for(Map.Entry<String,String> e:bundle.outcomes.entrySet()){if(!first)s.append(',');first=false;s.append(quote(e.getKey())).append(':').append(quote(e.getValue()));}return s.append("}}\n").toString();
    }
}
