package com.caloraview.export;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public final class MainActivity extends Activity {
    private static final String USB_PERMISSION="com.caloraview.export.USB_PERMISSION";
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private UsbManager manager;
    private UsbDevice selected;
    private volatile UsbDeviceConnection activeConnection;
    private CalibrationProtocol.Bundle captured;
    private TextView status;
    private Button read,export;
    private boolean busy;
    private final BroadcastReceiver permissionReceiver=new BroadcastReceiver() {
        public void onReceive(Context context,Intent intent) {
            if(!USB_PERMISSION.equals(intent.getAction()) || selected==null) return;
            if(manager.hasPermission(selected)) beginRead();
            else show("USB permission was not granted. No calibration data read.");
        }
    };
    @Override public void onCreate(Bundle state) {
        super.onCreate(state); manager=(UsbManager)getSystemService(USB_SERVICE);
        LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);layout.setPadding(32,40,32,32);
        TextView title=new TextView(this);title.setText("Caloraview calibration export");title.setTextSize(23);layout.addView(title);
        TextView detail=new TextView(this);detail.setText("Connect the SK02 directly to this Android device using USB host/OTG. Close other camera apps. Select the camera, grant Android USB access, then save the export ZIP.\n\nThis experimental helper reads factory data only. It has no shutter, settings, firmware, upload or reset controls. It does not use the internet.");detail.setPadding(0,20,0,20);layout.addView(detail);
        read=new Button(this);read.setText("Select SK02 and read calibration");read.setOnClickListener(v->chooseDevice());layout.addView(read);
        export=new Button(this);export.setText("Save export ZIP");export.setEnabled(false);export.setOnClickListener(v->{Intent save=new Intent(Intent.ACTION_CREATE_DOCUMENT);save.addCategory(Intent.CATEGORY_OPENABLE);save.setType("application/zip");save.putExtra(Intent.EXTRA_TITLE,"Caloraview-calibration-export.zip");startActivityForResult(save,2);});layout.addView(export);
        status=new TextView(this);status.setText("Ready. Only USB devices matching 38be:0184 are listed.");status.setTextIsSelectable(true);status.setPadding(0,20,0,0);
        ScrollView scroll=new ScrollView(this);scroll.addView(status);layout.addView(scroll,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,0,1));setContentView(layout);
        IntentFilter filter=new IntentFilter(USB_PERMISSION);
        if(Build.VERSION.SDK_INT>=33) registerReceiver(permissionReceiver,filter,Context.RECEIVER_NOT_EXPORTED);else registerReceiver(permissionReceiver,filter);
    }
    private void chooseDevice() {
        if(busy)return;
        ArrayList<UsbDevice> devices=new ArrayList<>();
        for(UsbDevice device:manager.getDeviceList().values()) if(device.getVendorId()==0x38be && device.getProductId()==0x0184) devices.add(device);
        if(devices.isEmpty()){show("No matching SK02 found. Check USB host/OTG support, cable and camera power.");return;}
        String[] labels=new String[devices.size()];for(int i=0;i<labels.length;i++) labels[i]="SK02 38be:0184 — "+devices.get(i).getDeviceName();
        new AlertDialog.Builder(this).setTitle("Select attached SK02").setItems(labels,(dialog,index)->{selected=devices.get(index);requestAccess();}).setNegativeButton("Cancel",null).show();
    }
    private void requestAccess() {
        // Android can recreate this Activity while the runtime permission UI is open.
        // The selected device is intentionally not guessed or restored by name.
        if(selected==null){show("Select the attached SK02 again to continue USB access.");return;}
        if(checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED){show("Android requires Camera permission to grant USB access to a video-class device. This helper only reads calibration data from the selected SK02.");requestPermissions(new String[]{Manifest.permission.CAMERA},1);return;}
        if(manager.hasPermission(selected)){beginRead();return;}
        PendingIntent pending=PendingIntent.getBroadcast(this,0,new Intent(USB_PERMISSION).setPackage(getPackageName()),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        manager.requestPermission(selected,pending);
    }
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] grants) {
        super.onRequestPermissionsResult(request,permissions,grants);
        if(request==1 && grants.length>0 && grants[0]==PackageManager.PERMISSION_GRANTED)requestAccess();
        else show("Android Camera permission was not granted. No USB camera data accessed.");
    }
    private void beginRead() {
        if(busy || selected==null)return;busy=true;read.setEnabled(false);export.setEnabled(false);captured=null;
        final UsbDevice device=selected;
        worker.execute(()->{
            UsbDeviceConnection connection=null;UsbInterface control=null;boolean claimed=false;
            try {
                if(device.getVendorId()!=0x38be || device.getProductId()!=0x0184)throw new IOException("USB identity changed.");
                connection=manager.openDevice(device);if(connection==null)throw new IOException("Cannot open selected USB device.");activeConnection=connection;
                verifyExtension(connection.getRawDescriptors());
                for(int i=0;i<device.getInterfaceCount();i++){UsbInterface candidate=device.getInterface(i);if(candidate.getId()==0 && candidate.getAlternateSetting()==0 && candidate.getInterfaceClass()==14 && candidate.getInterfaceSubclass()==1)control=candidate;}
                if(control==null)throw new IOException("Verified VideoControl interface was not found.");
                if(Thread.currentThread().isInterrupted())throw new IOException("Read cancelled before interface claim.");
                claimed=connection.claimInterface(control,false);
                if(!claimed){
                    if(Thread.currentThread().isInterrupted())throw new IOException("Read cancelled before interface retry.");
                    show("Requesting temporary access to the selected SK02 control interface.");
                    claimed=connection.claimInterface(control,true);
                }
                if(!claimed)throw new IOException("Cannot claim the selected SK02 control interface. Close other camera apps and reconnect the camera.");
                final UsbDeviceConnection transport=connection;
                String serial;try{serial=device.getSerialNumber();}catch(Exception unavailable){serial="unavailable";}
                captured=new CalibrationProtocol((requestType,request,value,index,bytes,timeout)->transport.controlTransfer(requestType,request,value,index,bytes,bytes.length,timeout),10,0,this::show).readAll(serial==null?"unavailable":serial);
                StringBuilder summary=new StringBuilder(captured.complete?"All requested files read. Save the ZIP for desktop protocol validation.\n":"Export is incomplete. Save the ZIP to retain diagnostics and any complete files.\n");
                for(Map.Entry<String,String> item:captured.outcomes.entrySet())summary.append('\n').append(item.getKey()).append(": ").append(item.getValue());show(summary.toString());
            } catch(Exception error){show("Read stopped: "+error.getMessage());}
            finally {if(connection!=null){try{if(claimed)connection.releaseInterface(control);}finally{connection.close();}}activeConnection=null;runOnUiThread(()->{busy=false;read.setEnabled(true);export.setEnabled(captured!=null);});}
        });
    }
    private static void verifyExtension(byte[] descriptors) throws IOException {
        byte[] guid={0x41,0x76,(byte)0x9e,(byte)0xa2,0x04,(byte)0xde,(byte)0xe3,0x47,(byte)0x8b,0x2b,(byte)0xf4,0x34,0x1a,(byte)0xff,0x00,0x3b};
        boolean videoControl=false;
        for(int offset=0;descriptors!=null && offset<descriptors.length;){
            int length=descriptors[offset]&255;if(length<2 || offset+length>descriptors.length)throw new IOException("Malformed USB descriptor.");
            int type=descriptors[offset+1]&255;
            if(type==4 && length>=9)videoControl=descriptors[offset+2]==0 && descriptors[offset+3]==0 && descriptors[offset+5]==14 && descriptors[offset+6]==1;
            if(videoControl && type==0x24 && length>=24 && descriptors[offset+2]==6 && descriptors[offset+3]==10 && Arrays.equals(guid,Arrays.copyOfRange(descriptors,offset+4,offset+20)))return;
            offset+=length;
        }
        throw new IOException("Verified SK02 extension unit was not found.");
    }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);if(request!=2 || result!=RESULT_OK || data==null || data.getData()==null || captured==null)return;
        final CalibrationProtocol.Bundle snapshot=captured;busy=true;read.setEnabled(false);export.setEnabled(false);
        worker.execute(()->{
            try(OutputStream output=getContentResolver().openOutputStream(data.getData(),"w")) {
                if(output==null)throw new IOException("Document provider returned no output stream.");
                try(ZipOutputStream zip=new ZipOutputStream(output)){for(Map.Entry<String,byte[]> file:snapshot.files.entrySet()){if(Thread.currentThread().isInterrupted())throw new IOException("Export cancelled.");zip.putNextEntry(new ZipEntry(file.getKey()));zip.write(file.getValue());zip.closeEntry();}}
                show("ZIP saved. "+(snapshot.complete?"All requested files are included.":"Some reads failed; see manifest.json and transactions.tsv."));
            } catch(Exception error){show("ZIP save failed: "+error.getMessage());}
            finally{runOnUiThread(()->{busy=false;read.setEnabled(true);export.setEnabled(true);});}
        });
    }
    private void show(String message){runOnUiThread(()->status.setText(message));}
    @Override protected void onDestroy(){unregisterReceiver(permissionReceiver);worker.shutdownNow();UsbDeviceConnection connection=activeConnection;if(connection!=null)connection.close();super.onDestroy();}
}
