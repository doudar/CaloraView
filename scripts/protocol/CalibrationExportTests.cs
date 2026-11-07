using System;
using Caloraview.Protocol;
public static class CalibrationExportTests {
    static void Check(bool value,string name){if(!value)throw new Exception(name);}
    public static int Main(){
        const string serial="A43EB0_EXAMPLE";
        Check(CalibrationExport.SerialFromParentId("USB\\VID_38BE&PID_0184\\"+serial)==serial,"Physical serial binding");
        Check(CalibrationExport.SerialFromParentId("USB\\VID_38BE&PID_0184&MI_00\\c&3132d716&0&0000")==null,"Interface instance must not become serial");
        Check(CalibrationExport.SerialFromParentId("USB\\VID_38BE&PID_0184\\7&fake&0")==null,"Generated instance must not become serial");
        Check(CalibrationExport.SerialFromParentId("USB\\VID_0001&PID_0184\\"+serial)==null,"Different device rejected");
        string instance="vid_38be&pid_0184&mi_00#c&3132d716&0&0000";
        Check(CalibrationExport.InstanceMatch("@device_pnp_\\\\?\\usb#"+instance+"#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global")==instance,"FFmpeg exact moniker");
        Check(KsFactoryDownload.DevicePathMatches("\\\\?\\usb#"+instance+"#{guid}\\global",instance),"Exact selected instance rejected");
        Check(!KsFactoryDownload.DevicePathMatches("\\\\?\\usb#"+instance+"1#{guid}\\global",instance),"Instance prefix collision accepted");
        foreach(string invalid in new[]{"vid_38be&pid_0184", "vid_38be&pid_0184&mi_01#other", "vid_38be&pid_0184&mi_00#x#y"}) {
            bool rejected=false;try{CalibrationExport.InstanceMatch(invalid);}catch(ArgumentException){rejected=true;}Check(rejected,"Invalid moniker accepted");
        }
        Console.WriteLine("Calibration export identity tests passed. No hardware opened.");return 0;
    }
}
